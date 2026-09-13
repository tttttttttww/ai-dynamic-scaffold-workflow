# 本版修复：Coze 对话流自定义参数（code 4000）

## 现象

网页 `/api/chat/start` 能成功返回，浏览器随后轮询 `/api/chat/status`，但 Coze 对话最终失败并返回：

`The input parameters provided to the model are invalid. (code 4000)`

这说明“网页 -> 自己的后端 -> Coze 发起对话”已经能走通，错误发生在 Coze 处理本轮对话/对话流节点时。

## 根因方向

当前智能体使用外层“对话流”时，开始节点中的自定义参数必须通过 `POST /v3/chat` 请求体顶层的 `parameters` 传入。

上一版只把图片放进了 `additional_messages`（让智能体能看见图片），却没有把同一张图片赋值给对话流开始节点的自定义 Image 参数。因此如果外层流程要求 `program_image`，内部节点拿到的是空值/非法值，就可能出现 code 4000。

## 本版做了什么

1. 保留上一版已经稳定的“新会话 + 异步轮询”结构。
2. 图片仍通过 `additional_messages` 以多模态消息传给智能体。
3. 同时通过顶层 `parameters` 把图片 HTTPS URL 赋给 `COZE_FLOW_IMAGE_PARAM`。
4. 默认图片变量名为 `program_image`。
5. 后续纯文字追问仍会把最近一次截图重新传给图片参数，避免必填 Image 参数在后续轮次变空。
6. 文本默认只走 `USER_INPUT`。若外层对话流还有自定义必填文本参数，可用 `COZE_FLOW_TEXT_PARAM` 指定。
7. 日志和 CSV 会记录实际使用的参数名，方便排查，但不会记录 Token。

## EdgeOne 环境变量

保留：
- `COZE_ACCESS_TOKEN`
- `COZE_BOT_ID`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`
- `EXPERIMENT_RUN_ID`

新增：
- `COZE_FLOW_IMAGE_PARAM=program_image`
- `COZE_FLOW_TEXT_PARAM=`

### 只有一种情况需要改 `COZE_FLOW_TEXT_PARAM`

打开 **外层对话流 -> 开始节点**：
- 如果只有 `USER_INPUT` + `program_image`：保持空白；
- 如果另有一个必填 String 参数，且名字确实是 `student_answer`：设置 `COZE_FLOW_TEXT_PARAM=student_answer`；
- 如果变量名不同：必须填外层开始节点显示的准确英文变量名。

## 测试

部署后：
1. 打开网页，输入学生编号；
2. 上传当前程序截图；
3. 点击开始检查；
4. 打开开发者工具 Network；
5. `start` 应返回 202；
6. `status` 应经历 202 后返回 200 + `assistantMessage`。

如果仍返回 code 4000，请不要继续改网页 UI。下一步只需要截图 **外层对话流的开始节点（输入参数）** 和失败节点的输入/输出，即可确认是变量名、变量类型还是某个模型节点参数的问题。
