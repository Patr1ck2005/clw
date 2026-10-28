# CLW source notices

CLW-owned code is available under the root MIT LICENSE, effective for this source release on 2026-10-28. Third-party components retain their own copyright and license terms. The change does not alter an older immutable installer's bundled bytes or notices.

| Component | Source and license material |
|---|---|
| codex-chatgpt-web browser bridge and carrier | [Bridge provenance](apps/codex-web-bridge/upstream/UPSTREAM.json), [bridge MIT license](apps/codex-web-bridge/upstream/LICENSE), [carrier provenance](apps/web-host/vendor/codex-chatgpt-web/UPSTREAM.json), [carrier MIT license](apps/web-host/vendor/codex-chatgpt-web/LICENSE). CLW changes are retained as overlay/backport patches and manifests. |
| Native WebCodex Server, Runner and CLI | [Source archive, patches and reproduction](vendor/native-runtime/README.md), [Apache-2.0 license](vendor/native-runtime/LICENSE-APACHE-2.0). This component is not relicensed to MIT. |
| Markdown rendering | [markdown-it MIT](apps/web-host/assets/vendor/markdown-it/LICENSE), [markdown-it-texmath MIT](apps/web-host/assets/vendor/markdown-it-texmath/LICENSE). |
| Math typesetting and fonts | [KaTeX MIT and included materials](apps/web-host/assets/vendor/katex/LICENSE). |
| Tokenization | [tiktoken license](docs/licenses/tiktoken-1.0.22-LICENSE.txt). |

Dependency versions and transitive licenses are additionally recorded in the relevant package manifests and lockfiles. Electron/Chromium, Bun/JavaScriptCore, private Python, PowerShell, Tunnel client and installer dependencies require their corresponding notices and, where applicable, source/relink materials when binaries are redistributed. The existing release builder assembles that binary inventory; this source notice is not a substitute for an actual binary release inventory.

The repository does not grant rights to third-party accounts, subscriptions, online services or trademarks. No credentials, browser profiles or private task records are required to study the source. Public fixtures are synthetic and do not represent current connected accounts or permissions.
