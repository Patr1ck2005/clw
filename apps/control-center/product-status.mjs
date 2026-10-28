// One process identity for every page. No upgrade, mutation, credential or model calls.
export function statusText(value){
  if(value?.success!==true||value.schema_version!==1||!['clw-control-center','clw-web-workspace'].includes(value.product)||typeof value.version!=='string'||value.version.length>80||!['stable','candidate','development','test'].includes(value.channel)||!/^[a-f0-9]{32}$/.test(value.instance_id||''))throw Error('invalid_product_identity');
  const labels={stable:'稳定运行版',candidate:'隔离候选版',development:'开发快照',test:'测试进程'};
  const fixed=value.fixed_release===true&&value.verified_at_start===true;
  if(value.state_id!=null&&(typeof value.state_id!=='string'||!/^[a-f0-9]{32}$/.test(value.state_id)))throw Error('invalid_state_identity');
  const workspace=value.product==='clw-web-workspace';
  const sourceVerified=workspace?value.commit_describes_payload===false&&value.source_kind==='frozen_current_worktree'&&
    /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}-[a-f0-9]{8}$/.test(value.build_id||'')&&/^[a-f0-9]{64}$/.test(value.manifest_sha256||''):
    value.commit_describes_payload===true;
  if(value.fixed_release===true&&(!fixed||!sourceVerified||!/^[a-f0-9]{40}$/.test(value.source_commit||'')||!/^[a-f0-9]{64}$/.test(value.payload_sha256||'')))throw Error('unverified_fixed_release');
  if(['stable','candidate'].includes(value.channel)&&!fixed)throw Error('fixed_channel_without_proof');
  return {title:`${labels[value.channel]} · ${value.version}`,warning:value.restart_required===true,
    detail:fixed?(workspace?'冻结源码与文件哈希已核对；来源提交不等于冻结内容，工作流仍须实际验收。':'固定提交与文件哈希已核对；这不代表网页托管已验收。'):'当前代码是启动快照，不把源码 HEAD 当成已发布版本。',
    commit:typeof value.source_commit==='string'?value.source_commit:'未知',payload:typeof value.payload_sha256==='string'?value.payload_sha256:'未知',
    instance:value.instance_id,state:value.state_id||'隔离测试 / 未提供',started:value.started_at||'未知',
    disk:value.restart_required?'磁盘代码已变化或无法读取；当前进程不会热更新。':'已返回的静态页面固定为本次启动快照。'};
}
export function mountStatus(doc=globalThis.document,fetcher=globalThis.fetch){
  const main=doc.querySelector('main');if(!main)return;
  const box=doc.createElement('section');box.className='product-status';box.id='productStatus';box.setAttribute('aria-live','polite');main.prepend(box);
  const title=doc.createElement('strong'),detail=doc.createElement('span'),expand=doc.createElement('details'),summary=doc.createElement('summary'),data=doc.createElement('dl'),button=doc.createElement('button');
  title.textContent='正在核对运行版本…';summary.textContent='版本与数据身份';button.textContent='重新核对';button.type='button';expand.append(summary,data);box.append(title,detail,expand,button);
  let active=false,previous=null;
  async function refresh(){
    if(active)return;active=true;button.disabled=true;
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),6000);
    try{
      const r=await fetcher('./api/product/info',{cache:'no-store',credentials:'omit',signal:abort.signal});if(!r.ok)throw Error('identity_unavailable');
      const raw=await r.text();if(raw.length>20000)throw Error('oversized_identity');const info=JSON.parse(raw),s=statusText(info);
      title.textContent=s.title;detail.textContent=s.detail;box.dataset.state=s.warning?'changed':'observed';data.replaceChildren();
      for(const [label,text] of [['运行提交',s.commit],['内容哈希',s.payload],['进程身份',s.instance],['数据库组',s.state],['启动时间',s.started],['磁盘核对',s.disk]]){const dt=doc.createElement('dt'),dd=doc.createElement('dd');dt.textContent=label;dd.textContent=text;data.append(dt,dd);}
      if(previous&&previous!==s.instance){detail.textContent='运行进程已经切换。原请求和编辑草稿不自动重发；先核对回执再继续。';box.dataset.state='changed';}
      previous=s.instance;
    }catch{title.textContent='运行版本未核验';detail.textContent='可能仍在运行旧进程或已断开。不要根据源码版本推定功能已启用。';data.replaceChildren();box.dataset.state='unknown';}
    finally{clearTimeout(timer);active=false;button.disabled=false;}
  }
  button.addEventListener('click',refresh);doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)refresh();});refresh();
  return {refresh};
}
if(typeof document!=='undefined')mountStatus();
