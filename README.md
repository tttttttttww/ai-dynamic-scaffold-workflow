# AI 动态学习支架（Coze Workflow 版）

这一版已经从旧的 **Bot Chat API (`/v3/chat`)** 改为 **Workflow API (`/v1/workflow/run`)**。

## Coze 授权（最小权限）

给腾讯云后端使用的服务身份凭证，只需要授权：

1. **工作流 → run**（运行已发布工作流）
2. **文件 → uploadFile**（把学生截图上传到 Coze）

资源范围只选“当前工作流所在空间”即可。知识库检索发生在工作流内部，不需要网站另外调用知识库 OpenAPI。

## 腾讯云环境变量

复制 `.env.example` 中的变量。必填：

- `COZE_ACCESS_TOKEN`
- `COZE_WORKFLOW_ID`
- `COZE_WORKFLOW_TEXT_PARAM`（默认 `student_answer`）
- `COZE_WORKFLOW_IMAGE_PARAM`（默认 `program_image`）
- `COZE_WORKFLOW_OUTPUT_PARAM`（默认 `final_feedback`）
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

如果工作流属于“扣子应用”，再填 `COZE_APP_ID`；如果 Coze 试运行明确要求关联智能体，再填 `COZE_WORKFLOW_BOT_ID`。

## 图片与多轮交互

学生第一次必须上传程序截图。后端会：

1. 保存截图到 EdgeOne Blob；
2. 上传到 Coze，得到 `file_id`；
3. 运行工作流；
4. 后续学生只输入文字时，自动复用该学生最近一次截图的 `file_id`；
5. 学生重新上传截图时，用新截图替换上下文。

因此不再使用旧 Bot 的 `conversation_id` / `chat_id`。

## 工作流输入输出

默认按截图中的工作流：

- Image 输入：`program_image`
- 文本输入：`student_answer`
- 结束节点文本输出：`final_feedback`

若你实际部署的是另一个外层工作流，在腾讯云修改这三个参数名即可，无需改代码。
