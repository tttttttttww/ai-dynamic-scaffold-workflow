import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "crypto";
import { getStore } from "@edgeone/pages-blob";

const app = express();
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("仅支持 JPG / PNG / WEBP 图片"), ok);
  }
});

const store = getStore({ name: "ai-dynamic-scaffold-data", consistency: "strong" });

const COZE_BASE = "https://api.coze.cn";
const TOKEN = process.env.COZE_ACCESS_TOKEN;
const BOT_ID = process.env.COZE_BOT_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET;
const RUN_ID = process.env.EXPERIMENT_RUN_ID || "default";

function safeId(v) {
  return String(v || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
const SAFE_RUN_ID = safeId(RUN_ID) || "default";

function ensureConfig() {
  if (!TOKEN) throw new Error("COZE_ACCESS_TOKEN 未配置");
  if (!BOT_ID) throw new Error("COZE_BOT_ID 未配置");
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}
function extFromMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}
function mimeFromKey(key) {
  const k = String(key).toLowerCase();
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

async function cozeFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${TOKEN}`);
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || (typeof data.code === "number" && data.code !== 0)) {
    const logid = data?.detail?.logid || data?.logid || "";
    const code = data?.code != null ? ` [code: ${data.code}]` : "";
    const lid = logid ? ` [logid: ${logid}]` : "";
    throw new Error((data.msg || data.message || `Coze 请求失败 (${res.status})`) + code + lid);
  }
  return data;
}

async function uploadImageToCoze(buffer, filename, mime) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename || "image.jpg");
  const data = await cozeFetch(`${COZE_BASE}/v1/files/upload`, {
    method: "POST",
    body: form
  });
  const id = data?.data?.id || data?.data?.file_id;
  if (!id) throw new Error("Coze 未返回 file_id");
  return String(id);
}

async function runCozeBot({ studentId, message, conversationId, imageFileId }) {
  ensureConfig();

  const text = message || (imageFileId
    ? "请根据这张程序截图，结合我的思考过程给我提供适合当前学习水平的学习支架。"
    : "请继续帮助我分析当前问题。");

  const isMultiModal = Boolean(imageFileId);
  const content = isMultiModal
    ? JSON.stringify([
        { type: "image", file_id: imageFileId },
        { type: "text", text }
      ])
    : text;

  const query = conversationId
    ? `?conversation_id=${encodeURIComponent(conversationId)}`
    : "";

  const created = await cozeFetch(`${COZE_BASE}/v3/chat${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bot_id: BOT_ID,
      user_id: `study_${SAFE_RUN_ID}_${studentId}`,
      stream: false,
      auto_save_history: true,
      additional_messages: [{
        role: "user",
        content,
        content_type: isMultiModal ? "object_string" : "text"
      }]
    })
  });

  const chat = created?.data;
  if (!chat?.id || !chat?.conversation_id) {
    throw new Error("Coze 未返回 chat_id / conversation_id");
  }

  let detailData = chat;
  let status = chat.status || "created";

  for (let i = 0; i < 50 && !["completed", "failed", "requires_action", "canceled"].includes(status); i++) {
    await sleep(900);
    const detail = await cozeFetch(
      `${COZE_BASE}/v3/chat/retrieve?conversation_id=${encodeURIComponent(chat.conversation_id)}&chat_id=${encodeURIComponent(chat.id)}`
    );
    detailData = detail?.data || detailData;
    status = detailData?.status || status;
  }

  if (status !== "completed") {
    const lastError = detailData?.last_error;
    const extra = lastError?.msg
      ? `：${lastError.msg}${lastError.code ? ` (code ${lastError.code})` : ""}`
      : "";
    throw new Error(`智能体本轮状态：${status}${extra}`);
  }

  const msgData = await cozeFetch(
    `${COZE_BASE}/v3/chat/message/list?conversation_id=${encodeURIComponent(chat.conversation_id)}&chat_id=${encodeURIComponent(chat.id)}`
  );

  const messages = Array.isArray(msgData?.data) ? msgData.data : [];
  const answers = messages.filter(m =>
    m.role === "assistant" &&
    m.type === "answer" &&
    typeof m.content === "string" &&
    m.content.trim()
  );
  const fallback = messages.filter(m =>
    m.role === "assistant" &&
    m.content_type === "text" &&
    typeof m.content === "string" &&
    m.content.trim()
  );

  const assistantMessage = (answers.length ? answers : fallback)
    .map(m => m.content)
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!assistantMessage) throw new Error("智能体已完成本轮对话，但未获取到最终回复");

  return {
    chatId: String(chat.id),
    conversationId: String(chat.conversation_id),
    assistantMessage,
    usage: detailData?.usage || null,
    cozeLogId: created?.detail?.logid || msgData?.detail?.logid || ""
  };
}

