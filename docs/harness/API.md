# Harness 本机适配接口 · v0.7 alpha

## Web 故障恢复伴侣

已配对的chatgpt_web_host线程提供GET recovery?thread_id=...、command recovery.pair（两分钟单次配对码）和recovery.disable。本机普通页面不得直接产生模型恢复确认。

/api/harness/recovery-wire仅接受合法扩展Origin：pair通过单次码绑定准确ChatGPT URL；后续需要该绑定专用token。status/observe/dispatch/finish均为严格小JSON合同，没有任意URL、Shell、领取/回复或Host-key接口。一次错误的dispatch提交后不允许再发，pending/unknown单独核对；sent不是模型已启动，私有Host recover才记录恢复确认。原请求和claim从未重置。原生通信scope和身份隔离不变。

使用与实际验收边界见WEB_RECOVERY.md、RECOVERY_RECEIVER.md。当前实际登录网页自动恢复尚未通过，不能把隔离DOM/worker测试当作上线证据。

## Project Host 通道（独立于 Native Conversation）

`GET /api/harness/host`仅显示显式本机配对及等待器最近观察。provider为chatgpt_web_host的线程，message.send返回queued_for_web_host，thread.sync仅核本机请求状态，host.pause/host.resume控制接收，不会伪造原生interrupt/fork。原native_web通道的权限失败原样保留，不自动重试或偷换身份。

`POST /api/harness/host-control`只供受信任项目进程使用：仍限制loopback/同Origin/体积，另需本机私有X-CLW-Host，不接受浏览器X-CLW-Intent替代。register/poll/claim/read/reply/release-wait均核store、配置target、冻结Session和原请求/claim/reply身份。key由CLW生成，存在已忽略的.local/harness，仅客户端内部读取、不打印。它不认证OpenAI账号；公开模型回复的实际来源由调用链与Host实测证明。

各模型载体的原生历史和执行权威保持。这个本机邮箱只存请求与回执，不读取被拒的原Conversation、也不替程序生成模型结果。具体命令和接收规则见HOST_RECEIVER.md。


## Native Web 提供者增量

`GET /api/harness/web`返回保留的访问观察、检查时间、目标目录及缺少的scope，不自动重试已知拒绝。
`POST command action=web.probe data={authorization_changed:boolean}`只在操作者确认原正式授权变化后重新读取原连接引用；通过相同原生目标核验后才采用，不替换未决发送的主体。
`POST command action=web.attach data={target_id,confirm:true}`绑定config/harness-web-targets.json中明确配置的已有原生Agent/Conversation；不新建网页、不旋转Endpoint、不解除旧任务暂停。首个真实发送仍由后端独立检查manage权限。

对native_web线程，message.send保存全文和原请求，投递短通知；state=message_posted_not_completed。`GET web-request?request_id=...&store_id=...`只返回已具有原native receipt的完整要求，供真实接收者在普通工程授权后读取。thread.sync读取该原房间的增量公开回复；后台观察线程也只读这些已明确绑定的未完成请求。

只有同一原生Agent署名、相同store/request以及reply_to原Message的clw.web.reply.v1正文被展示为AI公开回复。progress、completed、blocked为AI报告；完成不等于独立审查或用户品质验收。消息/事件原ID去重，未知投递不按正文相似恢复或换键重发。Web等待期间阻止同工程面板Codex另起并发写者；这不是对外部未参与面板的会话提供OS沙箱。

Web不支持当前Codex的thread.fork/turn.stop/message.steer；这些动作明确拒绝、不转发给其他provider。原生停止仍由原页面或确切Job执行。所有Web故障保持原执行和旧草稿。正式权限修复见WEB_CONNECTION.md和WEB_ACCESS_REPAIR_REQUEST.md。


本接口组织已经授权的运行时，不是新的模型循环或任意Shell代理。初版服务只绑定启动时的CLW工程，HTTP只监听loopback；任何其他项目都需要后续明确注册/接入。网页、CLI或其他harness可以使用同一JSON边界，不需要把Codex原生线程复制成第二套任务账本。

## 读取

`GET /api/harness/info` 返回实例、store、当前根、每个provider的真实能力和临时本机CSRF intent。intent仅留本机进程/页面内存，不写日志、Git或外发。

`GET /api/harness/threads` 返回本应用绑定的原生线程，不扫描其他账户历史。

`GET /api/harness/events?thread_id=...&after=...` 返回有序有界的公开增量事件以及下次游标；读取失败保留原游标，不当作空历史。隐藏推理和认证内容不投影。

`GET /api/harness/receipt?request_id=...` 核对原应用请求，不重发模型工作。

`GET /api/harness/diff?thread_id=...` 读取当前工程已跟踪差异；不是当前线程专属差异，也不修改Git。

`GET /api/harness/artifacts?thread_id=...` 列出该线程native fileChange中的可核产物引用；`artifact?thread_id=...&artifact_id=...` 读取符合路径、链接/普通文件、大小和文本规则的当前字节。

`GET /api/harness/approvals?thread_id=...` 读取本实例确切待审批。`GET /api/harness/web` 只检查原WebCodex连接的实际授权，不替换主体或启用发送。

## 操作

`POST /api/harness/command`，JSON内容、与监听端口一致的Origin，以及当前 `X-CLW-Intent` 必须齐全。请求格式：

```json
{
  "request_id": "stable-original-uuid-per-action",
  "action": "message.send",
  "thread_id": "hthr_actual_id",
  "data": {"text": "完整但相关的目标与约束"}
}
```

操作限定为 `provider.connect`、`thread.create`（title）、`thread.fork`（父thread_id与title）、`thread.sync`、`message.send`、`message.steer`（text及expected_turn_id）、`turn.stop`、`approval.respond`（approval_id/decision）。不接受任意方法名、cwd、可执行文件或模型提供方注入。

发送者必须先持久保存原请求ID、参数、store与接收目标；结果未知先GET原receipt，不能换ID重发。同ID不同参数拒绝；相同请求返回原回执。`accepted_not_completed`只是原生turn已接受；`stop_requested_not_terminal`只是停止已请求。实际完成/中断以原生事件和读取为准。

`message.steer` 只针对调用者看到的 `expected_turn_id`，返回 `steered_not_completed`；不暗中创建新回合或更改模型配置。停止和追加需要同一回合的 `turn/started` 观测，最多等待5秒；未观测到则在发出控制请求前拒绝。已自然完成返回 `already_terminal`，不是停止成功。`thread.sync` 返回 `state_applied`：当只读历史比当前执行旧或读取期间状态变化时，保留当前执行状态，不以旧完成记录解除互锁。

Codex transport 使用已安装 App Server JSONL。该运行时拥有原生历史、工具、模型和审批；本应用只保存绑定/父子关系/公开事件/请求回执。原生Web继续使用WebCodex已有通信对象；当前面板发送未开放，不以Codex可用冒充Web连通。Pi/ACP等后续实现相同应用级语义，仍须分别协商其协议和认证，不根据可执行文件存在就宣称兼容通过。

同根目录的面板管理turn暂时串行，独立工作树适配后才能真正开放安全并行写入。底层允许并发RPC，不代表不同AI可以无协调地改同一文件。业务计划、分支数量、审查方式与整合策略仍由AI决定。
