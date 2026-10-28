# Codex＋Web

原生 Codex 负责文件操作、终端和工具执行，ChatGPT 网页模型负责推理。使用本项目专用入口；普通 Codex 的全局模型与登录配置保持原样。当前能力与验收以 [CURRENT](../../CURRENT.md) 为准。

## 启动与派发

1. 启动本机 CLW，进入 **Codex＋Web**，等待本机工具与账号连接就绪。本机默认 A，WKR 默认 B；各安装保留自己的登录、网络与连接。
2. 把完整目标、输入路径、写入范围、完成条件和交接文件写入 **UTF-8** 提示词文件。输入文件放在结果目录之外；每次派发使用新的结果目录。
3. 正式开发／研究使用 `-Account A -Model pro`；本轮流程测试使用 `-Model extra-high`。示例中的项目和工作包路径需替换为本次实际路径：

```powershell
powershell -NoProfile -File D:/Dev/Projects/Personal/clw-webcodex/scripts/start_codex_web.ps1 -Account A -Model pro -WorkingDirectory D:/Dev/Projects/Personal/Games/你的项目 -PromptFile D:/你的工作包/prompt.md -ResultDirectory D:/你的工作包/result-01
```

也可在 CLW 中点击“打开 Codex＋Web”，在原生 Codex 窗口直接工作。账号与本轮任务保持一致；连接未就绪或访问受限时等待原连接恢复，不重复创建工作包。

已有共享连接可在设置中切换 A/B；程序控制使用 `configure_codex_web_bridge.py --through-workspace --reuse-local-mcp --web-account B`，先核实返回，再正常退出并重开载体。切换不更改隧道，不迁移旧任务；有在途执行时保留原连接，工作包的 `-Account` 只校验当前账号，不隐式切换。

安装版使用自己的 Python 与网络配置。Codex CLI 使用本机已有安装；CLI 不在 PATH 时，启动脚本接受 `-CodexExecutable <可执行文件>`，Node 版另加 `-CodexScript <codex.js>`，不修改全局设置。WKR 的实际路径与首次接入状态在其 WorkFlow 使用页维护。

## 读取、等待与接续

状态读取不发送模型消息：

```powershell
python -B D:/Dev/Projects/Personal/clw-webcodex/scripts/read_codex_web_task.py D:/你的工作包/result-01
```

需要等任一工作包结束或需处理时，可由程序等待：

```powershell
python -B D:/Dev/Projects/Personal/clw-webcodex/scripts/read_codex_web_task.py D:/你的工作包/result-01 D:/你的工作包/result-02 --wait-seconds 3600
```

程序等待不消耗模型回合；默认等待 0 秒，读取当前快照。从 Codex 工具启动后保留原 **tool/session** 等待，收到返回再核对结果并接续；返回“仍在运行”时继续等待同一会话，不再次启动。**当前没有跨已结束桌面主控回合的自动唤醒**；主控若已结束回合，需要再进入本任务读取结果，结果落盘不等于自动通知。

处理完 `wait.readyResultDirectories` 后，下次只等待仍未处理的目录；已完成目录再次传入会立即返回。等待时限只约束这次读取，不停止工作包；完整结果核验可能稍晚返回。

- `execution.json`：模型、账号、工作目录、进程与终态；`events.jsonl`：原生工具事件；`final.md`：最终答复；`prompt.txt`：本轮输入。
- 已受理或结果未知时先查原结果、原 tool/session 与实际文件，不覆盖原结果目录、不换身份重发。宿主不在不等于原任务已失败。
- `turn_completed` 只表示回合结束，`taskAcceptance=unverified` 仍需主控核对答复、工具事件与成果。平台拒绝也可能正常结束，退出码 0 不代替业务验收。
- 追加工作使用同一启动命令，加 `-Resume <原生thread UUID>`、新的提示词文件与新的结果目录。先确认原回合已结束，且没有其他客户端持有原任务。交互接续可用 `-Resume pick`。
- 已结束的旧网页不能靠直接输入“继续”恢复原生执行身份；从原 Codex 任务建立新回合。

