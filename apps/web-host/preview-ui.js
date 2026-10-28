'use strict';
(() => {
  const opener=document.getElementById('preview-settings-open');if(!opener)return;
  const host=document.createElement('div');
  host.innerHTML=`<dialog id="preview-dialog" class="preview-dialog" aria-labelledby="preview-title">
    <div class="dialog-head"><div><span class="dialog-eyebrow">CLW 免费预览版</span><h2 id="preview-title">准备工作区</h2></div><button id="preview-close" class="icon" type="button" aria-label="关闭连接设置">×</button></div>
    <nav id="preview-steps" class="preview-steps" aria-label="首次连接步骤"><button type="button" data-step="0">1 网络</button><button type="button" data-step="1">2 登录</button><button type="button" data-step="2">3 本地工具</button><button type="button" data-step="3">4 工作目录</button></nav>
    <section class="preview-step" data-panel="0"><h3>选择这台电脑的网络</h3><p class="scope-hint">设置仅用于本安装的网页和工具连接。</p>
      <label>网络方式<select id="preview-network"><option value="system">跟随系统设置</option><option value="proxy">指定代理</option><option value="direct">直接连接</option></select></label>
      <label id="preview-proxy-field" hidden>代理地址<input id="preview-proxy" type="url" autocomplete="off" placeholder="http://127.0.0.1:7890"></label>
      <p class="scope-hint">指定代理不可用时会等待，不自动回退直连。修改后请按提示重新打开。</p><p id="preview-network-pending-note" class="scope-hint" hidden>已有独立后台保留原设置，待下次 Windows 启动后统一应用；不会强停任务。</p>
    </section>
    <section class="preview-step" data-panel="1" hidden><h3>登录自己的网页账号</h3><p>点击下方按钮，在原网页完成登录。你可以直接聊天，也可以稍后从“本机连接”继续设置工具。</p>
      <button id="preview-login" type="button" class="secondary">打开账号网页</button><p class="scope-hint">CLW 不提供账号或模型额度。网页登录和本地工具连接分别核验。</p>
    </section>
    <section class="preview-step" data-panel="2" hidden><h3>连接自己的本地工具</h3><p class="scope-hint">在 OpenAI Platform 创建或选择 Tunnel，并关联要使用的 ChatGPT 工作区。密钥只在本机保存。</p>
      <label>选择账号<select id="preview-account"><option value="A">账号 A</option><option value="B">账号 B · 可选</option></select></label>
      <button id="preview-platform" type="button" class="quiet">打开官方 Tunnel 设置 ↗</button>
      <label>Tunnel ID<input id="preview-tunnel" maxlength="48" autocomplete="off" spellcheck="false" placeholder="tunnel_…"></label>
      <label>运行密钥<input id="preview-key" type="password" maxlength="4096" autocomplete="off" placeholder="已保存时可留空"></label>
      <p id="preview-account-note" class="scope-hint"></p>
      <p class="scope-hint">最后在该账号的 ChatGPT 中添加自定义 MCP 连接，选择同一 Tunnel。缺少平台入口或权限时，先完成官方账号设置。</p>
    </section>
    <section class="preview-step" data-panel="3" hidden><h3>选择工作目录</h3><p class="scope-hint">只登记你明确选择的目录。每行一个；普通网页聊天可以暂时跳过。</p>
      <textarea id="preview-roots" rows="4" spellcheck="false" placeholder="选择允许本地工具使用的项目目录"></textarea><button id="preview-pick-root" type="button" class="quiet">选择文件夹…</button>
      <label class="collaboration-opt-in"><input id="preview-auto-connect" type="checkbox" checked> 登录 Windows 后自动连接本地工具</label>
      <p class="scope-hint">自动连接不会自动开始开发任务。连接完成后，用一次真实文件读取确认网页工具可用。</p>
    </section>
    <section id="preview-about" hidden><h3>CLW 免费预览版 <small id="preview-version"></small></h3><p>用户自带账号、本地执行。原网页可手动使用，CLW 提供任务记录、长目标和连接恢复。</p><p class="scope-hint">这是未签名预览版；Windows 可能显示未知发布者。校验值用于检查文件一致性。</p><div class="preview-docs"><button type="button" data-document="start" class="quiet">使用说明</button><button type="button" data-document="terms" class="quiet">免费使用条款</button><button type="button" data-document="privacy" class="quiet">隐私说明</button></div><button id="preview-export" type="button" class="secondary">导出诊断…</button><p class="scope-hint">导出版本、连接状态和固定错误码，不包含密钥、聊天正文或项目文件内容。</p></section>
    <p id="preview-message" class="preview-message" role="status" aria-live="polite"></p><button id="preview-check" type="button" class="quiet">检查连接</button>
    <div class="dialog-actions"><button id="preview-skip" type="button" class="quiet">稍后设置</button><button id="preview-back" type="button" class="secondary">上一步</button><button id="preview-next" type="button" class="primary">保存并继续</button></div>
  </dialog>`;
  document.body.append(host);
  const $=id=>document.getElementById(id),dialog=$('preview-dialog');
  let snapshot=null,step=0,working=false,dirty=false,about=false,openedOnce=false,available=false;
  const labels={preview_operation_in_progress:'原操作仍在处理，请等待结果。',preview_previous_operation_unknown:'原操作回执尚未核对，请先点击“检查连接”。',preview_controller_result_unknown:'原操作的回执暂未确认。请先检查连接，不要重复启动。',preview_credentials_missing:'请先填写自己的 Tunnel 信息。',preview_credentials_invalid:'Tunnel ID 或运行密钥格式不完整，请核对官方页面提供的信息。',preview_proxy_invalid:'代理地址无效。请填写 HTTP、HTTPS 或 SOCKS5 地址，不在地址中填写密码。',preview_project_root_missing:'工作目录不存在，请重新选择现有文件夹。',preview_project_roots_required:'请选择允许本地工具使用的项目目录。',preview_bundled_binary_missing:'本地运行文件缺失，请重新运行同一安装包修复，原数据会保留。',preview_native_command_failed:'本地执行环境尚未准备好。请检查连接，必要时导出诊断。',preview_startup_directory_unavailable:'无法登记登录后自动连接；你仍可手动打开本安装使用。'};
  const message=text=>{$('preview-message').textContent=text||'';};
  function errorText(error){const code=String(error?.message||'preview_controller_unavailable');return labels[code]||'连接尚未完成：'+code;}
  function pendingText(result){
    const pending=result?.pendingChanges||[];
    if(pending.includes('network_applies_after_owned_process_restart'))return '网络设置已保存。独立后台仍使用原网络，将在下次 Windows 启动后应用新设置；当前任务继续。';
    if(pending.includes('project_root_removal_requires_safe_reload'))return '目录设置已保存。已有后台任务保留原目录权限，待后台安全重载后再应用移除。';
    return '';
  }
  function render(){
    $('preview-steps').hidden=about;$('preview-about').hidden=!about;
    $('preview-title').textContent=about?'关于与诊断':'准备工作区';
    for(const panel of dialog.querySelectorAll('[data-panel]'))panel.hidden=about||Number(panel.dataset.panel)!==step;
    for(const button of dialog.querySelectorAll('[data-step]')){button.classList.toggle('active',Number(button.dataset.step)===step);button.setAttribute('aria-current',Number(button.dataset.step)===step?'step':'false');}
    $('preview-proxy-field').hidden=$('preview-network').value!=='proxy';
    $('preview-network-pending-note').hidden=!Object.keys(snapshot?.status?.owners||{}).length;
    $('preview-back').hidden=about||step===0;$('preview-next').hidden=about;
    $('preview-next').textContent=working?'正在处理…':step===3?'保存并连接':step===1?'继续':'保存并继续';
    for(const button of dialog.querySelectorAll('button'))button.disabled=working&&button.id!=='preview-close';
    for(const input of dialog.querySelectorAll('input,select,textarea'))input.disabled=working;
    $('preview-check').hidden=about;
    $('preview-skip').textContent=about?'关闭':'稍后设置';
  }
  function fill(value){
    if(!value?.manifest)return;snapshot=value;
    if(typeof value.application_version==='string'&&value.application_version.length<=80)$('preview-version').textContent=value.application_version;
    if(dirty)return;
    const manifest=value.manifest;
    $('preview-network').value=manifest.network?.mode||'system';$('preview-proxy').value=manifest.network?.proxy_url||'';
    $('preview-roots').value=(manifest.projectRoots||[]).join('\n');$('preview-auto-connect').checked=manifest.auto_connect!==false;
    accountNote();render();
  }
  function accountNote(){
    const row=snapshot?.accounts?.find(account=>account.id===$('preview-account').value);
    $('preview-account-note').textContent=row?.credentialConfigured?'此账号的连接信息已保存，密钥留空可继续使用。':'尚未保存此账号的本地工具连接。';
  }
  async function load(){working=true;message('正在读取本机配置…');render();try{const result=await window.clw.command('preview-read');fill(result);message(pendingText(result.status));}catch(error){message(errorText(error));}finally{working=false;render();}}
  function open(showAbout=false){about=showAbout;if(typeof nativeView==='function')nativeView(false);if(!dialog.open)dialog.showModal();render();void load();}
  async function save(){
    if(!snapshot?.manifest)throw Error('preview_configuration_not_loaded');
    const manifest=JSON.parse(JSON.stringify(snapshot.manifest));manifest.network={mode:$('preview-network').value};
    if(manifest.network.mode==='proxy')manifest.network.proxy_url=$('preview-proxy').value.trim();
    manifest.projectRoots=$('preview-roots').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
    manifest.auto_connect=$('preview-auto-connect').checked;
    const key=$('preview-key').value,tunnel=$('preview-tunnel').value.trim(),account=$('preview-account').value;
    const payload={manifest};
    if(key||tunnel){
      if(!manifest.accounts.some(row=>row.id===account))manifest.accounts.push({id:account});
      payload.credentials={[account]:{tunnel_id:tunnel,api_key:key}};
    }
    const result=await window.clw.command('preview-save',payload);dirty=false;$('preview-key').value='';$('preview-tunnel').value='';fill(result);return result;
  }
  opener.onclick=()=>open(false);$('preview-about-open').onclick=()=>open(true);
  $('preview-close').onclick=$('preview-skip').onclick=()=>dialog.close();
  $('preview-back').onclick=()=>{step=Math.max(0,step-1);message('');render();};
  for(const button of dialog.querySelectorAll('[data-step]'))button.onclick=()=>{step=Number(button.dataset.step);message('');render();};
  for(const input of dialog.querySelectorAll('input,select,textarea'))input.addEventListener('input',()=>{dirty=true;render();});
  $('preview-account').onchange=()=>{accountNote();};
  $('preview-network').onchange=()=>{dirty=true;render();};
  $('preview-next').onclick=async()=>{
    if(working)return;working=true;message(step===3?'正在保存并准备原执行环境…':'正在保存…');render();
    try{
      if(step!==1){const saved=await save();if(saved.restart_required){message(saved.backend_settings_pending?'网络设置已保存。独立后台仍在运行，请在下次 Windows 启动后统一采用新设置；当前任务继续，不重复连接。':'网络设置已保存。请正常退出并重新打开本安装，再继续登录和工具连接；当前网页与执行保持原网络。');return;}}
      if(step===3){
        await window.clw.command('preview-bootstrap');const result=await window.clw.command('preview-connect');
        message(pendingText(result)||(result?.state==='ready'?'本地工具已连接。请在网页中核对连接器并实际读取一个文件。':result?.state==='awaiting_credentials'?'本地执行环境已准备好。请完成 Tunnel 信息和网页连接器设置。':'已保留当前连接结果，可从本机连接继续检查。'));
        fill(await window.clw.command('preview-read'));
      }else{step++;message('');}
    }catch(error){message(errorText(error));}finally{working=false;render();}
  };
  $('preview-login').onclick=async()=>{working=true;render();try{await window.clw.command('login',{account:$('preview-account').value});dialog.close();if(typeof nativeView==='function')nativeView(true);}catch(error){message(errorText(error));}finally{working=false;render();}};
  $('preview-platform').onclick=()=>window.clw.command('preview-open-platform').catch(error=>message(errorText(error)));
  $('preview-pick-root').onclick=async()=>{try{const picked=await window.clw.command('preview-pick-root');if(picked.path){const roots=new Set($('preview-roots').value.split(/\r?\n/).filter(Boolean));roots.add(picked.path);$('preview-roots').value=[...roots].join('\n');dirty=true;}}catch(error){message(errorText(error));}};
  $('preview-export').onclick=async()=>{working=true;render();try{const result=await window.clw.command('preview-export');message(result.cancelled?'':'诊断已导出。');}catch(error){message(errorText(error));}finally{working=false;render();}};
  $('preview-check').onclick=async()=>{working=true;render();try{const result=await window.clw.command('preview-check');message(pendingText(result)||(result.healthy?'本地工具已连接。':result.operation_reconciled?'原操作已核对，可按当前状态继续。':'已核对原连接，仍在等待就绪或需要完成账号配置。'));fill(await window.clw.command('preview-read'));}catch(error){message(errorText(error));}finally{working=false;render();}};
  for(const button of dialog.querySelectorAll('[data-document]'))button.onclick=()=>window.clw.command('preview-document',{kind:button.dataset.document}).catch(error=>message(errorText(error)));
  function update(valueState){
    available=valueState.preview?.available===true;opener.hidden=!available;$('preview-about-open').hidden=!available;
    if(!available)return;
    const value=valueState.preview.configuration;if(value){snapshot=value;if(dialog.open&&!working&&!dirty)fill(value);}
    if(!openedOnce&&value){openedOnce=true;let seen=false;const id=value.manifest?.installation_id||'default';try{seen=localStorage.getItem('clw-preview-setup-'+id)==='seen';if(!seen)localStorage.setItem('clw-preview-setup-'+id,'seen');}catch{}
      if(!seen&&!value.accounts?.some(row=>row.credentialConfigured))open(false);
    }
  }
  window.clwPreview=Object.freeze({update});
  if(typeof state!=='undefined')update(state);
})();
