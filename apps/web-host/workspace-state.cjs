'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {writePrivateFileAtomic}=require('../codex-web-bridge/upstream/launcher/electron/atomic-file.cjs');
const conversationUrl = url => typeof url === 'string' && /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(url) ? url : null;
const manualReadingUrl = page => page?.manualControl===true&&typeof page.manualUrl==='string'&&/^https:\/\/chatgpt\.com\//.test(page.manualUrl)?page.manualUrl:null;
const boundConversationUrl = record => record?.phase === 'bound' ? conversationUrl(record.url) : null;
function acceptedDirectReading(record){
  const request=record?.latest_request,attempt=record?.attempt;
  return record?.phase==='bound'&&record.conversation_mode==='direct'&&record.url==='https://chatgpt.com/'&&
    !!request?.id&&['queued','processing','suspended','unknown'].includes(request.phase)&&
    /^control_[a-f0-9]{32}$/.test(request.attempt_id||'')&&attempt?.id===request.attempt_id&&
    ['dispatching','sent','unknown','acknowledged'].includes(attempt.state)&&
    Number.isFinite(attempt.dispatched)&&attempt.dispatched>0;
}
const hasReadingOwner=page=>Object.hasOwn(page,'readingRequestId')||Object.hasOwn(page,'readingAttemptId');
function readingOwnerMatches(record,page){
  // Legacy reading positions have no owner fields. New captures retain the
  // original keys so a later request cannot borrow an old unconfirmed URL.
  return !hasReadingOwner(page)||
    page.readingRequestId===record?.latest_request?.id&&page.readingAttemptId===record?.latest_request?.attempt_id;
}
function restoreConversationUrl(record,...descriptors){
  // Viewing position is not a runtime binding. The durable bound row always
  // owns its address, including when saved metadata points at another chat.
  const samePage=descriptors.filter(page=>page?.id===record?.page_id&&(page.account||'B')===(record.account||'B'));
  const manual=samePage.map(manualReadingUrl).find(Boolean);if(manual)return manual;
  if(record?.phase==='bound'){
    const bound=boundConversationUrl(record);if(bound)return bound;
    // A direct first Send starts on the homepage. Its accepted original turn
    // may still need browser confirmation before the ledger can bind /c/.
    // Restore only the same page/account's reading position, never an ACK or
    // permission to Send; receipt identity still comes from the public marker.
    if(acceptedDirectReading(record)){
      const owned=samePage.some(hasReadingOwner);
      const saved=samePage.filter(page=>(!owned||hasReadingOwner(page))&&readingOwnerMatches(record,page)).map(page=>conversationUrl(page.url)).find(Boolean);
      if(saved)return saved;
    }
    return record.url||null;
  }
  const accepted=record?.phase==='receiver_enrolled'||['sending','sent','unknown'].includes(record?.bootstrap_state);
  if(accepted&&record.url==='https://chatgpt.com/'){
    const saved=samePage.map(page=>conversationUrl(page.url)).find(Boolean);
    if(saved)return saved;
  }
  return record?.url||samePage.map(page=>conversationUrl(page.url)).find(Boolean)||null;
}

