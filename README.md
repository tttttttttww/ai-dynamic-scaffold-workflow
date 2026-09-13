# ⚠️ v2 Parameters Fix（2026-09-13）

本版针对 Coze 返回 `The input parameters provided to the model are invalid. (code 4000)`：在保留图片多模态消息的同时，将外层**对话流开始节点**所需的图片自定义参数通过 `/v3/chat` 的顶层 `parameters` 传入。详见 `PARAMETERS_FIX.md`。

默认 `COZE_FLOW_IMAGE_PARAM=program_image`；文本默认走对话流内置 `USER_INPUT`，只有外层开始节点另有必填 String 自定义参数时才配置 `COZE_FLOW_TEXT_PARAM`。

---

# AI 动态学习支架（Bot + 图片 URL + 异步轮询版）

本版针对“Coze 正式体验页能完成，但网站 API 一直停在 `in_progress`”做了两项核心修复，并顺带移除了 120 秒同步等待限制。

## 核心修复

1. **图片改为 `file_url` 传给 Bot**
   - 学生图片仍保存在 EdgeOne Blob。
   - 后端为图片生成一个带 HMAC 签名、12 小时有效的 HTTPS 地址。
   - `/v3/chat` 的多模态消息使用 `file_url`，让 Bot 后续调用内部工具时可以直接拿到图片 URL。
   - 不再依赖 Coze `file_id` 做这一层传递。

2. **每次从“开始检查程序”进入都强制新建 conversation**
   - 同一个学生编号重新开始时，不再复用历史测试 conversation。
   - 同一轮后续文字追问仍继续使用本轮新 conversation。

3. **改成异步轮询**
   - `/api/chat/start` 只负责发起 Coze 对话，立即返回。
   - 浏览器每 2 秒调用 `/api/chat/status` 查询状态。
   - 最多可等待 8 分钟，不再受 EdgeOne 单次函数 120 秒限制。
   - 日志从发起时就写入，完成后更新为 `completed`。

## 腾讯云环境变量

保持这 5 个即可：

- `COZE_ACCESS_TOKEN`
- `COZE_BOT_ID`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `EXPERIMENT_RUN_ID`

无需 Workflow ID。

## Coze 权限

本版需要：

- 发起对话 `chat`
- 查询对话 `getChat`
- 查询消息 `listMessage`

因为图片改为网站自己的临时 HTTPS URL，本版不再必须调用 Coze 上传文件接口；已有 `uploadFile` 权限保留也没有影响。

## 部署后检查

访问：

`/api/health`

应看到：

```json
{
  "ok": true,
  "cozeMode": "bot-file-url-async",
  "botConfigured": true,
  "tokenConfigured": true,
  "asyncPolling": true
}
```

测试时推荐打开：

`/?debug=1`

如果失败，学生页面会显示真实错误信息。
