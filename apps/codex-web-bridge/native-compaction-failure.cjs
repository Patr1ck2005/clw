'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {verifyNativeCompactionFailureReceipt} = require('./native-terminal-receipt.cjs');
const {writePrivateFileAtomic} = require('./upstream/launcher/electron/atomic-file.cjs');
const evidence=require('./native-compaction-evidence.cjs');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=evidence.read;

function beforeSendRecord(home, identity, logicalTrace, physicalTrace, sessionsRoot) {
  if (!/^[a-f0-9]{12}$/.test(logicalTrace) || !/^[a-f0-9]{12}_(fallback|fresh)$/.test(physicalTrace)) throw Error('compaction_presend_identity');
  const proof = verifyNativeCompactionFailureReceipt({...identity, sessionsRoot});
  if (proof.returnedTools !== 0) throw Error('compaction_presend_has_tools');
  const source = JSON.parse(read(path.join(home,'turn-sources',logicalTrace+'.json')));
  const turn = JSON.parse(read(path.join(home,'turns',physicalTrace+'.json')));
  const start = Date.parse(proof.startedAt), end = Date.parse(proof.endedAt);
  if (source.threadId !== identity.threadId || source.turnId !== identity.turnId || source.traceId !== logicalTrace || source.purpose !== 'compaction' ||
      !['A','B'].includes(source.account) || turn.account !== source.account || turn.traceId !== physicalTrace ||
      turn.status !== 'failed' || turn.submission !== 'not-observed' || turn.url ||
      !Number.isFinite(Date.parse(turn.startedAt)) || !Number.isFinite(Date.parse(turn.endedAt)) ||
      Date.parse(turn.startedAt) < start || Date.parse(turn.endedAt) > end || Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) throw Error('compaction_presend_mismatch');
  const folders = fs.readdirSync(path.join(home,'diagnostics/browser-turns')).filter(n=>n.startsWith(physicalTrace+'-'));
  if (folders.length !== 1) throw Error('compaction_presend_diagnostics_ambiguous');
  const folder = path.join(home,'diagnostics/browser-turns',folders[0]), names = fs.readdirSync(folder);
  const failures = names.filter(n=>/^\d+-turn-failed\.json$/.test(n));
  if (names.length > 64 || failures.length !== 1 || names.some(n=>/-(?:send-ready|send-activated|send-accepted|submission-accepted|prompt-attached)\./.test(n))) throw Error('compaction_presend_send_unknown');
  const failure = JSON.parse(read(path.join(folder,failures[0])));
  const state = failure.state;
  // Bind recognized model-selection failures to their actual stage, before
  // prompt attachment. Missing Send checkpoints alone never prove no Send.
  const modelControlUnavailable = failure.error === 'ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.';
  const modelClickTimeout = typeof failure.error === 'string' && failure.error.startsWith('locator.click: Timeout ')
    && failure.error.includes('data-codex-intelligence-trigger') && failure.error.includes('data-composer-navigation-target')
    && failure.error.includes('scrolling into view if needed') && !failure.error.includes('send-button');
  if (modelClickTimeout) {
    const stages = names.filter(n => /^\d+-effort-control-ready\.json$/.test(n));
    if (stages.length !== 1 || names.some(n => /-(?:effort-menu|effort-slider|effort-selected|effort-selection|prompt-|file-|send-|submission-)/.test(n))) throw Error('compaction_presend_stage_unproved');
    const stage = JSON.parse(read(path.join(folder,stages[0])));
    if (stage.traceId !== physicalTrace || stage.checkpoint !== 'effort-control-ready'
      || !Number.isFinite(Date.parse(stage.capturedAt)) || Date.parse(stage.capturedAt) < start
      || Date.parse(stage.capturedAt) > Date.parse(failure.capturedAt)) throw Error('compaction_presend_stage_unproved');
  }
  if (failure.traceId !== physicalTrace || failure.checkpoint !== 'turn-failed' ||
      (!modelControlUnavailable && !modelClickTimeout) ||
      Date.parse(failure.capturedAt) < start || Date.parse(failure.capturedAt) > end || !Number.isFinite(Date.parse(failure.capturedAt)) ||
      state?.location?.origin !== 'https://chatgpt.com' || state.location.pathSegments !== 0 ||
      state.turns?.user !== 0 || state.turns?.stopButtonCount !== 0 || state.turns?.assistant?.length !== 0 ||
      state.composer?.visibleCount !== 1 || state.composer.textChars?.length !== 1 || state.composer.textChars[0] !== 0 ||
      turn.publicState?.loginRequired || turn.publicState?.usageLimited) throw Error('compaction_presend_stage_unproved');
  let begun=false, ended=false;
  for (const row of evidence.activity(home)) {
    if(row.traceId!==physicalTrace||!['browser.turn_started','browser.turn_ended'].includes(row.event))continue;
    const at=Date.parse(row.at);if(!Number.isFinite(at)||at<start||at>end)throw Error('compaction_presend_window');
    if(row.event==='browser.turn_started'){if(begun)throw Error('compaction_presend_overlap');begun=true;}
    else {if(!begun||ended||row.status!=='failed')throw Error('compaction_presend_end');ended=true;}
  }
  if(!begun||!ended)throw Error('compaction_presend_end_missing');
  return {version:1,...identity,logicalTrace,physicalTrace,kind:'explicit_compaction_before_send',
    sourceSha256:digest(source),turnSha256:digest(turn),failureSha256:digest(failure),nativeReceiptSha256:proof.receiptSha256,automaticReplay:false};
}
const beforeSendFile=(home,trace)=>path.join(home,'runtime/native-turn-admission','compaction-presend-'+trace+'.json');
const retainedBeforePageFile=(home,trace)=>path.join(home,'runtime/native-turn-admission','retained-before-page-'+trace+'.json');

