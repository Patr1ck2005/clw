# 2026-10-28: CLW source is now open under MIT

The complete application source, native source archive, tests and build entrypoints are now available here. See [the engineering retrospective](docs/ARCHITECTURE_REVIEW.md), [source instructions](docs/SOURCE.md) and [source delivery](docs/OPEN_SOURCE_RELEASE.md).

The source snapshot is `22480823a91484d2bd5a911ef5ca565aaeebd87c`; per-file provenance is in `SOURCE_EXPORT.json`. Private operational history remains outside this public repository. Public fixtures are synthetic; third-party licenses are preserved.

This is a source publication, not a new installer. Existing preview.2 binary assets, their hashes and original bundled notices remain unchanged. They do not automatically include subsequent source fixes. Actual publication checks are recorded in `SOURCE_VALIDATION.json`.

---

# CLW 0.8.0-preview.2

本次更新修复原生任务完成通知对 `timeout` 终态的处理，并为失败通知加入每候选 30 秒退避。Job 的原始结果和执行身份继续保留，不因此重放已受理任务。

工具桥接现在保留固定存储错误码、调用身份和阶段耗时；连接守候能区分观察期限结束与已证实的 Runner 离线。诊断不记录资源 URI 或文件正文。

正常安装升级现在可更新版本目录内的私有执行环境；维护时沿原事务重新绑定整组程序，回退也恢复对应的程序版本，保留账号、目录配置与本机数据。已有的开机自动连接入口会先更新到目标版本，随后才切换版本与清理旧程序；登记中断可沿原事务继续。

各设备仍使用同一完整安装包，并分别配置自己的账号、连接和数据。升级通过手动运行新版 EXE 完成。

实际安装包身份、SHA256、验证环境、通过范围及待验项目，以本次 Release 随附的 `DISTRIBUTION.json` 和 `ACCEPTANCE.md` 为准。此前 0.8.0-preview.1 的一小时观察属于原版本证据，本次没有重复该窗口。
