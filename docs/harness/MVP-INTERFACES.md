# Harness MVP: native Web + Codex, one view, separate providers

User-confirmed scope: a usable conversation-first development product, followed by self-hosted iteration. AI owns planning and delegation; no required role templates, business stages or rework quotas. Existing paused ACCOUNT-A-SELF-TRIAL is preserved.

## This implementation's ownership
M (existing A Session) owns integration, UI, harness session bindings/replay journal, HTTP/API, launcher, docs and shared Git index. A new genuine local Codex engineering branch may only create `scripts/harness_rpc.py` and `tests/test_harness_rpc.py`. It is not W1 or W2; it does not change their files or identities. Shared index is M-only. No installs, token changes, native Server/Runner/Tunnel changes, old maintenance, unrelated project writes, pushes or history rewrites.

## Thin runtime contract
The installed Codex App Server is the Codex execution authority. WebCodex remains the native-Web execution/communication authority. Local harness SQLite stores only provider/thread bindings, parent relations, user-visible events and exact operation receipts; no competing business completion state.

Transport module `harness_rpc.py` exports:
- `RpcFailure(code: str, *, unknown: bool = False)`: safe error code, flag that a dispatched request may have taken effect. No provider raw errors/secrets in exception text.
- `codex_command() -> list[str]`: resolve installed executable without installation or scanning credential stores; Windows npm wrapper uses its existing Node entry, if unambiguously present.
- `CodexConnection(root: Path, on_event: Callable[[dict], None], command: list[str] | None = None)`. Optional command is test-only constructor injection, never HTTP input.
- `start() -> dict`: launch owned `codex app-server --listen stdio://`, initialize with `clw_harness` metadata then send `initialized`. Never log in, change config, create model turns or replace models. Return initialization result.
- `request(method: str, params: dict, timeout: float = 30) -> dict`: correlated one-time JSONL request; notifications/server requests flow to callback. No automatic replay of writes. JSON-RPC errors return a bounded RpcFailure.
- `respond(request_id, result: dict)`: send server request response exactly once; used for real explicit approval decisions by the user, not blanket approvals.
- `close()`: close stdin, bounded wait and terminate only owned process as necessary, unblock pending requests, close streams. `alive` property and `pid` property.

Use bounded lines/queues, concurrent requests, clean EOF, malformed-line failure, callback isolation and timeout/late-response observation. Server requests with an `id` go to callback and must not be mistaken for responses. `clw/lateResponse` may carry `{id, result|error}` after a request timed out, for caller reconciliation; it is not replay.

The application exposes capabilities per provider. Codex create/fork/turn/interrupt use actual supported native APIs. Web messages use existing Conversation tools only after the exact configured connection is authorized. Pi/ACP-compatible harnesses can implement the same application-level adapter contract; they are not falsely advertised as tested providers.

## Initial surface
Existing approved Codex-like layout: project + threads left, current conversation centre, changes/connection details right. API connects to one explicit root initially (this product), keeps drafts per thread, persists send intention before dispatch, streams public output via bounded event polling, exposes stop and genuine native history fork. No hidden thinking mirror, synthetic AI responses or fake Git actions.

Auth is checked before inference: use existing ChatGPT Codex login; no API key fallback. Existing model/effort preserved unless user explicitly chooses supported values. Approvals surfaced as pending requests. Browser capabilities never expand filesystem scopes. Read diagnostics distinguish native 401/403 and required scope without echoing credentials.

## Acceptance
Real installed protocol handshake; transport unit tests; HTTP-origin/body/input isolation; send replay protection; one actual Codex turn on a scoped development request; real public answer shown through API; reload retains thread identity; fork/interrupt only called when supported. Browser end-to-end only on allowed local tool path; previous blocked operations are not silently replayed. Program fixtures and actual model/Host results remain separately labelled.