## 并行与工具边界

独立工作包可并行，先明确各包写域和整合者。同一 Git 仓库、重叠写域或排他资源可能在本地排队串行；不清锁抢占原任务。`-WritePaths` 与 `-ExclusiveResources` 用于声明工作包写域和排他资源，默认写域为整个工作目录。

专用入口默认保留原生工具与本地 MCP，不继承已连接 Apps；确需使用时加 `-IncludeConnectedApps`。`-AppServer` 使用原生 thread/turn stdio 接口，不与工作包参数混用。工具调用结果与网页回合的发送分别记录，等待和状态查询不调用模型。

同仓库、独立候选写域的并行包可显式加 `-GitReadOnly`：双方都声明不写Git元数据时，准入只比较实际写路径及独占资源；默认仍保留Git排他。此声明禁止commit、checkout、reset和index写入，不改变文件访问权限，也不允许写出原写域。已有原包可用 `native_work_admission.py declare-git-read-only --database <绝对路径> --result-path <原结果目录> --owner-pid <原launcher>` 按既有任务约定登记；保留原claim、队列顺序和prompt，不撤回或重发。路径重叠、Unity/GPU等明确排他资源仍串行。

`-IncludeConnectedApps`不是Edge扩展开关。网页模型通过原生MCP调用浏览器仍需要对应工具确实被该执行发现，以及本机浏览器扩展实际附着；本地主控能用、配置中启用插件或仅调用node_repl处理文件均不能代替这个验证。已有排队包不因此重建；先在原包做只读连接检查，再按项目约定使用原游戏页。

明确取消已经退出、却因缺少模型终态而占位的原包，可用 `python -B scripts/native_work_admission.py cancel-stopped --database <原harness.sqlite3绝对路径> --result-path <原结果目录> --operation-id <UUID> --thread-id <原thread> --turn-id <原turn> --trace-id <原trace>`。入口逐项核原命令/MCP结果、原执行器及bridge退出、所属Job停稳，再定向撤销并审计释放；只标取消未验收，原unknown与候选保留。它不强退活跃任务，不停独立Job；未知取消只核原operation，不换ID重试。

## 验证与来源

活跃原轮次需要明确取消时，使用同一准入CLI的 `request-cancel`，参数与上述原身份一致。请求先审计再定向撤销，只保存确认，不立即释放claim；实际原生失败与工具／所属Job终态核对后再 `settle`，结果为 `cancelled_unverified`。取消回包未知只查原operation；不重放，不停止其他轮次或独立Job。已有精确取消确认时，`cancel-stopped`可核该原turn已撤销，不要求退出仍服务其他任务的共享bridge。

2026-10-25 已通过账号 A／Extra High 两路轻量并发，以及主控派发→程序等待→回收→原线程接续→整合的两回合实测；不代表重度 Pro 或长时稳定性验收。最新事实、原结果与限制见 [CURRENT](../../CURRENT.md)。

- 日常操作与恢复：[MANUAL](../../docs/harness/MANUAL.md)、[正式控制 API／CLI](../../docs/harness/APP_CONTROL.md)。
- 历史验收与诊断：[原生闭环](../../evidence/CODEX-WEB-BRIDGE-20260925/REPORT.md)、[Extra High 对照](../../evidence/XHIGH-COMPARISON-20260926/REPORT.md)、[可靠性与压缩](../../evidence/RELIABILITY-20260929/REPORT.md)。历史记录保留原日期与适用范围。
- 上游与复现：[UPSTREAM.json](upstream/UPSTREAM.json)、[vendor overlay](vendor-overlays/manifest.json)、[来源说明](../../evidence/CONTROLLED-DIAGNOSTICS-20260927/UPSTREAM.md)、[隔离复现证据](../../evidence/VENDOR-REPRODUCIBILITY-20260927/REPORT.md)。修改运行源码须同步适配增量并核对重建哈希，不能用旧生成器覆盖当前源码。
