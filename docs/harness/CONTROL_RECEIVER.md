# CLW Web Companion：历史控制合同与 0.5.0 兼容说明

> 当前正常入口：`AUTONOMOUS_RUN_RECEIVER.md` 与 `../handoffs/AUTONOMOUS-LOW-COST-TEST.md`。统一 Companion 0.5.0 / control protocol 4 在0.4.0 browser-native结果回传基础上增加后台 exact-page transport：浏览器必须存在，但窗口不要求置顶/foreground；已enroll或已知精确页可由service worker自动绑定/恢复。未知ChatGPT页保持被动。本页下方0.2.x/0.3.x为历史兼容说明。

本指南针对统一的 Web Companion 0.2.1。它直接升级原 Recovery Companion 0.1.1 的安装路径，并合并原请求接管与明确生成失败恢复；拆分的 Control Companion 0.1.0 不再作为用户安装入口。默认不接管未登记聊天；它保留原Workflow Session、request、claim、Job与A/B归属，不创建模型、不访问Cookie/私有聊天接口，也不能证明实际模型计费。实现计划见CONTROL_IMPLEMENTATION_PLAN.md。

## 一、正常应用生命期

日常从普通Windows终端运行项目根目录 `START_HARNESS.cmd`。现在它以前台方式启动 `scripts/harness_launcher.py run --open`，这个启动终端必须保留。监督器取得kernel锁，仅管理自己spawn的CLW应用；没有安装服务或逃逸Runner的时限。不要用一个有界run_process/run_detached_process再声称实现永久在线。

另一个普通终端运行 `STOP_HARNESS.cmd` 只写当前supervisor实例的停止要求。监督器仅停止自己保存的Popen进程对象，不根据数据库里旧PID杀进程，不停Server/Runner/Tunnel。正常退出或用户停止不重启；异常退出最多3次、1/3/9秒，源码/公开目标配置或原state变化就不重开。原请求状态由原库保持，不重发。每次应用日志最多2MiB，额外内容被丢弃并报告数量。

只读命令：
```text
python -X utf8 -B scripts/harness_launcher.py status
python -X utf8 -B scripts/harness_doctor.py
```

端口被占用时不换端口、不杀未知owner。先核真实应用和原Job。启动器status中的心跳不是对未知PID的停止授权。首次真正运行候选会增添控制表，不改变旧请求/claim；升级前保留数据库备份，复核备份/源码/停止状态。自动修复未知发送不在监督器职责内。

## 二、统一0.2.2：正常情况只点一次

1. 用户把要接管的真实Web对话切到Sol；思考档位可为Medium/中等或Extra High/极高。当前ChatGPT若直接暴露模型/档位文本，扩展严格核对；若新版Composer Pill只暴露模式控件而把精确文本藏进Radix菜单，本次用户明确点“识别并启用”作为低成本确认。任何可见Pro或High/Low/Instant都拒绝。标签/确认都是UI保护，不是计费认证。
2. **不要再安装 `apps/web-control-companion/`。** 原来已经安装的 `apps/web-recovery-companion/` 0.1.1 直接在Edge扩展管理页点一次“重新加载”，即升级为统一的 **CLW Web Companion 0.2.2**，扩展ID和既有浏览器信任来源保持。
3. 在目标ChatGPT对话打开0.2.2扩展，先点“查看当前页识别状态（不发送）”。必须能识别输入控件、逻辑用户回合和模式控件；诊断会分别显示editor_known、user_known、mode_control_known。精确model/effort可以因当前UI折叠而为空，但Pro或不允许档位一旦可见就不能继续。
4. 点一次 **“识别并启用当前CLW对话”**。扩展用当前chat URL和已有CLW扩展信任去查询**已登记且当前可运行**的Web线程；它不读取任务正文，不要求用户知道target。若当前页没有历史映射且只有一个可运行候选，这一次明确点击自动绑定并adopt原请求；只有多个候选时按人类标题选择。若当前URL已经明确登记为另一个无请求的CLW对话，而别处有待处理分支，则返回“当前页/待处理”人类标题并要求切页，绝不把其他分支请求重绑到这个已知页面。
5. 完成这一次页面启用（或多候选时的一次标题选择）后，此后这个已绑定CLW对话的新请求自动观察和接管，不再每次生成配对码、选择target或手动adopt。浏览器重启/扩展重载只恢复原绑定；旧dispatch/unknown永不因此重发。任意未登记ChatGPT对话不会因为安装扩展就被CLW控制。
6. 只有首次安装且本浏览器从未与该CLW建立过任何可信绑定、或自动识别出现歧义/状态冲突时，才使用CLW“网页接管”里的高级手动配对/诊断入口。手动target、配对码和手动adopt都不是正常流程。

