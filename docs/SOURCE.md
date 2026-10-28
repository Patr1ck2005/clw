# 源码、验证与构建

公开入口：[Patr1ck2005/clw](https://github.com/Patr1ck2005/clw)。自有代码MIT；第三方许可见[NOTICE](../NOTICE.md)。先读[架构复盘](ARCHITECTURE_REVIEW.md)，再按要修改的模块深入。

## 源码范围

`apps/` 包含桌面工作区、网页推理桥、Edge伴侣及其测试；`scripts/` 包含持久任务、准入、连接恢复和发行逻辑；`tests/` 保留回归测试；`ops/`、`packaging/` 保留首次初始化与安装入口。依赖锁、离线公式资产、vendor来源、backport/overlay和原生源码归档一起公开。

Rust原生源码目前按原有可恢复Git归档保存在 [vendor/native-runtime](../vendor/native-runtime/README.md)，不是一个仅有二进制的闭源组件。按该README解压到新的空目录即可检查与构建；保留其Apache-2.0声明与原commit身份。

公开源码是从私有工程库的明确提交导出，`SOURCE_EXPORT.json`记录对应提交、每个文件的SHA256和合成化范围。没有公开旧库的私人运行历史。`evidence/`、`checkpoints/`、实例CURRENT/PLAN、账号交接和原始用户需求不作为源码分发；可公开的实验结论留在架构复盘及去身份摘要。原操作数据不因导出而删除。

示例项目、历史控制台样本和旧恢复测试中的实例身份已合成化；默认目标列表为空，个人预授权不转赠给安装者。测试中的“在线”“成功”和样例时间均不表示真实连接。源码中的部分开发路径及旧入口仍体现原开发环境，应按本机配置调整；固定vendor字节不为美化路径而篡改。不要直接把开发机恢复脚本当成新用户首次配置。

## 不启动模型的本地检查

从仓库根执行。Python与Node版本以所选模块/依赖要求为准；下面检查只使用本地fixture，不要求登录ChatGPT：

```powershell
python -B -m unittest discover -s tests -p test_open_source_export.py
python -B -m unittest discover -s tests -p test_web_workspace_release.py
python -B -m unittest discover -s tests -p test_native_work_admission.py
node --test tests/control-center.test.mjs tests/live.test.mjs tests/task-client.test.mjs tests/journal-client.test.mjs tests/account-view.test.mjs tests/asset-client.test.mjs tests/product-status.test.mjs
```

带 `browser`、`live` 或外部执行入口的其他测试可能需要专用环境，不能把整个测试库无差别运行在正在工作的浏览器上。本轮开源验证的实际项目与结果记录在公开交付说明中，不将上面的可用入口自动写成全量通过。

发行测试同时包含纯fixture检查和真实构建材料检查。干净源码中尚未构建helper或安装依赖时，后者明确跳过并给出缺少材料，不当作通过。准备下节构建环境后再运行，才可验证完整发行清单。

## 源码开发与安装包

桌面载体使用Electron，桥的TypeScript源码使用Bun；Python负责本地状态与管理。先安装各模块锁定依赖：

```powershell
npm ci --prefix apps/web-host
Push-Location apps/codex-web-bridge/upstream
bun install --frozen-lockfile
Pop-Location
bun apps/codex-web-bridge/upstream/scripts/build-browser-helper.ts apps/codex-web-bridge/upstream/dist/browser-helper.cjs
```

这些是构建者动作，会下载依赖；本次文档发布没有替用户执行这些安装。Bun版本在上游package中固定；不要用旧生成器覆盖已修改的vendor源码。按 `UPSTREAM.json`、overlay/backport manifest核对来源及构建结果。

查看正式入口及参数：

```powershell
python -B scripts/web_workspace_release.py --help
python -B scripts/preview_installer.py --help
```

完整Windows EXE还需要发行清单明确列出的Python、PowerShell、Electron、Bun、原生程序、Tunnel客户端和Inno Setup构建材料。沿现有 `prepare → install → select → inspect` 合同，配置自己的固定组件路径与哈希；不复制别人的登录、配置或运行目录。详见[候选发行](WEB_WORKSPACE_CANDIDATE.md)及 [packaging/preview.iss](../packaging/preview.iss)。

**本次交付是完整源码开源，并未生成新EXE，也没有在干净Windows机器重做安装验收。** 已有Release资产保持原样。源码可检查、历史包可下载、当前源码可一键全平台复现是三个不同主张；最后一个没有在本轮得到证明。

## 后续维护

优先改已有模块及其合同，避免再加独立监督器或状态库。涉及发送、停止、取消与恢复时保留原操作身份和用户手动状态；观察故障不应触发业务重放。问题报告明确区分源码测试、实际装载和真实任务结果。

公开仓库可正常fork和提交PR。私有工程库保留现场档案，今后同步用可审阅源码导出，不把私有Git历史合并到公开仓库。旧安装包与旧回执不可用同名内容覆盖。