// Older hosts kept an acquisition error in the selected tab, without writing a
// page diagnostic. An explicit operator audit binds that original host error to
// the ended native turn and unchanged completed page; missing markers alone
// still cannot settle a handoff. All tools from the earlier response must return.
function retainedBeforePageRecord(home,identity,logicalTrace,physicalTrace,auditFile,sessionsRoot) {
  const validTrace=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{6,128}$/.test(value);
  if(!validTrace(logicalTrace)||!validTrace(physicalTrace)||logicalTrace===physicalTrace)throw Error('retained_presend_identity');
  const proof=verifyNativeCompactionFailureReceipt({...identity,sessionsRoot});
  const source=JSON.parse(read(path.join(home,'turn-sources',logicalTrace+'.json')));
  const turn=JSON.parse(read(path.join(home,'turns',physicalTrace+'.json')));
  const audit=JSON.parse(read(auditFile));
  if(audit.version!==1||audit.kind!=='original_retained_viewport_failure'||audit.threadId!==identity.threadId||audit.turnId!==identity.turnId||
    audit.logicalTrace!==logicalTrace||audit.physicalTrace!==physicalTrace||!validTrace(audit.responseTrace)||
    source.traceId!==logicalTrace||source.threadId!==identity.threadId||source.turnId!==identity.turnId||source.purpose!=='compaction'||
    !['A','B'].includes(source.account)||turn.traceId!==physicalTrace||turn.account!==source.account||turn.status!=='failed'||turn.submission!=='not-observed'||
    !/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(turn.url||''))throw Error('retained_presend_mismatch');
  const responseSource=JSON.parse(read(path.join(home,'turn-sources',audit.responseTrace+'.json')));
  const response=JSON.parse(read(path.join(home,'turns',audit.responseTrace+'.json')));
  if(responseSource.traceId!==audit.responseTrace||responseSource.threadId!==identity.threadId||responseSource.turnId!==identity.turnId||
    responseSource.purpose!=='response'||responseSource.account!==source.account||response.traceId!==audit.responseTrace||response.account!==source.account||
    response.submission!=='confirmed'||response.status!=='completed'||response.url!==turn.url||response.tabId!==turn.tabId)throw Error('retained_presend_source_mismatch');
  const ordered=[proof.startedAt,response.startedAt,response.endedAt,turn.startedAt,turn.endedAt,proof.endedAt,audit.at].map(Date.parse);
  if(ordered.some(n=>!Number.isFinite(n))||ordered.some((n,i)=>i&&n<ordered[i-1]))throw Error('retained_presend_window');
  const host=audit.host,page=audit.page;
  if(!Number.isSafeInteger(host?.ownerPid)||host.ownerPid<1||!Number.isSafeInteger(host.runtimePid)||host.runtimePid<1||
    host.account!==source.account||host.status!=='error'||host.activeTabId!==turn.tabId||host.traceId!==physicalTrace||host.url!==turn.url||
    host.message!=='ChatGPT browser surface did not expose an operational viewport: page.waitForFunction: Timeout 10000ms exceeded.'||
    page?.url!==turn.url||page.generating!==false||page.draft!==false||page.approvalRequired!==false||page.stopped!==false||page.failure!=='')throw Error('retained_presend_public_mismatch');
  const diagnostics=path.join(home,'diagnostics/browser-turns');
  const folders=fs.readdirSync(diagnostics).filter(n=>n.startsWith(audit.responseTrace+'-'));
  if(folders.length!==1)throw Error('retained_presend_source_diagnostics');
  const folder=path.join(diagnostics,folders[0]),names=fs.readdirSync(folder),complete=names.filter(n=>/^\d+-turn-completed\.json$/.test(n));
  if(complete.length!==1)throw Error('retained_presend_source_diagnostics');
  const checkpoint=JSON.parse(read(path.join(folder,complete[0]))),state=checkpoint.state;
  const handoffFolders=fs.readdirSync(diagnostics).filter(n=>n.startsWith(physicalTrace+'-'));
  if(handoffFolders.length>1||handoffFolders.some(n=>fs.readdirSync(path.join(diagnostics,n)).some(p=>/-(?:browser-page-acquired|prompt-|send-|submission-)/.test(p))))throw Error('retained_presend_stage_unknown');
  let publicState=turn.publicState,failedCheckpointSha256;
  if(!publicState&&turn.observationUnavailable===true){
    // The host's ordinary end observation can fail through the same SDK waiter.
    // Bind its original, successful diagnostic read; never infer silence alone.
    if(handoffFolders.length!==1)throw Error('retained_presend_failure_diagnostic_missing');
    const failedNames=fs.readdirSync(path.join(diagnostics,handoffFolders[0]));
    if(failedNames.length!==1||!/^\d+-turn-failed\.json$/.test(failedNames[0]))throw Error('retained_presend_failure_diagnostic_ambiguous');
    const failed=JSON.parse(read(path.join(diagnostics,handoffFolders[0],failedNames[0]))),observed=failed.state;
    if(failed.traceId!==physicalTrace||failed.checkpoint!=='turn-failed'||failed.error!==host.message||
      !Number.isFinite(Date.parse(failed.capturedAt))||Date.parse(failed.capturedAt)<ordered[3]||Date.parse(failed.capturedAt)>ordered[4]||
      observed?.location?.origin!=='https://chatgpt.com'||observed.location.pathSegments!==2||observed.surfaceBound!==true||
      observed.turns?.stopButtonCount!==0||observed.turns?.user!==page.users||observed.turns?.assistant?.length!==page.assistants||
      page.loginRequired!==false||page.usageLimited!==false||page.alerts?.length!==0)throw Error('retained_presend_failure_diagnostic_mismatch');
    publicState={userTurns:observed.turns.user,assistantTurns:observed.turns.assistant.length,loginRequired:false,usageLimited:false,alerts:[]};
    failedCheckpointSha256=digest(failed);
  }
  if(checkpoint.traceId!==audit.responseTrace||checkpoint.checkpoint!=='turn-completed'||
    Date.parse(checkpoint.capturedAt)<ordered[1]||Date.parse(checkpoint.capturedAt)>ordered[2]||!Number.isFinite(Date.parse(checkpoint.capturedAt))||
    state?.location?.origin!=='https://chatgpt.com'||state.location.pathSegments!==2||state.turns?.stopButtonCount!==0||
    !Number.isSafeInteger(page.users)||page.users<1||page.users!==state.turns?.user||!Number.isSafeInteger(page.assistants)||
    page.assistants<1||page.assistants!==state.turns?.assistant?.length||
    publicState?.userTurns!==page.users||publicState?.assistantTurns!==page.assistants||
    publicState?.loginRequired!==false||publicState?.usageLimited!==false||publicState?.alerts?.length!==0)throw Error('retained_presend_page_changed');
  return {version:1,...identity,logicalTrace,physicalTrace,auditFile:path.resolve(auditFile),kind:'explicit_retained_acquisition_before_send',
    auditSha256:digest(audit),sourceSha256:digest(source),responseSourceSha256:digest(responseSource),responseSha256:digest(response),
    turnSha256:digest(turn),checkpointSha256:digest(checkpoint),...(failedCheckpointSha256?{failedCheckpointSha256}:{}),nativeReceiptSha256:proof.receiptSha256,automaticReplay:false};
}

