# CLW · Web Workspace

CLW 是一个 Windows 本地 Agent Harness 实验：把网页模型、原生 Codex、本地 MCP 工具和可恢复的任务记录连接起来。支持直接操作原网页，也提供 Codex＋Web 桥与 Edge 网页伴侣。

**2026-10-28 起，自有源码采用 [MIT](LICENSE) 开源。** 公开源码及下载统一在 [Patr1ck2005/clw](https://github.com/Patr1ck2005/clw)。第三方代码保留各自许可；私人账号、聊天、连接配置和操作历史不在公开源码中。

这是可研究、可修改的工程实现，**不是已证明长期无人值守稳定的产品**。网页结构变化、平台连接与协议兼容仍会造成失败。我们保留这些限制，并在[架构与稳定性复盘](docs/ARCHITECTURE_REVIEW.md)中解释具体机制、已有证据和取舍。

## 从哪里开始

- **理解原理与面试准备：**[架构复盘](docs/ARCHITECTURE_REVIEW.md)。包含三条执行路线、失败案例、并发与幂等，以及值得保留和简化的部分。
- **看源码、运行测试与构建：**[源码说明](docs/SOURCE.md)。完整应用、桥、伴侣、测试、打包入口及原生源码归档均提供。
- **现有安装包：**[GitHub Releases](https://github.com/Patr1ck2005/clw/releases)。`0.8.0-preview.2` 是较早的不可变安装包，**不包含截至本次开源的全部源码修复，也未因此重新验收**；版本、哈希和条款以该发行自身记录为准。
- **日常使用：**[安装与启动](docs/WEB_WORKSPACE_START.md)、[手动指南](docs/harness/MANUAL.md)、[账号与数据隐私](docs/PRIVACY.md)。用户自行提供第三方账号、网络和平台权限。

## 三条路线

| 路线 | 用途 | 实现入口 |
|---|---|---|
| 纯 Web＋Local-MCP | 网页模型调用自己的本地工具；工作区管理记录、Goal和下一轮补充 | [web-host](apps/web-host)、[Harness](scripts/serve_harness.py) |
| Codex＋Web | 网页推理配合原生 Codex 文件、终端和工具能力 | [桥的使用说明](apps/codex-web-bridge/README.md) |
| Edge Companion | 在已经打开的原网页上观察、程序控制和有限恢复 | [伴侣说明](apps/web-recovery-companion/README.md) |

模型与人工操作优先；已受理或结果未知的操作查询原回执，避免盲目重发。独立Job、网页生成与目标验收分别记录。源码开源不改变用户的登录或现役任务，也不自动迁移已有环境。

## 来源与反馈

CLW 复用并修改了 `codex-chatgpt-web` 等开源组件，不是从零重写所有执行内核。[第三方说明](NOTICE.md)列出原许可证与固定来源；原生 Server／Runner 的 Apache-2.0 源码见 [vendor/native-runtime](vendor/native-runtime/README.md)。提交保留实际 AI 辅助来源。

可通过 [Issues](https://github.com/Patr1ck2005/clw/issues)反馈具体版本、操作、预期与实际结果。不要把账号密钥、Cookie、私人聊天或项目正文放进公开 Issue。此仓库没有新增遥测、云端调度或自动更新服务。
