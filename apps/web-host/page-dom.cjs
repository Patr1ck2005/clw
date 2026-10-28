'use strict';
const pageInput=require('./page-input.cjs');
const {publicAccessLimit}=require('./account-access.cjs');
const {publicApproval}=require('./public-approval.cjs');
// Public DOM selectors adapted from the pinned upstream chatgpt-session.ts.
// No cookies, private endpoints, React internals or background account APIs.
function dom(action,arg={},activate,accessLimited=()=>false,approval=()=>({required:false})) {
  // This function is serialized into the original renderer, so its matcher
  // cannot close over require(). Keep the same pure ASCII label contract as
  // connector-identity; raw public values and app paths remain untouched.
  const sameConnectorLabel=(observed,expected)=>{
    if(typeof observed!=='string'||typeof expected!=='string'||!observed||!expected)return false;
    const fold=value=>value.replace(/[A-Z]/g,letter=>String.fromCharCode(letter.charCodeAt(0)+32));
    return fold(observed)===fold(expected);
  };
  if(!globalThis.__clwCompositionObserved){
    globalThis.__clwCompositionObserved=true;globalThis.__clwComposing=false;
    document.addEventListener('compositionstart',()=>{globalThis.__clwComposing=true;},true);
    document.addEventListener('compositionend',()=>{globalThis.__clwComposing=false;},true);
    document.addEventListener('beforeinput',e=>{if(e.isComposing)globalThis.__clwComposing=true;},true);
  }
  const visible=e=>!!e&&!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)&&e.getAttribute('aria-hidden')!=='true';
  const knownEditorNodes=[...document.querySelectorAll('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]')];
  const editors=knownEditorNodes.filter(visible);
  const editor=editors.length===1?editors[0]:null,form=editor?.closest('form');
  const buttons=[...document.querySelectorAll('button')];
  const knownControlNodes=buttons.filter(e=>e.matches('[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"],button[aria-haspopup="menu"][data-tone="neutral"],button[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"][aria-haspopup="menu"]'));
  const control=knownControlNodes.filter(visible).at(-1);
  const owned=control?.getAttribute('aria-controls');
  const menu=(owned?document.getElementById(owned):null)||[...document.querySelectorAll('[data-testid="composer-intelligence-picker-content"],[role="menu"],[role="group"]')].find(e=>visible(e)&&e.querySelector('[data-model-reasoning-effort-slider],[data-model-picker-power-slider]'));
  const text=e=>(e?.textContent||'').replace(/\s+/g,' ').trim();
  const pageDiagnostics=()=>{
    // Evidence only: alternatives never become an input/control fallback.
    // Keep values, transcript, navigation and hidden content out of this
    // public diagnostic envelope, including on a SPA showing a turn at '/'.
    const bounded=(value,limit)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,limit);
    const publicVisible=e=>{
      if(!visible(e)||e.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
      const style=getComputedStyle(e);
      return style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse';
    };
    const privateContent='[data-message-author-role],[data-conversation-role],[data-turn-key],[data-content-search-turn-key],[data-testid^="conversation-turn-"],[data-user-message-bubble],.thread-scroll-container,nav,[role="navigation"],aside,[data-testid^="history-"],[data-testid^="sidebar-"],[data-testid="history"]';
    const editable='[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"],textarea,input[type="text"],input:not([type])';
    const excluded=privateContent+',form[data-chatgpt-composer],[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable],[role="textbox"],textarea,input,select,.markdown,[data-markdown-text-style],script,style,template,noscript';
    const publicText=(root,limit)=>{
      let result='';
      const read=node=>{
        if(result.length>=limit)return;
        if(node.nodeType===3){result+=(node.textContent||'').replace(/\s+/g,' ').slice(0,limit-result.length);return;}
        if(node.nodeType!==1||node.matches(excluded)||!publicVisible(node))return;
        for(const child of node.childNodes){read(child);if(result.length>=limit)break;}
        if(result.length<limit)result+=' ';
      };
      if(root)read(root);
      return bounded(result,limit);
    };
    const alternatives=[...document.querySelectorAll(editable)].filter(e=>!knownEditorNodes.includes(e)&&!e.closest(privateContent));
    const visibleAlternatives=alternatives.filter(publicVisible);
    const descriptors=visibleAlternatives.slice(0,6).map(e=>({tag:bounded(e.tagName,24),attributes:Object.fromEntries(
      ['id','role','contenteditable','data-testid','data-lexical-editor','data-composer-markdown','aria-label','aria-multiline','placeholder','type']
        .filter(name=>e.hasAttribute(name)).map(name=>[name,bounded(e.getAttribute(name),96)]))}));
    const dialogs=[...document.querySelectorAll('[role="alert"],[role="dialog"],[role="alertdialog"]')]
      .filter(e=>publicVisible(e)&&!e.closest(privateContent));
    const dimension=value=>Number.isFinite(value)&&value>=0?Math.min(100000,Math.round(value)):null;
    const publicNavigation=()=>{
      const safeURL=value=>typeof value==='string'&&value.length<=256&&
        /^https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9-]+)?$/.test(value)?value:null;
      const result={available:false,name:null,finalLocation:safeURL(location.href),type:null,redirectCount:null};
      try{
        const entry=window.performance?.getEntriesByType?.('navigation')?.[0];
        if(!entry)return result;
        result.available=true;result.name=safeURL(entry.name);
        result.type=['navigate','reload','back_forward','prerender'].includes(entry.type)?entry.type:null;
        result.redirectCount=Number.isInteger(entry.redirectCount)&&entry.redirectCount>=0&&entry.redirectCount<=100?entry.redirectCount:null;
      }catch{}
      return result;
    };
    const readiness={document:{readyState:bounded(document.readyState,24),title:bounded(document.title,160),navigation:publicNavigation()},
      viewport:{width:dimension(globalThis.window?.innerWidth??document.documentElement?.clientWidth),
        height:dimension(globalThis.window?.innerHeight??document.documentElement?.clientHeight)},
      knownEditors:{rawCount:knownEditorNodes.length,visibleCount:editors.length},
      knownControls:{rawCount:knownControlNodes.length,visibleCount:knownControlNodes.filter(visible).length},
      editableAlternatives:{rawCount:alternatives.length,visibleCount:visibleAlternatives.length,descriptors},
      dialogs:{visibleCount:dialogs.length,descriptors:dialogs.slice(0,4).map(e=>({role:bounded(e.getAttribute('role'),24),text:publicText(e,240)}))}};
    let pageLoadFailure;
    if((!editor||!control)&&location.href==='https://chatgpt.com/'){
      const main=[...document.querySelectorAll('main,[role="main"]')].find(publicVisible);
      if(main)readiness.mainText=publicText(main,480);
      if(main&&editors.length===0&&visibleAlternatives.length===0&&!control){
        // The visible platform title may not use a heading tag. Admit its
        // exact prefix in sanitized MAIN text with a unique public reload
        // button; chat prose, hidden text and a generic reload do not qualify.
        // No unique editor is not proof of absence: duplicates and alternative
        // editables may contain drafts, so require their explicit zero counts.
        const safe=e=>publicVisible(e)&&!e.closest(excluded);
        const headings=[...main.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(safe);
        const reloads=[...main.querySelectorAll('button,[role="button"]')].filter(e=>safe(e)&&/^(?:重新加载|Reload)$/i.test(publicText(e,160)));
        const failedTitle=/^(?:无法加载你的账户|Unable to load your account|Could(?: not|n't) load your account)$/i;
        const failedPrefix=/^(?:无法加载你的账户|Unable to load your account|Could(?: not|n't) load your account)(?:\s|$)/i;
        if((headings.some(e=>failedTitle.test(publicText(e,160)))||failedPrefix.test(publicText(main,160)))&&reloads.length===1)
          pageLoadFailure='account_load_failed';
      }
    }
    return {readiness,...(pageLoadFailure?{pageLoadFailure}:{})};
  };
  const mentionSelector='[data-id^="plugin:"][data-keyword],[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const selectedMentions=()=>editor?[...editor.querySelectorAll(mentionSelector)]:[];
  const editorText=()=>{
    if(!editor)throw Error('editor_missing');
    if('value' in editor)return String(editor.value||'');
    // Lexical stores each pasted paragraph in a separate child. Read the
    // public contenteditable exactly as the native ChatGPT adapter does.
    // A standalone app row/cursor is composer structure, not a blank paragraph
    // in the original prompt. Remove only rows containing a mention/cursor and
    // no body text; preserve actual blank paragraphs and leading prompt spaces.
    const parts=[];
    for(const child of editor.childNodes){
      // ProseMirror app selection produces exactly this standalone app row
      // with one trailing ASCII separator. It is not prompt indentation. Keep
      // every other blank/body node, including two spaces and leading lines.
      if(child.nodeType===1&&child.tagName==='P'&&child.childNodes.length===2&&
         child.firstChild.nodeType===1&&child.firstChild.matches('[app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]')&&
         child.lastChild.nodeType===3&&child.lastChild.textContent===' ')continue;
      const clone=child.cloneNode(true),hasMention=child.nodeType===1&&
        (child.matches(mentionSelector)||child.querySelector(mentionSelector));
      if(clone.nodeType===1){
        if(clone.matches(mentionSelector))continue;
        clone.querySelectorAll(mentionSelector).forEach(part=>part.remove());
        const cursors=[...(clone.matches('[data-inline-selection-pill-cursor-target]')?[clone]:[]),...clone.querySelectorAll('[data-inline-selection-pill-cursor-target]')];
        for(const cursor of cursors){
          // Chromium may clone this cursor wrapper around genuine pasted body.
          // Ignore its single initial composer sentinel, never its body text.
          const first=cursor.firstChild;
          if(first?.nodeType===3&&/^[\u200b\uFEFF]/.test(first.textContent||''))first.textContent=first.textContent.slice(1);
        }
        if(clone.matches('[data-inline-selection-pill-cursor-target]')&&!clone.textContent)continue;
      }
      const body=clone.textContent||'';
      if(hasMention&&!body)continue;
      parts.push(body);
    }
    return parts.join('\n');
  };
  const editorEquivalent=(expected,observed)=>{
    expected=expected.replace(/\r\n/g,'\n');
    if(expected.length!==observed.length)return false;
    for(let i=0;i<expected.length;i++){
      if(expected[i]===observed[i])continue;
      // Contenteditable may expose spaces in a multi-space run as NBSP.
      if(expected[i]!==' '||observed[i]!=='\u00a0'||(expected[i-1]!==' '&&expected[i+1]!==' '))return false;
    }
    return true;
  };
  const optionText=e=>text(e.querySelector('.truncate')||e);
  const click=e=>{const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('model_control_not_visible');activate(e);return {clicked:true};};
  const composerBusy=()=>({
    generating:buttons.some(e=>visible(e)&&(e.matches('[data-testid="stop-button"]')||form?.contains(e)&&/^(Stop|停止|停止生成)$/.test(e.getAttribute('aria-label')||''))),
    approvalRequired:!!approval().required,accessLimited:!!accessLimited(),
    blocked:/^https:\/\/chatgpt\.com\/auth\//.test(location.href)
  });
  const assertComposerIdle=()=>{
    const state=composerBusy();
    if(state.generating||state.approvalRequired||state.accessLimited||state.blocked||globalThis.__clwComposing)throw Error('send_baseline_changed');
    if(arg.expectedBaseline){
      const current=dom('snapshot',{},activate,accessLimited,approval),expected=arg.expectedBaseline;
      if(current.url!==expected.url||current.userId!==expected.userId||current.assistantId!==expected.assistantId||current.blocked||current.loginRequired)
        throw Error('send_baseline_changed');
    }
  };
  const connectorMenu=()=>{
    // The portal may be under body without aria-controls. Unique editor,
    // structural marker, exact owned query and focus jointly own that menu.
    const roots=[...document.querySelectorAll('[data-composer-overlay-floating-ui] [data-mention-list-scroll-area]')]
      .filter(e=>visible(e)&&(!e.closest('form')||e.closest('form')===form));
    const ownedIds=(editor?.getAttribute('aria-controls')||editor?.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
    for(const list of document.querySelectorAll('[role="listbox"]')){
      if(visible(list)&&(list.closest('form')===form||ownedIds.includes(list.id))&&!roots.includes(list)&&
         !roots.some(root=>root.contains(list)||list.contains(root)))roots.push(list);
    }
    const rows=roots.flatMap(root=>[...root.querySelectorAll('.__menu-item[tabindex="0"],button[data-list-navigation-item="true"]')].filter(visible));
    // Only the first public title counts. A description mentioning Local-MCP
    // underneath a different app name cannot stand in for that app's identity.
    const rowTitle=row=>{
      const leaf=[...row.querySelectorAll('*')].find(e=>e.children.length===0&&visible(e)&&text(e));
      return leaf?text(leaf):(row.innerText||row.textContent||'').split('\n').map(s=>s.replace(/\s+/g,' ').trim()).find(Boolean)||'';
    };
    const exact=rows.filter(row=>sameConnectorLabel(rowTitle(row),arg.expectedConnector));
    return {roots,rows,exact,titles:rows.map(rowTitle).filter(Boolean)};
  };
  const connectorQueryDiagnostics=()=>{
    // Read-only evidence for a query with no detected menu. These structural
    // candidates never feed connectorMenu, selection, input or activation.
    // A body-overlay is unowned structure, not an assertion of an app menu.
    const bounded=value=>String(value||'').replace(/\s+/g,' ').trim().slice(0,80);
    const excluded='[data-message-author-role],[data-conversation-role],[data-turn-key],[data-content-search-turn-key],[data-testid^="conversation-turn-"],[data-user-message-bubble],.thread-scroll-container,.markdown,[data-markdown-text-style],nav,[role="navigation"],aside,[data-testid^="history-"],[data-testid^="sidebar-"]';
    const protectedText=excluded+',[contenteditable],[role="textbox"],textarea,input,script,style,template,noscript';
    const publicVisible=e=>{
      if(!visible(e)||e.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
      const style=getComputedStyle(e);return style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse';
    };
    const counts=selector=>{const nodes=[...document.querySelectorAll(selector)];return {rawCount:nodes.length,visibleCount:nodes.filter(publicVisible).length};};
    const active=document.activeElement,selection=globalThis.window?.getSelection?.();
    const inEditor=node=>!!(editor&&node&&editor.contains(node));
    const ownerIds=(editor?.getAttribute('aria-controls')||editor?.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
    const popupSelector='[role="menu"],[role="listbox"],[role="combobox"],[data-composer-overlay-floating-ui]';
    const popups=[...document.querySelectorAll(popupSelector)].filter(e=>publicVisible(e)&&!e.closest(protectedText)&&
      (form&&e.closest('form')===form||ownerIds.includes(e.id)||!e.closest('form')&&document.body.contains(e)));
    const rowSelector='[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],button,[data-list-navigation-item],.__menu-item';
    const seenTitles=new Set();let remainingTitles=6;
    const popupStructures=popups.slice(0,6).map(e=>{
      const candidates=[...e.querySelectorAll(rowSelector)].filter(row=>publicVisible(row)&&!row.closest(protectedText)&&
        !row.parentElement?.closest(rowSelector));
      const rows=candidates.length?candidates:[...e.children].filter(row=>publicVisible(row)&&!row.closest(protectedText));
      const rowTitles=[];
      for(const row of rows){
        if(!remainingTitles)break;
        const leaf=[...row.querySelectorAll('*')].find(part=>!part.children.length&&publicVisible(part)&&!part.closest(protectedText)&&text(part));
        // A bare row may itself be the title; never read the whole container
        // or an input value when its descendants do not provide a title.
        const title=bounded(leaf?text(leaf):[...row.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent||'').join(' '));
        if(title&&!seenTitles.has(title)){seenTitles.add(title);rowTitles.push(title);remainingTitles--;}
      }
      return {tag:bounded(e.tagName),scope:ownerIds.includes(e.id)?'editor-owned':form&&e.closest('form')===form?'composer':'body-overlay',
        attributes:Object.fromEntries(['id','role','class','data-testid','data-state','data-composer-overlay-floating-ui']
          .filter(name=>e.hasAttribute(name)).map(name=>[name,bounded(e.getAttribute(name))])),rowTitles};
    });
    return {documentFocused:document.hasFocus(),focusInEditor:inEditor(active),
      selectionAvailable:!!selection,selectionAnchorInEditor:inEditor(selection?.anchorNode),selectionFocusInEditor:inEditor(selection?.focusNode),
      selectionCollapsed:selection?!!selection.isCollapsed:null,
      composerOverlay:counts('[data-composer-overlay-floating-ui]'),mentionScroll:counts('[data-mention-list-scroll-area]'),popupStructures};
  };
  const connectorState=()=>{
    const mentions=selectedMentions(),selected=mentions.map(e=>e.getAttribute('data-keyword')??e.getAttribute('app-mention-display-name')??''),{roots,exact,titles}=connectorMenu();
    return {editorCount:editors.length,text:editor?editorText():'',selected,visibleSelectedCount:mentions.filter(visible).length,
      ...(arg.diagnostics===true?{queryDiagnostics:connectorQueryDiagnostics(),selectedDetails:mentions.map(e=>{const rect=e.getBoundingClientRect(),style=getComputedStyle(e);return {
        name:e.getAttribute('data-keyword')??e.getAttribute('app-mention-display-name')??'',
        tag:e.tagName,path:e.getAttribute('app-mention-path')||e.getAttribute('data-id')||'',
        visible:visible(e),display:style.display,visibility:style.visibility,
        width:rect.width,height:rect.height,ariaHidden:e.getAttribute('aria-hidden'),
        hiddenAncestor:!!e.closest('[hidden],[inert],[aria-hidden="true"]')};})}:{}),
      composing:!!globalThis.__clwComposing,menuCount:roots.length,exactRows:exact.length,
      titles,...composerBusy()};
  };
  const requireConnector=()=>{
    const state=connectorState();
    if(typeof arg.expectedConnector!=='string'||!arg.expectedConnector||state.editorCount!==1||
       state.selected.length!==1||!sameConnectorLabel(state.selected[0],arg.expectedConnector)||state.visibleSelectedCount!==1)
      throw Error('connector_selection_mismatch');
    return state;
  };
  if(action==='connector-state')return connectorState();
  const coldRetryState=()=>{
    if(!arg.expectedBaseline||typeof arg.reconciliationId!=='string'||
       !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(arg.reconciliationId))
      throw Error('connector_cold_retry_identity_required');
    assertComposerIdle();
    // Focus/selection events can synchronously replace the editor or add a
    // stop button. Re-read public nodes instead of using this call's cache.
    const currentEditors=[...document.querySelectorAll('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]')].filter(visible);
    const state=dom('connector-state',{expectedConnector:arg.expectedConnector},activate,accessLimited,approval);
    if(state.generating||state.approvalRequired||state.accessLimited||state.blocked||state.composing)throw Error('send_baseline_changed');
    if(currentEditors.length!==1||currentEditors[0]!==editor||state.editorCount!==1||state.selected.length||state.text!==arg.expectedText)
      throw Error('send_preparation_query_changed');
    return state;
  };
  const coldClearReady=()=>{
    const state=coldRetryState();
    if(state.menuCount===1&&state.exactRows===1)return true;
    if(state.menuCount!==0||state.exactRows!==0)throw Error('connector_menu_not_unique_or_query_changed');
    return false;
  };
  if(action==='connector-clear-query'){
    // Only a reconciled pre-click connector query may be removed. No prompt,
    // selected app, user edit or active generation is part of this operation.
    assertComposerIdle();const state=connectorState(),query='@'+arg.expectedConnector;
    if(!arg.reconciliationId||!editor||!form||state.editorCount!==1||state.selected.length||
       state.text!==query||arg.expectedText!==query||globalThis.__clwComposing)
      throw Error('send_preparation_query_changed');
    if(arg.coldRetry===true){
      // Only this invocation's confirmed mention can use cold retry. A menu
      // arriving after the last read belongs to selection, never deletion.
      if(coldClearReady())return {menuReady:true};
    }
    editor.focus();if(document.activeElement!==editor)throw Error('editor_focus_failed');
    if('value' in editor)editor.setSelectionRange(0,editor.value.length);
    else{
      const selection=window.getSelection();if(!selection)throw Error('editor_selection_missing');
      const range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      if(!selection.anchorNode||!editor.contains(selection.anchorNode))throw Error('editor_selection_foreign');
    }
    if(arg.coldRetry===true&&coldClearReady())return {menuReady:true};
    if(!document.execCommand('delete',false,null)||editorText()!=='')throw Error('send_preparation_query_clear_unconfirmed');
    return {cleared:true};
  }
  if(action==='connector-query'){
    assertComposerIdle();
    const state=connectorState();
    if(typeof arg.expectedConnector!=='string'||!arg.expectedConnector||!editor||!form||state.selected.length||state.text||globalThis.__clwComposing)
      throw Error('editor_missing_or_user_draft');
    const requireColdEmpty=()=>{
      const state=coldRetryState();
      if(arg.expectedText!==''||state.menuCount!==0||state.exactRows!==0)throw Error('connector_menu_not_unique_or_query_changed');
    };
    if(arg.coldRetry===true)requireColdEmpty();
    editor.focus();if(document.activeElement!==editor)throw Error('editor_focus_failed');
    if(!('value' in editor)){
      const selection=window.getSelection();if(!selection)throw Error('editor_selection_missing');
      const range=document.createRange();range.selectNodeContents(editor);range.collapse(false);selection.removeAllRanges();selection.addRange(range);
      if(!selection.isCollapsed||!selection.anchorNode||!editor.contains(selection.anchorNode))throw Error('editor_selection_foreign');
    }
    if(arg.coldRetry===true)requireColdEmpty();
    if(!document.execCommand('insertText',false,'@'+arg.expectedConnector))throw Error('editor_insert_rejected');
    return {inserted:true};
  }
  if(action==='connector-select'){
    assertComposerIdle();
    const state=connectorState();
    if(!editor||!form||state.menuCount!==1||state.exactRows!==1||state.selected.length||
       state.text!=='@'+arg.expectedConnector||globalThis.__clwComposing||document.activeElement!==editor)
      throw Error('connector_menu_not_unique_or_query_changed');
    const {exact}=connectorMenu();
    if(exact.length!==1||exact[0].disabled||exact[0].getAttribute('aria-disabled')==='true')throw Error('connector_row_not_unique_or_disabled');
    if(exact[0].tagName==='BUTTON')exact[0].click();
    else exact[0].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}));
    return {activated:true};
  }
  const describe=e=>(e?.getAttribute('aria-describedby')||'').split(/\s+/).filter(Boolean).map(id=>text(document.getElementById(id))).join(' ');
  const visuallyVisibleSlider=e=>{
    // The native power-slider thumb is aria-hidden but visibly rendered. ARIA
    // describes accessibility exposure; geometry/CSS determines this key target.
    if(!e||e.closest('[hidden],[inert]')||!(e.offsetWidth||e.offsetHeight||e.getClientRects().length))return false;
    for(let node=e;node;node=node.parentElement){
      const style=typeof getComputedStyle==='function'?getComputedStyle(node):node.style;
      if(style?.display==='none'||style?.visibility==='hidden'||style?.visibility==='collapse')return false;
    }
    return true;
  };
  const visibleContainers=menu?[...menu.querySelectorAll('[data-model-reasoning-effort-slider],[data-model-picker-power-slider]')].filter(e=>visible(e)&&visuallyVisibleSlider(e)):[];
  const visibleSliders=[...new Set(visibleContainers.flatMap(container=>[...container.querySelectorAll('[role="slider"]')].filter(visuallyVisibleSlider)))];
  // Read and focus the same unique visible owned control. A hidden old picker
  // can precede the current one without being the observed model or key target.
  const sliderContainer=visibleContainers.length===1?visibleContainers[0]:null;
  const slider=sliderContainer&&visibleSliders.length===1?visibleSliders[0]:null;
  const radios=menu?[...menu.querySelectorAll('[role="menuitemradio"]')]:[];
  if(action==='open-model') {if(arg.expectedBaseline)assertComposerIdle();if(!control)throw Error('model_control_not_found');return control.getAttribute('aria-expanded')==='true'?{}:click(control);}
  const readModel=()=>{
    const selected=radios.filter(e=>e.getAttribute('aria-checked')==='true').map(optionText);
    const value=slider?.getAttribute('aria-valuenow');const min=slider?.getAttribute('aria-valuemin');const max=slider?.getAttribute('aria-valuemax');
    const selectedTick=sliderContainer?[...sliderContainer.querySelectorAll('[data-locked][data-selected="true"]')].find(visible):null;
    const description=slider?.getAttribute('aria-valuetext')||describe(slider?.closest('[role="menuitem"]'))||text(selectedTick);
    const announcement=description.split(/[,，]/)[0];
    const version=announcement.match(/^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(?:Sol|Astra))?\s+(.+)$/i);
    const effort=version?version[2]:announcement;
    const family=selected.join(' · ');
    const ticks=sliderContainer?[...sliderContainer.querySelectorAll('[data-selected]')].filter(visible):[];
    const powerEnabled=sliderContainer?.hasAttribute('data-model-picker-power-slider')&&[...sliderContainer.querySelectorAll('[data-orientation="horizontal"][aria-disabled="false"]')].some(visible);
    return {model:version&&family&&!family.toLowerCase().startsWith('gpt-'+version[1])?`GPT-${version[1]} · ${family}`:family,effort:effort||(value!==null&&value!==undefined?`档位 ${value} / ${max}`:''),selection:selected,description,sliderCount:visibleSliders.length,sliderContainerCount:visibleContainers.length,slider:value===null||value===undefined?null:{value:Number(value),min:Number(min),max:Number(max)},efforts:ticks.map((e,i)=>({value:Number(min)+i,label:text(e),available:e.getAttribute('data-locked')==='false'||(powerEnabled&&!e.hasAttribute('data-locked')),selected:e.getAttribute('data-selected')==='true'})),options:radios.map(e=>({name:optionText(e),checked:e.getAttribute('aria-checked')==='true',available:e.getAttribute('aria-disabled')!=='true'}))};
  };
  if(action==='model'){if(arg.expectedBaseline)assertComposerIdle();return readModel();}
  if(action==='choose-model') {const options=radios.filter(e=>optionText(e)===arg.label&&e.getAttribute('aria-disabled')!=='true');if(options.length!==1)throw Error('model_option_not_unique');if(options[0].getAttribute('aria-checked')==='true')return {};if(options[0].closest('[inert]')){const toggle=menu.querySelector('[role="menuitem"][aria-expanded="false"][aria-hidden="false"],[data-model-picker-view="simple"] [data-model-picker-view-toggle="true"][aria-hidden="false"]');if(!toggle)throw Error('model_advanced_toggle_missing');return click(toggle);}return {...click(options[0]),settles:true};}
  if(action==='focus-effort') {if(!slider)throw Error('effort_slider_missing');(slider.closest('[role="menuitem"]')||slider).focus();return {};}
  if(action==='focus-editor') {if(!editor||editorText()||globalThis.__clwComposing)throw Error('editor_missing_or_user_draft');if(arg.expectedConnector){assertComposerIdle();requireConnector();}editor.focus();return {};}
  if(action==='insert-plain-text') {
    if(!editor||editorText()||globalThis.__clwComposing||typeof arg.text!=='string'||!arg.text)throw Error('editor_missing_or_user_draft');
    if(arg.expectedConnector){assertComposerIdle();requireConnector();}
    editor.focus();if(document.activeElement!==editor)throw Error('editor_focus_failed');
    if('value' in editor){editor.setSelectionRange(editor.value.length,editor.value.length);if(!document.execCommand('insertText',false,arg.text))throw Error('editor_insert_rejected');return {inserted:true};}
    const selection=window.getSelection();if(!selection)throw Error('editor_selection_missing');
    // Chromium can resolve an editor-boundary caret back into the last inline
    // app cursor and clone that ignored span into every pasted paragraph.
    // Give our still-empty body a separate editable paragraph/text anchor.
    const range=document.createRange();
    if(arg.expectedConnector){
      const paragraph=document.createElement('p');paragraph.appendChild(document.createElement('br'));editor.appendChild(paragraph);
      range.setStart(paragraph,0);range.collapse(true);
    }else{range.selectNodeContents(editor);range.collapse(false);}
    selection.removeAllRanges();selection.addRange(range);
    if(!selection.isCollapsed||!selection.anchorNode||!editor.contains(selection.anchorNode))throw Error('editor_selection_foreign');
    if(!document.execCommand('insertText',false,arg.text.replace(/\r\n/g,'\n')))throw Error('editor_insert_rejected');
    return {inserted:true};
  }
  if(action==='editor-text')return {text:editorText()};
  const stopButtons=buttons.filter(e=>visible(e)&&(e.matches('[data-testid="stop-button"]')||(form?.contains(e)&&e.matches('button[type="button"]')&&/^(Stop|停止|停止生成)$/.test(e.getAttribute('aria-label')||''))));
  // Long conversations virtualize turns outside the current scroll viewport.
  // The last DOM node can therefore be an old, already completed answer.
  const history=document.querySelector('.thread-scroll-container');
  const reversed=history&&getComputedStyle(history).flexDirection==='column-reverse';
  const historyAtLatest=history?Math.abs(reversed?history.scrollTop:history.scrollHeight-history.clientHeight-history.scrollTop)<=8:null;
  if(action==='show-latest') {
    if(!history||stopButtons.length||editor&&editorText()||globalThis.__clwComposing)return {moved:false};
    if(historyAtLatest)return {moved:false};
    history.scrollTo({top:reversed?0:history.scrollHeight,behavior:'instant'});
    return {moved:true};
  }
  if(action==='stop') {if(stopButtons.length>1)throw Error('stop_button_not_unique');const stop=stopButtons[0];if(stop)stop.click();return {clicked:!!stop};}
  if(action!=='snapshot'&&action!=='send')throw Error('unknown_dom_operation');
  const roleUnits=(group,role)=>{
    const key=group?.getAttribute('data-content-search-turn-key');
    if(!key)return [];
    return [...group.querySelectorAll('[data-content-search-unit-key]')].filter(unit=>{
      const unitKey=unit.getAttribute('data-content-search-unit-key')||'';
      return unit.closest('[data-content-search-turn-key]')===group&&unitKey.startsWith(`${key}:`)&&unitKey.endsWith(`:${role}`)&&
        !!unit.querySelector(role==='user'?'[data-user-message-bubble]':'[data-conversation-role="assistant"]');
    });
  };
  const turns=role=>[...document.querySelectorAll('[data-testid^="conversation-turn-"],[data-turn-key],[data-content-search-turn-key]')].filter(e=>{
    if(e.hasAttribute('data-content-search-turn-key'))return roleUnits(e,role).length>0;
    if(e.hasAttribute('data-turn-key'))return !e.closest('[data-content-search-turn-key]')&&!!e.querySelector(role==='user'?'[data-user-message-bubble]':'[data-conversation-role="assistant"]');
    return !e.closest('[data-turn-key],[data-content-search-turn-key]')&&(e.getAttribute('data-turn')===role||e.getAttribute('data-message-author-role')===role||e.querySelector(`[data-message-author-role="${role}"]`));
  });
  const user=turns('user').at(-1),assistant=turns('assistant').at(-1);
  const currentAssistant=!!assistant&&(!user||user===assistant||!!(user.compareDocumentPosition(assistant)&Node.DOCUMENT_POSITION_FOLLOWING));
  const identity=(e,role)=>e?.hasAttribute('data-content-search-turn-key')?`group:${role}:${roleUnits(e,role).at(-1)?.getAttribute('data-content-search-unit-key')}`:e?.hasAttribute('data-turn-key')?`group:${role}:${e.getAttribute('data-turn-key')}`:e?.getAttribute('data-turn-id')||e?.getAttribute('data-message-id')||e?.querySelector('[data-message-id]')?.getAttribute('data-message-id')||'';
  const userText=text(user?.hasAttribute('data-content-search-turn-key')?roleUnits(user,'user').at(-1)?.querySelector('[data-user-message-bubble]'):user?.hasAttribute('data-turn-key')?user.querySelector('[data-user-message-bubble]'):user);
  const markers=[...userText.matchAll(/\[CLW:(control_[0-9a-f]{32})\]/g)];
  const marker=markers.length===1&&/^(?:\s|…|\.{3}|Show more|显示更多|展开)*$/i.test(userText.slice(markers[0].index+markers[0][0].length))?markers[0][0]:null;
  // Count physical bubbles once even when both public turn wrappers exist.
  const userBubbles=turns('user').flatMap(e=>e.hasAttribute('data-content-search-turn-key')?roleUnits(e,'user').map(unit=>unit.querySelector('[data-user-message-bubble]')):[e.querySelector('[data-user-message-bubble]')||e]);
  const markerCount=marker?[...new Set(userBubbles.filter(Boolean))].filter(e=>text(e).includes(marker)).length:0;
  const currentGroup=user;
  const currentUserAnchor=user?.hasAttribute('data-content-search-turn-key')?roleUnits(user,'user').at(-1):user?.querySelector('[data-user-message-bubble],[data-message-author-role="user"]');
  const rawStopPresent=stopButtons.length>0;
  const approvalState=approval();
  const approvalRequired=approvalState.required;
  const alerts=[...document.querySelectorAll('[role="alert"],[role="dialog"],[role="alertdialog"]')].filter(e=>visible(e)&&!e.closest('[data-message-author-role],[data-conversation-role],[data-turn-key],[data-content-search-turn-key]')).map(text);
  const terminalStop=/^(?:Stopped thinking|已停止思考|已中斷思考)$/i;
  const assistantStopped=currentAssistant&&[...assistant.querySelectorAll('span,button')].some(e=>terminalStop.test(text(e)));
  const terminalFailure=/^(?:Something went wrong while generating the response\.?|生成回复时出错[。.]?|Thinking failed|思考失败|无法思考|Error in message stream[.]?|消息流中的错误[。.]?)$/i;
  const publicTurn='[data-turn-key],[data-content-search-turn-key],[data-testid^="conversation-turn-"]';
  const prose='.markdown,[data-markdown-text-style],[data-user-message-bubble],pre,code,blockquote';
  const platformVisible=e=>{
    if(!e||e.closest('[hidden],[inert],[aria-hidden="true"]'))return false;
    for(let node=e;node;node=node.parentElement){
      if(!visible(node))return false;
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return false;
    }
    return true;
  };
  // Exact platform labels may be individual children of a status block. Do
  // not substring-match prose or treat a Retry/processing notice as failure.
  const platformLabel=(root,pattern,{error=false}={})=>{
    if(!platformVisible(root))return '';
    const copy=root.cloneNode(true);
    const children=[...root.querySelectorAll('*')],copies=[...copy.querySelectorAll('*')];
    children.forEach((child,index)=>{
      if(!platformVisible(child)||child.closest(publicTurn)!==root.closest(publicTurn)||
         child.matches(error?'button,[role="button"]':prose))copies[index].remove();
    });
    const whole=text(copy);
    if(pattern.test(whole))return whole;
    const label=children.find(e=>platformVisible(e)&&e.closest(publicTurn)===root.closest(publicTurn)&&
      (!error?!e.closest(prose):!e.closest('button,[role="button"]'))&&pattern.test(text(e)));
    return text(label);
  };
  const assistantUnit=assistant?.hasAttribute('data-content-search-turn-key')?roleUnits(assistant,'assistant').at(-1):assistant;
  const errorPanel=currentAssistant?[...(assistantUnit?.querySelectorAll('.text-token-text-error')||[])].find(e=>
    platformVisible(e)&&!e.closest(prose)&&e.closest(publicTurn)===assistant&&
    (!currentUserAnchor||!currentUserAnchor.contains(e)&&!!(currentUserAnchor.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING))):null;
  const errorText=platformLabel(errorPanel,terminalFailure,{error:true});
  // A Retry button alone can accompany a quota/permission refusal too.
  // Only explicit generation-error wording authorizes continuation.
  // A failed platform title may lose its activity class or assistant body.
  // Only the latest managed user's public turn (or its explicitly current
  // assistant turn) owns it. Never use a whole-page text/error fallback.
  const platformGroups=[...new Set([currentGroup,currentAssistant?assistant:null].filter(Boolean))];
  const lastAssistantUnits=new Map(platformGroups.map(group=>{
    const key=group.getAttribute('data-content-search-turn-key');
    const units=[...group.querySelectorAll('[data-content-search-unit-key]')].filter(unit=>{
      const unitKey=unit.getAttribute('data-content-search-unit-key')||'';
      return unit.closest(publicTurn)===group&&unitKey.endsWith(':assistant')&&(!key||unitKey.startsWith(key+':'))&&
        currentUserAnchor&&!currentUserAnchor.contains(unit)&&!!(currentUserAnchor.compareDocumentPosition(unit)&Node.DOCUMENT_POSITION_FOLLOWING);
    });
    return [group,units.at(-1)];
  }));
  const ownedPlatform=e=>{
    const group=e.closest(publicTurn),unit=e.closest('[data-content-search-unit-key]');
    return platformGroups.includes(group)&&currentUserAnchor&&!currentUserAnchor.contains(e)&&
      !!(currentUserAnchor.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)&&!e.closest(prose)&&
      (!unit||unit===lastAssistantUnits.get(group))&&platformVisible(e);
  };
  const terminalActive=/^(?:Thinking(?:\.{3}|…)?|思考中(?:\.{3}|…)?|正在思考(?:\.{3}|…)?)$/i;
  const semanticTitle='h1,h2,h3,h4,h5,h6,[role="heading"],[role="status"],[role="alert"]';
  const currentActivities=platformGroups.flatMap(group=>[...group.querySelectorAll('[class~="group/activity-header"],'+semanticTitle+',div,span')]).filter(e=>{
    const activity=e.matches('[class~="group/activity-header"]'),semantic=e.matches(semanticTitle);
    const leaf=!activity&&!semantic&&e.childElementCount===0&&(e.textContent||'').length<=160?text(e):'';
    // Discard arbitrary body spans before style walks or copying descendants.
    if(!activity&&!semantic&&!(terminalFailure.test(leaf)||terminalStop.test(leaf)||terminalActive.test(leaf)))return false;
    if(!ownedPlatform(e))return false;
    if(activity)return true;
    // Explicit public alerts already identify a platform status in the latest
    // user group. Keep that legacy contract independent of managed markers;
    // only the class-free/title fallback requires a unique CLW marker.
    const currentPublicAlert=e.matches('[role="alert"]')&&e.closest(publicTurn)===currentGroup;
    if((!currentPublicAlert&&(!marker||markerCount!==1))||e.closest('[data-conversation-role],[data-message-author-role],button,[role="button"],a,[role="link"],input,textarea,select,[contenteditable]'))return false;
    if(semantic)return !!(platformLabel(e,terminalFailure)||platformLabel(e,terminalStop)||platformLabel(e,terminalActive));
    // Class-free div/span phase labels must be bounded visible exact leaves,
    // not ancestor transcript containers or arbitrary prose substrings.
    return !!leaf&&!e.closest('[class~="group/activity-header"]');
  }).sort((a,b)=>a===b?0:a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
  // A later activity header is the current phase, even in the same managed
  // turn. A retained earlier failure cannot override resumed thinking.
  const waitingNotice=/^(?:连接已中断，正在等待完整答复[。.]?|我们的系统正在进一步处理此请求[。.]?)$/;
  const currentPhases=currentActivities.filter(e=>!platformLabel(e,waitingNotice)||
    platformLabel(e,terminalFailure)||platformLabel(e,terminalStop)||platformLabel(e,terminalActive));
  const latestActivity=currentPhases.at(-1);
  const activityFailure=platformLabel(latestActivity,terminalFailure)?latestActivity:null;
  // The live UI places a stream failure inside the current user group, with
  // role=alert but no assistant unit. Global alerts deliberately exclude chat
  // groups; admit only a visible, exact platform alert after this user's bubble.
  const currentGroupAlerts=currentGroup?[...currentGroup.querySelectorAll('[role="alert"]')].filter(e=>
    platformVisible(e)&&currentUserAnchor&&!currentUserAnchor.contains(e)&&!!(currentUserAnchor.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)&&
    e.closest(publicTurn)===currentGroup&&!e.closest(prose+', [data-conversation-role],[data-message-author-role]')
  ):[];
  // Explicit alerts participate in phase order too. An older alert must not
  // revive a failure after a later current thinking header/status.
  const groupAlertFailure=latestActivity?.matches('[role="alert"]')&&platformLabel(latestActivity,terminalFailure)?latestActivity:null;
  const ownedFailure=errorText||platformLabel(activityFailure,terminalFailure)||platformLabel(groupAlertFailure,terminalFailure);
  // A retained Stop cannot hide an explicit failure on this unique managed
  // attempt. It remains physical busy evidence for preparation and sole Send;
  // a server-processing/connection-wait notice alone never ends generation.
  const priorityFailure=!!marker&&markerCount===1&&!!ownedFailure;
  const generating=rawStopPresent&&!priorityFailure;
  const stopped=!rawStopPresent&&(assistantStopped||currentActivities.some(e=>terminalStop.test(text(e))));
  const failure=priorityFailure?ownedFailure:!rawStopPresent&&(alerts.find(t=>terminalFailure.test(t))||ownedFailure)||'';
  const platformNotices=[...currentActivities,...currentGroupAlerts,...(errorPanel?[errorPanel]:[])];
  const streamInterrupted=platformNotices.some(e=>platformLabel(e,/^连接已中断，正在等待完整答复[。.]?$/));
  const processingNotice=platformNotices.some(e=>platformLabel(e,/^我们的系统正在进一步处理此请求[。.]?$/));
  const usageLimited=alerts.some(t=>/(?:reached|hit|exceeded).{0,60}(?:usage|message|Pro).{0,30}limit|usage limit.{0,50}(?:reached|reset|try again)|limit reached|用量上限|已(?:达到|用完).{0,30}(?:上限|额度)/i.test(t));
  const blocked=usageLimited||alerts.some(t=>/登录已过期/i.test(t));
  const answerSelector='.markdown,[data-markdown-text-style="assistant-message"]';
  const contents=assistant?[...assistant.querySelectorAll(answerSelector)].filter(e=>!e.parentElement?.closest(answerSelector)).filter(e=>{
    if(assistant.hasAttribute('data-content-search-turn-key'))return roleUnits(assistant,'assistant').some(unit=>unit.contains(e));
    if(!assistant.hasAttribute('data-turn-key'))return true;
    const unit=e.closest('[data-content-search-unit-key]');return !!unit&&[...unit.children].some(c=>c.getAttribute('data-conversation-role')==='assistant');
  }):[];
  const grouped=assistant?.hasAttribute('data-turn-key')||assistant?.hasAttribute('data-content-search-turn-key');
  const completion=grouped?contents.length>0&&[...assistant.querySelectorAll('.turn-action-controls button,[data-testid="copy-turn-action-button"],button[aria-label="复制"],button[aria-label="Copy"],button[aria-label="重新生成回复"],button[aria-label="Regenerate"]')].some(e=>!!(contents.at(-1).compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING)):!!assistant?.querySelector('[data-testid="copy-turn-action-button"]');
  const effortLabel=(control?.innerText||text(control)).trim();
  const userUnit=user?.hasAttribute('data-content-search-turn-key')?roleUnits(user,'user').at(-1):user;
  const userBubble=userUnit?.querySelector('[data-user-message-bubble]');
  const userTextComplete=!!userBubble&&![...userUnit.querySelectorAll('button,[role="button"]')].some(e=>/^(?:show more|see more|read more|显示更多|展开|展开更多)$/i.test((e.getAttribute('aria-label')||text(e)).trim()))&&
    !/(?:…|\.{3})\s*(?:show more|see more|显示更多|展开)?$/i.test(userText);
  const bootstrapMarkers=[...userText.matchAll(/\[CLW-BOOTSTRAP:(web-[0-9a-f-]{36})\]/g)];
  const bootstrapMarker=bootstrapMarkers.length===1&&/^(?:\s|…|\.{3}|Show more|显示更多|展开)*$/i.test(userText.slice(bootstrapMarkers[0].index+bootstrapMarkers[0][0].length))?bootstrapMarkers[0][0]:null;
  const bootstrapMarkerCount=bootstrapMarker?[...new Set(userBubbles.filter(Boolean))].filter(e=>text(e).includes(bootstrapMarker)).length:0;
  // Search fallback keys are viewport ordinals, not message identities. After
  // reload a new answer can receive the *old* answer's ordinal. Only a unique
  // exact marker in the same public user/assistant group scopes this identity;
  // quoted markers, a later user group and foreign replies never qualify.
  const scopedAssistant=currentAssistant&&user===assistant&&marker&&markerCount===1&&
    /^fallback-turn-/.test(assistant?.getAttribute('data-content-search-turn-key')||'');
  const ownFailure=[activityFailure,groupAlertFailure].find(e=>e&&platformLabel(e,terminalFailure)===failure&&
    e.closest('[data-turn-key],[data-content-search-turn-key],[data-testid^="conversation-turn-"]')===currentGroup);
  const scopedFailure=!!marker&&markerCount===1&&!!failure&&!!ownFailure&&
    /^fallback-turn-/.test(user?.getAttribute('data-content-search-turn-key')||'')&&roleUnits(currentGroup,'assistant').length===0;
  // Failed thinking can have no assistant unit at all. A previous assistant's
  // viewport key is not the current failure's identity. Pin the public failure
  // to its own unique managed user turn so reloads retain the same baseline.
  const assistantIdentity=scopedFailure?`managed-public:${marker}:failed-assistant:${failure}`:
    scopedAssistant?`managed-public:${marker}:assistant`:identity(assistant,'assistant');
  const scopedUser=marker&&markerCount===1&&/^fallback-turn-/.test(user?.getAttribute('data-content-search-turn-key')||'');
  const userIdentity=scopedUser?`managed-public:${marker}:user`:identity(user,'user');
  const turnStructure=()=>{
    // Diagnose a missing public turn identity without reading transcript text,
    // attribute values, private interfaces or altering receipt decisions.
    const result={version:1,eligible:!userIdentity&&/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(location.href),
      limits:{scannedElements:4096,nodes:8,ancestors:8,attributes:16,attributeProbe:24},
      scannedElements:0,scanTruncated:false,nodesTruncated:false,counts:{},nodes:[]};
    if(!result.eligible)return result;
    result.recognized={users:turns('user').length,assistants:turns('assistant').length};
    const root=history||document.querySelector('main')||document.body||document.documentElement;
    result.scope=history?'history':root?.tagName==='MAIN'?'main':'body';
    const excluded='nav,aside,[role="navigation"],form,input,textarea,select,[contenteditable],script,style,template,noscript';
    const roleValue=(e,name)=>{const value=e.getAttribute(name);return value?(['user','assistant','system','tool'].includes(value)?value:'other'):null;};
    const unitRole=e=>{const value=e.getAttribute('data-content-search-unit-key');return value?(['user','assistant','tool'].find(role=>value.endsWith(':'+role))||'other'):null;};
    const descriptor=e=>{
      const attributes=[];let attributesTruncated=e.attributes.length>24;
      for(let i=0;i<Math.min(e.attributes.length,24);i++){
        const name=e.attributes[i].name;
        if(!/^(?:data-[a-z0-9-]{1,60}|role|class|id|aria-hidden)$/.test(name))continue;
        if(attributes.length<16)attributes.push(name);else attributesTruncated=true;
      }
      return {tag:String(e.tagName||'').slice(0,24),attributes,attributesTruncated,
        messageAuthorRole:roleValue(e,'data-message-author-role'),conversationRole:roleValue(e,'data-conversation-role'),
        turnRole:roleValue(e,'data-turn'),unitRole:unitRole(e)};
    };
    const signatures=[['legacyTurn','[data-testid^="conversation-turn-"]'],['turnKey','[data-turn-key]'],
      ['searchTurnKey','[data-content-search-turn-key]'],['searchUnitKey','[data-content-search-unit-key]'],
      ['userBubble','[data-user-message-bubble]'],['messageAuthor','[data-message-author-role]'],
      ['conversationRole','[data-conversation-role]'],['turnRole','[data-turn]'],['markdown','[data-markdown-text-style]']];
    for(const [name] of signatures)result.counts[name]={raw:0,visible:0};
    const walker=document.createTreeWalker(root,1);let node;
    while(result.scannedElements<4096&&(node=walker.nextNode())){
      result.scannedElements++;
      if(node.closest(excluded))continue;
      const matches=signatures.filter(([,selector])=>node.matches(selector)).map(([name])=>name);
      if(!matches.length)continue;
      const isVisible=platformVisible(node);
      for(const name of matches){result.counts[name].raw++;if(isVisible)result.counts[name].visible++;}
      const ancestors=[];let parent=node.parentElement;
      while(parent&&ancestors.length<8){ancestors.push(descriptor(parent));if(parent===root){parent=null;break;}parent=parent.parentElement;}
      if(result.nodes.length===8){result.nodes.shift();result.nodesTruncated=true;}
      result.nodes.push({...descriptor(node),matches,visible:isVisible,ancestors,ancestorsTruncated:!!parent});
    }
    result.scanTruncated=result.scannedElements===4096;
    return result;
  };
  const failureDiagnostics=()=>{
    // Evidence only. Labels are fixed codes, never transcript excerpts. Include
    // excluded structures so a missed platform title can be diagnosed without
    // changing failure/Send semantics or exposing a generic DOM query interface.
    const result={version:1,eligible:!!marker&&markerCount===1&&!!currentUserAnchor,
      limits:{nodes:12,ancestors:12,scannedElements:4096,textProbeChars:160,classTokens:8},
      scannedElements:0,nodesTruncated:false,scanTruncated:false,nodes:[]};
    if(!result.eligible)return result;
    const knownLabels=[
      [/^Something went wrong while generating the response\.?$/i,'response_error_en'],[/^生成回复时出错[。.]?$/,'response_error_zh'],
      [/^Thinking failed$/i,'thinking_failed_en'],[/^思考失败$/,'thinking_failed_zh'],[/^无法思考$/,'thinking_unavailable_zh'],
      [/^Error in message stream[.]?$/i,'stream_error_en'],[/^消息流中的错误[。.]?$/,'stream_error_zh'],
      [/^Stopped thinking$/i,'stopped_thinking_en'],[/^已停止思考$/,'stopped_thinking_zh'],[/^已中斷思考$/,'stopped_thinking_zh_hant'],
      [/^Thinking(?:\.{3}|…)?$/i,'thinking_en'],[/^思考中(?:\.{3}|…)?$/,'thinking_zh'],[/^正在思考(?:\.{3}|…)?$/,'thinking_started_zh'],
      [/^连接已中断，正在等待完整答复[。.]?$/,'connection_wait_zh'],[/^我们的系统正在进一步处理此请求[。.]?$/,'processing_request_zh']
    ];
    const editable='input,textarea,select,[contenteditable],[role="textbox"]';
    const controls='button,[role="button"],a,[role="link"],input,textarea,select,[contenteditable],[role="textbox"]';
    const author='[data-conversation-role],[data-message-author-role]';
    const classes=new Set(['group/activity-header','text-token-text-error','markdown','turn-action-controls']);
    const roles=new Set(['heading','status','alert','alertdialog','dialog','button','link','textbox','group','region','presentation','none']);
    const role=e=>{const value=e.getAttribute('role');return value?(roles.has(value)?value:'other'):null;};
    const authorRole=(e,name)=>{const value=e.getAttribute(name);return value?(['user','assistant','system','tool'].includes(value)?value:'other'):null;};
    const groupKind=e=>{const group=e.closest(publicTurn);return !group?'none':group===currentGroup?'current_user':currentAssistant&&group===assistant?'current_assistant':'foreign';};
    const unitRole=e=>{const unit=e.closest('[data-content-search-unit-key]');if(!unit)return 'none';
      const value=unit.getAttribute('data-content-search-unit-key')||'';return ['user','assistant','tool'].find(name=>value.endsWith(':'+name))||'other';};
    const descriptor=e=>({tag:String(e.tagName||'').slice(0,32),role:role(e),
      classTokens:[...classes].filter(value=>e.classList.contains(value)).slice(0,8),
      conversationRole:authorRole(e,'data-conversation-role'),messageAuthorRole:authorRole(e,'data-message-author-role'),
      publicGroup:groupKind(e),unitRole:unitRole(e),prose:!!e.closest(prose),control:!!e.closest(controls)});
    const labelCode=e=>{
      if(e.closest(editable)||e.matches('script,style,template,noscript'))return null;
      // Bound probes before reading a large ancestor's complete textContent.
      let value='',visited=0;const pending=[e];
      while(pending.length){
        const node=pending.pop();if(++visited>128)return null;
        if(node.nodeType===3){if(value.length+(node.nodeValue||'').length>160)return null;value+=node.nodeValue||'';}
        else if(node.nodeType===1){if(node.matches(editable+',script,style,template,noscript'))return null;
          // Account for queued work before expanding a wide container. The
          // probe never allocates a child stack larger than its total budget.
          if(visited+pending.length+node.childNodes.length>128)return null;
          for(let i=node.childNodes.length-1;i>=0;i--)pending.push(node.childNodes[i]);}
      }
      value=value.replace(/\s+/g,' ').trim();return knownLabels.find(([pattern])=>pattern.test(value))?.[1]||null;
    };
    const after=e=>!currentUserAnchor.contains(e)&&!!(currentUserAnchor.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING);
    const walker=document.createTreeWalker(document.body||document.documentElement,1);
    // Do not revisit prior transcript/navigation. Count every visited element,
    // including descendants inside the current user, against the one scan cap.
    walker.currentNode=currentUserAnchor;
    const collectedNodes=[];let node,nextUser=null;
    while((node=walker.nextNode())){
      if(result.scannedElements>=4096){result.scanTruncated=true;break;}result.scannedElements++;
      if(!after(node))continue;
      if(!nextUser&&node.matches('[data-user-message-bubble],[data-message-author-role="user"]'))nextUser=node;
      const code=labelCode(node);if(!code)continue;
      // Report the deepest exact label, with its semantic wrappers in ancestors.
      // A stack of identical one-child wrappers cannot consume all 12 results.
      if([...node.children].some(child=>labelCode(child)===code))continue;
      if(result.nodes.length>=12){result.nodesTruncated=true;continue;}
      const group=node.closest(publicTurn),unit=node.closest('[data-content-search-unit-key]'),visible=platformVisible(node);
      const annotations=descriptor(node),ancestors=[];let ancestor=node.parentElement;
      while(ancestor&&ancestors.length<12){ancestors.push(descriptor(ancestor));ancestor=ancestor.parentElement;}
      const exclusions=[];
      if(!platformGroups.includes(group))exclusions.push('outside_current_public_turn');
      if(unit&&unit!==lastAssistantUnits.get(group))exclusions.push('not_latest_assistant_unit');
      if(annotations.prose)exclusions.push('prose');if(node.closest(author))exclusions.push('author_container');
      if(annotations.control)exclusions.push('interactive_control');if(!visible)exclusions.push('not_visible');
      collectedNodes.push(node);
      result.nodes.push({...annotations,labelCode:code,relationToCurrentUser:'after',
        visible,latestGroup:group===currentGroup,ownedAssistant:!!unit&&unit===lastAssistantUnits.get(group),
        ownedPlatform:ownedPlatform(node),authorContainer:!!node.closest(author),exclusions,ancestors,ancestorsTruncated:!!ancestor});
    }
    result.nextUserObserved=!!nextUser;
    result.nodes.forEach((entry,index)=>{const candidate=collectedNodes[index];
      entry.relationToNextUser=!nextUser?(result.scanTruncated?'not_observed_within_bound':'none'):nextUser.contains(candidate)?'inside':
        nextUser.compareDocumentPosition(candidate)&Node.DOCUMENT_POSITION_FOLLOWING?'after':'before';
    });
    return result;
  };
  // Public activity only, as an optional projection of this existing snapshot.
  // No hidden reasoning, extra collector, body scraping or completion signal.
  const publicProcess=()=>{
    const headers=currentActivities.filter(e=>e.matches('[class~="group/activity-header"]'));
    const activities=[];
    const publicLabel=(root,limit)=>{
      const walker=document.createTreeWalker(root,5);let node,visited=0,value='';
      while((node=walker.nextNode())&&++visited<=128&&value.length<limit){
        if(node.nodeType!==3)continue;
        const parent=node.parentElement;
        if(!parent||parent.closest('svg,kbd,script,style,input,textarea,[contenteditable]')||!platformVisible(parent))continue;
        value+=(node.nodeValue||'').slice(0,limit-value.length)+' ';
      }
      return value.replace(/\s+/g,' ').trim().slice(0,limit);
    };
    for(const header of headers.slice(-12)){
      const title=publicLabel(header,240);
      const summaryNode=[...header.querySelectorAll('[data-reasoning-summary],[data-testid="reasoning-summary"]')].find(platformVisible);
      const summary=summaryNode?publicLabel(summaryNode,640):'';
      if(title&&!activities.some(item=>item.title===title&&item.summary===summary))activities.push({title,summary});
    }
    return {source:'public_dom',scope:'current_user_turn',userId:userIdentity,activities,truncated:headers.length>12};
  };
  const snapshot={url:location.href,editor:!!editor,draft:!!(editor&&editorText()),generating,rawStopPresent,streamInterrupted,processingNotice,stopped,blocked,usageLimited,failure,approvalRequired,accessLimited:accessLimited(),focused:document.hasFocus(),composing:!!globalThis.__clwComposing,
    visibleModel:menu&&visible(menu)?readModel():null,effortLabel:/^(极高|中|中等|高|低|即时|Extra High|Medium|High|Low|Instant|Pro)$/i.test(effortLabel)?effortLabel:'',
    userId:userIdentity,userText,userTextComplete,attemptMarker:marker,attemptMarkerCount:markerCount,bootstrapMarker,bootstrapMarkerCount,assistantId:assistantIdentity,
    historyAtLatest,complete:historyAtLatest!==false&&!!user&&currentAssistant&&!generating&&!failure&&completion,
    html:contents.map(e=>e.outerHTML).join('\n'),publicText:contents.map(text).join('\n'),
    controlKnown:!!control,loginRequired:/^https:\/\/chatgpt\.com\/auth\/(login|signup)(?:[/?#]|$)/.test(location.href)||(!editor&&buttons.some(e=>/^(Log in|登录)$/.test(text(e)))),
    ...(action==='snapshot'?pageDiagnostics():{})};
  if(action==='snapshot'){
    snapshot.readiness.approvalImplementationVersion=approvalState.implementationVersion||1;
    snapshot.readiness.failureDiagnostics=failureDiagnostics();
    try{snapshot.readiness.turnStructure=turnStructure();}catch{snapshot.readiness.turnStructure={version:1,unavailable:true};}
    // Observation errors never alter readiness, Send or outcome persistence.
    try{snapshot.publicProcess=publicProcess();}catch{snapshot.publicProcess={source:'public_dom',scope:'current_user_turn',userId:userIdentity,activities:[],unavailable:true};}
  }
  if(action==='send'){
    if(typeof arg.expectedText!=='string'||!arg.expectedText||!editorEquivalent(arg.expectedText,editorText())||globalThis.__clwComposing)throw Error('editor_prompt_mismatch');
    requireConnector();
    const expected=arg.expectedBaseline;
    if(!expected||snapshot.url!==expected.url||snapshot.userId!==expected.userId||snapshot.assistantId!==expected.assistantId||
       rawStopPresent||snapshot.generating||snapshot.blocked||snapshot.approvalRequired||snapshot.accessLimited||snapshot.loginRequired)
      throw Error('send_baseline_changed');
    if(arg.expectedModel){
      const current=readModel(),model=arg.expectedModel;
      if(!control||!owned||!menu||menu.id!==owned||!visible(menu)||current.sliderCount!==1||current.sliderContainerCount!==1||
         !model.model||!model.effort||current.model!==model.model||current.effort!==model.effort||
         !Array.isArray(model.selection)||!model.selection.length||current.selection.length!==model.selection.length||
         !current.selection.every((choice,i)=>choice===model.selection[i]))throw Error('send_model_selection_mismatch');
    }
    const sends=[...(form?.querySelectorAll('[data-testid="send-button"],button[type="submit"]')||[])].filter(e=>visible(e)&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');
    if(sends.length!==1)throw Error('send_button_unavailable');
    // Original public identity + exact body + exact app are one synchronous
    // transaction with this sole click. An observation timeout never retries.
    sends[0].click();return {};
  }
  return snapshot;
}
// Keep this coordinator and its native-read slots for the lifetime of the app.
// A hot adapter update changes only the function serialized into the public page.
const adapterFS=require('node:fs'),adapterCrypto=require('node:crypto');
const adapterSourceSHA=()=>adapterCrypto.createHash('sha256').update(adapterFS.readFileSync(__filename)).digest('hex');
let domImplementation=dom,adapterSHA=adapterSourceSHA(),adapterRevision=1;
const coordinatorSHA=adapterSHA;
function adapterSnapshot(){return {sha256:adapterSHA,revision:adapterRevision,
  coordinator_sha256:coordinatorSHA,scope:'serialized-public-dom'};}
function adapterRejected(code){return Object.assign(Error(code),{code,accepted:false});}
function reloadDOMImplementation({expectedSHA,expectedAdapter,assertCurrent=()=>{}}={}){
  const original={implementation:domImplementation,sha256:adapterSHA,revision:adapterRevision};
  const check=()=>{
    if(!expectedAdapter||expectedAdapter.sha256!==adapterSHA||expectedAdapter.revision!==adapterRevision)
      throw adapterRejected('page_adapter_loaded_identity_changed');
    assertCurrent();
  };
  if(!/^[a-f0-9]{64}$/.test(expectedSHA||''))throw adapterRejected('page_adapter_source_sha_required');
  check();
  // There is no payload path or executable source. This is the original module's
  // fixed, canonical local file; verify both sides of synchronous module loading.
  if(adapterSourceSHA()!==expectedSHA)throw adapterRejected('page_adapter_source_sha_mismatch');
  const canonical=__filename,cached=require.cache[canonical],children=module.children.slice();
  if(cached!==module)throw adapterRejected('page_adapter_coordinator_cache_changed');
  try{
    delete require.cache[canonical];
    const fresh=require(canonical);
    if(adapterSourceSHA()!==expectedSHA)throw adapterRejected('page_adapter_source_changed_during_load');
    check();
    if(typeof fresh.dom!=='function')throw adapterRejected('page_adapter_implementation_invalid');
    if(domImplementation!==original.implementation||adapterSHA!==original.sha256||adapterRevision!==original.revision)
      throw adapterRejected('page_adapter_loaded_identity_changed');
    // Commit without an await: imported runDom and its WeakMap never change.
    domImplementation=fresh.dom;module.exports.dom=fresh.dom;
    adapterSHA=expectedSHA;adapterRevision++;
    return {...adapterSnapshot(),reloaded:true,read_queues_preserved:true,run_dom_preserved:true};
  }finally{
    // Even successful updates leave future requires on the original coordinator.
    require.cache[canonical]=cached;module.children.splice(0,module.children.length,...children);
  }
}
const snapshotReads=new WeakMap();
function readSnapshot(wc,expression,timeoutMs){
  const original=snapshotReads.get(wc);
  if(original)return original.wait;
  const entry={};
  const evaluation=Promise.resolve().then(()=>pageInput.evaluate(wc,expression));
  let timer;
  entry.wait=Promise.race([evaluation,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('page_snapshot_timeout')),timeoutMs);
  })]).finally(()=>clearTimeout(timer));
  snapshotReads.set(wc,entry);
  // The deadline releases the caller, not the original browser read. Keep
  // that read's identity until it settles so periodic checks cannot accumulate
  // more commands in a stalled renderer. A late result is never published.
  const clear=()=>{if(snapshotReads.get(wc)===entry)snapshotReads.delete(wc);};
  void evaluation.then(clear,clear);
  return entry.wait;
}
async function runDom(wc,action,arg={}, {snapshotTimeoutMs=8000}={}) {
  if(!/^https:\/\/chatgpt\.com\//.test(wc.getURL()))throw Error('chat_page_required');
  const key=Symbol.for('clw.manual-input-sequence'),sequence=wc[key]||0;
  const assertCurrent=()=>{if((wc[key]||0)!==sequence)throw Object.assign(Error('原网页正在被手动操作，自动操作已让位。'),{code:'manual_control'});};
  for(let step=0;step<3;step++){
    const expression=`(${domImplementation.toString()})(${JSON.stringify(action)},${JSON.stringify(arg)},${pageInput.domClick.toString()},${publicAccessLimit.toString()},${publicApproval.toString()})`;
    // A stalled read must not hold the observer's busy flag indefinitely.
    // Only the read-only snapshot gets a deadline. Input/Send keep their
    // original unknown-result handling and are never replayed by this wait.
    const result=await (action==='snapshot'?readSnapshot(wc,expression,snapshotTimeoutMs):pageInput.evaluate(wc,expression,{assertCurrent}));
    if(!result.clicked)return result;
    // Radix opens on pointer down. HTMLElement.click() alone does not open it.
    // Input stays inside this owned renderer and never takes the OS foreground.
    await new Promise(resolve=>setTimeout(resolve,150));
    if(result.settles)return {};
  }
  throw Error('model_menu_did_not_settle');
}
module.exports={dom,runDom,adapterSnapshot,reloadDOMImplementation};

// Older coordinators retain publicApproval in both runDom and ApprovalManager.
// They already serialize that same function object into their owned renderers.
// Keep a single facade on that object, selecting its source by the coordinator's
// committed DOM function. A failed/stale reload therefore still serializes the
// old implementation; its pending native reads and approval journal stay intact.
if(module.parent?.filename===__filename&&typeof module.parent.exports?.adapterSnapshot==='function'){
  const coordinator=module.parent,canonical=require.resolve('./public-approval.cjs');
  const cached=require.cache[canonical],source=adapterFS.readFileSync(canonical,'utf8');
  let candidate;
  try{delete require.cache[canonical];candidate=require(canonical).publicApproval;}
  finally{if(cached)require.cache[canonical]=cached;else delete require.cache[canonical];}
  if(typeof candidate!=='function'||adapterFS.readFileSync(canonical,'utf8')!==source)
    throw adapterRejected('approval_adapter_source_changed');
  const key=Symbol.for('clw.serialized-approval-adapter'),prior=publicApproval[key];
  if(prior&&prior.coordinator!==coordinator)throw adapterRejected('approval_adapter_coordinator_changed');
  const control=prior||{coordinator,sources:new WeakMap(),baseline:publicApproval.toString()};
  if(!prior){
    Object.defineProperty(publicApproval,key,{value:control});
    Object.defineProperty(publicApproval,'toString',{configurable:true,value(){
      return control.sources.get(control.coordinator.exports.dom)||control.baseline;
    }});
  }
  control.sources.set(dom,Function.prototype.toString.call(candidate));
}
