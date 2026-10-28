# 本地应用控制

实现2026-10-06用户要求：Codex沿应用入口自行控制与验证CLW，截图作为参考，不依赖computer use、CDP或用户代替完成日常操作。业务效果沿[协作合同](MANAGED_WEB.md)与原账本，不新增发送流程。

应用主进程在本机随机端口提供认证HTTP接口；描述文件在原profile的 `control/app-control.json`，含当前实例身份与私有令牌。Windows仅新control目录保护为当前用户/SYSTEM/Administrators，原Chromium/profile权限不改。令牌不显示在健康摘要、CLI结果、日志或发布包；网页Origin/Sec-Fetch请求拒绝。接口没有任意脚本、选择器点击、通用命令执行或任意文件写入能力；终端动作只复用下述既有CLI启动入口。

CLI为 `python -B scripts/web_host_control.py`。安装版使用该版本code根的脚本与data/web-host的profile。`state`、`capabilities`读取真实当前状态；`show`、`inspect-ui`、`capture-shell`、`view`、`reload-shell`是应用动作。状态含当前实例、主进程与界面源码身份、连接代际、任务身份和驻留页数量；正文经既有record接口按需取得。能力以运行实例返回为准，源码具备接口不代表旧进程已经装载。

业务命令用 `command --request-file <JSON>`。文件含唯一 `operation_id`、`action`、`payload`、`expected_identity`；身份取原state的app_instance_id、root、runtime_generation，任务动作同时带tasks行的完整identity，界面动作带selected。Native记录与接续使用native_tasks行的原trace/thread/turn/account身份；`record-body`精确匹配trace与task_key，同一thread的旧轮次可以读取。`record-history`与`record-index`使用该thread的入口身份。goal仍带原etag/goal request/run及业务operation_id；保存目标和验收不会增加额度、恢复暂停或派发下一包。

已接入原dispatcher的入口如下。它们提供应用控制和原回执；业务成功仍按实际Host、网页与Native执行记录核验。

