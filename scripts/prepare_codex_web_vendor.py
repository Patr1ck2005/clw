"""Import the approved immutable upstream sources, with reviewed CLW adaptations.

Does not install dependencies, touch Codex settings, or launch any runtime.
"""
from pathlib import Path
import argparse,hashlib,json,re,subprocess,io,tarfile,tempfile
ROOT=Path(__file__).resolve().parents[1]
COMMIT='a13cd09950969f43e3b7e25c71fa43efaf5446c5'
# One complete release baseline, not a mixture of runtime versions.
REPOSITORY='https://github.com/miuuyy/codex-chatgpt-web'
OVERLAY_ROOT=ROOT/'apps/codex-web-bridge/vendor-overlays'
BACKPORT_ROOT=ROOT/'apps/codex-web-bridge/vendor-backports/6.1.2'
BACKPORT_COMMIT='2d73f626290a5062825bb595dabb89aaf88d16c5'
POST_BACKPORT_ROOT=OVERLAY_ROOT/'post-backport'

def apply_reviewed_overlay(prepared,entries,*,overlay_root=None,allowed_prefixes=('src/','tests/')):
    """Apply and verify reviewed CLW patches against the fixed upstream base."""
    overlay_root=Path(overlay_root) if overlay_root is not None else OVERLAY_ROOT
    manifest_path=overlay_root/'manifest.json'
    if not manifest_path.is_file():return prepared,entries
    manifest=json.loads(manifest_path.read_text(encoding='utf8'))
    if manifest.get('version')!=1 or manifest.get('baseline_commit')!=COMMIT or manifest.get('patch')!='clw.patch':
        raise ValueError('vendor_overlay_manifest_invalid')
    listed=manifest.get('files')
    if not isinstance(listed,list) or not listed:raise ValueError('vendor_overlay_files_missing')
    base={str(path).replace('\\','/'):content for path,content in prepared}
    names=set(base)
    overlays={}
    for item in listed:
        if not isinstance(item,dict):raise ValueError('vendor_overlay_entry_invalid')
        name=item.get('path')
        if (not isinstance(name,str) or not name.startswith(allowed_prefixes) or '\\' in name or
                Path(name).is_absolute() or any(part in ('','.','..') for part in name.split('/')) or name in overlays):
            raise ValueError('vendor_overlay_path_invalid')
        if not isinstance(item.get('sha256'),str) or not re.fullmatch('[0-9a-f]{64}',item['sha256']):
            raise ValueError('vendor_overlay_target_hash_invalid')
        before=item.get('base_sha256')
        if name in base:
            if not isinstance(before,str) or hashlib.sha256(base[name]).hexdigest()!=before:
                raise ValueError('vendor_overlay_base_changed: '+name)
        elif before is not None:
            raise ValueError('vendor_overlay_new_file_base_invalid: '+name)
        overlays[name]=item
    with tempfile.TemporaryDirectory(prefix='clw-vendor-overlay-') as directory:
        stage=Path(directory)
        for name,content in base.items():
            out=stage/name;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(content)
        patch=overlay_root/'clw.patch'
        if not patch.is_file():raise ValueError('vendor_overlay_patch_missing')
        for args in (('apply','--check',str(patch)),('apply',str(patch))):
            subprocess.run(['git','-C',str(stage),'-c','core.autocrlf=false',*args],
                           check=True,capture_output=True)
        nodes=list(stage.rglob('*'))
        if any(p.is_symlink() for p in nodes):raise ValueError('vendor_overlay_symlink_forbidden')
        found={p.relative_to(stage).as_posix() for p in nodes if p.is_file()}
        if found!=names|set(overlays):raise ValueError('vendor_overlay_file_set_changed')
        updated={name:(stage/name).read_bytes() for name in found}
        # Git for Windows can materialize patched text with CRLF outside a worktree.
        # Normalize only when that produces the exact reviewed target digest.
        for name,item in overlays.items():
            raw=updated[name]
            if hashlib.sha256(raw).hexdigest()!=item['sha256']:
                normalized=raw.replace(b'\r\n',b'\n')
                if hashlib.sha256(normalized).hexdigest()==item['sha256']:
                    updated[name]=normalized
    changed={name for name in updated if name not in base or updated[name]!=base[name]}
    if changed!=set(overlays):raise ValueError('vendor_overlay_changed_files_mismatch')
    by_name={entry['path']:entry for entry in entries}
    for name,item in overlays.items():
        digest=hashlib.sha256(updated[name]).hexdigest()
        if digest!=item['sha256']:raise ValueError('vendor_overlay_result_hash_mismatch: '+name)
        note='Reviewed CLW overlay: '+item.get('reason','local adaptation')
        if name in by_name:
            by_name[name]['sha256']=digest
            by_name[name]['adaptations'].append(note)
        else:
            by_name[name]={'path':name,'source_commit':None,'source_sha256':None,
                           'sha256':digest,'adaptations':[note]}
    return sorted(updated.items()),[by_name[name] for name in sorted(by_name)]

