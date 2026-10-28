'use strict';
// Browser lifetime adapted from codex-chatgpt-web, commit recorded in vendor/UPSTREAM.json.
// CLW deliberately has no MAX_BROWSER_TABS: admission is by real resources, not head count.
const { EventEmitter } = require('node:events');
const pageInput = require('./page-input.cjs');
const { shouldBlockSleepForTurns } = require('./vendor/codex-chatgpt-web/launcher/electron/turn-suspension.cjs');
const programmaticInput = Symbol.for('clw.programmatic-input');
const chatUrl=raw=>{try{const url=new URL(raw);return url.protocol==='https:'&&url.hostname==='chatgpt.com'?url.href:null;}catch{return null;}};

class BrowserPool extends EventEmitter {
  constructor({ window, WebContentsView, partition, partitionForAccount, powerSaveBlocker, allowedUrl, networkGuard, accountAccessFor, openExternal }) {
    super();Object.assign(this,{window,WebContentsView,partition,partitionForAccount,powerSaveBlocker,allowedUrl,networkGuard,accountAccessFor,openExternal});
    this.pages=new Map();this.selected=null;this.blocker=null;this.native=false;this.details=false;
    this.attachedViews=new WeakSet();
  }
  register(id,url='https://chatgpt.com/',metadata={}) {
    if(this.pages.has(id))return this.pages.get(id);
    if(!this.allowedUrl(url))throw Error('browser_url_not_allowed');
    const page={...metadata,id,url,view:null,status:'unloaded',rendererState:'unloaded',hidden:metadata.hidden===true||metadata.closed===true,closed:false,domReady:false,modelRestorePending:true,documentGeneration:0,manualInteractionSequence:0,lastManualInteractionAt:null,pins:new Set()};
    this.pages.set(id,page);this.emit('changed');return page;
  }
  async create(id,url='https://chatgpt.com/',metadata={}) {
    this.register(id,url,metadata);return this.ensure(id);
  }
  isLoaded(id) {
    const page=this.pages.get(id);return !!(page?.view&&!page.view.webContents.isDestroyed());
  }
  ensure(id) {
    const page=this.pages.get(id);
    if(!page||page.closed)return Promise.reject(Error('browser_page_missing'));
    if(page.hydration)return page.hydration;
    if(this.isLoaded(id))return Promise.resolve(page);
    // Assign the shared promise before emitting events inside hydrate. A changed
    // listener may itself request this page while account admission is pending.
    const hydration=Promise.resolve().then(()=>this.hydrate(page));page.hydration=hydration;
    const clear=()=>{if(page.hydration===hydration)page.hydration=null;};
    void hydration.then(clear,clear);return hydration;
  }
  currentView(page,view) {
    return this.pages.get(page.id)===page&&page.view===view&&!view.webContents.isDestroyed();
  }
  manualInteraction(page,view,kind) {
    if(!this.currentView(page,view))return;
    const at=Date.now(),sequence=(page.manualInteractionSequence||0)+1;
    page.manualInteractionSequence=sequence;page.lastManualInteractionAt=at;page.manualControl=true;
    view.webContents[Symbol.for('clw.manual-input-sequence')]=sequence;
    page.manualUrl=chatUrl(view.webContents.getURL?.())||chatUrl(page.url)||page.manualUrl||null;
    page.externalGesture={at,sequence,view};
    // Synchronous notification makes an in-flight automatic operation yield
    // before its next write. Reading by scrolling alone does not take control.
    this.emit('manual-interaction',{id:page.id,sequence,kind,at});
  }
  openExternalFromGesture(page,view,raw) {
    let url;try{url=new URL(raw);}catch{return false;}
    if(url.protocol!=='https:'||url.username||url.password||typeof this.openExternal!=='function')return false;
    const gesture=page.externalGesture,age=gesture?Date.now()-gesture.at:Infinity;
    if(!this.currentView(page,view)||!this.isUserViewing(page.id)||gesture?.view!==view||age<0||age>1500)return false;
    page.externalGesture=null;
    // No arbitrary page script can open an OS browser without a recent native
    // click/key gesture; one gesture admits at most one ordinary HTTPS link.
    try{Promise.resolve(this.openExternal(url.href)).catch(()=>this.emit('external-open-failed',{id:page.id,code:'external_link_open_failed'}));}
    catch{this.emit('external-open-failed',{id:page.id,code:'external_link_open_failed'});}
    return true;
  }
  releaseView(view) {
    if(!view)return;
    let failure;
    if(this.attachedViews.has(view)){
      try{this.window.contentView.removeChildView(view);this.attachedViews.delete(view);}catch(error){failure=error;}
    }
    // close releases WebContents resources; removing the child view alone does not.
    try{if(!view.webContents.isDestroyed())view.webContents.close({waitForBeforeUnload:false});}catch(error){failure??=error;}
    if(failure)throw failure;
  }
  async hydrate(page) {
    let view;
    if(this.pages.get(page.id)!==page||page.closed)throw Error('browser_page_missing');
    page.rendererState='hydrating';this.emit('changed');
    try{
      if(page.view){const previous=page.view;page.view=null;this.releaseView(previous);}
      const account=page.account||'B';
      this.accountAccessFor?.(account).assertCanStart();
      await this.accountAccessFor?.(account).admitNavigation();
      if(this.pages.get(page.id)!==page||page.closed)throw Error('browser_page_missing');
      if(!this.allowedUrl(page.url))throw Error('browser_url_not_allowed');
      if(this.networkGuard&&!this.networkGuard.ready)throw Error('VPN 尚未通过核验，网页保持离线。');
      const partition=this.partitionForAccount?this.partitionForAccount(account):this.partition;
      view=new this.WebContentsView({webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      page.hydratingView=view;
      if(this.networkGuard){
        await this.networkGuard.protect(view.webContents.session);
        if(this.pages.get(page.id)!==page||page.closed||view.webContents.isDestroyed())throw Error('browser_page_missing');
        this.networkGuard.protectContents(view.webContents);
      }
      if(this.pages.get(page.id)!==page||page.closed||view.webContents.isDestroyed())throw Error('browser_page_missing');
      page.view=view;page.hydratingView=null;page.rendererState='resident';page.status='loading';
      page.domReady=false;page.metrics=null;page.viewportReady=null;page.observation=null;page.modelSelection=null;page.modelRestorePending=true;
      this.window.contentView.addChildView(view);this.attachedViews.add(view);
      this.bindView(page,view,partition);this.layout();this.emit('changed');
      // A slow page must not hold service readiness, other workers or local UI.
      // DOM readiness is checked by the driver before it can offer or send work.
      page.navigation=Promise.resolve(view.webContents.loadURL(page.url)).then(()=>{
        if(this.currentView(page,view)&&page.status==='loading'){page.status='idle';this.emit('changed');}
      }).catch(error=>{
        if(!this.currentView(page,view)||error.code==='ERR_ABORTED')return;
        page.status='load_failed';this.emit('load-failed',{id:page.id,code:error.code||'page_load_failed'});this.emit('changed');
      });
      return page;
    }catch(error){
      if(page.view===view)page.view=null;
      if(page.hydratingView===view)page.hydratingView=null;
      try{this.releaseView(view);}catch{ /* Preserve the original admission/protection failure. */ }
      if(this.pages.get(page.id)===page){page.rendererState='unloaded';page.status='load_failed';page.domReady=false;this.emit('changed');}
      throw error;
    }
  }
  bindView(page,view,partition) {
    const id=page.id,current=()=>this.currentView(page,view);
    // On Windows an off-window WebContentsView can start at a 0 x 0 renderer
    // viewport despite nonzero native bounds. Initialize after DOM-ready (an
    // override on about:blank before navigation can crash Chromium).
    view.webContents.on('dom-ready',()=>{if(!current())return;page.domReady=true;page.metrics=null;this.layout();});
    view.webContents.on('did-start-loading',()=>{
      if(!current())return;
      // The tab spinner also starts for subframes. Only a new main document
      // invalidates its DOM; a known subframe load preserves the page's state.
      if(typeof view.webContents.isLoadingMainFrame==='function'&&view.webContents.isLoadingMainFrame()===false)return;
      page.status='loading';this.emit('changed');
    });
    view.webContents.on('did-start-navigation',details=>{
      if(!current())return;
      if(details.isMainFrame&&!details.isSameDocument){
        page.domReady=false;
        page.documentGeneration++;
        page.modelRestorePending=true;page.modelSelection=null;
        page.observation=null;
      }
    });
    view.webContents.on('did-stop-loading',()=>{if(!current())return;if(page.status==='loading')page.status='idle';this.emit('changed');});
    view.webContents.on('before-input-event',(event,input)=>{
      if(!current())return;
      if(input.type==='keyDown'||input.type==='char'){
        const pending=view.webContents[programmaticInput];
        const expected=Array.isArray(pending)?pending.findIndex(item=>item.type===input.type&&item.key===input.key&&(!item.code||item.code===input.code)):-1;
        if(expected>=0)pending.splice(expected,1);
        else this.manualInteraction(page,view,'keyboard');
      }
      if(input.type==='keyDown'&&(input.key==='F5'||((input.control||input.meta)&&input.key.toLowerCase()==='r'))){event.preventDefault();this.emit('refresh-requested',{id});}
    });
    view.webContents.on('before-mouse-event',(_event,input)=>{if(current()&&input.type==='mouseDown')this.manualInteraction(page,view,'pointer');});
    view.webContents.setWindowOpenHandler(({url})=>{
      // Authentication popups remain visible in this isolated partition. They
      // never inherit Node, preload, or access to the CLW shell bridge.
      if(!current())return {action:'deny'};
      if(!this.allowedUrl(url)){this.openExternalFromGesture(page,view,url);return {action:'deny'};}
      return {action:'allow',overrideBrowserWindowOptions:{width:900,height:760,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true}}};
    });
    view.webContents.on('will-navigate',(event,url)=>{
      if(!current()){event.preventDefault();return;}
      if(!this.allowedUrl(url)){event.preventDefault();this.openExternalFromGesture(page,view,url);}
    });
    const navigated=(_event,url)=>{if(!current())return;page.url=url;if(page.manualControl)page.manualUrl=chatUrl(url)||page.manualUrl||null;this.emit('navigation',{id,url});};
    view.webContents.on('did-navigate',navigated);
    view.webContents.on('did-navigate-in-page',navigated);
    view.webContents.on('render-process-gone',(_event,details)=>{if(!current())return;page.status='needs_attention';this.syncPower();this.emit('crashed',{id,reason:details.reason});});
  }
  select(id) {if(!this.pages.has(id))throw Error('browser_page_missing');this.selected=id;this.layout();this.emit('changed');}
  isUserViewing(id) {return !!(this.native&&this.selected===id&&this.window.isVisible?.()&&!this.window.isMinimized?.()&&this.window.isFocused?.());}
  pin(id,token=Symbol('browser-operation')) {const p=this.pages.get(id);if(!p||p.closed)throw Error('browser_page_missing');p.pins.add(token);return token;}
  unpin(id,token='operation') {this.pages.get(id)?.pins.delete(token);}
  suspend(id,options={}) {
    const page=this.pages.get(id);
    const refused=reason=>({suspended:false,released:false,reason});
    if(!page)return refused('page_missing');
    if(page.hydration||page.hydratingView||page.rendererState==='hydrating')return refused('hydrating');
    if(!page.view)return {suspended:true,released:false,reason:'already_unloaded'};
    if(page.status==='running'||page.activeWork)return refused('active_work');
    if(options.busy)return refused('busy');
    if(options.pinned||page.pins.size)return refused('pinned');
    if(this.native&&this.selected===id&&this.window.isVisible?.()&&!this.window.isMinimized?.())return refused('selected_visible');
    if(page.modelSendUnknown||options.modelSendUnknown)return refused('model_send_unknown');
    for(const key of ['generating','draft','composing','approvalRequired'])if(page[key]||options[key])return refused(key);
    if(page.status==='loading'||!page.domReady)return refused('loading');
    const observations=[page.observation,options.observation].filter(Boolean);
    const observation=observations.sort((a,b)=>(b.at??-Infinity)-(a.at??-Infinity))[0];
    const now=options.now??Date.now(),maxAge=options.maxObservationAgeMs??30000;
    if(!observation||!Number.isFinite(observation.at)||now-observation.at<0||now-observation.at>maxAge)return refused('observation_stale');
    for(const key of ['draft','composing','approvalRequired'])if(observation[key])return refused(key);
    if(observation.error||observation.unknown||observation.known===false||observation.generating!==false||observation.draft!==false)return refused('observation_unknown');
    const view=page.view;
    const url=view.webContents.getURL?.();if(url&&url!=='about:blank')page.url=url;
    // Invalidate callbacks before close, which can emit navigation/crash events.
    page.view=null;page.rendererState='unloaded';page.status='unloaded';page.domReady=false;page.metrics=null;page.viewportReady=null;page.navigation=null;
    page.modelRestorePending=true;page.modelSelection=null;page.documentGeneration++;page.suspendedAt=now;
    try{this.releaseView(view);}catch(error){
      if(!view.webContents.isDestroyed()){page.view=view;page.rendererState='resident';page.status='needs_attention';}
      this.emit('load-failed',{id,code:'page_release_failed'});this.emit('changed');return refused('release_failed');
    }
    this.syncPower();this.emit('changed');return {suspended:true,released:true,reason:options.reason||'idle'};
  }
  hibernate(id,options) {return this.suspend(id,options);}
  async reload(id,restoreUrl,{assertCurrent=()=>{},assertNavigationCurrent=assertCurrent,navigationIntent}={}) {
    const page=this.pages.get(id);if(!page||page.closed)throw Error('browser_page_missing');
    if(restoreUrl&&!this.allowedUrl(restoreUrl))throw Error('browser_url_not_allowed');
    if(!this.isLoaded(id)){if(restoreUrl)page.url=restoreUrl;return this.ensure(id);}
    const view=page.view,manualSequence=page.manualInteractionSequence||0;
    this.accountAccessFor?.(page.account||'B').assertCanStart();
    await this.accountAccessFor?.(page.account||'B').admitNavigation();
    await assertCurrent();
    if(page.closed||!this.currentView(page,view))throw Error('browser_page_missing');
    if((page.manualInteractionSequence||0)!==manualSequence)throw Error('manual_web_interaction');
    if(this.networkGuard&&!this.networkGuard.ready)throw Error('VPN 尚未通过核验，不能刷新网页。');
    // The awaited page read can yield to a pause/exit or owner change. The
    // final identity check is synchronous with the actual navigation call.
    assertNavigationCurrent();
    if(navigationIntent)navigationIntent.dispatched=true;
    page.status='loading';page.domReady=false;page.metrics=null;page.observation=null;page.modelSelection=null;page.modelRestorePending=true;page.documentGeneration=(page.documentGeneration||0)+1;
    if(restoreUrl){
      page.url=restoreUrl;page.navigation=view.webContents.loadURL(restoreUrl).catch(error=>{
        if(!this.currentView(page,view)||error.code==='ERR_ABORTED')return;
        page.status='load_failed';this.emit('load-failed',{id,code:error.code||'page_load_failed'});this.emit('changed');
      });
    }else view.webContents.reload();
    this.emit('changed');
  }
  layout() {
    const size=this.window.getContentSize();
    // Windows can report zero native size while minimized. Keep the renderer
    // viewport usable for background work, including the selected conversation.
    if(size[0]>0&&size[1]>0)this.lastSize=size;
    const [width,height]=this.lastSize||[1280,900];
    for(const p of this.pages.values()) {
      if(!this.isLoaded(p.id))continue;
      const view=p.view;
      const active=this.native&&!p.closed&&!p.hidden&&p.id===this.selected;
      // Upstream keeps running renderers at a non-zero viewport outside the
      // shell's visible content. setVisible(false) would collapse the viewport.
      const viewport=this.viewport?.width>0&&this.viewport?.height>0?this.viewport:null;
      const bounds=active?(viewport||{x:242,y:78,width:Math.max(1,width-242-(this.details?360:0)),height:Math.max(1,height-78)}):{x:width+32,y:height+32,width:Math.max(800,width-242),height:Math.max(600,height-78)};
      view.setBounds(bounds);
      view.setVisible(true);
      const metrics=`${bounds.width}:${bounds.height}`;
      if(p.domReady&&p.metrics!==metrics){
        p.metrics=metrics;
        p.viewportReady=pageInput.viewport(view.webContents,bounds.width,bounds.height).catch(()=>{
          if(this.currentView(p,view)){p.metrics=null;p.status='needs_attention';this.emit('load-failed',{id:p.id,code:'page_viewport_unavailable'});}
        });
      }
    }
  }
  running(id,active) {const p=this.pages.get(id);if(p){p.status=active?'running':'idle';this.syncPower();this.emit('changed');}}
  work(id,active) {const p=this.pages.get(id);if(p){p.activeWork=active;this.syncPower();}}
  syncPower() {
    const needed=shouldBlockSleepForTurns(this.pages.values())||[...this.pages.values()].some(p=>p.activeWork);
    if(needed&&this.blocker===null&&this.powerSaveBlocker)this.blocker=this.powerSaveBlocker.start('prevent-app-suspension');
    if(!needed&&this.blocker!==null){this.powerSaveBlocker?.stop(this.blocker);this.blocker=null;}
  }
  inspect() {return [...this.pages.values()].map(p=>{
    const resident=this.isLoaded(p.id),observation=resident?p.observation:null;
    const residentRequired=observation?!!(observation.draft||observation.composing||observation.approvalRequired||observation.generating):!!p.residentRequired;
    const location=resident?p.view.webContents.getURL?.():null,url=location&&location!=='about:blank'?location:p.url||'https://chatgpt.com/';
    return {id:p.id,title:p.title||p.id,status:p.status,url,root:p.root,account:p.account||'B',kind:p.kind||(/账号 [AB]/.test(p.title)?'account':'task'),closed:!!(p.closed||p.hidden),selected:p.id===this.selected,resident,rendererState:p.rendererState||'resident',residentRequired,
      manualControl:!!p.manualControl,manualInteractionSequence:p.manualInteractionSequence||0,manualUrl:p.manualUrl||null};
  });}
  close(id) {
    const p=this.pages.get(id);if(!p)return;
    p.closed=true;const view=p.view||p.hydratingView;p.view=null;p.hydratingView=null;
    this.pages.delete(id);if(this.selected===id)this.selected=null;
    try{this.releaseView(view);}finally{this.syncPower();this.emit('changed');}
  }
}
module.exports={BrowserPool};