function contextKey(studentId) {
  return `context/${SAFE_RUN_ID}/${studentId}.json`;
}
async function getStudentContext(studentId) {
  try {
    return await store.get(contextKey(studentId), { type: "json", consistency: "strong" });
  } catch {
    return null;
  }
}
async function saveStudentContext(studentId, context) {
  await store.setJSON(contextKey(studentId), {
    ...context,
    botId: BOT_ID,
    experimentRunId: RUN_ID,
    updatedAt: new Date().toISOString()
  });
}

function issueAdminToken() {
  if (!ADMIN_SECRET) throw new Error("ADMIN_SESSION_SECRET 未配置");
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 8 * 60 * 60 * 1000
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || !ADMIN_SECRET) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!verifyAdminToken(token)) return jsonError(res, 401, "管理员登录已失效");
  next();
}

async function getLogs(studentFilter = "") {
  const { blobs = [] } = await store.list({ prefix: "logs/", consistency: "strong" });
  const logs = await Promise.all(
    blobs.slice(-1500).map(async ({ key }) => {
      try { return await store.get(key, { type: "json", consistency: "strong" }); }
      catch { return null; }
    })
  );
  return logs
    .filter(Boolean)
    .filter(x => !studentFilter || String(x.studentId).toLowerCase() === studentFilter.toLowerCase())
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

const chatHandler = async (req, res) => {
  try {
    const studentId = safeId(req.body.studentId);
    const message = String(req.body.message || "").trim().slice(0, 4000);

    if (!studentId) return jsonError(res, 400, "学习编号不能为空");
    if (!req.file && !message) return jsonError(res, 400, "请上传截图或输入回答");

    let imageKey = "";
    let imageFileId = "";
    let imageName = "";

    if (req.file) {
      const ext = extFromMime(req.file.mimetype);
      imageKey = `images/${SAFE_RUN_ID}/${studentId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      imageName = req.file.originalname || `program.${ext}`;

      await store.set(
        imageKey,
        new Blob([req.file.buffer], { type: req.file.mimetype })
      );

      imageFileId = await uploadImageToCoze(
        req.file.buffer,
        imageName,
        req.file.mimetype
      );
    }

    const savedContext = await getStudentContext(studentId);
    const conversationId = savedContext?.botId === BOT_ID
      ? String(savedContext?.conversationId || "")
      : "";

    // 首轮要求有截图；后续轮次可只输入文字，Coze 会通过同一个 conversation 保留历史上下文。
    if (!conversationId && !imageFileId) {
      return jsonError(res, 400, "这是该学习编号的第一轮对话，请先上传当前程序截图");
    }

    const result = await runCozeBot({
      studentId,
      message,
      conversationId,
      imageFileId
    });

    await saveStudentContext(studentId, {
      conversationId: result.conversationId,
      lastChatId: result.chatId,
      lastImageKey: imageKey || savedContext?.lastImageKey || "",
      lastImageName: imageName || savedContext?.lastImageName || ""
    });

    const levelMatch = result.assistantMessage.match(/\bLevel\s*([123])\b/i);

    const log = {
      timestamp: new Date().toISOString(),
      experimentRunId: RUN_ID,
      studentId,
      botId: BOT_ID,
      conversationId: result.conversationId,
      chatId: result.chatId,
      cozeLogId: result.cozeLogId,
      message,
      imageKey,
      imageName,
      imageFileId,
      assistantMessage: result.assistantMessage,
      level: levelMatch ? levelMatch[1] : "",
      usage: result.usage
    };

    const logKey = `logs/${Date.now()}-${studentId}-${crypto.randomUUID()}.json`;
    await store.setJSON(logKey, log);

    res.json({
      ok: true,
      assistantMessage: result.assistantMessage,
      conversationId: result.conversationId,
      chatId: result.chatId
    });
  } catch (err) {
    console.error(err);
    jsonError(res, 500, err.message || "服务器错误");
  }
};

app.post(["/chat", "/api/chat"], upload.single("image"), chatHandler);

const loginHandler = (req, res) => {
  try {
    if (!ADMIN_PASSWORD || !ADMIN_SECRET) {
      return jsonError(res, 500, "管理员环境变量未配置");
    }
    const input = Buffer.from(String(req.body.password || ""));
    const real = Buffer.from(String(ADMIN_PASSWORD));
    const ok = input.length === real.length && crypto.timingSafeEqual(input, real);
    if (!ok) return jsonError(res, 401, "管理员密码错误");
    res.json({ ok: true, token: issueAdminToken() });
  } catch (err) {
    jsonError(res, 500, err.message || "登录失败");
  }
};
app.post(["/admin/login", "/api/admin/login"], loginHandler);

const logsHandler = async (req, res) => {
  try {
    const filter = safeId(req.query.studentId || "");
    const logs = await getLogs(filter);
    res.json({ logs });
  } catch (err) {
    jsonError(res, 500, err.message || "读取日志失败");
  }
};
app.get(["/admin/logs", "/api/admin/logs"], requireAdmin, logsHandler);

const imageHandler = async (req, res) => {
  try {
    const key = String(req.query.key || "");
    if (!key.startsWith("images/")) return jsonError(res, 400, "非法图片路径");
    const data = await store.get(key, { type: "arrayBuffer", consistency: "strong" });
    if (!data) return jsonError(res, 404, "图片不存在");
    res.set("Content-Type", mimeFromKey(key));
    res.set("Cache-Control", "private, max-age=60");
    res.send(Buffer.from(data));
  } catch (err) {
    jsonError(res, 500, err.message || "读取图片失败");
  }
};
app.get(["/admin/image", "/api/admin/image"], requireAdmin, imageHandler);

function csvCell(v) {
  const s = String(v ?? "").replace(/\r?\n/g, " ");
  return `"${s.replace(/"/g, '""')}"`;
}
const exportHandler = async (req, res) => {
  try {
    const logs = await getLogs("");
    const rows = [
      ["timestamp","experimentRunId","studentId","botId","conversationId","chatId","cozeLogId","level","message","imageName","imageKey","imageFileId","assistantMessage"],
      ...logs.map(x => [
        x.timestamp,x.experimentRunId,x.studentId,x.botId,x.conversationId,x.chatId,x.cozeLogId,x.level,
        x.message,x.imageName,x.imageKey,x.imageFileId,x.assistantMessage
      ])
    ];
    const csv = "\uFEFF" + rows.map(r => r.map(csvCell).join(",")).join("\n");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="ai-dynamic-scaffold-logs.csv"');
    res.send(csv);
  } catch (err) {
    jsonError(res, 500, err.message || "导出失败");
  }
};
app.get(["/admin/export", "/api/admin/export"], requireAdmin, exportHandler);

app.get(["/health", "/api/health"], (req, res) => {
  res.json({
    ok: true,
    service: "ai-dynamic-scaffold",
    cozeMode: "bot",
    botConfigured: Boolean(BOT_ID),
    tokenConfigured: Boolean(TOKEN),
    experimentRunId: RUN_ID
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return jsonError(res, 400, "图片不能超过 5MB");
  jsonError(res, 400, err?.message || "请求失败");
});

export default app;
