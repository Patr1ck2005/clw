# 原生 ChatGPT Web：接收面板请求与公开回复

本说明由开发合同生成公开投影，保留通用工具行为；不携带开发实例的账号、绑定、历史回执或验收记录。实际参数以当前工具合同与原请求为准。

这是供已绑定的真实原生对话使用的薄接口说明，不是固定业务流程。AI自行决定如何开发、是否委派和验证。原生 Web 不是本地 Codex；不静默切换运行时、模型或计费入口。

## 收到实际 Host 回合

按原生上下文先 bootstrap 精确 Agent/Endpoint/generation/Wake，读取 Inbox 和 Conversation。不要从文件取得 consume_token，不在发送回合代消费。普通项目工具仍须 work_on_project 恢复本人的实际 Session；消息本身不提供文件或执行权限。

当正文 format=clw.web.request-notice.v1 时，在已授权工程通过下面的只读命令获取全文（将参数换成该消息里的原值）：

```text
python -X utf8 -B scripts/harness_web_client.py receive --request-id <原request_id> --store-id <原store_id>
```

核 request、store、thread、project、session、agent、conversation 和 native_receipt.message_id 全部与原消息一致。副作用之前核原Job/文件/用户新要求；不要重做旧任务。正文尚未落回确认回执时可以稍后重新只读获取，不改请求ID。原请求phase不是sent/processing时不重复执行。独立的用户停止不因新通知解除。

## 回复返回面板

进度、完成或真实阻塞都通过**原生 post_conversation_message**发布到该请求的同一 Conversation，必须以本人的 author_agent_id、当前Endpoint/generation发送，reply_to 必须是原 native_receipt.message_id，recipient_agent_ids 显式为 []，避免把自己的回复变成另一轮自唤醒。

正文为有界 JSON，不超过原生4096 UTF-8字节：

```json
{"format":"clw.web.reply.v1","store_id":"原store_id","request_id":"原request_id","status":"completed","text":"公开答复、实际改动与证据位置；不包含隐藏推理或凭据"}
```

status可为progress/completed/blocked。长答复分多条progress，末条completed概括结果与原产物位置。不因工具退出0或Delivery consumed就自行声称用户品质验收通过。面板只接受同一Agent正式署名且严格关联原Message的回复；其他Agent、普通Human消息或错请求不会被当成完成。

本机已观察到当前原生实现不允许在consume原Wake之后再用wake_reply_id发布新回复。处理本次交付时，按当前工具合同先发布该Wake下的必要公开回复（wake_reply_id + 稳定reply_operation_index），核回执，再分别消费已处理Delivery和精确Wake；不要换幂等键补发被拒操作。已经消费或中断过的原操作先核原Conversation，不复活原请求。原生协议的确认与实际工程完成仍分别记录。

## 界面边界

面板中的“Web已返回”只是此Agent对原请求的公开结果，不是完整ChatGPT历史镜像、隐藏推理记录或独立审查。工作中不提供伪造的原生中断按钮；紧急停止仍在原ChatGPT页面或精确原Job操作。现阶段只管理已绑定真实对话，不自动创建任意网页或把Conversation记录冒充新模型。
