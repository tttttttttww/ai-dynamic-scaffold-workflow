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
const WORKFLOW_ID = process.env.COZE_WORKFLOW_ID;
const WORKFLOW_TEXT_PARAM = process.env.COZE_WORKFLOW_TEXT_PARAM || "student_answer";
const WORKFLOW_IMAGE_PARAM = process.env.COZE_WORKFLOW_IMAGE_PARAM || "program_image";
const WORKFLOW_OUTPUT_PARAM = process.env.COZE_WORKFLOW_OUTPUT_PARAM || "final_feedback";
const WORKFLOW_APP_ID = process.env.COZE_APP_ID || "";
const WORKFLOW_BOT_ID = process.env.COZE_WORKFLOW_BOT_ID || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET;
const RUN_ID = process.env.EXPERIMENT_RUN_ID || "default";

function ensureConfig() {
  if (!TOKEN) throw new Error("COZE_ACCESS_TOKEN 未配置");
  if (!WORKFLOW_ID) throw new Error("COZE_WORKFLOW_ID 未配置");
}
function safeId(v) {
  return String(v || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 30);
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
    const logid = data?.detail?.logid ? ` [logid: ${data.detail.logid}]` : "";
    throw new Error((data.msg || data.message || `Coze 请求失败 (${res.status})`) + logid);
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

function parseWorkflowData(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { __raw: text }; }
}

function pickWorkflowText(rawData) {
  const data = parseWorkflowData(rawData);
  const candidates = [
    data?.[WORKFLOW_OUTPUT_PARAM],
    data?.final_feedback,
    data?.result,
    data?.output,
    data?.answer,
    data?.content,
    data?.__raw
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const value of Object.values(data || {})) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function runCozeWorkflow({ studentId, message, imageFileId }) {
  ensureConfig();

  const parameters = {};
  parameters[WORKFLOW_TEXT_PARAM] = message || "请根据当前程序截图继续给我学习支架。";
  if (imageFileId && WORKFLOW_IMAGE_PARAM) {
    // Coze Workflow 的 Image 参数用 {"file_id":"..."} 的 JSON 字符串传入。
    parameters[WORKFLOW_IMAGE_PARAM] = JSON.stringify({ file_id: imageFileId });
  }

  const body = {
    workflow_id: WORKFLOW_ID,
    parameters,
    ext: { user_id: `study_${studentId}` }
  };
  if (WORKFLOW_APP_ID) body.app_id = WORKFLOW_APP_ID;
  if (WORKFLOW_BOT_ID) body.bot_id = WORKFLOW_BOT_ID;

  const result = await cozeFetch(`${COZE_BASE}/v1/workflow/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const assistantMessage = pickWorkflowText(result?.data);
  if (!assistantMessage) {
    throw new Error(`工作流已执行，但未找到输出字段 ${WORKFLOW_OUTPUT_PARAM}`);
  }

  return {
    assistantMessage,
    executeId: result?.execute_id || "",
    debugUrl: result?.debug_url || "",
    usage: result?.usage || null,
    cozeLogId: result?.detail?.logid || ""
  };
}

async function getStudentContext(studentId) {
  try {
    return await store.get(`context/${studentId}.json`, { type: "json", consistency: "strong" });
  } catch {
    return null;
  }
}

async function saveStudentContext(studentId, context) {
  await store.setJSON(`context/${studentId}.json`, {
    ...context,
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
    blobs.slice(-1000).map(async ({ key }) => {
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
    let reusedImage = false;

    if (req.file) {
      const ext = extFromMime(req.file.mimetype);
      imageKey = `images/${studentId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
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

      await saveStudentContext(studentId, { imageFileId, imageKey, imageName });
    } else {
      const context = await getStudentContext(studentId);
      if (context?.imageFileId) {
        imageFileId = String(context.imageFileId);
        imageKey = String(context.imageKey || "");
        imageName = String(context.imageName || "");
        reusedImage = true;
      }
    }

    if (WORKFLOW_IMAGE_PARAM && !imageFileId) {
      return jsonError(res, 400, "请先上传程序截图，再开始与小助手对话");
    }

    const result = await runCozeWorkflow({
      studentId,
      message,
      imageFileId
    });

    const levelMatch = result.assistantMessage.match(/\bLevel\s*([123])\b/i);

    const log = {
      timestamp: new Date().toISOString(),
      experimentRunId: RUN_ID,
      studentId,
      workflowId: WORKFLOW_ID,
      workflowExecuteId: result.executeId,
      workflowDebugUrl: result.debugUrl,
      cozeLogId: result.cozeLogId,
      message,
      imageKey,
      imageName,
      imageFileId,
      reusedImage,
      assistantMessage: result.assistantMessage,
      level: levelMatch ? levelMatch[1] : "",
      usage: result.usage
    };

    const logKey = `logs/${Date.now()}-${studentId}-${crypto.randomUUID()}.json`;
    await store.setJSON(logKey, log);

    res.json({
      ok: true,
      assistantMessage: result.assistantMessage,
      workflowExecuteId: result.executeId,
      contextReady: Boolean(imageFileId)
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
      ["timestamp","experimentRunId","studentId","workflowId","workflowExecuteId","cozeLogId","level","message","imageName","imageKey","imageFileId","reusedImage","assistantMessage","workflowDebugUrl"],
      ...logs.map(x => [
        x.timestamp,x.experimentRunId,x.studentId,x.workflowId,x.workflowExecuteId,x.cozeLogId,x.level,
        x.message,x.imageName,x.imageKey,x.imageFileId,x.reusedImage,x.assistantMessage,x.workflowDebugUrl
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
    cozeMode: "workflow",
    workflowConfigured: Boolean(WORKFLOW_ID)
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err?.code === "LIMIT_FILE_SIZE") return jsonError(res, 400, "图片不能超过 5MB");
  jsonError(res, 400, err?.message || "请求失败");
});

export default app;
