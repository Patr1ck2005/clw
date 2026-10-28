# ChatGPT Web 正式接入：当前缺口与最短操作

本版本已增加原生Web提供者代码：精确绑定现有Agent/Conversation、面板指令持久化、原生消息投递、带署名的公开回复回传、原请求去重、跨载体同工程写入互锁。不是抓取ChatGPT页面，也不自动替换成本地Codex。

## 已知授权阻塞

产品现有连接是**managed user PAT**，来自早先操作者明确选择的Runner登录配置及配套user-token引用。不是网页Cookie，也不是Codex登录。保留的原生响应为HTTP403，缺少communication:read。发送还需要communication:manage。当前Local-MCP的Agent可见性不代表产品这份PAT拥有相同范围或主体；修复scope以后还必须核对已配置A Agent及Conversation在原用户下可见。

权限由原生WebCodex管理，不由CLW给自己增加。需要原WebCodex管理员或当前登录者沿原正式令牌/授权路径为**产品正在使用的同一用户通信主体**开放所需通信权限。请勿把Server bootstrap token换进产品，勿用Runner token，勿改写已有Agent归属，也不要通过重建Tunnel来处理scope问题。尚未从当前原生工具目录得到可供产品直接办理该增量授权的接口，因此这里不提供未经实测的管理员修改命令。

## 授权修复后的使用

当前面板左侧“接入ChatGPT Web”显示保留的精确拒绝原因和检查时间；不会反复轮询一个已经被拒绝的操作。管理员完成原连接授权后，点击“原连接授权已修复，重新检查”。这只是重新读取，不会触发模型。

只有原后端版本、目标Agent、Conversation参与者与代次核验通过，才能点“绑定 ChatGPT Web · A 主对话”。确认仅允许该面板往这个原生对话投递你输入的要求，不是新建网页，不重置原W1/W2任务。第一次尝试发送若仍缺manage权限，会保存明确拒绝，不转发到Codex。

Agent收到实际Host新回合后按WEB_RECEIVER.md读取全文，开发并发布公开回复。面板只展示真实Agent署名且reply_to匹配原Message的回复；读取失败保留历史，Delivery consumed不会让项目自动完成。紧急中断使用原ChatGPT页面/原Job，面板不伪造原生Web停止成功。

## 当前实现与验收口径

本轮代码与隔离测试不能作为实际Web模型双向开发已通过的证明。原M首次真实Host续接的历史证据保留，但新面板端到端仍需在正式授权通过后执行。老Codex线程、原store、旧暂停试用、Server/Runner/Tunnel均保持。原项目范围仅CLW自身。
