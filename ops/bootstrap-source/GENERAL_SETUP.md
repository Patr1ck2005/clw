# 通用WebCodex：一个执行环境，多个项目和账号入口

**高级CLI备选，不是当前首次使用步骤。** 本机所有者现在优先按DESKTOP_FIRST_RUN.md使用原版Desktop完成正常安装/授权，由上游界面管理通用Server/Runner。不需要同时运行本文的初始化与配对命令；两种管理路径不混用。以下保留给明确选择CLI部署时参考。

本页替代上一轮按账号用途分Code/Math的设置。目标是：先连通一套通用WebCodex，在会话中选择项目。两个账号均可开发、研究或处理其他任务，不设置固定职业或项目绑定。

## 当前事实

WebCodex v0.4.1与固定tunnel-client v0.0.12已校验。前轮code/math配置未启动、未配对，保留为停用历史，不能直接用于本页。通用workspace配置尚未初始化，也没有账号端真实验收。
先前代理启动/配对调用的安全拒绝仍未解决，本轮不尝试另一方式执行。以下是本机所有者主动配置的正常步骤，不关闭安全检查，不向聊天发送密钥。
数学项目目标名称为math-research；Windows目前拒绝旧目录的改名操作，实际仍在sun-math-research。请先完成目录更名，或暂时仅登记已存在的clw-webcodex，不能登记不存在的目标路径。

## 1. 先完成一个通用入口

使用上游普通Server/Runner或官方桌面正常安装流程，不做专门Code/Math版本。已备CLI的本机路径：

```text
D:\Dev\Projects\Personal\webcodex-workflow\vendor\webcodex-v0.4.1\webcodex.exe
```

手动CLI路径使用独立workspace配置，默认回环18791端口。首次初始化仅在路径不存在时运行；若发现已有状态，先核对，不覆盖：

```powershell
$root = 'D:\Dev\Projects\Personal\webcodex-workflow'
$p = Join-Path $root 'profiles\workspace'
$wc = Join-Path $root 'vendor\webcodex-v0.4.1\webcodex.exe'
if (Test-Path $p) { throw 'Workspace state exists. Inspect before initializing.' }
& $wc server init --listen 127.0.0.1:18791 --data-dir (Join-Path $p 'data') --env-file (Join-Path $p 'server.env') --json
if ($LASTEXITCODE -ne 0) { throw 'Initialization failed. Inspect local files before retry.' }
$envFile = Join-Path $p 'server.env'
$text = [IO.File]::ReadAllText($envFile)
if (-not $text.Contains('WEBCODEX_SHARED_KEY_ENABLED=true')) { throw 'Unexpected configuration; inspect locally.' }
[IO.File]::WriteAllText($envFile, $text.Replace('WEBCODEX_SHARED_KEY_ENABLED=true','WEBCODEX_SHARED_KEY_ENABLED=false'), [Text.UTF8Encoding]::new($false))
Remove-Variable text
```

随后双击START.cmd（或用上游server run保持前台，二选一）。初始化或启动不是连接成功；还需正常本地pairing/login与Runner启动。
本地WebCodex用户名用workspace-owner之类中性名称。只选择本次允许的项目根；首次可以只登记clw-webcodex，之后通过project register登记其他存在的目录。不要因为文件位于同一大目录便自动授权所有兄弟项目。
上游允许login通过多个明确allowed-root扩展项目范围；若希望两项目都可用，完成改名后再分别登记clw-webcodex和math-research。项目选择与账号标签独立，不为第二账号重新建立“数学版服务”。

正常pairing/login的参数和密钥处理以固定上游指南为准：sources/webcodex-v0.4.1/webcodex-f080c8f3ea70e37bd9f17fdd0e1b4c3a3aa330f8/docs/PERSONAL_SETUP.md。相同配对码只兑换一次，不为了重新显示配置再配对。不要向模型粘贴server.env、PAT、Runner配置或平台密钥。

## 2. 接入账号，而不是分配账号用途

先让当前账号完成一个真实MCP读取、可回查写入与后台Job检查。再让另一个账号通过其正式授权接入同一WebCodex后端。
若两个账号所在的Platform/ChatGPT工作区不能共享同一个Tunnel权限，可以分别关联接入通道；它们仍连接同一通用后端。这是接入认证差异，不是Code/Math业务隔离，也不意味着必须维护两套Server。
仅本人拥有并授权访问相同项目的账号可以共用相同本地工作主体；需要权限差异时才建立独立本地主体与项目授权。会话/任务ID和写入所有权始终独立，账号相同或不同都不能并发无约束写同一文件。
通用显示名用WebCodex或自定义普通名称，不使用按用途限制的产品变体。

OpenAI Tunnel配置和本地认证注入仍用固定上游Windows指南以及当前官方文档。Tunnel+No authentication只在本机已经正常注入认证时适用，不得让WebCodex公开匿名访问。
平台账户授权是人工环节；本次没有替你登录、创建Tunnel或执行被拒绝的账号配对。

## 3. 日常完整任务

选择项目 → 说明完整目标/验收 → 持续执行至完成。重要状态变化保存检查点后继续，不因时长停轮、拆任务或要求新对话。
真正中断时恢复同一任务的目标、文件状态和原Job；已接受操作不重跑。瞬时只读失败有限恢复；平台限制、权限拒绝或用户停止不绕过。
代码任务可使用../clw-webcodex/prompts/START_CODE.md；数学协作角色是该项目的可选模板，不是账号身份。

## 4. 当前下一步

完成一套通用入口的正常初始化/本机配对/Runner启动和当前账号实测，然后复用到第二账号。此链路未完成前，不继续扩展自研桌面或执行内核。
旧START-CODE/START-MATH入口只显示停用提示，不再启动旧配置。STATUS.cmd只读通用workspace状态，不代表端到端健康。

## 一手资料

- 固定普通多项目路径：https://raw.githubusercontent.com/yyjeqhc/webcodex/v0.4.1/docs/PERSONAL_SETUP.md
- OpenAI Tunnel权限/工作区关联：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