function reconcileNativeRetainedCompactionBeforePage(home,identity,logicalTrace,physicalTrace,auditFile,sessionsRoot) {
  const record=retainedBeforePageRecord(home,identity,logicalTrace,physicalTrace,auditFile,sessionsRoot),file=retainedBeforePageFile(home,logicalTrace);
  if(fs.existsSync(file)){if(digest(JSON.parse(read(file)))!==digest(record))throw Error('retained_presend_changed');}
  else writePrivateFileAtomic(file,JSON.stringify(record)+'\n');
  return record;
}

// The operator must identify the original physical attempt. This records a
// verified link, never guesses a trace or authorizes replay of the old turn.
function reconcileNativeCompactionBeforeSend(home,identity,logicalTrace,physicalTrace,sessionsRoot) {
  const record=beforeSendRecord(home,identity,logicalTrace,physicalTrace,sessionsRoot),file=beforeSendFile(home,logicalTrace);
  if(fs.existsSync(file)){if(digest(JSON.parse(read(file)))!==digest(record))throw Error('compaction_presend_changed');}
  else writePrivateFileAtomic(file,JSON.stringify(record)+'\n');
  return record;
}

// Reconcile an ended native compaction failure as a group, including its logical
// compact trace. Every physical Send must have the host's matching end handshake.
// Unknown tool results, ongoing browsers and user stops remain unresolved.
function reconcileNativeCompactionFailure(home, identity, traces, sessionsRoot) {
  try {
    if (!Array.isArray(traces) || traces.length < 1 || new Set(traces).size !== traces.length) return false;
    const proof = verifyNativeCompactionFailureReceipt({...identity, sessionsRoot});
    const start = Date.parse(proof.startedAt), end = Date.parse(proof.endedAt);
    const sources = traces.map(traceId => {
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw Error('compaction_failure_trace_invalid');
      const source = JSON.parse(read(path.join(home, 'turn-sources', traceId + '.json')));
      if (source.traceId !== traceId || source.threadId !== identity.threadId || source.turnId !== identity.turnId ||
          !['response', 'compaction'].includes(source.purpose)) throw Error('compaction_failure_source_mismatch');
      return source;
    });
    const responses = sources.filter(row => row.purpose === 'response');
    if (!responses.length && sources.length === 1 && proof.returnedTools === 0) {
      const link=JSON.parse(read(beforeSendFile(home,traces[0])));
      return digest(link) === digest(beforeSendRecord(home,identity,traces[0],link.physicalTrace,sessionsRoot));
    }
    if (!responses.length || !sources.some(row => row.purpose === 'compaction')) return false;
    const urls = new Set(), physical = new Map(), beforePage = new Set();
    for(const source of sources.filter(row=>row.purpose==='compaction')) {
      const file=retainedBeforePageFile(home,source.traceId);
      if(!fs.existsSync(file))continue;
      const record=JSON.parse(read(file));
      if(digest(record)!==digest(retainedBeforePageRecord(home,identity,source.traceId,record.physicalTrace,record.auditFile,sessionsRoot)))return false;
      beforePage.add(record.physicalTrace);
    }
    for (const source of responses) {
      const turn = JSON.parse(read(path.join(home, 'turns', source.traceId + '.json')));
      if (turn.traceId !== source.traceId || !/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(turn.url || '') ||
          turn.submission !== 'confirmed' || !['completed', 'failed', 'aborted'].includes(turn.status) ||
          !Number.isFinite(Date.parse(turn.startedAt)) || !Number.isFinite(Date.parse(turn.endedAt)) ||
          Date.parse(turn.startedAt) < start || Date.parse(turn.endedAt) > end || Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) return false;
      urls.add(turn.url); physical.set(turn.traceId, turn);
    }
    for (const name of evidence.turnNames(path.join(home, 'turns'),/^[A-Za-z0-9_-]{6,128}\.json$/)) {
      const turn = JSON.parse(read(path.join(home, 'turns', name)));
      if (!urls.has(turn.url) || Date.parse(turn.startedAt) < start || Date.parse(turn.startedAt) > end) continue;
      if (turn.traceId + '.json' !== name || (turn.submission !== 'confirmed' && !beforePage.has(turn.traceId)) ||
          !['completed', 'failed', 'aborted'].includes(turn.status) || !Number.isFinite(Date.parse(turn.endedAt)) ||
          Date.parse(turn.endedAt) > end || Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) return false;
      physical.set(turn.traceId, turn);
    }
    // A logical compaction without an identifiable physical handoff is still unknown.
    if (![...physical.keys()].some(trace => !traces.includes(trace))) return false;
    const begun = new Set(), ended = new Set();
    for (const row of evidence.activity(home)) {
      const turn = physical.get(row.traceId);
      if (!turn || !['browser.turn_started', 'browser.turn_ended'].includes(row.event)) continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at) || at < start || at > end) return false;
      if (row.event === 'browser.turn_started') {
        if (begun.has(row.traceId)) return false;
        begun.add(row.traceId);
      } else {
        if (!begun.has(row.traceId) || ended.has(row.traceId) || row.status !== turn.status) return false;
        ended.add(row.traceId);
      }
    }
    if (ended.size !== physical.size) return false;
    const record = {version: 1, ...identity, kind: proof.kind, nativeReceiptSha256: proof.receiptSha256,
      returnedTools: proof.returnedTools, sources: sources.map(s => ({traceId: s.traceId, sha256: digest(s)})),
      physical: [...physical.values()].map(t => ({traceId: t.traceId, sha256: digest(t)})), automaticReplay: false};
    const key = digest([identity.threadId, identity.turnId]);
    const file = path.join(home, 'runtime', 'native-turn-admission', 'compaction-failure-' + key + '.json');
    if (fs.existsSync(file)) {
      if (digest(JSON.parse(read(file))) !== digest(record)) return false;
    } else evidence.save(file,record);
    return true;
  } catch { return false; }
}
// A pre-sampling summary was accepted by native Codex, then a bridge error ended
// that exact turn. The native acknowledgement binds the logical checkpoint;
// it does not establish an ordinary task final or allow its replay.
function checkpointGroup(home, identity, traces, sessionsRoot) {
  if (traces.length < 2 || new Set(traces).size !== traces.length) return null;
  const sources = traces.map(traceId => {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw Error('checkpoint_group_trace_invalid');
    const source = JSON.parse(read(path.join(home,'turn-sources',traceId+'.json')));
    if (source.traceId !== traceId || source.threadId !== identity.threadId || source.turnId !== identity.turnId ||
        !['response','compaction'].includes(source.purpose) || !['A','B'].includes(source.account)) throw Error('checkpoint_group_source_invalid');
    return source;
  });
  if (new Set(sources.map(s=>JSON.stringify([s.account,s.model,s.workingDirectory]))).size !== 1) return null;
  const compact = sources.filter(s=>s.purpose==='compaction'), responses = sources.filter(s=>s.purpose==='response');
  if (compact.length !== 1 || !responses.length) return null;
  const review = JSON.parse(read(path.join(home,'turn-reviews',compact[0].traceId+'.json')));
  if (review.traceId !== compact[0].traceId || review.threadId !== identity.threadId || review.turnId !== identity.turnId ||
      !/^[a-f0-9]{64}$/.test(review.finalSha256||'')) return null;
  const proof = verifyNativeCompactionFailureReceipt({...identity,sessionsRoot,expectedCheckpointSha256:review.finalSha256});
  const start = Date.parse(proof.startedAt), end = Date.parse(proof.endedAt), physical = new Map(), urls = new Set(), diagnostics = [];
  for (const source of responses) {
    const turn = JSON.parse(read(path.join(home,'turns',source.traceId+'.json')));
    if (turn.traceId !== source.traceId || turn.account !== source.account || !['completed','failed'].includes(turn.status) ||
        !Number.isFinite(Date.parse(turn.startedAt)) || !Number.isFinite(Date.parse(turn.endedAt)) ||
        Date.parse(turn.startedAt) < start || Date.parse(turn.endedAt) > end || Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) return null;
    if (turn.submission === 'confirmed' && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(turn.url||'')) urls.add(turn.url);
    else {
      // A known model-control hydration error ended before prompt attachment.
      // Bind both the original empty page and the upstream cleanup receipt.
      if (turn.status !== 'failed' || turn.submission !== 'not-observed' || turn.url ||
          turn.publicState?.userTurns !== 0 || turn.publicState?.assistantTurns !== 0 || turn.publicState?.loginRequired !== false ||
          turn.publicState?.usageLimited !== false || turn.publicState?.alerts?.length !== 0) return null;
      const folders = fs.readdirSync(path.join(home,'diagnostics/browser-turns')).filter(n=>n.startsWith(source.traceId+'-'));
      if (!folders.length) {
        // Compatibility for an old helper that failed before acquiring any
        // page: an explicit read-only operator audit must bind the still-empty
        // owned idle surfaces, dead native consumer and normal claim release.
        // This closes the failed turn; it never authorizes its replay.
        const audit = JSON.parse(read(path.join(home,'runtime/native-turn-admission','prepage-audit-'+source.traceId+'.json')));
        const nativeReplayError = 'stream disconnected before completion: The original in-memory browser round is no longer available for replay. Reconcile the original turn; no new Web message was sent.';
        if (audit.version !== 1 || audit.kind !== 'original_idle_acquisition_failure' || audit.threadId !== identity.threadId ||
            audit.turnId !== identity.turnId || audit.traceId !== source.traceId || audit.sourceSha256 !== digest(source) ||
            audit.turnSha256 !== digest(turn) || audit.nativeReceiptSha256 !== proof.receiptSha256 ||
            proof.failureSha256 !== crypto.createHash('sha256').update(nativeReplayError).digest('hex') ||
            audit.ownerAlive !== false || audit.claimState !== 'released' || audit.host?.account !== source.account ||
            audit.host.status !== 'error' || audit.host.traceId !== source.traceId || audit.host.tabId !== turn.tabId ||
            audit.host.message !== 'Launcher browser CDP endpoint is not ready: This operation was aborted' ||
            !audit.host.url?.startsWith('data:text/html;charset=utf-8,') || !audit.host.url.endsWith('#codex-web-gpt-browser-host') ||
            !Number.isSafeInteger(audit.host.ownerPid) || audit.host.ownerPid<1 || !Number.isSafeInteger(audit.host.runtimePid) || audit.host.runtimePid<1 ||
            audit.health?.pid !== audit.host.runtimePid || audit.health.active_http_turns !== 0 || audit.health.active_browser_turns !== 0 ||
            !Array.isArray(audit.pages) || audit.pages.length!==1 || audit.pages.some(p=>p.url!==audit.host.url ||
              p.userTurns!==0 || p.assistantTurns!==0 || p.stopButtons!==0 || p.composers!==0 || p.bodyChars!==0 || p.readyState!=='complete') ||
            !Number.isFinite(Date.parse(audit.at)) || Date.parse(audit.at)<end || audit.modelSends!==0) return null;
        diagnostics.push({traceId:source.traceId,acquisitionAuditSha256:digest(audit)});
        physical.set(turn.traceId,turn);
        continue;
      }
      if (folders.length !== 1) return null;
      const folder = path.join(home,'diagnostics/browser-turns',folders[0]), names = fs.readdirSync(folder);
      const failed = names.filter(n=>/^\d+-turn-failed\.json$/.test(n));
      if (names.length > 64 || failed.length !== 1 || names.some(n=>/-(?:prompt-|file-|send-|submission-|effort-menu|effort-selected|effort-selection)/.test(n))) return null;
      const diagnostic = JSON.parse(read(path.join(folder,failed[0]))), state = diagnostic.state;
      const unavailable = 'ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.';
      if (diagnostic.traceId !== source.traceId || diagnostic.checkpoint !== 'turn-failed' ||
          typeof diagnostic.error !== 'string' || !diagnostic.error.startsWith(unavailable) ||
          !diagnostic.error.includes('ChatGPT owned effort control is not unique') ||
          crypto.createHash('sha256').update('stream disconnected before completion: '+diagnostic.error).digest('hex') !== proof.failureSha256 ||
          !Number.isFinite(Date.parse(diagnostic.capturedAt)) || Date.parse(diagnostic.capturedAt) < Date.parse(turn.startedAt) ||
          Date.parse(diagnostic.capturedAt) > Date.parse(turn.endedAt) || state?.location?.origin !== 'https://chatgpt.com' ||
          state.location.pathSegments !== 0 || state.surfaceBound !== true || state.composer?.visibleCount !== 1 ||
          state.composer.textChars?.length !== 1 || state.composer.textChars[0] !== 0 || state.effortControls?.length !== 0 ||
          state.turns?.user !== 0 || state.turns?.assistant?.length !== 0 || state.turns?.stopButtonCount !== 0) return null;
      const settled = JSON.parse(read(path.join(home,'runtime/native-turn-admission','failed-settlement-'+source.traceId+'.json')));
      if (settled.version !== 1 || settled.threadId !== identity.threadId || settled.turnId !== identity.turnId || settled.traceId !== source.traceId ||
          settled.kind !== 'upstream_physical_settlement' || settled.sourceSha256 !== digest(source) || settled.turnSha256 !== digest(turn) ||
          !/^[a-f0-9]{64}$/.test(settled.receiptSha256||'') || !Number.isFinite(Date.parse(settled.observedAt)) ||
          Date.parse(settled.observedAt) < Date.parse(turn.endedAt) || Date.parse(settled.observedAt) > end) return null;
      diagnostics.push({traceId:source.traceId,sha256:digest(diagnostic),settlementSha256:digest(settled)});
    }
    physical.set(turn.traceId,turn);
  }
  if (!urls.size || !diagnostics.length) return null;
  for (const name of evidence.turnNames(path.join(home,'turns'),/\.json$/)) {
    const turn = JSON.parse(read(path.join(home,'turns',name)));
    if (!urls.has(turn.url) || Date.parse(turn.startedAt) < start || Date.parse(turn.startedAt) > end) continue;
    if (turn.traceId+'.json' !== name || turn.account !== sources[0].account || turn.submission !== 'confirmed' ||
        !['completed','failed'].includes(turn.status) || !Number.isFinite(Date.parse(turn.endedAt)) ||
        Date.parse(turn.endedAt) > end || Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) return null;
    physical.set(turn.traceId,turn);
  }
  const begun = new Set(), ended = new Set();
  for (const row of evidence.activity(home)) {
    const turn = physical.get(row.traceId);
    if (!turn || !['browser.turn_started','browser.turn_ended'].includes(row.event)) continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < start || at > end) return null;
    if (row.event === 'browser.turn_started') {if (begun.has(row.traceId)) return null; begun.add(row.traceId);}
    else {if (!begun.has(row.traceId) || ended.has(row.traceId) || row.status !== turn.status) return null; ended.add(row.traceId);}
  }
  if (ended.size !== physical.size) return null;
  return {version:1,...identity,kind:proof.kind,nativeReceiptSha256:proof.receiptSha256,returnedTools:proof.returnedTools,
    sources:sources.map(s=>({traceId:s.traceId,sha256:digest(s)})),reviewSha256:digest(review),
    physical:[...physical.values()].map(t=>({traceId:t.traceId,sha256:digest(t)})),diagnostics,automaticReplay:false};
}
function reconcileNativeCheckpointFailure(home, identity, traces, sessionsRoot) {
  try {
    if (!Array.isArray(traces) || !traces.length) return false;
    if (traces.length > 1) {
      const record = checkpointGroup(home,identity,traces,sessionsRoot);
      if (!record) return false;
      const file = path.join(home,'runtime/native-turn-admission','checkpoint-failure-'+digest([identity.threadId,identity.turnId])+'.json');
      if (fs.existsSync(file)) {if (digest(JSON.parse(read(file))) !== digest(record)) return false;}
      else evidence.save(file,record);
      return true;
    }
    const traceId = traces[0];
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) return false;
    const source = JSON.parse(read(path.join(home,'turn-sources',traceId+'.json')));
    const review = JSON.parse(read(path.join(home,'turn-reviews',traceId+'.json')));
    if (source.traceId !== traceId || source.threadId !== identity.threadId || source.turnId !== identity.turnId
      || source.purpose !== 'compaction' || review.traceId !== traceId || review.threadId !== identity.threadId
      || review.turnId !== identity.turnId || !/^[a-f0-9]{64}$/.test(review.finalSha256 || '')) return false;
    const proof = verifyNativeCompactionFailureReceipt({...identity,sessionsRoot,expectedCheckpointSha256:review.finalSha256});
    if (proof.returnedTools !== 0) return false;
    const record = {version:1,...identity,kind:proof.kind,nativeReceiptSha256:proof.receiptSha256,
      sourceSha256:digest(source),reviewSha256:digest(review),automaticReplay:false};
    const file = path.join(home,'runtime/native-turn-admission','checkpoint-failure-'+digest([identity.threadId,identity.turnId])+'.json');
    if (fs.existsSync(file)) {if (digest(JSON.parse(read(file))) !== digest(record)) return false;}
    else writePrivateFileAtomic(file,JSON.stringify(record)+'\n');
    return true;
  } catch {return false;}
}
module.exports = {reconcileNativeCompactionFailure,reconcileNativeCompactionBeforeSend,reconcileNativeRetainedCompactionBeforePage,reconcileNativeCheckpointFailure};
