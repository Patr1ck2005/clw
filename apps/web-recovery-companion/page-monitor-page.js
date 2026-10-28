/* Opt-in observation of one existing manual chat. No model menu, navigation,
 * private API, transcript export, or task ownership. A click is not delivery. */
(() => {
  'use strict';
  const version='0.6.6';
  if (globalThis.CLWPageMonitorPage?.version===version) return;
  globalThis.__clwPageMonitorStop?.();
  const PROMPT='继续原任务。先核对已有成果和在途作业，从未完成处继续，完成当前所有可推进的工作。';
  const editors='[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"], form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]';
  const sends='[data-testid="send-button"], [data-testid="composer-send-button"]';
  const stops='[data-testid="stop-button"], [data-testid="composer-stop-button"]';
  const stopLabel=/^(Stop|Stop generating|Stop streaming|停止|停止生成|停止回复|停止流式传输|停止流传输)$/i;
  function stopButtons(ed){
    const form=ed?.closest('form'),labelled=form?[...form.querySelectorAll('button[type="button"]')].filter(n=>stopLabel.test(n.getAttribute('aria-label')||'')):[];
    return [...new Set([...document.querySelectorAll(stops),...labelled])].filter(shown);
  }
  const failures=new Map([
    ['无法思考','cannot_think'],['思考失败','cannot_think'],['Unable to think','cannot_think'],['Thinking failed','cannot_think'],
    ['Something went wrong while generating the response','generation_failed'],['生成回复时出错','generation_failed'],
    ['Error in message stream','generation_failed'],['消息流中的错误','generation_failed'],
    ['连接已中断','connection_lost'],['连接中断','connection_lost'],['Connection interrupted','connection_lost'],
    ['Network connection lost','connection_lost'],['The network connection was lost','connection_lost'],
    ['A network error occurred','connection_lost'],['Network error','connection_lost']
  ]);
  const publicTurn='[data-content-search-turn-key], [data-turn-key], [data-testid^="conversation-turn-"]';
  const prose='pre,code,blockquote,.markdown,[data-markdown-text-style],[data-user-message-bubble]';
  const shown=n=>!!n&&n.getClientRects().length>0&&!n.closest('[hidden],[inert],[aria-hidden="true"]')&&
    (typeof getComputedStyle!=='function'||getComputedStyle(n).visibility!=='hidden');
  const unique=s=>{const nodes=[...new Set(document.querySelectorAll(s))].filter(shown);return nodes.length===1?nodes[0]:null;};
  const value=n=>String(n?.value??n?.textContent??'');
  const publicText=n=>String(n?.innerText??n?.textContent??'').trim();
  const main=()=>[...document.querySelectorAll('main, [role="main"]')].filter(shown).at(-1);
  const afterUser=(user,n)=>!!user.n&&!!(user.n.compareDocumentPosition?.(n)&4)&&!user.n.contains?.(n);
  function editorFocused(ed){
    let foreground=true;
    try{if(typeof document.hasFocus==='function')foreground=document.hasFocus()!==false;}catch{}
    return foreground&&!!ed&&(document.activeElement===ed||ed.contains?.(document.activeElement)===true);
  }
  function publicReply(user,assistant){
    const root=main();
    const blocks=[...(root?.querySelectorAll('.markdown,[data-markdown-text-style="assistant-message"]')||[])].filter(n=>
      shown(n)&&afterUser(user,n)&&!n.closest('aside,nav,[role="complementary"],[role="navigation"],.sr-only,[data-user-message-bubble],[data-message-author-role="user"]'));
    if(blocks.length)return publicText(blocks.at(-1));
    const reply=shown(assistant.n)&&(!root||root.contains(assistant.n))&&afterUser(user,assistant.n)&&
      !assistant.n.closest('aside,nav,[role="complementary"],[role="navigation"],.sr-only')?publicText(assistant.n):'';
    return /^(?:ChatGPT\s*(?:说|said)?\s*[：:]?)$/i.test(reply)?'':reply;
  }
  const digest=async s=>s?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join(''):'';
  function turn(role){
    const selector=role==='user'?'[data-message-author-role="user"], [data-user-message-bubble]':'[data-message-author-role="assistant"], [data-conversation-role="assistant"]';
    const n=[...document.querySelectorAll(selector)].at(-1);
    const container=n?.closest(publicTurn+', [data-turn-id], [data-turn-id-container]')||n;
    const unit=n?.closest('[data-content-search-unit-key]');
    const id=n?.getAttribute('data-message-id')||unit?.getAttribute('data-content-search-unit-key')||container?.getAttribute('data-turn-id')||container?.getAttribute('data-turn-id-container')||container?.getAttribute('data-turn-key')||container?.getAttribute('data-content-search-turn-key')||container?.getAttribute('data-testid')||'';
    return {n,container,id};
  }
  function terminal(assistant,user){
    if(!user.id)return {kind:'',label:'',id:'',waiting:false};
    const currentAssistant=assistant.id&&assistant.container&&!(user.n&&assistant.container.compareDocumentPosition?.(user.n)&4);
    const groups=[...new Set([user.container,currentAssistant&&assistant.container].filter(Boolean))];
    let result={kind:'',label:'',id:currentAssistant?assistant.id:'',waiting:false};
    for(const group of groups){
      const grouped=!!group.getAttribute?.('data-content-search-turn-key');
      const units=grouped?[...group.querySelectorAll('[data-content-search-unit-key]')].filter(n=>
        n.closest(publicTurn)===group&&(n.getAttribute('data-content-search-unit-key')||'').startsWith(group.getAttribute('data-content-search-turn-key')+':')&&
        (n.getAttribute('data-content-search-unit-key')||'').endsWith(':assistant')):[];
      const nodes=group.querySelectorAll('[role="alert"], [role="status"], [data-testid="response-error"], [class~="group/activity-header"], h1,h2,h3,h4,h5,h6,div,span,button,[role="button"]');
      for(const n of [...nodes].slice(-300)){
      if(!shown(n)||n.closest(prose))continue;
      const owner=n.closest(publicTurn);if(owner&&owner!==group)continue;
      if(user.n&&(user.n.contains?.(n)||user.n.compareDocumentPosition&&!(user.n.compareDocumentPosition(n)&4)))continue;
      const unit=n.closest('[data-content-search-unit-key]');if(unit&&unit!==units.at(-1))continue;
      const authored=n.closest('[data-conversation-role], [data-message-author-role]');
      const semanticSelector='[role="alert"], [role="status"], [data-testid="response-error"], [class~="group/activity-header"]';
      const semantic=n.matches?.(semanticSelector)||!!n.closest(semanticSelector);
      if(!semantic&&(authored||n.closest('button,[role="button"],a,[role="link"],input,textarea,select,[contenteditable]')||n.childElementCount>0))continue;
      // Read exact leaves/direct labels. Aggregating a header's descendants
      // would revive quoted, hidden or foreign nested turn errors.
      const raw=n.childElementCount>0?[...n.childNodes].filter(child=>child.nodeType===3).map(child=>child.textContent||'').join(''):String(n.textContent||'');
      const label=raw.trim().replace(/[.!。！]$/,'');
      if(/^(Thinking(?:…|\.{3})?|思考中(?:…|\.{3})?|正在思考(?:…|\.{3})?)$/i.test(label))result={kind:'',label:'',id:result.id,waiting:false};
      if(label==='连接已中断，正在等待完整答复')result.waiting=true;
      if(failures.has(label))result={kind:failures.get(label),label,id:currentAssistant?assistant.id:'public-after:'+user.id,waiting:result.waiting};
      }
    }
    return result;
  }
  function publicProgress(user,assistant){
    const current=assistant.container&&!(user.n&&assistant.container.compareDocumentPosition?.(user.n)&4);
    const groups=[...new Set([user.container,current&&assistant.container].filter(Boolean))];
    const titles=[];let nodes=0,tail='';
    for(const group of groups){
      nodes+=Math.min(16384,group.querySelectorAll('*').length);
      for(const n of [...group.querySelectorAll('[class~="group/activity-header"], [role="status"], [role="alert"]')].slice(-12)){
        if(!shown(n)||n.closest(prose))continue;
        const label=String(n.innerText??n.textContent??'').trim().slice(0,160);
        if(label&&label!=='连接已中断，正在等待完整答复')titles.push(label.replace(/\b\d+:\d+(?::\d+)?\b|\d+\s*(?:秒|分钟|seconds?|minutes?)/g,''));
      }
      const blocks=[...group.querySelectorAll('.markdown,[data-markdown-text-style="assistant-message"]')].filter(shown);
      const last=blocks.at(-1);if(last){const leaf=last.lastElementChild||last;tail=String(leaf.innerText??'').slice(-256);}
    }
    return {titles:titles.slice(-12),nodes,tail};
  }
  async function readPage({composing=false,manual=false,url=location.href}={}){
    const ed=unique(editors),user=turn('user'),assistant=turn('assistant'),failure=terminal(assistant,user);
    const alerts=[...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(shown).slice(-12).map(n=>String(n.textContent||'').slice(0,500)).join('\n');
    const blocked=!!unique('[data-testid="login-button"]')||/usage limit|too many requests|limit resets|达到.{0,20}上限|access denied|permission denied|无法确定.{0,12}安全|权限.{0,8}拒绝|安全.{0,8}拒绝|verify you are human|验证.{0,6}真人/i.test(alerts);
    const online=navigator.onLine!==false,generating=stopButtons(ed).length>0;
    const draft=value(ed).trim().length>0,focused=editorFocused(ed);
    const known=!!ed&&(typeof ed.value==='string'||ed.isContentEditable===true)&&!!user.id;
    const kind=blocked?'blocked':!online?'offline':!known?'unsupported':draft||composing?'draft':failure.waiting&&!failure.kind?'connection_wait':generating?'generating':failure.kind||'idle';
    return {user_key:await digest(user.id),assistant_key:await digest(failure.id||assistant.id),failure_key:failure.kind?await digest(user.id+'\n'+(failure.id||assistant.id)+'\n'+failure.label):'',
      kind,controls_known:known,generating,draft,focused,composing,online,blocked,stopped:manual||location.href!==url,
      continuation_seen:!!user.n&&value(user.n).trim()===PROMPT,...(known?{progress_key:await digest(JSON.stringify(publicProgress(user,assistant)))}:{})};
  }
  function insert(ed,text){
    if(typeof ed.value==='string'){
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
      if(!setter)throw Error('monitor_editor_unsupported');setter.call(ed,text);
    }else if(ed.isContentEditable){
      ed.focus();const selection=getSelection(),range=document.createRange();range.selectNodeContents(ed);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('insertText',false,text))throw Error('monitor_editor_input_failed');
    }else throw Error('monitor_editor_unsupported');
    ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
  }
  let stopCurrent=()=>{},inspectCurrent=()=>readPage(),canAct=()=>false;
  async function start(generation){
    stopCurrent();
    if(typeof generation!=='string'||!generation)throw Error('monitor_generation_required');
    const url=location.href;
    let closed=false,busy=false,composing=false,manual=false,inserted=false,ownInsertion=false;
    canAct=()=>!closed&&!manual&&!composing&&location.href===url;
    const call=async(type,extra={})=>{
      const response=await chrome.runtime.sendMessage({type,generation,...extra});
      if(!response?.ok)throw Error(response?.error||'monitor_channel_unavailable');
      return response.value;
    };
    const snapshot=()=>readPage({composing,manual,url});inspectCurrent=snapshot;
    function gesture(e){
      if(!e.isTrusted)return;
      if(e.type==='input'&&ownInsertion)return;
      const clicked=e.type==='click'?e.target?.closest('button'):null;
      const composer=unique(editors)?.closest('form');
      if(clicked&&composer?.contains(clicked)&&stopLabel.test(clicked.getAttribute('aria-label')||'')){
        manual=true;void call('monitor-gesture').catch(()=>{});return;
      }
      if((e.type==='input'||e.type==='compositionstart'||e.type==='keydown')&&e.target?.closest(editors)||
         e.type==='click'&&e.target?.closest(stops+', '+sends+', '+editors+', [data-testid="model-switcher-dropdown-button"], [data-testid="composer-thinking-effort-button"], [data-codex-intelligence-trigger], [data-composer-navigation-target="reasoning"]')){
        manual=true;void call('monitor-gesture').catch(()=>{});
      }
    }
    const begin=e=>{composing=true;gesture(e);},end=()=>{composing=false;};
    async function dispatch(offer,observed){
      if(offer.prompt!==PROMPT)throw Error('monitor_prompt_mismatch');
      const current=await snapshot();
      if(manual||current.stopped||current.generating||current.draft||current.focused||current.composing||current.blocked||!current.online||
         current.user_key!==observed.user_key||current.failure_key!==observed.failure_key)return;
      const grant=await call('monitor-dispatch',{attempt_id:offer.attempt_id,snapshot:current});
      if(grant.dispatch!==true||grant.prompt!==PROMPT)return;
      let result='not_sent';
      try{
        const s=await snapshot(),ed=unique(editors);
        if(closed||manual||s.stopped||s.generating||s.draft||s.focused||s.composing||s.blocked||!s.online||s.failure_key!==current.failure_key||!ed)return;
        // Recheck after every async boundary. Programmatic focus stays in this
        // existing tab; no tab/window activation or navigation is requested.
        ownInsertion=true;try{insert(ed,PROMPT);inserted=true;}finally{ownInsertion=false;}
        for(let i=0;i<8;i++){
          const button=unique(sends);if(button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true')break;
          if(manual||composing||closed||location.href!==url||value(ed)!==PROMPT)break;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        const latest=await snapshot(),button=unique(sends);
        if(manual||closed||composing||location.href!==url||latest.generating||latest.blocked||!latest.online||latest.user_key!==current.user_key||
           latest.failure_key!==current.failure_key||unique(editors)!==ed||value(ed)!==PROMPT||!button||button.disabled||button.getAttribute('aria-disabled')==='true')return;
        result='unknown';button.click();result='clicked';
      }finally{
        await call('monitor-finish',{attempt_id:offer.attempt_id,result});
        // An inserted draft is preserved if input/send couldn't be confirmed.
        // Never erase user text, repeat a click, or replay an unknown attempt.
        if(result==='not_sent'&&inserted)manual=true;
      }
    }
    async function tick(){
      if(closed||busy)return;busy=true;
      try{
        if(location.href!==url){manual=true;await call('monitor-gesture');closed=true;return;}
        const s=await snapshot(),status=await call('monitor-observe',{snapshot:s});
        if(status.offer)await dispatch(status.offer,s);
      }catch(e){
        // Transient observer errors do not refresh or interrupt the model. The
        // worker's persisted grant remains authoritative on reconnect.
        if(/generation|document_changed|not_bound|navigation|paused|binding_mismatch/.test(String(e.message)))closed=true;
      }finally{busy=false;}
    }
    const message=(m,_sender,reply)=>{if(m?.type==='clw-monitor-tick'){void tick();reply({ok:true});}};
    for(const type of ['input','keydown','click'])document.addEventListener(type,gesture,true);
    document.addEventListener('compositionstart',begin,true);document.addEventListener('compositionend',end,true);
    chrome.runtime.onMessage.addListener(message);
    const timer=setInterval(()=>{void tick();},3000);
    stopCurrent=()=>{
      closed=true;clearInterval(timer);for(const type of ['input','keydown','click'])document.removeEventListener(type,gesture,true);
      document.removeEventListener('compositionstart',begin,true);document.removeEventListener('compositionend',end,true);
      chrome.runtime.onMessage.removeListener(message);
    };
    globalThis.__clwPageMonitorStop=stopCurrent;
    await tick();
  }
  async function inspect(){
    const user=turn('user'),assistant=turn('assistant'),progress=publicProgress(user,assistant);
    const selectors='button[data-testid="model-switcher-dropdown-button"], button[data-testid="composer-thinking-effort-button"], button[data-testid="thinking-effort-button"], [data-codex-intelligence-trigger], [data-composer-navigation-target="reasoning"]';
    const labels=[...new Set([...document.querySelectorAll(selectors)].filter(shown).flatMap(n=>
      [n.textContent,n.getAttribute('aria-label'),n.getAttribute('aria-valuetext')]
        .map(v=>String(v||'').trim().replace(/\s+/g,' ').slice(0,160)).filter(Boolean)))].slice(0,8);
    const reply=publicReply(user,assistant),requirement=value(user.n).trim(),root=main(),body=publicText(root);
    const buttons=[...new Set([...(root?.querySelectorAll('button,[role="button"]')||[]),...(unique(editors)?.closest('form')?.querySelectorAll('button,[role="button"]')||[])])];
    const buttonLabels=[...new Set(buttons.filter(shown).map(n=>String(n.getAttribute('aria-label')||publicText(n)).replace(/\s+/g,' ').trim().slice(0,80)).filter(Boolean))].slice(-16);
    return {url:location.href,version,snapshot:await inspectCurrent(),public_title:String(document.title||'').slice(0,240),
      public_model_labels:labels,public_last_user_text:requirement.slice(-4096),public_last_user_truncated:requirement.length>4096,
      public_activities:progress.titles,public_reply_tail:reply.slice(-4096),public_reply_truncated:reply.length>4096,
      public_main_tail:body.slice(-6000),public_main_truncated:body.length>6000,public_button_labels:buttonLabels};
  }
  // The local broker has already durably claimed one explicit operator command.
  // This method is called only from the extension worker's isolated-world script.
  async function sendText(text,expectedURL,expectedUser){
    if(typeof text!=='string'||!text.trim()||[...text].length>65536)throw Error('control_text_invalid');
    if(location.href!==expectedURL)throw Error('control_page_changed');
    const ed=unique(editors);let clicked=false,manual=false,ownInput=false;
    const events=['input','keydown','pointerdown','compositionstart'];
    const gesture=e=>{if(e.isTrusted&&!(e.type==='input'&&ownInput))manual=true;};
    // Observe human input before the first async digest, not only after its
    // already-outdated draft/focus snapshot has resolved.
    for(const event of events)document.addEventListener(event,gesture,true);
    try{
      const original=await inspectCurrent();
      if(original.user_key!==expectedUser||original.generating||original.draft||original.focused||original.composing||original.blocked||!original.online||!original.controls_known)throw Error('control_composer_busy_or_page_changed');
      if(manual||location.href!==expectedURL||unique(editors)!==ed||value(ed).length||editorFocused(ed))throw Error('control_user_took_over');
      stopCurrent();ownInput=true;try{insert(ed,text);}finally{ownInput=false;}
      for(let i=0;i<8;i++){
        const b=unique(sends);if(b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true')break;
        if(manual||location.href!==expectedURL||value(ed)!==text)throw Error('control_user_took_over');
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      const current=await readPage(),button=unique(sends);
      if(manual||location.href!==expectedURL||current.user_key!==expectedUser||current.generating||current.blocked||!current.online||unique(editors)!==ed||value(ed)!==text||!button||button.disabled||button.getAttribute('aria-disabled')==='true')throw Error('control_page_changed_before_send');
      clicked=true;button.click();
      for(let i=0;i<12;i++){
        const user=turn('user'),key=await digest(user.id);
        if(key&&key!==expectedUser&&value(user.n).trim()===text.trim())return {state:'completed',result:{clicked:true,message_received:true,model_resumed:(await readPage()).generating,user_key:key}};
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      return {state:'unknown',result:{clicked:true,message_received:false,reason:'original_send_requires_reconciliation'}};
    }catch(e){return {state:clicked?'unknown':'failed',result:{clicked,message_received:false,reason:String(e.message).slice(0,160)}};}
    finally{for(const event of events)document.removeEventListener(event,gesture,true);}
  }
  // The operator supplies authority. These public labels only identify one
  // ordinary Local-MCP confirmation; they can never grant task permission.
  function mcpToolCard(user){
    const root=main(),candidates=[];
    const label=n=>{
      const copy=n.cloneNode(true);
      for(const child of copy.querySelectorAll('kbd,[aria-hidden="true"],[data-testid="keyboard-shortcut"]'))child.remove();
      return publicText(copy).replace(/\s*(?:⏎|↵|Enter|Esc|Escape|回车|回車)\s*$/i,'').trim();
    };
    const allow=n=>/^(Allow(?: once)?|允许|允许一次|仅允许一次|允許|允許一次|僅允許一次)$/i.test(label(n));
    const deny=n=>/^(Deny|拒绝|拒絕)$/i.test(label(n));
    const tool=/Allow\s+ChatGPT\s+to\s+use|允许\s*ChatGPT\s*使用|允許\s*ChatGPT\s*使用/i;
    for(const button of [...(root?.querySelectorAll('button')||[])].filter(n=>shown(n)&&allow(n))){
      if(button.disabled||button.getAttribute('aria-disabled')==='true'||!afterUser(user,button)||
         button.closest(prose+',aside,nav,[role="complementary"],[role="navigation"],[data-message-author-role="user"]'))continue;
      for(let card=button.parentElement,level=0;card&&card!==root&&level<10;card=card.parentElement,level++){
        const body=publicText(card).replace(/\s+/g,' ');if(body.length>8000)break;
        const controls=[...card.querySelectorAll('button')].filter(shown);
        if(!controls.some(deny))continue;
        if(!tool.test(body))continue;
        const elements=[card,...card.querySelectorAll('*')].filter(shown);
        const names=[...new Set(elements.filter(n=>n.matches('span,strong,b,h1,h2,h3,h4,h5,h6')).map(publicText).filter(s=>/^Local-MCP(?:-B)?$/.test(s)))];
        const texts=elements.flatMap(n=>[...n.childNodes].filter(c=>c.nodeType===3).map(c=>String(c.textContent||'').trim()));
        for(const text of texts){
          const match=/^(?:Allow\s+ChatGPT\s+to\s+use|允许\s*ChatGPT\s*使用|允許\s*ChatGPT\s*使用)\s+(Local-MCP(?:-B)?)\s*[?？]?$/.exec(text);
          if(match&&!names.includes(match[1]))names.push(match[1]);
        }
        const mentions=texts.flatMap(s=>[...s.matchAll(/[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Cf}.]*Local-MCP[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Cf}.]*/gu)].map(m=>m[0]));
        const connector=names.length===1&&mentions.length&&mentions.every(n=>n===names[0])?names[0]:'';
        // Tool arguments can describe login UI or policy files. Only actual
        // rendered error notices indicate an access restriction here.
        const notices=[...card.querySelectorAll('[role="alert"],[role="dialog"],[data-testid="response-error"]')].filter(shown).map(publicText).join(' ');
        const blocked=/verify you are human|captcha|验证.{0,6}真人|验证码|驗證碼|登录|登入|sign\s*in|log\s*in|access denied|permission denied|(?:safety|policy).{0,30}(?:blocked|denied|refused|violation|not permitted)|无法确定.{0,12}安全|安全.{0,30}(?:拦截|阻止|拒绝)|(?:策略|政策).{0,30}(?:拦截|阻止|拒绝)/i.test(notices)||
          /允许文件实体化|允許檔案實體化|Allow file materialization/i.test(body);
        const messageId=button.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')||'';
        candidates.push({button,card,connector,body,identity:JSON.stringify([location.href,user.id,connector,messageId,body]),eligible:!!connector&&!blocked&&controls.filter(allow).length===1});break;
      }
    }
    return candidates.length===1&&candidates[0].eligible?candidates[0]:null;
  }
  const approvalAttempts=new Set();
  async function approveMcpTool(expectedURL,expectedUser){
    let clicked=false,manual=false,signature='',original;
    const events=['input','keydown','pointerdown','click','compositionstart'];
    const gesture=e=>{if(e.isTrusted)manual=true;};
    for(const event of events)document.addEventListener(event,gesture,true);
    try{
      if(location.href!==expectedURL)throw Error('control_page_changed');
      const user=turn('user'),ed=unique(editors);original=mcpToolCard(user);
      if(!original)throw Error('control_approval_not_unique_or_unsupported');
      const snapshot=await inspectCurrent();signature=await digest(original.identity);
      if(snapshot.user_key!==expectedUser||snapshot.draft||snapshot.focused||snapshot.composing||snapshot.blocked||!snapshot.online||!snapshot.controls_known)throw Error('control_composer_busy_or_page_changed');
      if(approvalAttempts.has(signature))return {state:'unknown',result:{clicked:true,card_disappeared:false,card_signature:signature,reason:'original_approval_requires_reconciliation'}};
      const currentUser=turn('user'),current=mcpToolCard(currentUser);
      if(manual||location.href!==expectedURL||currentUser.id!==user.id||unique(editors)!==ed||value(ed).length||editorFocused(ed)||
         !current||current.card!==original.card||current.button!==original.button||current.identity!==original.identity)throw Error('control_user_or_approval_changed');
      // Mark the original card before invoking its one click. A thrown or lost
      // click result must never turn into a second approval attempt.
      approvalAttempts.add(signature);clicked=true;original.button.click();
      for(let i=0;i<8;i++){
        if(location.href!==expectedURL)throw Error('control_page_changed_after_approval');
        if(original.card.isConnected===false||original.button.isConnected===false||!shown(original.card)||!shown(original.button))
          return {state:'completed',result:{clicked:true,card_disappeared:true,card_signature:signature}};
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      return {state:'completed',result:{clicked:true,card_disappeared:false,card_signature:signature}};
    }catch(e){return {state:clicked?'unknown':'failed',result:{clicked,card_disappeared:false,card_signature:signature,reason:String(e.message).slice(0,160)}};}
    finally{for(const event of events)document.removeEventListener(event,gesture,true);}
  }
  function stopGeneration(expectedURL){
    if(location.href!==expectedURL)throw Error('control_page_changed');
    const buttons=stopButtons(unique(editors));if(buttons.length!==1)throw Error('control_stop_not_unique');
    buttons[0].click();return {stop_clicked:true,native_jobs_stopped:false};
  }
  async function reloadIfIdle(url,user,progress){
    const snapshot=await inspectCurrent(),ed=unique(editors);
    if(location.href!==url||!canAct()||snapshot.user_key!==user||snapshot.progress_key!==progress||snapshot.kind!=='connection_wait'||snapshot.draft||snapshot.focused||snapshot.composing||snapshot.blocked||!snapshot.online||value(ed).trim())return {reload_requested:false,snapshot};
    // Final gesture/draft check and navigation share one JS task in the pinned
    // old document; user input cannot interleave between these two statements.
    if(!canAct()||value(ed).trim()||location.href!==url)return {reload_requested:false,snapshot:{...snapshot,stopped:true}};
    location.reload();return {reload_requested:true};
  }
  globalThis.CLWPageMonitorPage=Object.freeze({start,PROMPT,version,inspect,sendText,approveMcpTool,stopGeneration,reloadIfIdle});
})();