def adapted(name,raw):
    if name=='launcher/electron/atomic-file.cjs':
        # Reuse the pinned upstream Windows replacement/retry implementation.
        # Only critical CLW intent/exit records opt into flush before replace.
        s=raw.decode('utf8')
        replacements=[
          ('{ mode = 0o600, protectDirectory = true } = {}',
           '{ mode = 0o600, protectDirectory = true, flush = false } = {}'),
          ('  try {\n    fs.writeFileSync(temporary, content, { flag: "wx", mode });',
           '  let fd;\n  try {\n    fd = fs.openSync(temporary, "wx", mode);\n    fs.writeFileSync(fd, content);\n    if (flush) fs.fsyncSync(fd);\n    fs.closeSync(fd); fd = undefined;'),
          ('    fs.rmSync(temporary, { force: true });',
           '    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }\n    // Cleanup cannot turn a committed replacement into an ambiguous failure.\n    try { fs.rmSync(temporary, { force: true }); } catch {}')]
        for old,new in replacements:
            if s.count(old)!=1:raise ValueError('upstream_atomic_write_changed')
            s=s.replace(old,new)
        return s.encode('utf8'),['Optional flush before atomic replacement for durable CLW intents; cleanup cannot report a committed replacement as failed. Original Windows bounded lock retry retained.']
    if name not in {'src/chatgpt-session.ts','src/server.ts','src/adapters/chatgpt-web/browser-worker.ts',
                    'src/adapters/chatgpt-web/concurrency.ts','src/adapters/chatgpt-web/turn-broker.ts','src/adapters/chatgpt-web/markdown.ts',
                    'launcher/electron/browser-host.cjs','src/launcher-browser-host.ts',
                    'tests/chatgpt-effort-browser.test.ts','tests/retained-compaction.test.ts','tests/browser-worker-contract.test.ts',
                    'tests/dev-chat.test.ts','tests/zero-risk-mcp-lifecycle.test.ts','tests/browser-turn-binding.test.ts'}:
        return raw,[]
    s=raw.decode('utf8');changes=[]
    if name=='src/adapters/chatgpt-web/turn-broker.ts':
        old='interface ToolWaiter {'
        new='''interface CompletedToolReceipt {
  resultDigest: string;
  receipt: { completed: true };
}

interface ToolWaiter {'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_receipt_type_changed')
        s=s.replace(old,new)
        old='''  invocations: Map<string, PendingInvocation>;
  waiters: Set<ToolWaiter>;'''
        new='''  invocations: Map<string, PendingInvocation>;
  /** ACK-loss retries are idempotent only while this exact broker token remains live. */
  completedToolReceipts: Map<string, CompletedToolReceipt>;
  waiters: Set<ToolWaiter>;'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_channel_changed')
        s=s.replace(old,new)
        old='function errorOf(value: unknown): Error {'
        new='''function canonicalResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalResult(item)]));
}

function toolResultDigest(result: BrokerToolResult): string {
  return createHash("sha256").update(JSON.stringify(canonicalResult(result))).digest("hex");
}

function errorOf(value: unknown): Error {'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_digest_anchor_changed')
        s=s.replace(old,new)
        old='''      invocations: new Map(),
      waiters: new Set(),'''
        new='''      invocations: new Map(),
      completedToolReceipts: new Map(),
      waiters: new Set(),'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_register_changed')
        s=s.replace(old,new)
        old='''  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();'''
        new='''  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.completeToolReceipt(token, callId, result);
  }

  private completeToolReceipt(token: string, callId: string, result: BrokerToolResult): { completed: true } {
    this.prune();'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_method_changed')
        s=s.replace(old,new)
        old='''    this.assertSafeHarnessRunning(channel, true);
    const invocation = channel.invocations.get(callId);'''
        new='''    // A Zero Risk turn can remain allocated briefly after terminal completion.
    // Its old ACK cannot become a back door through that terminal state.
    this.assertSafeHarnessRunning(channel, true);
    const digest = toolResultDigest(result);
    const completed = channel.completedToolReceipts.get(callId);
    if (completed) {
      if (completed.resultDigest !== digest) throw new Error(`tool call completion result conflicts with original: ${callId}`);
      return completed.receipt;
    }
    const invocation = channel.invocations.get(callId);'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_lookup_changed')
        s=s.replace(old,new)
        old='''    channel.invocations.delete(callId);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);'''
        new='''    channel.invocations.delete(callId);
    const receipt = { completed: true } as const;
    channel.completedToolReceipts.set(callId, { resultDigest: digest, receipt });
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
    return receipt;'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_commit_changed')
        s=s.replace(old,new)
        old='''      this.completeTool(request.token, request.callId, request.toolResult);
      return { completed: true };'''
        new='''      return this.completeToolReceipt(request.token, request.callId, request.toolResult);'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_dispatch_changed')
        s=s.replace(old,new)
        changes.append('Cache only the canonical result digest and original owner_complete ACK for each live token/call. Exact ACK-loss retries return the same receipt; changed results, invalid tokens and terminal Zero Risk turns remain rejected.')
    if name=='tests/dev-chat.test.ts':
        old='test("disconnecting a remote owner_next removes its broker waiter", async () => {'
        new='''test("owner_complete replays the original ACK only for the same token, call and result", async () => {
  const root = scratch("cgw-owner-complete-ack");
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const environment = {
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const },
    tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
  };
  let token: string | undefined;
  try {
    token = await remote.register(environment, 60_000, "owner-complete-ack");
    const { bindingId } = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke", bindingId, wireName: "exec_command", arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await remote.nextToolBatch(token);
    expect(request).toBeDefined();
    const result: BrokerToolResult = {
      content: [{ type: "text", text: "done" }],
      structuredContent: { first: true, second: 2 },
    };
    const complete = { method: "owner_complete" as const, token, callId: request!.callId, toolResult: result };
    // The first completion is applied; pretend its response never reached the owner.
    const originalAck = await callTurnBroker<{ completed: true }>(socketPath, complete);
    expect(await invocation).toEqual(result);
    const retryAck = await callTurnBroker<{ completed: true }>(socketPath, {
      ...complete,
      toolResult: { structuredContent: { second: 2, first: true }, content: [{ text: "done", type: "text" }] },
    });
    expect(retryAck).toEqual(originalAck);
    await expect(callTurnBroker(socketPath, {
      ...complete, toolResult: { content: [{ type: "text", text: "different" }] },
    })).rejects.toThrow("completion result conflicts with original");
    await expect(callTurnBroker(socketPath, {
      ...complete, callId: "call_foreign", toolResult: result,
    })).rejects.toThrow("tool call is not pending");
    await remote.revoke(token);
    await expect(callTurnBroker(socketPath, complete)).rejects.toThrow("invalid or expired");
    const expired = await remote.register(environment, 1, "owner-complete-expired");
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(callTurnBroker(socketPath, { ...complete, token: expired })).rejects.toThrow("invalid or expired");
  } finally {
    if (token) await remote.revoke(token);
    await broker.close();
  }
});

test("disconnecting a remote owner_next removes its broker waiter", async () => {'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_test_anchor_changed')
        s=s.replace(old,new)
        changes.append('Cover lost owner_complete ACK replay, canonical result equivalence, conflicting result/call and revoked or expired tokens through the local broker socket.')
    if name=='tests/zero-risk-mcp-lifecycle.test.ts':
        old='''      await expect(broker.waitForSafeCompletion(requestId)).resolves.toBe("done");
    } finally {'''
        new='''      await expect(broker.waitForSafeCompletion(requestId)).resolves.toBe("done");
      expect(() => broker.completeTool(requestId, request!.callId, toolResult({ ok: true })))
        .toThrow("Zero Risk turn is already terminal");
    } finally {'''
        if s.count(old)!=1:raise ValueError('upstream_owner_complete_safe_test_anchor_changed')
        s=s.replace(old,new)
        changes.append('Assert a cached completion cannot bypass a still-allocated terminal Zero Risk turn.')
    if name=='tests/browser-turn-binding.test.ts':
        old='test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {'
        new=r'''test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("generation acknowledgement still records the user while waiting for Activity", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const baseline = await worker.captureSubmissionBaseline(page, 'Read fixture.');
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe('generation_running');
    expect(baseline.acceptedUserIdentity).toBeUndefined();
    // Real failure: Send was acknowledged before the user mounted; the next
    // observation saw this rich bubble, then Activity replaced it for 60 seconds.
    const user = '<div data-user-message-bubble><div data-search-result-target><span data-prompt-link-href="app://fixture">Local-MCP-B</span> Read fixture.</div></div>';
    await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="accepted">${user}</div>`);
    const original = worker.submissionDomState.bind(worker);
    let observations = 0;
    worker.submissionDomState = async (...args: any[]) => {
      const state = await original(...args);
      if (++observations === 1) await page.locator('main').evaluate(node => {
        node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>';
      });
      return state;
    };
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
    expect(binding.identity).toBe('group:assistant:fallback-turn-0');
    expect(baseline.acceptedUserIdentity).toBe('group:user:accepted');
    await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="accepted">${user}<div data-content-search-unit-key="accepted:assistant"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>Done.</p></div></div><div class="turn-action-controls"><button>Copy</button></div></div>`);
    expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe('group:assistant:accepted');
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("optimistic user identity rekeys only after the exact rich prompt is visible", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read fixture.\nReturn its contents.";
    const richPrompt = '<span data-prompt-link-href="app://test">Codex Native</span> Read fixture.<br>Return its contents.';
    const user = (content: string) => `<div data-user-message-bubble><div data-search-result-target>${content}</div></div>`;
    const page = await browser.newPage();
    await page.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const baseline = await worker.captureSubmissionBaseline(page, prompt);
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");

    // The saved group mounts before its rich content. This observation must stay
    // pending, while the original submission remains confirmed and non-replayable.
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      '<div data-turn-key="persisted"><div data-user-message-bubble></div></div>');
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="persisted">${user('<span data-prompt-link-href="app://test">Codex Native</span> Read fixture.')}</div>`);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");
    await page.locator("main").evaluate((node, html) => {
      setTimeout(() => { node.innerHTML = html; }, 50);
    }, `<div data-turn-key="persisted">${user(richPrompt)}<span hidden data-chatgpt-agent-turn-start></span></div>`);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding.identity).toBe("group:assistant:persisted");
    expect(baseline.acceptedUserIdentity).toBe("group:user:persisted");
    await page.close();

    const unverifiedPage = await browser.newPage();
    await unverifiedPage.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const unverifiedBaseline = await worker.captureSubmissionBaseline(unverifiedPage, prompt);
    await unverifiedPage.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
    expect(await worker.currentSubmissionEvidence(unverifiedPage, unverifiedBaseline)).toBe("user_turn");
    await unverifiedPage.locator("main").evaluate(node => {
      node.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble></div></div>';
    });
    expect(await worker.currentSubmissionEvidence(unverifiedPage, unverifiedBaseline)).toBe("user_turn");
    unverifiedBaseline.pendingUserRekeySince = Date.now() - 60_001;
    await unverifiedPage.locator("main").evaluate(node => {
      node.innerHTML = '<div data-turn-key="fallback"><span hidden data-chatgpt-agent-turn-start></span></div>';
    });
    await expect(worker.waitForNewAssistantTurn(unverifiedPage, unverifiedBaseline, Date.now() + 2_000))
      .rejects.toThrow("could not verify the rekeyed user turn");
    await unverifiedPage.close();

    for (const scenario of ["changed-prompt", "partial-mismatch", "competing-turn", "old-group-remains"] as const) {
      const foreignPage = await browser.newPage();
      await foreignPage.setContent('<main></main>');
      const foreignBaseline = await worker.captureSubmissionBaseline(foreignPage, prompt);
      await foreignPage.locator("main").evaluate((node, html) => { node.innerHTML = html; },
        `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
      expect(await worker.currentSubmissionEvidence(foreignPage, foreignBaseline)).toBe("user_turn");
      const content = scenario === "changed-prompt" ? "Different task."
        : scenario === "partial-mismatch" ? "Read fixture. X" : richPrompt;
      let html = `<div data-turn-key="persisted">${user(content)}</div>`;
      if (scenario === "competing-turn") html += '<div data-turn-key="foreign"><span hidden data-chatgpt-agent-turn-start></span></div>';
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"></div>';
      await foreignPage.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      await expect(worker.currentSubmissionEvidence(foreignPage, foreignBaseline))
        .rejects.toThrow("ChatGPT changed the user turn that acknowledged the submission");
      await foreignPage.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {'''
        if s.count(old)!=1:raise ValueError('upstream_early_generation_identity_test_anchor_changed')
        s=s.replace(old,new)
        old=r'''    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>' : answer}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "same-user") {
        expect((await result).identity).toBe("group:assistant:submitted");
      } else {
        await expect(result).rejects.toThrow("another user turn");
      }
      await page.close();'''
        new=r'''    for (const scenario of ["same-user", "rekeyed-user", "different-user", "competing-turn", "old-group-remains", "unfinished"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "rekeyed-user" || scenario === "different-user" ? "persisted" : "submitted";
      const renderedUser = scenario === "different-user"
        ? '<div data-user-message-bubble><div data-search-result-target>Different task.</div></div>'
        : scenario === "rekeyed-user" ? user.replace("<br>", "<br><br>")
        : user;
      if (scenario === "rekeyed-user") {
        await page.locator("main").evaluate(node => {
          node.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble></div><div data-conversation-role="assistant"></div></div>';
        });
        // The fallback binding stays untrusted while the persisted bubble has
        // no content target; a later observation can still rebind it.
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity)
          .toBe("group:assistant:fallback-turn-0");
      }
      let replacement = `<div data-turn-key="${key}">${renderedUser}${scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>' : answer}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "same-user" || scenario === "rekeyed-user") {
        expect((await result).identity).toBe(`group:assistant:${key}`);
      } else {
        await expect(result).rejects.toThrow(scenario === "different-user"
          ? "changed the user turn that acknowledged the submission" : "another user turn");
      }
      await page.close();'''
        if s.count(old)!=1:raise ValueError('upstream_activity_rekey_regression_changed')
        s=s.replace(old,new)
        changes.append('DOM regressions for exact rich-prompt rekey, strict-prefix hydration, Activity fallback, timeout and foreign-turn rejection.')
    if name=='tests/browser-worker-contract.test.ts':
        s=s.replace('browser turns run concurrently up to the five-tab limit','browser turns admit more than five independently owned pages')
        s=s.replace('expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);','expect(MAX_CHATGPT_BROWSER_TABS).toBe(Number.POSITIVE_INFINITY);')
        old='''  await expect(worker.run(browserTurn("trace_6"))).rejects.toThrow("at most 5 simultaneous browser turns");

  releases.get("trace_1")?.();
  await active[0];
'''
        if s.count(old)!=1:raise ValueError('upstream_concurrency_test_changed')
        s=s.replace(old,'')
        s=s.replace('for (const traceId of ["trace_2", "trace_3", "trace_4", "trace_5", "trace_6"])','for (const traceId of ["trace_1", "trace_2", "trace_3", "trace_4", "trace_5", "trace_6"])').replace('await Promise.all([...active.slice(1), sixth]);','await Promise.all([...active, sixth]);')
        s=s.replace('expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(5_000);','expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(30_000);')
        s=s.replace('}, page)).rejects.toBe(error);','}, page)).rejects.toMatchObject({code:"browser_not_ready",cause:error,retryable:false});')
        s=s.replace('["pressSequentially", "@codex"]','["pressSequentially", "@Codex Native2"]').replace('expect(value).toBe("@codex");','expect(value).toBe("@Codex Native2");').replace('["type", "@codex"]','["type", "@Codex Native2"]')
        old='''    activeComposer: async () => selectedComposer,
    connectorIsSelected: async () => true,'''
        if s.count(old)!=1:raise ValueError('upstream_selected_connector_fixture_changed')
        s=s.replace(old,old+'\n    attachedPromptText: async () => "",')
        changes.append('Align explicit assertions with reviewed CLW unlimited slots, bounded 30s observation, readiness error and configured connector name; selected-pill fixture supplies the new empty-draft observation. Dedicated CLW tests cover foreign-draft cleanup.')
    if name=='tests/chatgpt-effort-browser.test.ts':
        old='else await expect(result).rejects.toMatchObject({ retryable: false });'
        if s.count(old)!=1:raise ValueError('upstream_effort_test_contract_changed')
        s=s.replace(old,'else { let failure; try { await result; } catch (error) { failure=error; } expect(failure).toMatchObject({ retryable: false }); }')
        changes.append('Test-only Windows/Bun async matcher workaround: await browser I/O before the same error assertion; no production logic changed.')
    if name=='tests/retained-compaction.test.ts':
        start=s.index('test("active compaction delivers');end=s.index('test("active compaction drains',start)
        part,count=re.subn(r'await expect\((.*?)\)\.resolves\.',r'expect(await \1).',s[start:end],flags=re.S)
        if count!=2:raise ValueError('upstream_compaction_test_contract_changed')
        s=s[:start]+part+s[end:]
        changes.append('Test-only Windows/Bun async matcher workaround: await named-pipe I/O before the same two receipt assertions; no broker logic changed.')
    if name=='src/chatgpt-session.ts':
        old='form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]'
        if s.count(old)!=1:raise ValueError('upstream_stop_selector_changed')
        s=s.replace(old,', '.join('form[data-chatgpt-composer] button[type="button"][aria-label="'+label+'"]' for label in ['Stop','停止','停止生成']))
        changes.append('Recognize the localized new composer Stop controls as live generation, so long reasoning does not lose its native tool authority after the DOM grace period.')
    if name=='src/server.ts':
        old='dependencies: { fetchUpstream?: NativeFetch; adapterFactory?: ChatGptWebAdapterFactory } = {},'
        new='dependencies: { fetchUpstream?: NativeFetch; adapterFactory?: ChatGptWebAdapterFactory; requestGuard?: (req: Request) => Response | undefined | Promise<Response | undefined> } = {},'
        if s.count(old)!=1:raise ValueError('upstream_server_dependencies_changed')
        s=s.replace(old,new)
        old='''    async fetch(req) {
      const url = new URL(req.url);'''
        new='''    async fetch(req) {
      const guarded = await dependencies.requestGuard?.(req);
      if (guarded) return guarded;
      const url = new URL(req.url);'''
        if s.count(old)!=1:raise ValueError('upstream_server_fetch_changed')
        s=s.replace(old,new)
        changes.append('Optional owner request guard; CLW prevents unintended native model/API fallback before any turn starts. Upstream default behavior remains unchanged.')
    if name=='src/adapters/chatgpt-web/browser-worker.ts':
        old='const CHATGPT_CONNECTOR_MENTION_QUERY = "@codex";\n'
        if s.count(old)!=1 or s.count('CHATGPT_CONNECTOR_MENTION_QUERY')!=5:raise ValueError('upstream_connector_search_changed')
        s=s.replace(old,'').replace('CHATGPT_CONNECTOR_MENTION_QUERY','mentionQuery')
        matches=re.findall(r'^    const menuRows = page\.locator\(.+\);$',s,re.M)
        if len(matches)!=1:raise ValueError('upstream_connector_rows_changed')
        anchor=matches[0]
        s=s.replace(anchor,'    const mentionQuery = "@" + this.config.appName; // CLW: search the configured connector identity.\n'+anchor)
        changes.append('Search the configured connector name, not hardcoded @codex; preserve exact visible-row and selected-identity checks.')
        old='''      if (await this.connectorIsSelected(composer, abortSignal)) {
        await capture("connector-already-selected");
        return composer;
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });'''
        new='''      if (await this.connectorIsSelected(composer, abortSignal)) {
        // A fresh saved-chat page can hydrate another tab's persisted draft,
        // including its connector pill. Reusing that pill must not append this
        // turn's transport to the other task. Clear only our owned, unsent editor.
        if (!(await this.attachedPromptText(page, abortSignal)).trim()) {
          await capture("connector-already-selected");
          return composer;
        }
        await capture("restored-draft-before-attachment");
        await this.clearChatGptComposerState(page);
        composer = await this.activeComposer(page, 30_000, abortSignal);
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });'''
        if s.count(old)!=1:raise ValueError('upstream_selected_connector_contract_changed')
        s=s.replace(old,new)
        changes.append('Before reusing a restored connector pill, require an empty owned composer. Clear a foreign persisted draft through native editing and select the same connector once; preserve exact prompt readback and never retry an accepted submission.')
        old='''    const composer = await this.activeComposer(page);
    if (!useSavedChats && await dismissChatGptTemporaryChatOnboarding(page)) {'''
        new='''    let composer: Locator;
    try {
      composer = await this.activeComposer(page, 180_000);
    } catch (cause) {
      // CLW: slow bootstrap is a browser readiness failure, not model capacity
      // or proof that the account expired. No message has been submitted here.
      throw new ChatGptWebAdapterError(
        "ChatGPT page is not ready; no message was sent. Check the browser connection and retry.",
        { status: 408, errorType: "invalid_request_error", code: "browser_not_ready", retryable: false, cause },
      );
    }
    if (!useSavedChats && await dismissChatGptTemporaryChatOnboarding(page)) {'''
        if s.count(old)!=1:raise ValueError('upstream_composer_readiness_changed')
        s=s.replace(old,new)
        changes.append('Wait up to 180 seconds for the initial composer without sending; report browser_not_ready rather than inferring login expiry or model capacity.')
        old='await appResult.waitFor({ state: "visible", timeout: 2_500, signal: personalizationSignal });'
        if s.count(old)!=1:raise ValueError('upstream_personalization_mention_wait_changed')
        s=s.replace(old,'await appResult.waitFor({ state: "visible", timeout: 20_000, signal: personalizationSignal });')
        old='''          await appResult.waitFor({
            state: "visible",
            timeout: 2_500,'''
        new='''          await appResult.waitFor({
            state: "visible",
            timeout: 20_000,'''
        if s.count(old)!=1:raise ValueError('upstream_connector_mention_wait_changed')
        s=s.replace(old,new)
        changes.append('Allow the original connector query 20 seconds to populate before a bounded trigger retry; avoid repeatedly cancelling a slow cold catalog lookup. Exact identity and existing three-attempt/operation limits remain.')
        old='''      let responseTurn = await this.waitForNewAssistantTurn(
        page,'''
        new='''      await diagnostics.capture(page, "submission-accepted");
      let responseTurn = await this.waitForNewAssistantTurn(
        page,'''
        if s.count(old)!=1:raise ValueError('upstream_submission_boundary_changed')
        s=s.replace(old,new)
        changes.append('Record submission acceptance before waiting for the assistant so a later DOM failure does not erase delivery evidence.')
        old='export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 5_000;'
        if s.count(old)!=1:raise ValueError('upstream_observation_deadline_changed')
        s=s.replace(old,'export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 30_000;')
        changes.append('Allow a busy long-context renderer 30 seconds to answer the original read before reconnecting the same page; retain bounded rebinds, aborts and explicit whole-turn deadlines.')
        old=r'''  acceptedUserIdentity?: string;
}'''
        new=r'''  acceptedUserIdentity?: string;
  pendingUserRekeySince?: number;
}'''
        if s.count(old)!=1:raise ValueError('upstream_user_rekey_state_changed')
        s=s.replace(old,new)
        old='''    if (evidence === "user_turn") {
      // Activity can temporarily replace this group before the assistant is mounted.
      // Preserve the identity that acknowledged Send, independently of rendered text.
      const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities)!;
      if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.acceptedUserIdentity = identity;
    }
    return evidence;
  }

  private async currentSubmissionAnswerText('''
        new=r'''    await this.rememberSubmittedUserIdentity(page, baseline, state, signal);
    return evidence;
  }

  private async submittedUserTextMatches(
    page: Page,
    identity: string,
    submittedText: string,
    signal?: AbortSignal,
  ): Promise<"match" | "pending" | "mismatch"> {
    return withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(({ key, submitted }): "match" | "pending" | "mismatch" => {
      const groups = [...document.querySelectorAll<HTMLElement>("[data-turn-key]")]
        .filter(group => group.getAttribute("data-turn-key") === key);
      if (groups.length === 0) return "pending";
      if (groups.length !== 1) return "mismatch";
      const bubbles = groups[0]!.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
      if (bubbles.length === 0) return "pending";
      if (bubbles.length !== 1) return "mismatch";
      const contents = bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]");
      if (contents.length === 0) return "pending";
      if (contents.length !== 1) return "mismatch";
      const content = contents[0]!;
      const mentions = content.querySelectorAll<HTMLElement>(
        '[data-prompt-link-href^="app://"], [app-mention-path^="app://"]',
      );
      if (mentions.length > 1) return "mismatch";
      let text = content.innerText;
      if (mentions.length === 1) {
        // A selected connector is rendered in the user bubble, although it was
        // attached separately from the submitted prompt. Remove only that explicit
        // leading app mention and its one separator, preserving prompt whitespace.
        const mention = mentions[0]!.innerText;
        if (!mention || !text.startsWith(mention)) return "mismatch";
        text = text.slice(mention.length).replace(/^[ \t\n\u00a0]/, "");
      }
      const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
      const observed = normalize(text);
      const expected = normalize(submitted);
      if (observed === expected) return "match";
      return observed.length < expected.length && expected.startsWith(observed)
        ? "pending" : "mismatch";
    }, { key: identity.slice("group:user:".length), submitted: submittedText }), signal));
  }

  private async rememberSubmittedUserIdentity(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    state: ChatGptSubmissionDomState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities);
    const pendingExpired = () => baseline.pendingUserRekeySince !== undefined
      && Date.now() - baseline.pendingUserRekeySince >= CHATGPT_RESPONSE_DOM_GRACE_MS;
    if (!identity) {
      if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
      return baseline.pendingUserRekeySince === undefined;
    }
    if (baseline.pendingUserRekeySince !== undefined && identity === baseline.acceptedUserIdentity) {
      const initial = new Set(baseline.initialTurnIdentities);
      const assistantIdentity = `group:assistant:${identity.slice("group:user:".length)}`;
      if (state.turnIdentities.every(turn => initial.has(turn)
        || turn === identity || turn === assistantIdentity)) {
        baseline.pendingUserRekeySince = undefined;
      }
    }
    if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
      const oldIdentity = baseline.acceptedUserIdentity;
      const assistantIdentity = `group:assistant:${identity.slice("group:user:".length)}`;
      const initial = new Set(baseline.initialTurnIdentities);
      const soleReplacement = oldIdentity.startsWith("group:user:")
        && identity.startsWith("group:user:")
        && !state.turnIdentities.includes(oldIdentity)
        && state.turnIdentities.every(turn => initial.has(turn)
          || turn === identity || turn === assistantIdentity);
      if (!soleReplacement || !baseline.submittedText) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      const match = await this.submittedUserTextMatches(page, identity, baseline.submittedText, signal);
      if (match === "pending") {
        baseline.pendingUserRekeySince ??= Date.now();
        if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
        return false;
      }
      if (match !== "match") {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.pendingUserRekeySince = undefined;
    }
    if (baseline.pendingUserRekeySince !== undefined) {
      if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
      return false;
    }
    baseline.acceptedUserIdentity = identity;
    baseline.pendingUserRekeySince = undefined;
    return true;
  }

  private async currentSubmissionAnswerText('''
        if s.count(old)!=1:raise ValueError('upstream_early_generation_identity_helper_changed')
        s=s.replace(old,new)
        old='''      recoveryAttempts = 0;
      // A tool batch can arrive while the DOM probe is in flight.'''
        new=r'''      recoveryAttempts = 0;
      // Stop or MCP activity can acknowledge Send before the user bubble exists.
      // An optimistic user group may also acquire a persisted key. Until the
      // replacement exposes the exact submitted content, keep observing instead
      // of binding an assistant response to an unverified group.
      const userIdentityVerified = await this.rememberSubmittedUserIdentity(
        observationPage, observationBaseline, state, signal,
      );
      // A tool batch can arrive while the DOM probe is in flight.'''
        if s.count(old)!=1:raise ValueError('upstream_early_generation_identity_observation_changed')
        s=s.replace(old,new)
        old=r'''      if (identity) return {'''
        new=r'''      if (identity && userIdentityVerified) return {'''
        if s.count(old)!=1:raise ValueError('upstream_assistant_identity_after_verified_user_changed')
        s=s.replace(old,new)
        old=r'''  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    const boundCount = await withChatGptBrowserObservationTimeout('''
        new=r'''  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    if (baseline.pendingUserRekeySince !== undefined) {
      const state = await this.submissionDomState(page, baseline.domCache, signal);
      if (!await this.rememberSubmittedUserIdentity(page, baseline, state, signal)) return binding;
    }
    const boundCount = await withChatGptBrowserObservationTimeout('''
        if s.count(old)!=1:raise ValueError('upstream_assistant_rekey_reconcile_guard_changed')
        s=s.replace(old,new)
        old=r'''        matches = baseline.acceptedUserIdentity
          ? user === baseline.acceptedUserIdentity
          : Boolean(baseline.submittedText) && await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(locator.evaluate((group, submitted) => {
          const bubbles = group.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
          const contents = bubbles.length === 1
            ? bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]")
            : [];
          const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
          // The bubble also contains Show more and accessibility spacing. Only its
          // observed message-content target represents the submitted prompt.
          return contents.length === 1 && normalize(contents[0]!.innerText) === normalize(submitted);
        }, baseline.submittedText!), signal));
'''
        new=r'''        if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== user) {
          if (!await this.rememberSubmittedUserIdentity(page, baseline, state, signal)) return binding;
        }
        if (baseline.acceptedUserIdentity) {
          matches = user === baseline.acceptedUserIdentity;
        } else if (baseline.submittedText) {
          const match = await this.submittedUserTextMatches(page, user, baseline.submittedText, signal);
          if (match === "pending") return binding;
          matches = match === "match";
        }
'''
        if s.count(old)!=1:raise ValueError('upstream_assistant_rekey_user_proof_changed')
        s=s.replace(old,new)
        old=r'''
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {'''
        new=r'''
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
      if (submissionBaseline.pendingUserRekeySince !== undefined) {
        const state = await this.submissionDomState(page, submissionBaseline.domCache, abortSignal);
        if (!await this.rememberSubmittedUserIdentity(page, submissionBaseline, state, abortSignal)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
          continue;
        }
      }
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {'''
        if s.count(old)!=1:raise ValueError('upstream_multipart_pending_rekey_guard_changed')
        s=s.replace(old,new)
        old=r'''
        let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        if (!snapshot.responsePresent) {'''
        new=r'''
        let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache);
        if (submissionBaseline.pendingUserRekeySince !== undefined) {
          const state = await this.submissionDomState(page, submissionBaseline.domCache, turn.abortSignal);
          if (!await this.rememberSubmittedUserIdentity(page, submissionBaseline, state, turn.abortSignal)) {
            await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
            continue;
          }
        }
        if (!snapshot.responsePresent) {'''
        if s.count(old)!=1:raise ValueError('upstream_response_pending_rekey_guard_changed')
        s=s.replace(old,new)
        changes.append('A unique persisted user group replaces an optimistic one only after exact prompt proof; explicit connector mention and strict-prefix hydration are handled with a 60-second fail-closed bound.')
        changes.append('Preserve the accepted user identity through Activity and strictly verify any group rekey.')
        # v6.1.1 authenticates remounted groups using the exact accepted user ID
        # or full submitted text and terminal controls. Do not union every
        # observed identity: it can bless a competing user turn during hydration.
    if name=='src/adapters/chatgpt-web/markdown.ts':
        old='''turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("preserveCodexPlanBlockTags", {'''
        new=r'''turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
// CLW: rendered KaTeX includes both accessibility and visual copies. Recover
// the public TeX annotation, as the pure-Web collector does, instead of joining
// all three representations into a corrupted final answer.
turndown.addRule("preserveLatex", {
  filter: node => node.classList.contains("katex-display")
    || (node.classList.contains("katex") && !node.parentElement?.closest(".katex-display")),
  replacement: (content, node) => {
    const element = node as HTMLElement;
    const source = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!source) return content;
    return element.classList.contains("katex-display")
      ? `\n\n\\[\n${source}\n\\]\n\n`
      : `\\(${source}\\)`;
  },
});
turndown.addRule("preserveCodexPlanBlockTags", {'''
        if s.count(old)!=1:raise ValueError('upstream_katex_annotation_rule_anchor_changed')
        s=s.replace(old,new)
        changes.append('Preserve public KaTeX TeX annotations without accessibility/visual duplication; CLW regression clw-latex-preservation.test.ts.')
    if name=='src/adapters/chatgpt-web/concurrency.ts':
        if 'export const MAX_CHATGPT_BROWSER_TABS = 5;' not in s:raise ValueError('upstream_concurrency_contract_changed')
        s='/** CLW: no fixed worker ceiling; preserve per-turn ownership and resource scheduling. */\nexport const MAX_CHATGPT_BROWSER_TABS = Number.POSITIVE_INFINITY;\n'
        changes.append('Remove fixed five-turn admission limit from browser worker and turn execution registry.')
    if name in ('launcher/electron/browser-host.cjs','src/launcher-browser-host.ts'):
        if 'persist:codex-web-gpt-chatgpt' not in s:raise ValueError('upstream_partition_contract_changed')
        s=s.replace('persist:codex-web-gpt-chatgpt','persist:clw-account-b')
        changes.append('Reuse the CLW account B partition inside the same Electron owner; no cookie transfer.')
    if name=='launcher/electron/browser-host.cjs':
        # Upstream now owns the scoped composer fix; no duplicate CLW patch.
        if 'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]' not in s:
            raise ValueError('upstream_host_composer_changed')
        old='const MAX_BROWSER_TABS = 5;'
        if s.count(old)!=1:raise ValueError('upstream_tab_contract_changed')
        s=s.replace(old,'const MAX_BROWSER_TABS = null; // CLW: no fixed worker count cap.')
        s,n=re.subn(r'if \(this\.turnTabs\.size >= MAX_BROWSER_TABS',
                    'if (MAX_BROWSER_TABS !== null && this.turnTabs.size >= MAX_BROWSER_TABS',s)
        if n!=2:raise ValueError('upstream_tab_guards_changed')
        pattern=r'const ordinal = Array\.from\(\{ length: MAX_BROWSER_TABS \}, \(_unused, index\) => index \+ 1\)\s*\.find\(candidate => !\[\.\.\.this\.turnTabs\.values\(\)\]\.some\(tab => tab\.ordinal === candidate\)\);'
        s,n=re.subn(pattern,'let ordinal = 1;\n    const usedOrdinals = new Set([...this.turnTabs.values()].map(tab => tab.ordinal));\n    while (usedOrdinals.has(ordinal)) ordinal++;',s)
        if n!=2:raise ValueError('upstream_tab_allocation_changed')
        changes.append('Remove the five-tab ceiling and allocate unbounded positive tab ordinals; preserve turn ownership and cancellation.')
        old='''    contents.on("did-finish-load", () => {
      tab.url = contents.getURL();
      tab.loading = false;
      tab.rendererReady = true;
      if (tab.url.startsWith(CHATGPT_ORIGIN)) tab.bootstrapReady = true;'''
        new='''    // CLW: the helper proceeds at DOMContentLoaded. Waiting for every
    // subresource leaves a newly navigated offscreen renderer at 0x0 on slow
    // links. DOM-ready is the first safe point to restore its viewport.
    contents.on("dom-ready", () => {
      if (contents.isDestroyed() || this.turnTabs.get(tab.id) !== tab) return;
      tab.rendererReady = true;
      tab.deviceEmulationDirty = true;
      this.syncViewVisibility();
    });
'''+old
        if s.count(old)!=1:raise ValueError('upstream_turn_dom_ready_changed')
        s=s.replace(old,new)
        changes.append('Restore owned background viewport at DOM-ready before slow subresources finish; preserve ownership and existing load completion checks.')
        old='''    contents.on("did-finish-load", () => {
      this.clearHomeNavigationTimeout();'''
        new='''    contents.on("dom-ready", () => {
      this.primaryRendererReady = true;
      this.primaryDeviceEmulationDirty = true;
      this.syncViewVisibility();
    });
'''+old
        if s.count(old)!=1:raise ValueError('upstream_primary_dom_ready_changed')
        s=s.replace(old,new)
        changes.append('Restore primary viewport at DOM-ready; use upstream primaryDeviceEmulationDirty and viewport sizing. The previous CLW viewport implementation is superseded by upstream.')
        old='''    // A browser tab represents an active Codex turn, not durable task history.'''
        new='''    // CLW keeps a failed public page for inspection without retaining execution
    // authority or eligibility for automatic conversation reuse.
    if (status !== "completed" && status !== "aborted" && !cancelledByUser) {
      tab.conversationKey = null;
      tab.connectorBound = false;
      tab.diagnosticOnly = true;
      this.publishState?.(this.snapshot());
      this.writeDescriptor();
      return { cancelledByUser };
    }
'''+old
        if s.count(old)!=1:raise ValueError('upstream_terminal_release_changed')
        s=s.replace(old,new)
        changes.append('Retain failed public pages for diagnosis with no active authority and no reuse eligibility; explicit cancellation still releases its page.')
    return s.encode('utf8'),changes

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True)
    p.add_argument('--update-reviewed',action='store_true')
    p.add_argument('--destination',type=Path,default=ROOT/'apps/codex-web-bridge/upstream');a=p.parse_args()
    source=a.source.resolve()
    def git(*args):return subprocess.check_output(['git','-C',str(source),'-c','core.autocrlf=false','-c','http.proxy=http://127.0.0.1:17890',*args],stderr=subprocess.DEVNULL)
    if git('rev-parse',COMMIT+'^{commit}').decode().strip()!=COMMIT:raise ValueError('wrong_upstream_commit')
    paths=git('ls-tree','-r','--name-only',COMMIT,'--','src','launcher','tests','scripts','package.json','bun.lock','tsconfig.json','LICENSE','README.md','README.zh-CN.md','TROUBLESHOOTING.md').decode().splitlines()
    # One read-only archive avoids hundreds of per-file Git process launches on Windows.
    archive=tarfile.open(fileobj=io.BytesIO(git('archive',COMMIT,'--',*paths)),mode='r:')
    dest=a.destination.resolve();entries=[];prepared=[]
    prior=json.loads((dest/'UPSTREAM.json').read_text(encoding='utf8')) if (dest/'UPSTREAM.json').exists() else {}
    old_entries={entry['path']:entry for entry in prior.get('files',[])}
    for name in paths:
        revision=COMMIT
        member=archive.getmember(name)
        if not member.isfile():raise ValueError('upstream_non_regular_source: '+name)
        raw=archive.extractfile(member).read()
        content,changes=adapted(name,raw)
        prepared.append((name,content))
        entries.append({'path':name,'source_commit':revision,'source_sha256':hashlib.sha256(raw).hexdigest(),'sha256':hashlib.sha256(content).hexdigest(),'adaptations':changes})
    prepared,entries=apply_reviewed_overlay(prepared,entries)
    if (BACKPORT_ROOT/'manifest.json').exists():
        backport=json.loads((BACKPORT_ROOT/'manifest.json').read_text(encoding='utf8'))
        if backport.get('source_commit')!=BACKPORT_COMMIT:
            raise ValueError('vendor_backport_source_changed')
        prepared,entries=apply_reviewed_overlay(prepared,entries,overlay_root=BACKPORT_ROOT,
                                               allowed_prefixes=('src/','tests/','launcher/'))
    prepared,entries=apply_reviewed_overlay(prepared,entries,overlay_root=POST_BACKPORT_ROOT,
                                           allowed_prefixes=('src/','tests/','launcher/'))
    for name,content in prepared:
        out=dest/name
        if out.exists() and out.read_bytes()!=content:
            if not a.update_reviewed or hashlib.sha256(out.read_bytes()).hexdigest()!=old_entries.get(name,{}).get('sha256'):
                raise ValueError('existing_vendor_diff_requires_review: '+name)
    for name,content in prepared:
        out=dest/name
        out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(content)
    (dest/'UPSTREAM.json').write_text(json.dumps({'repository':REPOSITORY,'commit':COMMIT,'release':'6.1.1',
        'reviewed_backports':([{'release':'6.1.2','commit':BACKPORT_COMMIT,'scope':'reply parsing, sign-in recovery, broker cleanup; selected changes only'}] if (BACKPORT_ROOT/'manifest.json').exists() else []),
        'license':'MIT','usage':'Complete runtime, launcher and test sources. Setup/config installer and upstream UI are not automatically executed. CLW uses its own shell.','files':entries},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'files':len(entries),'destination':str(dest),'commit':COMMIT}))

if __name__=='__main__':main()