已授权观察会续租1小时窗口，使长任务不会仅因配对满1小时中断；过期或撤销的token不能靠心跳复活。刷新后只恢复观察，不重发旧attempt。用户点Stop、手工发新消息或点击输入框会停止当前载体。输入法/草稿/输入框聚焦时不触碰输入。模型/档位变化只停止发送，不自动改回。自动范围始终是**已登记并已绑定到CLW的对话**，不是浏览器中的所有ChatGPT聊天。

## 三、历史 CLI receiver（0.4.0 起仅高级回退，0.5.0 后正常后台页也不需要）

正常 0.5.0 Web worker **不要执行下方命令**。Companion 会把原请求正文直接放进确切已绑定页面；页面 Send 被确认后由服务端创建原 claim；该轮新的公开助手回复稳定后自动写回原 request。只有浏览器自动回传明确 fail-closed、旧版本兼容或运维诊断时，才按下面历史合同人工核对。

本提示是原请求的通知，不是新任务或新权限。先读AGENTS.md、CURRENT.md和本文件，确认当前是原接收对话，再执行通知中给出的精确命令：
```text
python -X utf8 -B scripts/harness_host_client.py control-receive --store-id <原store> --target <本人target> --session-id <本人原Session> --attempt-id <精确control_attempt>
```

该命令必须从真实接收对话自己的项目工具执行。它验证原Session/代次/原请求/停止状态，再沿原claim领取或恢复；浏览器只持有通知权限，不能执行这一命令。保存返回的 `original_claim_id`、`control_attempt_id` 和原 `request_id`。

`already_received=true` 或 `already_claimed=true`：读取原Job/文件/日志，从未完成处继续，不能从零重做。返回processing不等于全部任务完成。原父恢复必须先用原claim的results/result读完整子回复（跟随has_more/next_after），独立判断后再完成父任务。不能用摘要、queued、sent或代码演员结果代替真实审查。

公开回复仍用原Host CLI：
```text
python -X utf8 -B scripts/harness_host_client.py read --store-id <原store> --target <本人target> --session-id <本人Session> --request-id <原request>
python -X utf8 -B scripts/harness_host_client.py reply --store-id <原store> --target <本人target> --session-id <本人Session> --request-id <原request> --claim-id <原claim> --reply-id <本条固定id> --status completed --text-file <公开结果文件>
```

read核对最新追加/取消，回复未知先找原receipt，不换ID重发。取消或权限/安全/额度拒绝优先，不能借新载体绕过。

## 四、控制记录的准确含义

| 状态 | 含义与操作 |
|---|---|
| offered | 已准备固定通知，尚未授予Send；当前页面保护不通过会停在这里 |
| dispatching | 一次Send授权已持久提交；即便丢失响应也不能再授予 |
| sent | 页面观察到新用户逻辑回合及输入框清空；不是模型已接管 |
| unknown | 是否发送/接受不确定，禁止自动重复；从原页面与原attempt核对 |
| not_sent | 该授权后的本地检查没允许Send，保留草稿；不自动新建下一attempt |
| acknowledged | 原项目接收命令已确认，沿原claim工作；不是整体任务通过 |

相同request初次接管epoch=0；父yield事件建立新非负epoch，结果全部返回后只恢复原claim。明确新生成失败恢复采用独立负epoch（最多-1/-2/-3），但仍是同一原请求和claim。服务端、worker及页面每层都有自己的边界，任何一层成功都不能冒充另一层成功。

## 五、故障恢复与保守停机

新控制载体仅对本代已经acknowledged、正在processing且没有未完成子任务的请求，识别新的明确“无法思考/生成失败”标记。旧安装时错误、长时间静默、引用/代码块中的错误文字均不算。每个原请求最多3次15/45/120秒退避；已存在dispatching/sent/unknown未确认尝试时不再发第二条。

检测模型、用户逻辑回合、错误事件、URL、草稿和停止状态后先取得唯一dispatch授权，发送前再核对；成功/失败不能复用新generation重放。这个方案提供本载体at-most-once授权，不声称浏览器和数据库具备跨系统exactly-once事务。

若发送页面未及时更新，但原项目control-receive已确认，finish可以返回acknowledged并解决这个局部未知，仍不重复Send。没有该真实回执的unknown/not_sent或过期offer需要人核对原请求，不能为了“自动恢复”删attempt或新建子任务。观察端离线、身份不匹配时工具给出准确原ID；不继续机械空等。已经成功返回request的原wait不再重跑。
