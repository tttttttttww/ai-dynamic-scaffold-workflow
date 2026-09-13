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
// 对话流“开始”节点里的自定义输入参数名。图片参数默认沿用当前项目工作流中的 program_image。
// 文本通常直接通过 additional_messages -> USER_INPUT 进入对话流，因此默认不额外传。
const FLOW_IMAGE_PARAM = String(process.env.COZE_FLOW_IMAGE_PARAM || "program_image").trim();
const FLOW_TEXT_PARAM = String(process.env.COZE_FLOW_TEXT_PARAM || "").trim();

function safeId(v) {
  return String(v || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
const SAFE_RUN_ID = safeId(RUN_ID) || "default";

function ensureConfig() {
  if (!TOKEN) throw new Error("COZE_ACCESS_TOKEN 未配置");
  if (!BOT_ID) throw new Error("COZE_BOT_ID 未配置");
  if (!ADMIN_SECRET) throw new Error("ADMIN_SESSION_SECRET 未配置");
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

function imageSignature(key, exp) {
  return crypto.createHmac("sha256", ADMIN_SECRET).update(`${key}\n${exp}`).digest("base64url");
}
function makePublicImageUrl(req, key) {
  // 给 Coze 一个真实可访问的 HTTPS 图片 URL，避免 Bot 看见 file_id 后无法继续把图片 URL 传给内部工具。
  const forwarded = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwarded || "https";
  const host = req.get("host");
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 小时，覆盖课堂/调试会话
  const sig = imageSignature(key, exp);
  return `${proto}://${host}/api/public-image?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
}
function verifyPublicImage(key, expRaw, sig) {
  const exp = Number(expRaw);
  if (!key.startsWith("images/") || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = imageSignature(key, exp);
  const a = Buffer.from(String(sig || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function startCozeBot({ studentId, message, conversationId, messageImageUrl, flowImageUrl }) {
  ensureConfig();

  const text = message || (flowImageUrl
    ? "请根据这张程序截图，结合我的思考过程给我提供适合当前学习水平的学习支架。"
    : "请继续帮助我分析当前问题。");

  // 1) 新上传的图片作为本轮用户消息发送，让智能体/模型可以直接看到图片。
  //    后续纯文本追问不会重复把旧图塞进消息，只会在 parameters 中复用旧图。
  const isMultiModal = Boolean(messageImageUrl);
  const content = isMultiModal
    ? JSON.stringify([
        { type: "image", file_url: messageImageUrl },
        { type: "text", text }
      ])
    : text;

  // 2) 关键修复：如果 Bot 使用“对话流模式”，对话流开始节点的自定义参数
  //    不能只靠 additional_messages 传入，必须通过 v3/chat 顶层 parameters 赋值。
  //    Image 类型自定义参数支持直接传公开可访问的 HTTPS URL。
  const parameters = {};
  if (FLOW_IMAGE_PARAM && flowImageUrl) {
    parameters[FLOW_IMAGE_PARAM] = flowImageUrl;
  }
  if (FLOW_TEXT_PARAM) {
    parameters[FLOW_TEXT_PARAM] = text;
  }

  const query = conversationId
    ? `?conversation_id=${encodeURIComponent(conversationId)}`
    : "";

  const body = {
    bot_id: BOT_ID,
    user_id: `study_${SAFE_RUN_ID}_${studentId}`,
    stream: false,
    auto_save_history: true,
    additional_messages: [{
      role: "user",
      content,
      content_type: isMultiModal ? "object_string" : "text"
    }]
  };
  if (Object.keys(parameters).length) body.parameters = parameters;

  const created = await cozeFetch(`${COZE_BASE}/v3/chat${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const chat = created?.data;
  if (!chat?.id || !chat?.conversation_id) {
    throw new Error("Coze 未返回 chat_id / conversation_id");
  }

  return {
    chatId: String(chat.id),
    conversationId: String(chat.conversation_id),
    status: String(chat.status || "created"),
    cozeLogId: created?.detail?.logid || ""
  };
}

async function retrieveCozeChat(conversationId, chatId) {
  const detail = await cozeFetch(
    `${COZE_BASE}/v3/chat/retrieve?conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`
  );
  return {
    ...(detail?.data || {}),
    cozeLogId: detail?.detail?.logid || ""
  };
}

async function getCozeAnswer(conversationId, chatId) {
  const msgData = await cozeFetch(
    `${COZE_BASE}/v3/chat/message/list?conversation_id=${encodeURIComponent(conversationId)}&chat_id=${encodeURIComponent(chatId)}`
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
    m.content.trim() &&
    !["function_call", "tool_response", "tool_output"].includes(m.type)
  );
  const assistantMessage = (answers.length ? answers : fallback)
    .map(m => m.content)
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    assistantMessage,
    messages,
    cozeLogId: msgData?.detail?.logid || ""
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

function issueSignedToken(payloadObject, ttlMs) {
  if (!ADMIN_SECRET) throw new Error("ADMIN_SESSION_SECRET 未配置");
  const payload = Buffer.from(JSON.stringify({
    ...payloadObject,
    exp: Date.now() + ttlMs
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySignedToken(token) {
  if (!token || !ADMIN_SECRET) return null;
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(data.exp) <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function issueAdminToken() {
  return issueSignedToken({ kind: "admin" }, 8 * 60 * 60 * 1000);
}
function verifyAdminToken(token) {
  const data = verifySignedToken(token);
  return Boolean(data && data.kind === "admin");
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

// Coze 直接拉取该 URL 获取图片。URL 带 HMAC 签名且有时效，不暴露管理员接口。
app.get(["/public-image", "/api/public-image"], async (req, res) => {
  try {
    const key = String(req.query.key || "");
    const exp = String(req.query.exp || "");
    const sig = String(req.query.sig || "");
    if (!verifyPublicImage(key, exp, sig)) return jsonError(res, 403, "图片链接已失效");
    const data = await store.get(key, { type: "arrayBuffer", consistency: "strong" });
    if (!data) return jsonError(res, 404, "图片不存在");
    res.set("Content-Type", mimeFromKey(key));
    res.set("Cache-Control", "public, max-age=300");
    res.send(Buffer.from(data));
  } catch (err) {
    jsonError(res, 500, err.message || "读取图片失败");
  }
});

const chatStartHandler = async (req, res) => {
  try {
    ensureConfig();
    const studentId = safeId(req.body.studentId);
    const message = String(req.body.message || "").trim().slice(0, 4000);
    const newSession = String(req.body.newSession || "") === "1";

    if (!studentId) return jsonError(res, 400, "学习编号不能为空");
    if (!req.file && !message) return jsonError(res, 400, "请上传截图或输入回答");

    let imageKey = "";
    let imageName = "";
    let imageUrl = "";

    if (req.file) {
      const ext = extFromMime(req.file.mimetype);
      imageKey = `images/${SAFE_RUN_ID}/${studentId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      imageName = req.file.originalname || `program.${ext}`;
      await store.set(imageKey, new Blob([req.file.buffer], { type: req.file.mimetype }));
      imageUrl = makePublicImageUrl(req, imageKey);
    }

    const savedContext = await getStudentContext(studentId);
    const conversationId = !newSession && savedContext?.botId === BOT_ID
      ? String(savedContext?.conversationId || "")
      : "";

    // 每次从“开始检查程序”进入都强制新建 Coze conversation，避免历史测试会话污染。
    if (!conversationId && !imageUrl) {
      return jsonError(res, 400, "这是新一轮学习对话，请先上传当前程序截图");
    }

    // 后续纯文本轮次仍可能重新进入同一对话流。若开始节点把 program_image 设为必填，
    // 就必须把本轮最近一次截图继续作为 parameters 传入，不能只在第一轮给一次。
    const effectiveImageKey = imageKey || savedContext?.lastImageKey || "";
    const effectiveImageUrl = imageUrl || (effectiveImageKey ? makePublicImageUrl(req, effectiveImageKey) : "");

    const startedAt = Date.now();
    const started = await startCozeBot({
      studentId,
      message,
      conversationId,
      messageImageUrl: imageUrl,
      flowImageUrl: effectiveImageUrl
    });

    await saveStudentContext(studentId, {
      conversationId: started.conversationId,
      lastChatId: started.chatId,
      lastImageKey: effectiveImageKey,
      lastImageName: imageName || savedContext?.lastImageName || ""
    });

    const logKey = `logs/chat-${started.chatId}.json`;
    await store.setJSON(logKey, {
      timestamp: new Date(startedAt).toISOString(),
      startedAt,
      completedAt: null,
      durationMs: null,
      status: started.status,
      experimentRunId: RUN_ID,
      studentId,
      botId: BOT_ID,
      conversationId: started.conversationId,
      chatId: started.chatId,
      cozeLogId: started.cozeLogId,
      message,
      imageKey,
      imageName,
      imageUrl: effectiveImageUrl,
      flowImageParam: FLOW_IMAGE_PARAM,
      flowTextParam: FLOW_TEXT_PARAM,
      assistantMessage: "",
      level: "",
      usage: null,
      error: "",
      newSession
    });

    const jobToken = issueSignedToken({
      kind: "chat-job",
      studentId,
      chatId: started.chatId,
      conversationId: started.conversationId,
      logKey
    }, 20 * 60 * 1000);

    res.status(202).json({
      ok: true,
      status: started.status,
      jobToken,
      chatId: started.chatId,
      conversationId: started.conversationId
    });
  } catch (err) {
    console.error(err);
    jsonError(res, 500, err.message || "服务器错误");
  }
};
app.post(["/chat/start", "/api/chat/start"], upload.single("image"), chatStartHandler);

const chatStatusHandler = async (req, res) => {
  try {
    ensureConfig();
    const job = verifySignedToken(String(req.query.job || ""));
    if (!job || job.kind !== "chat-job") return jsonError(res, 401, "本轮对话查询已失效，请重新开始");

    let log;
    try { log = await store.get(job.logKey, { type: "json", consistency: "strong" }); }
    catch { log = null; }

    if (log?.status === "completed" && log?.assistantMessage) {
      return res.json({
        ok: true,
        done: true,
        status: "completed",
        assistantMessage: log.assistantMessage,
        conversationId: job.conversationId,
        chatId: job.chatId
      });
    }

    const detail = await retrieveCozeChat(job.conversationId, job.chatId);
    const status = String(detail?.status || "unknown");
    const now = Date.now();

    if (["created", "in_progress"].includes(status)) {
      if (log) {
        await store.setJSON(job.logKey, {
          ...log,
          status,
          usage: detail?.usage || log.usage || null,
          cozeLogId: detail?.cozeLogId || log.cozeLogId || "",
          lastPolledAt: new Date(now).toISOString()
        });
      }
      return res.status(202).json({ ok: true, done: false, status });
    }

    if (status !== "completed") {
      const lastError = detail?.last_error;
      const error = lastError?.msg
        ? `${lastError.msg}${lastError.code ? ` (code ${lastError.code})` : ""}`
        : `智能体本轮状态：${status}`;
      if (log) {
        await store.setJSON(job.logKey, {
          ...log,
          status,
          error,
          completedAt: new Date(now).toISOString(),
          durationMs: log.startedAt ? now - log.startedAt : null,
          usage: detail?.usage || log.usage || null,
          cozeLogId: detail?.cozeLogId || log.cozeLogId || ""
        });
      }
      // 避免失败会话继续污染下一轮；下次从开始页重新建立 conversation。
      await saveStudentContext(job.studentId, { conversationId: "", lastChatId: job.chatId });
      return jsonError(res, 500, error);
    }

    const answer = await getCozeAnswer(job.conversationId, job.chatId);
    if (!answer.assistantMessage) return jsonError(res, 500, "智能体已完成本轮对话，但未获取到最终回复");

    const levelMatch = answer.assistantMessage.match(/\bLevel\s*([123])\b/i);
    const completedAt = Date.now();
    const finalLog = {
      ...(log || {}),
      timestamp: log?.timestamp || new Date().toISOString(),
      status: "completed",
      completedAt: new Date(completedAt).toISOString(),
      durationMs: log?.startedAt ? completedAt - log.startedAt : null,
      experimentRunId: RUN_ID,
      studentId: job.studentId,
      botId: BOT_ID,
      conversationId: job.conversationId,
      chatId: job.chatId,
      cozeLogId: answer.cozeLogId || detail?.cozeLogId || log?.cozeLogId || "",
      assistantMessage: answer.assistantMessage,
      level: levelMatch ? levelMatch[1] : "",
      usage: detail?.usage || log?.usage || null,
      error: ""
    };
    await store.setJSON(job.logKey, finalLog);

    return res.json({
      ok: true,
      done: true,
      status: "completed",
      assistantMessage: answer.assistantMessage,
      conversationId: job.conversationId,
      chatId: job.chatId
    });
  } catch (err) {
    console.error(err);
    jsonError(res, 500, err.message || "查询智能体状态失败");
  }
};
app.get(["/chat/status", "/api/chat/status"], chatStatusHandler);

// 旧前端若仍命中 /api/chat，明确提示刷新，避免继续执行旧的 120 秒同步等待逻辑。
app.post(["/chat", "/api/chat"], upload.single("image"), (req, res) => {
  res.status(409).json({ error: "客户端版本已更新，请刷新页面后重新开始对话" });
});

const loginHandler = (req, res) => {
  try {
    if (!ADMIN_PASSWORD || !ADMIN_SECRET) return jsonError(res, 500, "管理员环境变量未配置");
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
      ["timestamp","completedAt","durationMs","status","experimentRunId","studentId","botId","conversationId","chatId","cozeLogId","level","message","imageName","imageKey","imageUrl","flowImageParam","flowTextParam","assistantMessage","error"],
      ...logs.map(x => [
        x.timestamp,x.completedAt,x.durationMs,x.status,x.experimentRunId,x.studentId,x.botId,x.conversationId,x.chatId,x.cozeLogId,x.level,
        x.message,x.imageName,x.imageKey,x.imageUrl,x.flowImageParam,x.flowTextParam,x.assistantMessage,x.error
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
    cozeMode: "bot-conversation-flow-parameters-async",
    botConfigured: Boolean(BOT_ID),
    tokenConfigured: Boolean(TOKEN),
    asyncPolling: true,
    flowImageParam: FLOW_IMAGE_PARAM,
    flowTextParam: FLOW_TEXT_PARAM || null,
    experimentRunId: RUN_ID
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return jsonError(res, 400, "图片不能超过 5MB");
  jsonError(res, 400, err?.message || "请求失败");
});

export default app;
