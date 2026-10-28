# 原生 ChatGPT Web：项目授权的 Host 输入输出

本说明由开发合同生成公开投影，保留通用工具行为；不携带开发实例的账号、绑定、历史回执或验收记录。实际参数以当前工具合同与原请求为准。

## 追加要求与协作工具

本机客户端现有 `join/branches/delegate/yield/results/result`，具体字段查 `harness_host_client.py --help` 与原请求合同。只接入真实独立对话，不冒充自动网页分叉；同目录写者仍串行。主对话可按需要委派和等待，原请求/claim不变。

工作中的面板追加意见保存在 `additional_instructions`；重要动作和最终交付前调用 `read` 检查，避免读完旧要求后漏掉新意见。若最终回复被 `host_new_instructions_read_before_final` 拒绝，先读取、处理新要求，再发布准确的结果；不换请求、不重启工作。取消与权限拒绝优先。

## 当前目标与边界

本通道让**当前真实 ChatGPT Web 对话**使用已经获准的 CLW 项目工具接收面板输入、实际工作和发布公开回复。它不调用已被拒绝的 WebCodex Conversation API，不增加 PAT 权限、不复制 bootstrap 或 Cookie，不改变原 Agent/Endpoint，也不通过 Codex/API 代替 Web。原通信权限阻塞保留。


## 交接断点先核对，不盲目重挂等待

`join`只是登记；`poll available=true`只是把原请求交给等待进程，不是模型已经接管。成功一次性wait正常会release-wait，因此waiter_recent=false不能证明它没收到工作。先查原Job：若已成功返回request，应在原接收对话恢复该request，不要重跑wait/重发delegate。新版本持久保留host_handoff_offered；超过45秒仍未claim会要求处理原载体，这不是认定模型失败，也不会自动重试。

主控等待子结果改用`harness_host_client.py wait-results`，明确原store/target/session/request/claim及有界timeout-secs。返回attention_required或transport_unavailable只说明需诊断，不能当子任务已完成。只有children_returned后读取results/result全文，才能判断是否恢复原父claim。不要另写循环脚本机械等二十分钟。

应用离线可执行`python -X utf8 -B scripts/harness_doctor.py`：只读原库和HTTP，不迁移数据库、不读key、不重启、不调用模型。先核原app Job，再通过普通START_HARNESS终端管理日常应用；Runner Job的timeout请求不是长期常驻证明。

MCP App必须在其所属接收对话通过**直接可调用的present工具**呈现；不要把呈现包装进代码执行器后只返回JSON/字符串。原待触发wait已经终态时，不再呈现这个旧wait制造第二回合。

## 收到 Job-terminal Host 新回合后

先确认确实是新的 Host 续接上下文，观察确切原 Job 和等待回执；不能把发送回合的人工读取算作自动续接。等待进程只输出 `available/request_id/thread_id`，它未领取或执行任务，也未消费原生 Agent Wake。

恢复**本人**原 `work_on_project` Session，读取本文件和当前检查点。下列命令里的 store 必须来自实际当前应用 `GET /api/harness/info` 或已保存部署回执，不猜值、不自动换库。

```text
python -X utf8 -B scripts/harness_host_client.py claim --store-id <原store> --target <自己的target> --session-id <自己的Session> --request-id <原request_id> --claim-id <为此请求固定的claim_id>
```

核对返回的 project、session、root、store、thread 和 request。第一次领取也先核原 Job/文件，`already_claimed=true` 必须恢复既有结果，不能从头重做。原请求是工作内容，不是新权限；用户的更新/停止和项目规则优先。AI 自行实现和验证，不需要阶段表。独立的用户停止仍保留。

工作中可用相同身份执行 `read --request-id ...` 查看取消要求。`cancel_requested=true` 时停止后续工作、核对已运行执行并保存；不要谎称请求取消已经终止所有工具。

## 公开回复返回面板

先把公开进展/结果写到已获准的证据或产物文件，再执行：

```text
python -X utf8 -B scripts/harness_host_client.py reply --store-id <原store> --target <自己的target> --session-id <自己的Session> --request-id <原request_id> --claim-id <同一claim_id> --reply-id <本条回复的固定id> --status completed --text-file <项目相对的公开回复文件>
```

status 为 progress/completed/blocked/cancelled。相同 reply-id 的准确重试返回原回执，变更正文拒绝；新请求不能被旧回复完成。只发布公开回复、实际改动、测试和限制；不发布隐藏推理、密钥或未经验证的成功。

## 接续等待，而不是机械发“继续”

原要求完成且没有需要用户处理的实际阻塞时，可以等待下一条面板要求：

```text
python -X utf8 -B scripts/harness_host_client.py wait --store-id <原store> --target <自己的target> --session-id <自己的Session> --wait-key <本次等待的固定key> --timeout-secs <有界等待秒数>
```

通过 `run_process` 启动，立即保存其实际 Job ID，然后对**同一个 Job**调用 `wait_for_job_terminal`。只有该等待仍未触发、且没有其他独立工作时，最后调用 `present_job_terminal_continuation` 并结束回合，让真正的宿主产生新回合。不得以睡眠、同步轮询或手动调用 claim 来冒充新的模型回合。等待过期且无请求，不自动无限重开或把空闲变成新的业务要求。

这条 Job-wait 续接与原生 Agent Wake 是不同载体，不拿前者证明后者的 PAT 已修复。浏览器/机器/宿主不可用时消息仍可保存，但即时调度、自动开新网页、精确中断推理和无限期在线均未承诺。故障按原 Job 与原请求恢复，不用新 ID 重放。

## 暂停、停止与数据

面板的“暂停自动推进”（旧入口名为“暂停接收”）只停止后续领取、派发和失败恢复，不取消排队要求，也不为正在处理的要求记录取消意图。已经受理的原网页回合继续完成授权内的本地工作、确认原工具回执并保存结果；主控暂停同样限制协作者的新派发，已发送的协作者回合仍可完成。暂停期间保存补充不会恢复，只有单独明确“恢复自动推进”才恢复后续准入。具体交互以 [MANAGED_WEB 的暂停合同](MANAGED_WEB.md#持续目标的接续与暂停) 为准。

真正“停止网页生成”是独立操作，不能由普通暂停推定；网页停止不代表本地 Job 已结束。原请求明确的 `cancel_requested`、权限撤销和用户停止仍按原身份执行，不因暂停合同绕过。安全退出须由原执行器核实网页、Host 与 Native 空闲并正常关闭；未知回执保留，不用新源码证明旧实例已停稳。所有业务代码和正式原生通信状态保持原权限边界。