// App-owned task metadata only. Browser authentication remains in Chromium.
class WorkspaceState {
  constructor(folder, allowedUrl) {
    this.folder = folder;
    this.file = path.join(folder, 'workspace.json');
    this.tasks = new Map();
    this.removed = {};
    this.selected = null;
    this.theme = 'dark';
    this.accent = 'purple';
    this.windowMode = 'visible';
    this.pendingStarts = {};
    let source;
    try { source = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { source = {tasks: JSON.parse(fs.readFileSync(path.join(folder, 'pages.json'), 'utf8'))}; }
      catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
    }
    for (const [id,at] of Object.entries(source?.removed || {})) {
      if (/^web-[0-9a-f-]{36}$/.test(id) && Number.isFinite(at)) this.removed[id] = at;
    }
    for (const task of source?.tasks || []) {
      if (this.removed[task.id]) continue;
      if (!/^web-[0-9a-f-]{36}$/.test(task.id) || !allowedUrl(task.url)) continue;
      const boundUrl = conversationUrl(task.boundUrl);
      this.tasks.set(task.id, {...task, boundUrl, url: manualReadingUrl(task)||boundUrl||task.url, closed: !!task.closed});
      if (task.selected && !task.closed) this.selected = task.id;
    }
    if (source?.selected && !this.tasks.get(source.selected)?.closed && this.tasks.has(source.selected)) this.selected = source.selected;
    if (source?.theme === 'light') this.theme = 'light';
    if (['purple','blue','amber','rose','green'].includes(source?.accent)) this.accent = source.accent;
    if (['visible','background','minimized'].includes(source?.windowMode)) this.windowMode = source.windowMode;
    if (source?.pendingStarts && typeof source.pendingStarts === 'object') this.pendingStarts = source.pendingStarts;
  }
  update(id, data, record=null) {
    if (Object.hasOwn(this.removed,id)) return null;
    const previous=this.tasks.get(id),task = {...previous, ...data, id};
    const sameAccount=!previous||(previous.account||'B')===(task.account||'B');
    if(!sameAccount){delete task.readingRequestId;delete task.readingAttemptId;delete task.manualUrl;delete task.manualControl;}
    // A login redirect is the visible page, not a new task identity. The
    // durable runtime binding owns the URL used for reopen/restart.
    if (conversationUrl(task.boundUrl)) {
      if (data.url) task.visibleUrl = data.url;
      task.url = manualReadingUrl(task)||task.boundUrl;
    }else{
      const original=record?.page_id===id&&(record.account||'B')===(task.account||'B');
      const accepted=original&&acceptedDirectReading(record);
      const retained=conversationUrl(previous?.url);
      const knownReading=typeof previous?.readingRequestId==='string'&&!!previous.readingRequestId&&
        /^control_[a-f0-9]{32}$/.test(previous?.readingAttemptId||'');
      const incomplete=!record||original&&(!record.latest_request?.id||!record.latest_request?.attempt_id||!record.attempt);
      if(sameAccount&&retained&&data.url==='https://chatgpt.com/'&&
         (accepted&&restoreConversationUrl(record,previous)===retained||knownReading&&incomplete)){
        task.visibleUrl=data.url;task.url=retained;
      }
      // These are reading-position ownership keys, not execution evidence.
      // Only an actually captured /c/ or a retained original /c/ gets them.
      if(accepted&&conversationUrl(task.url)&&(conversationUrl(data.url)||readingOwnerMatches(record,task))){
        task.readingRequestId=record.latest_request.id;task.readingAttemptId=record.latest_request.attempt_id;
      }
    }
    this.tasks.set(id, task);
    return task;
  }
  syncBindings(records) {
    let changed = false;
    for (const record of records) {
      const url = boundConversationUrl(record), task = this.tasks.get(record.page_id);
      if (!url || !task || (task.boundUrl === url && task.url === (manualReadingUrl(task)||url))) continue;
      this.update(record.page_id, {boundUrl: url, url});
      changed = true;
    }
    return changed;
  }
  isClosed(id) { return Object.hasOwn(this.removed,id) || this.tasks.get(id)?.closed === true; }
  remove(id) {
    if (!this.tasks.get(id)?.closed) throw Error('请先关闭任务，再删除本机记录。');
    this.removed[id] = Date.now();
    this.tasks.delete(id);
    delete this.pendingStarts[id];
    if (this.selected === id) this.selected = null;
  }
  closed() { return [...this.tasks.values()].filter(t => t.closed).sort((a,b) => (b.closedAt || 0) - (a.closedAt || 0)); }
  capture(pool,records=null) {
    for (const page of pool.inspect()) this.update(page.id, page,records?.get?.(page.id));
    this.selected = this.tasks.has(pool.selected) ? pool.selected : null;
  }
  save() {
    fs.mkdirSync(this.folder, {recursive:true});
    const data = {version:1, selected:this.selected, theme:this.theme, accent:this.accent, windowMode:this.windowMode, tasks:[...this.tasks.values()],removed:this.removed,pendingStarts:this.pendingStarts};
    writePrivateFileAtomic(this.file, JSON.stringify(data, null, 2), {flush:true});
  }
}
module.exports = {WorkspaceState, boundConversationUrl,restoreConversationUrl};
