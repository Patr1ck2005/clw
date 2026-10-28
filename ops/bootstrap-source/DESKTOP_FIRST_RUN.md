# 现在需要你做什么

先在本机完成原版WebCodex Desktop的安装与账号授权；代码开发和检查继续由助手完成。无需再次批准Git，不必手工运行前轮的Server/Runner/配对脚本。

## 现在先做：安装并打开原版窗口

已准备匹配现有固定版本的安装包：

```text
D:\Dev\Projects\Personal\webcodex-workflow\downloads\webcodex-desktop-v0.4.1-win32-x64-setup.exe
```

文件SHA-256为177f450120a618be32e20fdb0fdc1b9b1bd0d55c3060146555d931b6d2627b4a，与发布者SHA256SUMS一致。这是来源完整性核对，不是安全审计。Windows Authenticode检查为NotSigned；安装包未数字签名。本轮没有启动安装程序。若Windows或本机政策拦截，不关闭防护、不绕过拦截，先检查发布者与本机允许的安装方式。

安装完成后打开WebCodex，选择Local Full Runtime / Use WebCodex on this computer，并选择真实项目：

```text
D:\Dev\Projects\Personal\clw-webcodex
```

这是上游普通多项目运行模式，不是临时Quick Share，也不是专用代码版。后续从Projects添加其他已授权目录；第二账号用途不受限制。math-research实际目录更名暂时被Windows拒绝，不阻塞先连接这个已存在项目。
桌面使用其自己的本地数据目录，不读取或迁移前轮未启动的CLI profiles/code、profiles/math，也不需要先创建profiles/workspace。不同时运行旧START脚本和Desktop来提供同一服务。

## 然后做：当前账号的一次正常Tunnel授权

在浏览器中登录当前账号，打开OpenAI Platform的Settings → Organization → Tunnels。创建或选择可用Tunnel，并关联目标ChatGPT工作区。
创建/编辑需要Tunnels Read + Manage；运行和使用需要Read + Use。使用Restricted Key，只给予本次所需的Tunnel权限。实际可用性以当前账号权限为准，不以已购买ChatGPT订阅推定拥有全部Platform权限。

在WebCodex的Settings → OpenAI Tunnel network填写Tunnel ID和Tunnel API key，点击Save configuration。密钥只填本机密码输入框，不发送到聊天、Git或截图。
该固定版本将Tunnel Key保存在用户应用数据目录下的未加密配置文件中；不要共享或自动打包该secrets目录。本流程不修改系统环境变量，不使用额外的模型推理API。

等Service、Runner、Project就绪后，在Connection选择OpenAI Secure Tunnel并点击Start secure tunnel。出现“Tunnel ready; waiting for ChatGPT”只表示本地准备完成。
在ChatGPT开发连接中选择Tunnel、填写对应Tunnel ID、Authentication选None/No authentication。这里由本机Tunnel注入WebCodex认证，不是把本地服务改成匿名开放。不要把API Key误填为Tunnel ID。

## 接通之后由助手执行

发现真实WebCodex工具与项目，读取本项目一个小文件，做一次可回查的写入和一个后台Job，核对原回执及恢复行为。随后开始用WebCodex开发本产品，并接入第二账号；不要求第二账号也先完成才能用第一个账号工作。
不要仅凭桌面绿色状态标记端到端成功。当前对话尚只有ShunCode MCP可用于本机准备，不应声称已经转到WebCodex执行。
任务仍按完整目标持续推进。重要变化保存检查点后继续，不因为一小时或任意分钟数主动拆任务、降档或结束回合。

## 本次准备边界

本轮只下载/核对上游安装文件、读取状态和改进非秘密指南。此前代理启动/配对操作曾被平台拦截，未换入口重试；本机所有者需按普通安装和账户授权界面操作。没有执行安装、启动服务、登录账号、读写凭据或重试目录改名。
GENERAL_SETUP.md是高级CLI备选，不是现在的必读操作单；旧Code/Math流程继续停用。

## 核验来源

- WebCodex固定Windows安装流程：https://raw.githubusercontent.com/yyjeqhc/webcodex/v0.4.1/docs/desktop-install.md
- WebCodex普通多项目流程：https://raw.githubusercontent.com/yyjeqhc/webcodex/v0.4.1/docs/PERSONAL_SETUP.md
- 发布文件：https://github.com/yyjeqhc/webcodex/releases/tag/v0.4.1
- 当前OpenAI Tunnel权限及关联：https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

以上是各来源的安装/权限说明；本机是否已运行以实际状态与回执为准。
