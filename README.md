# AI Dynamic Scaffold · Bot API 版

这是当前建议部署版本：网页只调用 Coze 智能体（Bot），Bot 内部继续运行已配置好的对话流/工作流。

## 功能

- 学生匿名编号（如 S01）
- 第一轮上传程序截图 + 文字，可继续多轮文字对话
- 图片先上传 Coze，再通过 `/v3/chat` 发送给 Bot
- 同一学生、同一 `EXPERIMENT_RUN_ID` 自动续接同一 conversation
- EdgeOne Blob 持久保存截图、会话上下文和交互日志
- 管理后台查看日志、查看截图、导出 CSV
- `/api/health` 可检查 Bot 与 Token 是否配置
- 测试时访问首页加 `?debug=1`，前端会显示真实后端错误；正式给学生的网址不要加这个参数

## 腾讯云环境变量

必须配置：

```text
COZE_ACCESS_TOKEN=你的 Coze 服务身份凭证
COZE_BOT_ID=7652241106834472996
ADMIN_PASSWORD=你自己设置的管理员密码
ADMIN_SESSION_SECRET=至少 32 位随机字符串
EXPERIMENT_RUN_ID=pilot01
```

### Coze 服务身份权限

至少需要：

- `chat`：调用 `/v3/chat`
- `uploadFile`：上传学生截图

Bot 及其内部使用的对话流/工作流需要已经发布，并且此凭证对 Bot 所在空间有访问权限。

## EdgeOne 构建设置

```text
框架预设：Other
根目录：./
输出目录：public
构建命令：留空
安装命令：npm install
生产分支：main
```

## 重要：实验批次

每次新的预实验或正式实验建议修改：

```text
EXPERIMENT_RUN_ID=pilot02
```

服务器会按批次隔离学生的 conversation，避免 S01 在新一轮实验中接着上一轮的聊天记录。

## 路径

- `/` 学生端
- `/admin.html` 管理后台
- `/api/chat` Bot 对话接口
- `/api/admin/logs` 日志
- `/api/admin/export` CSV
- `/api/health` 健康检查


## 2026-09-12 长耗时对话流修复

如果 `/api/chat` 返回 `智能体本轮状态：in_progress`，说明 Bot 已经成功接收请求，但其内部对话流/工作流在旧版约 45 秒等待窗口内尚未完成。

本版将：
- EdgeOne Cloud Functions `maxDuration` 从 60 秒提高到 120 秒；
- Bot 状态轮询窗口提高到约 105 秒；
- 每 1.5 秒查询一次状态，并为最终消息读取保留约 15 秒缓冲。

如果 105 秒后仍持续 `in_progress`，应进一步优化 Coze 工作流耗时，或改造成前端异步轮询模式。
