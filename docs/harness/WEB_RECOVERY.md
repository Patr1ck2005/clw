# ChatGPT Web 故障恢复 · 0.1

**2026-10-25 当前入口：** 已经在 Edge 手动运行、包括 Pro 的原对话，使用 [Companion 原页监护与本地程序控制](../../apps/web-recovery-companion/README.md)。不要求 CLW 任务登记或本地 Host，启用时无需刷新；连接等待后的有界原页刷新沿组件说明。下文为历史 0.1.x 的原请求恢复合同，不把旧配码／刷新步骤套到新模式；实际 Edge 装载及真实故障恢复另行核验。

## 0.1.1 更新（本轮整合验证通过后采用）

修复空闲确认消息污染下一原请求，以及两次观察间已发生的新失败被当作旧错误两个问题。新增仅布尔/枚举的页面健康诊断；面板能区分连接存在、页面识别、真实故障恢复三种证据，不传聊天正文。

当前实际旧配对在事件530被new_user_input停止，不能沿用此前paired=true声称仍在线。0.1.1与本轮分支/追加整合经350程序检查、14恢复浏览器检查、12分支浏览器检查及28克隆升级/语法检查通过；均不等于真实ChatGPT故障恢复已经验收。以evidence/HARNESS-CONTINUE-f7a6bca6/为最新回执。

更新时等本次工作结果回面板后，只关闭并重开CLW自己的START_HARNESS.cmd终端；不重启原生Server/Runner/Tunnel。到已安装扩展的管理卡片点“重新加载”，核版本0.1.1；刷新对应的原ChatGPT对话。回CLW生成新配对码，再在扩展弹窗绑定同一页。无需卸载扩展、重新登录ChatGPT或重新创建工程会话。Chrome官方说明content script改动需要重载扩展和宿主页，storage.session在扩展重载/更新时清除，因此本开发版这次需要新配对码。

官方参考（2026-09-23查阅）：
- https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#reload_the_extension
- https://developer.chrome.com/docs/extensions/reference/api/storage#session

加载后“自动恢复→刷新连接状态”应显示0.1.1以及页面识别情况。新页面若未识别，不放宽选择器猜测；保持停止，记录实际诊断。真实错误后的原request恢复仍需另验，正常模型长思考不能视作失败。

## 此次现场结论

第二次真实面板输入 `b5067470-1d5a-4297-b7a1-9d887f32c320` 不是未开始：已被原 Session 领取，claim 为 `clw-claim-b5067470-1d5a-4297-b7a1-9d887f32c320`；进度已回传，并有未提交协作模块代码。模型随后在网页显示“无法思考”。本次从同一 claim 恢复，不能重发工作或删除已有差异。本次恢复由用户新消息唤起，不写成自动恢复通过。

原 Job-terminal 卡片确认的是续接请求，不能提供此后全部模型失败状态。故需在模型之外观察明确失败信号。

## 当前实现

轻量浏览器伴侣只绑定你选中的一个具体 `https://chatgpt.com/.../c/...` 标签页；没有 Cookie、浏览历史、调试器、私有模型 API、管理员或其他网站权限。activeTab 只在点击扩展后取得当前标签页访问；localhost 权限用于固定127.0.0.1:18944恢复接口。开发版仅在浏览器当前会话中保存窄范围令牌，浏览器重启需重新配对。

明确、非引用的“无法思考/生成失败”状态才触发恢复；普通思考、暂时无输出、后台标签页、草稿、中文输入、布局不识别均不自动发送。用户手动停止或另发消息、登录/额度/安全拒绝会停用本轮恢复。每个原请求至多3次，退避15/45/120秒；提示在原网页普通输入框提交，不变更模型。每个独立错误只对应一份记录，发送前后两次检查。点击结果未知不重放。

服务端只存错误类型和有界标识，不存聊天页面全文；配对码两分钟一次有效。扩展令牌不能领取任务、伪造回复或执行项目工具。实际模型必须通过原 MCP 项目工具 recover 确认，再核对原claim/Job/文件继续。参见 RECOVERY_RECEIVER.md。

## 首次使用

新源提交后需重开CLW启动终端加载实现（不要重装WebCodex、不要重启Tunnel）。确认当前模型与工具已完成再关闭原CLW终端；重新双击START_HARNESS.cmd，保留同一.local/harness数据。

在Edge的edge://extensions或Chrome的chrome://extensions打开开发者模式，选择“加载解压缩的扩展”，目录为本项目apps/web-recovery-companion。这是本地未上架扩展，需要操作者首次允许，不能静默安装。

在CLW面板选择原Web对话→“自动恢复”→“生成当前对话配对码”。切到该原ChatGPT对话，点击扩展图标，将配对码填入扩展弹窗并“绑定当前标签页”。不要发到聊天。以后页面刷新，可在该标签页点击“刷新网页后恢复监测”。初始已有旧错误被忽略，防止安装时误发历史任务。

## 验收边界

原请求、claim保全与重复执行保护可程序验证；浏览器状态检测和普通发送可用隔离HTML/HTTP及扩展进程验证。它们都不等于真实登录的ChatGPT DOM已经验收。

实际页面必须确认能识别当前失败状态，且不会识别普通引用、代码块或用户输入。未知页面形态显示unsupported/停止，不使用模糊按钮补救。安装之后的真实一次故障→固定提示→同一claim恢复→实际产物回传，才可标记在线自动恢复通过。

原native_web PAT/主体问题未被修复，恢复伴侣不调用该拒绝接口、不改变旧Agent/W1/W2/游戏或数学归属。

参考合同：OpenAI Plugins UI reference（原Apps SDK reference）与Chrome activeTab、message passing官方文档；本地固定WebCodex源码mcp_job_terminal_continuation_app.html的one-shot delivered/unknown与model-turn terminal注释。开发采用独立薄适配，不替换其权限规则。