| 动作 | 当前合同 |
| --- | --- |
| `new` / `login` | 必须显式选择账号A或B。受理前固定execution_reference，新页id为 `web-<execution_reference>` 并保存外层原operation关联；登录页可复用原账号页。仅分配/打开页面，模型发送数为0。 |
| `start` / `budget-continue` | API新派发使用受理前固定的execution_reference关联Host原operation。`start`已有pending时必须匹配原执行引用，否则用只读 `reconcile-submission` 核对原提交；预算继续的pending分支查询原提交，不换键。UI入口保持原合同。`budget-continue`仍需要原预算与任务身份。 |
| `task-status` | 只读指定原任务的Host状态，包括request/attempt、goal、预算、维护与写域；它不发送模型消息。 |
| `goal-stop` | 原任务身份信封，加原 `operation_id`、`expected_etag` 和 `expected_goal_request_id`。幂等关闭 Goal 并暂停后续发送，不要求当前回合已结束，不删除要求、原请求、成果、未知发送或独立 Job。回执 `goal_stopped`／`model_sends:0`。迟到结果不重新激活；重新设置需明确保存。`owner_identity_valid` 表示稳定所属身份，`request_matches` 和 `identity_valid` 继续限制验收与接续；关闭后普通消息不会锁住重设目标。 |
| `quota-history` | 兼容旧调用，payload仅 `{account:'A'|'B',since?:UTC毫秒}`。实际返回 `history_read_disabled`／`policy:'cache_only'`／`model_sends:0`／`remote_requests:0`，不访问账号页、不读取历史、不重试。`state.quotas[]` 标明 `historyPolicy:'cache_only'`、`historyProgress:null`，只保留本机 `usage.lastGood/lastAttempt` 与原采集区间和时间，旧进度不恢复。 |
| `quota-verify` | 兼容旧调用，payload仅 `{account:'A'|'B'}`。返回 `history_read_disabled`／`policy:'cache_only'`／`model_sends:0`／`remote_requests:0`；不打开验证窗口或登录信息页，不接受URL、脚本或token。 |
| `quota-check` | 兼容旧调用，payload仅 `{account:'A'|'B'}`。返回 `model_status_read_disabled`／`policy:'cache_only'`／`model_sends:0`／`remote_requests:0`；不打开或读取辅助模型菜单。正常任务 `inspect-model`／`adopt-model`／`set-model`／`verify-model` 保持原合同。 |
| `quota-report` | 沿既有字段仅保存或清除本机手动限制标记，不联网、不表示官方额度恢复，不恢复暂停任务。 |
| `mcp-call-details` | 只读已记录原调用的参数或回包；payload 为 `scope:task/connection`、`callId`、`part:arguments/response` 及可选 `offset/max_bytes/format`。task 带原 `id` 和完整任务 identity，connection 保留连接级归属。每页最多64KiB，沿原ResultStore读取，不重新执行工具、不消耗模型消息，也不更改模型结果读取进度。未保存或已过期明确返回不可用。 |
| `task-observation` | 只读原已加载网页的当前生成、草稿、确认与连接器结构；正文只返回字节数和SHA256。`readiness` 提供页面就绪状态、视口、输入与模型控件数量、候选输入结构及可见提示；仅原首页缺少控件时返回有长度限制的主区域提示，排除输入正文、导航和对话记录。`queryDiagnostics` 提供有界菜单结构、公开菜单标题及输入焦点归属，观察到的全局浮层不自动成为可选择的菜单。`pageLoadFailure=account_load_failed` 仅用于首页、零个可见编辑器、明确账户加载错误与唯一重新加载入口。不开模型菜单、不操作输入框、不暂停或发送，用于核对原工作与网页变化。 |
| `reload-page-adapter` | 在线装载固定本地 `page-dom.cjs` 的公开页面函数。payload 仅含目标 `expected_page_dom_sha256`；expected_identity 同时带当前 `page_adapter` 的精确 `sha256`、`revision` 两字段。保留原网页、Host、请求、Goal与读取协调器，不暂停网页生成、不发送。暂停本地观察并等待原观察排空至多10秒，再核对全部原对象与绑定并同步装载；同步文件加载无法被该期限抢占。真实发送准备仍需先结束；原 queued／unknown 发送及 pending 可原样保留，不要求先有 ACK。 |
| `reconcile-send-preparation` | 明确指定原request与attempt，只在当前私有发送记录证明尚未点击、原Host接受/准备/双基线与当前网页一致时，复用原grant完成同一次发送，不新增dispatch。仅正式App operation可用；已有标记、已ack、真正未知点击及用户草稿均保留。未知返回查询原operation，不换键。2026-10-06原95事故另有冻结源与现场证据的单次历史迁移，不作为通用未知重发依据。 |
| `reset-bootstrap-query` | 仅正式App operation可用，payload为原页id与操作者指定的 `expected_query_sha256`，连接代际由原身份信封固定。只对已暂停、reserved/pending、无thread/request且control_failed的原预留任务执行；先后只读Host核验预算未受理及原任务合同。原已加载首页必须双基线为空、唯一编辑器、没有选中App或生成/IME/审批/登录阻碍，正文须精确等于原账号的 `@Local-MCP` 或 `@Local-MCP-B` 且SHA一致。删除前将原执行引用和查询/合同摘要原子保存为pending，原同步DOM只清该查询一次；清后DOM与Host核验完成才记cleared。回执 `model_sends:0`，保留原预留身份、暂停与issue，不恢复、不发送、不把用户草稿收编为系统所有。任何未知清除或后验失败保留原pending，跨重启及换操作键均不得再清，只查询原AppControl operation；已确认cleared后，新的明确操作仍需重新满足全部条件。 |
| `codex-start` / `codex-resume-turn` | 复用Codex＋Web的原启动/接续入口，核对原网页账号、桥状态和工具能力，然后打开交互式CLI。打开终端的回执不是模型调用或任务交付证明；模型发送数为0。 |
| `native-codex-start` | 打开本机已安装Codex的交互式CLI；payload仅含已存在的workingDirectory和可选resume（false/true/原UUID）。沿该CLI自身登录、模型和配置，返回opened/pid，loginVerified=false；不宣称本地模型任务已执行。 |
| `quit` | 默认普通退出，payload为 `{}` 或 `{maintenance:false}`；停止后续派发，核验当前网页与原执行者空闲后关闭，保留未结业务。严格维护退出显式使用 `{maintenance:true}`，仍须满足原维护停稳合同。可带当前 `exit_id` 核对退出身份；不接受其他字段。 |
| `exit-status` | payload仅为 `{}`，只读同一退出生命周期；也可从 `state.exit` 取得。返回原 `exit_id`、退出的 `operation_id`、模式、阶段、具体阻塞原因与原owner关闭状态，不发送关闭命令。 |
| `reconcile-exit` | payload仅为 `{exit_id:<state.exit.exit_id>}`，使用当前应用身份信封接续该原退出。重核已解除的停点、收取原关闭回执或补保存退出记录；保留原退出operation，未知关闭不重发。详见[原退出的核对与接续](#原退出的核对与接续)。 |
| `window-size` | 设置窗口内容尺寸；width为360..3840、height为480..2160的整数，拒绝额外字段。 |
| `capture-shell` | 应用自行生成PNG，保存在私有 `control/capture-UUID.png`，返回实际字节数、SHA256和尺寸。确认NativeImage非空、正整数尺寸及toPNG输出的签名、IHDR尺寸、chunk结构和CRC后才保存；这是原生截图结构校验，不是通用PNG解码器。只保留最近32张临时截图；长期证据需在淘汰前复制。旧图被占用时返回cleanup_pending并在后续截图重试清理。 |

控制操作持久记录accepted/running后才进原dispatcher；同键同内容只返回原回执，同键不同内容拒绝。执行前明确拒绝为rejected，执行后未知为unknown；观察到的原结果仍保留，不能因外层回执失败换键发送。SQLite Worker承担日志事务、结果压缩与读取，GUI仅保留64条热回执缓存；没有累计512操作上限，缓存淘汰不删除持久原键。单命令JSON请求上限64KiB、单回执128KiB，接口响应上限1MiB。

截图分阶段保存固定错误码：`capture_shell_inspect_failed`、`capture_shell_native_failed`、`capture_shell_image_invalid`、`capture_shell_png_failed`和`capture_shell_storage_failed`。前四种发生在本次截图写入前，明确返回rejected；存储可能已经产生文件时保留unknown，原身份断言不被包掉。同键查询或重播仍只读原回执，不重复截图。接口不为截图自动显示、恢复或聚焦窗口；隐藏时Electron若无法提供像素，使用`inspect-ui`取得结构化状态。已有旧unknown回执保留，不因新实现修正为成功或重新执行。

inspect与原生像素读取共用3000ms准备期限；超时分别返回`capture_shell_inspect_timeout`或`capture_shell_native_timeout`，accepted:false。原读取没有真正结束时，固定WebContents保留该槽，后续截图明确返回对应`*_pending`且不再读像素。迟到的读取只释放原槽，不访问图片、编码或写盘。

已开始的异步保存另有3000ms完成等待期限；`capture_shell_storage_timeout`保留accepted:true／unknown，避免文件I/O永久等待占据其它应用控制。原保存不能据此认定已取消，迟到写入或清理可能仍发生；固定capture store保留原槽，新的截图在读取和保存前核对，`capture_shell_storage_pending`明确rejected／accepted:false，不叠加新写入。迟到保存不将原unknown改成成功。这些期限约束异步等待，不能抢占同步PNG编码。此修订需要正常主进程升级，shell重载不能装载它；运行能力仍以实际实例与回执为准。

`operation <id> --expected-instance <原实例>`只查原操作，CLI超时保留原身份，不重新POST。当前实例用 `GET /operations/<id>`；旧实例用 `GET /operations/<id>?original_instance_id=<原实例>`，响应分别保留当前服务身份、original_identity与原operation。升级后同一data的旧记录仍可查；旧实例accepted/running在恢复时标为unknown，原执行关联保持。新进程不接受旧instance的POST命令，也不把历史查询当作重新执行。

正常退出可能先保存completed回执，再关闭HTTP接口。CLI遇到这一连接关闭时，会只读同profile的持久账本，核对原实例、操作键、完整请求hash、执行引用及结果摘要后返回原状态；不再把已经完成的退出误报为unknown。应用关闭、描述文件已删除时，仍可用 `operation <原id> --expected-instance <原实例> --request-file <原JSON>` 查询同一原结果。accepted／running／unknown保持原状态，没有回执时保留未知；此读取不创建账本、不重新执行，也不需要重新打开应用。completed退出回执只代表退出已经受理并开始关闭，实际进程是否退出仍须单独观察。

API `record-body`使用64KiB以内的UTF-8字节分块，响应为json-utf8-base64及整份JSON的sha256、byte_length、byte_offset、next_offset、complete。byte_offset=0且不带expected_sha256创建一份不可变正文快照；后续块带该sha256，始终读取同一快照，不重新传输或序列化整篇正文。快照最多4份、合计64MiB，创建后TTL为120秒；新快照可淘汰最早快照。快照过期/淘汰明确报 `record_chunk_snapshot_expired_restart_read`，需要另行发起字节0的新读取，不混合两份内容。

工具确认适配器可与 `reload-page-adapter` 同一事务在线更新。旧模块已捕获的确认函数保持同一对象，只在原DOM提交后选择新序列化源；失败更新仍选原源，原ApprovalManager、确认日志、未知回执与读取队列保留。`scripts/ensure_web_approval_adapter.py` 使用原控制接口及精确hash；安装版的候选保存在 `data/web-host/approval-adapter`，加载完成即复原版本目录原字节，不改冻结包／active指针。正常启动与派发入口复用该检查，不新增常驻服务。`task-observation.snapshot.readiness.approvalImplementationVersion` 核实际页面函数版本，更新回执同时记录DOM及确认源码hash；仅DOM hash相同不代表确认函数也相同。

安装版入口的可复用源码为 `scripts/start_web_approval_workspace.ps1 -InstallRoot <安装根>`；`-NoLaunch` 仅核对已运行实例，不重开应用。它显式使用所选版本的私有Python，不依赖系统PATH。WKR现有桌面与派发入口已接入同一逻辑；机器专用薄包装、凭据与运行回执仍留该机器，不随Git提交。

Python `AppControl.read_record(payload, expected_identity)`按同一原身份收集分块，默认正文上限32MiB，校验游标、长度、Base64、整份sha256和UTF-8 JSON。每次只读分块有自己的原operation；accepted/running/rejected/unknown均不会被换键自动重试。未完成回执通过ControlError.original_receipt保留，调用者先查该原operation；明确过期后重读属于新只读快照，不是业务重放。

`reload-shell`仅重载本地index及界面资源，保留BrowserPool、原网页WebContents、Host、原生桥与后台Job。先挡住本地shell的新输入，核对IME、临时新任务、打开的编辑/设置/目标及进行中的操作；草稿保存后才装载。每次等待重核原实例/连接/选择，装载后核原网页及执行器对象和源码，迟到或未知不重载第二次。重载不暂停后续或恢复业务暂停；主进程/preload变更仍需原正常退出再由正常launcher启动，不能用shell重载冒充主进程升级。

2026-10-07新增的页面模块更新使用 `python -B scripts/web_host_control.py reload-page-adapter --expected-page-dom-sha256 <目标64位SHA256>`，或保存完整身份信封后使用 `command --request-file`。state 的 `page_adapter` 记录当前公开页面函数源码SHA、初始为1的revision、原读取协调器源码SHA、`scope=serialized-public-dom` 与reloading状态。此入口只换公开页面函数；WebDriver、DOM读取队列、输入执行器、权限判定及主进程仍保持原版本。加载前后核目标文件SHA及原加载版本，提交前失败保留旧函数；模块缓存始终保留原协调器，finally尝试恢复观察。提交后若恢复观察失败，新函数保持，回执accepted:true／unknown，只查询原operation，不重装。同键查询不重新装载。旧运行版本没有该能力时须先完成一次实际客户端更新，shell重载不能补出该入口。

更新判定使用真正进入WebDriver.records的Host `list` 投影。只读观察更新不要求原请求已经 ACK；queued／unknown、暂停状态与未知 pending.state 原样保留，不据此许可 Send。现有 pending 必须仍属于同一 latest_request 的原 attempt；外国 attempt、缺失原请求以及真实 busy／bootstrap／授权／提交准备均阻止装载。等待观察排空后再次核对所有 owner、绑定、请求、Goal、attempt 与 pending 值；有变化就保留旧函数。list按已选原attempt ID及request ID投影固定状态字段，不独立重选另一attempt，不修改发送记录。装载后沿原回执继续观察，未知发送不重发；磁盘源码不能冒充当前运行合同。

`task-observation` 的 `snapshot.readiness.failureDiagnostics` 是只读结构诊断，不参与失败／Send判断。只有当前唯一受管用户标记可定位时才扫描，从该用户节点开始、最多4096个访问元素，并在同一遍历确认下一用户；文本探针在展开前限制128节点、160字符。输出最多12个固定标签分类码及各12层祖先的固定tag／role／已知class分类、归属与排除原因；没有正文、HTML、编辑器值或通用查询入口。截断和不可定位明确保留。是否具备该字段以实际已加载page_adapter版本及正式观察为准。

同一观察的 `snapshot.readiness.turnStructure` 仅在原 conversation 缺少可识别用户身份时诊断公开 turn 结构：最多遍历4096个元素，保留末8个候选及各8层祖先的固定角色分类、标签和有界属性名；排除导航与输入区，不返回正文、HTML、属性值或私有接口。该字段不参与发送或结果归属，真实结构经原页读取后才用于修订适配器。

Host私有管道未分类异常仍返回原 `managed_operation_unknown_reconcile`，后台单槽可受理时提供诊断ID及 `diagnostic_state=pending`。后台尽力保存原操作类别、任务身份、异常类型及有界代码位置到原store旁的 `managed-pipe-error.json`；不等待磁盘、不积累写线程、不重放业务。pending不表示已经落盘，Host退出或存储失败可能没有文件；槽位忙或诊断创建失败时，原unknown回执保持且没有诊断字段。原错误文本、请求正文、locals与源码行不写入该记录。原未知回执不因此升级为成功。

`inspect-ui`还返回`workflow_state`中的当前展示标题、独立观察提醒及主动作／恢复菜单可见性，用于核对界面语义；这些是展示字段，不改变原业务状态或发送权限。

`inspect-ui`含`composer_action`（kind／label／disabled／request_id／draft_length），用于程序核对输入区实际状态，不返回草稿正文。原任务已受理时，输入区提交的是精确原request的本地补充，`resume:false`；保存后显示“补充已排队”，按原文与顺序合并到下一轮，不注入当前回合；当前回合可以正常交付。这个操作不单独发送网页消息、不停止当前回合。中文“最新”与Latest为同一模型别名，本地补充也不依赖网页模型显示名称；新任务发送仍核选定模型。

`refresh`与网页视图页签旁的刷新按钮、F5／Ctrl+R共用原任务入口。一般刷新须确认原网页空闲；严格核验到空首页且保有durable bound URL时，允许返回该原对话来核对仍processing／suspended／unknown的回执。明确的账户加载失败也使用此入口：必须首页、可见已知及候选编辑器均为零、无生成/草稿/确认/用户或回复正文、无旧标记，不因编辑器重复或不唯一而当成无输入。返回不发送、不恢复暂停、不改请求终态；本地受理中的发送和结果处理仍保留。导航前再次核对真实URL、文档、原请求和实例，SPA切换也会取消旧导航。页面状态包含原`conversationUrl`、当前`url`与真实`loading`；只读snapshot有8秒共享deadline，底层读取未返回时保留同WebContents原读取，不叠加检查或重放输入。

直接对话首条发送尚待确认时，已经观察到的原 `c/` 阅读地址也按同 page／account／request／attempt 保留；网页回到首页只更新 `visibleUrl`，不擦掉原阅读地址。空闲首页可沿同一 `refresh` 返回该地址只读核对，导航前后重新检查原身份、文档和操作；生成、草稿、确认及真实本地操作仍阻挡刷新。阅读地址及 `readingRequestId`／`readingAttemptId` 不构成送达确认、正式绑定或新的发送权限；信息缺失不自动导航，原暂停保留。

当前唯一原回合明确显示“无法思考／思考失败／消息流错误”时，残留停止按钮不能把失败遮成工作中。此时保持物理停止按钮的发送保护，核对原 URL、request、attempt 标记与已确认发送的用户哈希，且输入为空、无确认或访问限制，才重连同一原对话；正常长思考、仅连接等待或系统处理提示不触发重连。自动重连每个原 attempt 只尝试一次，未知导航回执不重复；已确认原消息的回执等待保留，其他未知发送和待提交结果仍挡住导航。`task-observation` 分别返回 `stopped`、`rawStopPresent`、`streamInterrupted`、`processingNotice`，便于核对失败、真实停止与等待。重连不解除暂停、不发送消息、不重放工具。

没有Stop的明确终端失败同样需要被识别并交给原请求的有界恢复流程，不伪造完整结果。新兼容路径读取当前受管用户之后、归属当前公开回合的精确独立失败标签，包括heading、status及短div/span；新路径须有唯一受管标记，并排除用户正文、普通回复引用、历史与外来回合、隐藏元素和输入控件。既有当前回合的显式role=alert保留原合同。后出现的真实思考状态可覆盖旧错误，仅连接等待或进一步处理提示不会擦除终端失败。

## 原退出的核对与接续

普通「退出并保留现场」与严格维护退出分开。普通退出先停止未来派发，只等待真实当前网页回合、当前 Native 执行和当前发送核对；保留原request、claim、未完成目标、attention、独立计算及旧错误，这些历史或独立记录不阻挡退出。`waiting-current-turn` 显示活跃对话和等待原因，程序定期核对回合结束后继续原退出。`cancel-exit` 取消退出等待，已经暂停的后续发送保持暂停。严格 `maintenance:true` 沿原维护停稳证明，不通过普通退出解除维护占用或生成业务成功。普通退出后正常启动保持暂停，恢复须由操作者明确选择；维护退出保留原维护意图。

网页核验使用原绑定、原最新request/attempt及新鲜DOM；发送尚未知时核对原操作，不按未发送处理。严格维护还核对原用户标记、发送哈希、组字和审批，以及原 Session 同步调用与 Job；核验范围见[协作合同](MANAGED_WEB.md#原-session-的执行核验)。普通退出不等待独立后台 Job，也不要求历史结果全部回收。

`state.exit`／`exit-status`区分 `checking`、`waiting-current-turn`、`blocked`、`closing-native`、`closing-host`、`awaiting-original-exit`、`saving`、`save-failed` 与 `completed`；无退出时为 `idle`。`shutdown` 表示原关闭已经派发，`owners` 表示原owner退出已核验，两者不能互相替代。`blocked_reasons`保留原页、request/attempt、Job及状态等可核对身份。UI、托盘和API沿同一AppControl持久operation；正在检查或关闭时重复点击合并，loading不表示已经退出。

原 `quit` 回包未知时，先用 `operation <原id> --expected-instance <原实例>` 查原回执，再只读 `exit-status`。要接续同一次退出，提交 `reconcile-exit` 并带该 `exit_id`；这次核对命令有自己的AppControl操作键，但不替换生命周期里的原quit `operation_id`。`blocked`可重核原停点，关闭中只核对原派发及迟到回执。owner已经清退而退出记录写盘失败时，沿 `save-failed` 补保存原记录，不再关闭owner。主进程保存原控制回执后才关闭AppControl；退出API的completed回执与生命周期completed、实际GUI进程结束分别核验。

每个已受理或结果未知的Native／Host关闭只派发一次。只有私有管道明确 `ok:false` 且原回执证明拒绝发生在 `before_shutdown`、`shutdownDispatched:false` 时，才允许在原退出context及permit下重新核验后关闭尚未退出的Host；已经确认退出的Native不再关闭。超时、断联或未知结果不能作为第二次派发依据，不取消、重放业务或修改请求终态。

Native核验针对当前进程实际admitted身份，旧进程的历史unknown保留为历史问题，不从显示历史推定当前仍在运行。明确发生在Native owner启动前的配置失败保留错误，但不会让无Native运行任务的应用永远拒绝退出；后续启动或cleanup_unknown仍保留原owner。未配置首次空库只证明自己的业务、接纳和回执表均为空、没有外部执行范围，不声称外部全局Jobs为空。收起窗口及暂停后续不终止当前生成；真正停止网页仍是独立stop-generation。本节是退出合同，实际装载能力与生产验收仍见CURRENT，源码测试不证明旧实例已经具备这些入口。

实际装载检查使用正式固定安装和全新data的 `--clw-isolated-check`：完整manifest、安装及data junction匹配，空数据一次性标记。仅此检查Host显式port0，默认生产18944保持。检查直接禁用native桥配置及模型/账号/新任务入口，只公布并接受状态、视图、主题、截图、界面重载和原安全退出。它验证实际Electron/main/preload/HTTP/Host，不等于原账号业务或用户体验验收。

旧版本没有app-control广告和描述文件时，CLI明确报该运行版本无入口。第二实例仅聚焦，不注入代码；不使用CDP、强杀、换身份或旧grant。旧实例能力缺口与新固定应用的API实证分开保留，现场事实沿CURRENT与DEV接续。
## Free preview setup control

An installation with `.local/preview-installation.json` additionally exposes `preview-read`, `preview-bootstrap`, `preview-connect`, `preview-check`, and `preview-export`. They accept an empty payload and retain the app-instance/runtime owner envelope. Read and export return metadata only. Bootstrap and connect operate only this installation; unknown completion is reconciled through the original local controller before another mutation.

Credential-bearing configuration is available only to the trusted local settings IPC and the existing Python controller's JSON stdin, never the persistent AppControl request journal. Programmatic local setup uses `scripts/preview_connections.py --root <code-root> --action save` with the explicit manifest and optional credentials on stdin. `read` returns metadata and `has_key`, never the key. Secrets must not be placed in argv or model prompts.

The shell provides the same four-step setup, current connection check and manual diagnostic export. Changing saved network settings does not partially reconfigure active pages; a normal reopen applies one coherent process network snapshot. The legacy AB installation follows its existing configuration when no preview manifest is present.
