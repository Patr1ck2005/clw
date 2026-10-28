import {createAssetClient,channels,phaseLabel,stateLabel,availableKeys,importedContract} from './asset-client.mjs';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const opt=(value,label)=>{const n=el('option',label);n.value=value;return n;};
const note=text=>{$('assetNotice').textContent=text;};
let current=null,selected='',selectionEpoch=0,listEpoch=0,nextAfter=null,editing=null,editorEpoch=0,action=null,actionEpoch=0,projects=[];
const api=createAssetClient({onPending:()=>pendingView()});
function pendingView(){
 const p=api.pending(),r=p.upload?.command||p.metadata?.command;
 $('assetPending').hidden=!r;$('assetPendingText').textContent=r?`${r.batch_id||'新批次'} / ${r.request_id} / ${p.upload?'图片上传':r.action}`:'';
 $('retryAssetMetadata').hidden=!!p.upload;$('retryAssetFileLabel').hidden=!p.upload;controls();
}
function blocked(){const p=api.pending();return api.busy()||!!p.metadata||!!p.upload;}
function controls(){
 const stop=blocked();$('newAssetBatch').disabled=stop;$('saveAssetBatch').disabled=stop;$('assetActionGo').disabled=stop;
 for(const n of document.querySelectorAll('[data-mutating]'))n.disabled=stop||n.dataset.blocked==='true';
}
function editable(){if(blocked())throw Error('先核对原请求，不能开始另一个变更。');}
function button(text,fn,{disabled=false,cls='button secondary',mutating=true,id=''}={}){
 const n=el('button',text,cls);n.type='button';if(id)n.id=id;if(mutating){n.dataset.mutating='1';n.dataset.blocked=String(disabled);}n.disabled=disabled||(mutating&&blocked());n.onclick=()=>Promise.resolve().then(fn).catch(e=>note(e.message));return n;
}
function field(id,label,value='',type='text'){
 const wrap=el('label',label,'field'),n=el(type==='textarea'?'textarea':'input');n.id=id;if(type!=='textarea')n.type=type;else n.rows=3;n.value=value??'';wrap.append(n);return wrap;
}
function choice(id,label,values,value){const wrap=el('label',label,'field'),n=el('select');n.id=id;for(const [v,l]of values)n.append(opt(v,l));n.value=value;wrap.append(n);return wrap;}
function consent(label='我已核对本次完整目标、所选项及来源，确认记录。'){
 const wrap=el('label',null,'asset-check'),n=el('input');n.type='checkbox';n.id='assetConsent';n.required=true;wrap.append(n,el('span',label));return wrap;
}
function download(data,name,mime='application/json'){
 const blob=data instanceof Blob?data:new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type:mime});const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function refreshList(reset=true){
 const epoch=++listEpoch,r=await api.read('list',{query:$('assetSearch').value,after:reset?0:nextAfter||0});if(epoch!==listEpoch)return;
 if(reset)$('assetBatchList').replaceChildren();
 for(const b of r.batches){const n=button('',()=>selectBatch(b.id),{cls:'asset-batch'+(b.id===selected?' selected':''),mutating:false});n.dataset.batchId=b.id;n.append(el('b',b.title),el('small',b.project_id),el('span',`${phaseLabel(b.phase)} · ${b.progress.approved}/${b.progress.items} 已批准`,'tag'));$('assetBatchList').append(n);}
 if(!$('assetBatchList').children.length)$('assetBatchList').append(el('p','尚无匹配批次。','hint'));
 nextAfter=r.next_after;$('moreAssets').hidden=nextAfter==null;
 if(!selected&&r.batches.length)await selectBatch(r.batches[0].id);
}
async function selectBatch(id){
 selected=id;current=null;const epoch=++selectionEpoch;$('assetDetail').replaceChildren(el('div','正在读取所选批次…','empty'));controls();
 document.querySelectorAll('.asset-batch').forEach(n=>n.classList.toggle('selected',n.dataset.batchId===id));
 try{const r=await api.read('get',{id});if(epoch!==selectionEpoch||id!==selected)return;current=r.batch;render();}
 catch(e){if(epoch===selectionEpoch)$('assetDetail').replaceChildren(el('div','未采用旧批次：'+e.message,'empty'));}
}
function render(){
 const b=current,host=$('assetDetail');host.replaceChildren();if(!b)return;
 const c=b.contract,head=el('section',null,'panel'),top=el('div',null,'panel-heading');top.append(el('h2',c.title));top.firstChild.id='assetBatchTitle';top.append(el('span',phaseLabel(b.phase),'tag '+(b.delivery_ready?'ok':'')));head.append(top);
 head.append(el('p',`${c.project_id} · ${c.project_root}`,'asset-info'),el('p',`${c.executor} / ${c.provider} / ${c.model} · ${c.account_alias} · 计费池 ${c.billing_bucket}`,'asset-info'));
 const steps=el('p','01 保存需求　→　02 冻结 / 领取　→　03 外部生成 / 回报　→　04 图片审阅 / 交付','asset-steps');head.append(steps);
 const ledger=b.accounting,stats=el('div',null,'asset-stats');
 for(const [k,v]of [['当前批准',`${b.progress.approved} / ${b.progress.items}`],['候选图片',String(b.progress.candidates)],['执行领取',String(b.progress.attempts)]]){const x=el('div');x.append(el('small',k),el('b',v));stats.append(x);}head.append(stats);
 const bill=el('p',c.budget?`${ledger.currency} · 已记录金额 ${ledger.known_total} / 预留 ${ledger.held_total} / 可预留 ${ledger.available} · 未知费用 ${ledger.unknown_count} 笔`:'本批没有独立 API 账单；订阅官方余量未知，不换算费用。','asset-info'+(ledger.needs_reconciliation||ledger.over_budget?' asset-bill-warning':''));bill.id='assetAccounting';head.append(bill);
 if(ledger.needs_reconciliation)head.append(el('p','先核对原结果或费用，不能重领。','asset-bill-warning'));
 if(ledger.over_budget)head.append(el('p','实际记录已超本地预算；仍保存真实金额，不能继续领取。','asset-bill-warning'));
 if(b.parent_binding)head.append(el('p',`父任务 ${b.parent_binding.task_id} · 冻结版本 ${b.parent_binding.task_version} · ${b.parent_state}`,'mono'));
 const ids=el('details'),summary=el('summary','身份、冻结指纹与范围');ids.append(summary,el('p',`${b.id} · v${b.version}`,'mono'),el('p',b.spec_hash||'草稿尚未冻结','mono'),el('p','项目是交接声明，不是文件写入授权；参考图未包含在导出包中。','hint'));head.append(ids);
 const actions=el('div',null,'asset-actions');
 if(b.status==='draft')actions.append(button('编辑草稿',()=>openEditor(b.contract,b),{id:'editAssetDraft'}),button('发布冻结',()=>openAction('publish'),{id:'publishAssetBatch',cls:'button'}));
 else actions.append(button('领取勾选素材',()=>openAction('reserve'),{id:'reserveAssetItems',disabled:ledger.needs_reconciliation||ledger.over_budget,cls:'button'}),button('导出 Markdown 交接',()=>exportHandoff('markdown'),{mutating:false,id:'exportAssetMarkdown'}),button('导出 JSON 交接',()=>exportHandoff('json'),{mutating:false,id:'exportAssetJson'}),button('导出已批准交付 ZIP',exportDelivery,{mutating:false,id:'exportAssetDelivery',disabled:!b.delivery_ready}));
 actions.append(button('复制为修订草稿',()=>openAction('clone'),{id:'cloneAssetBatch'}),button('导出需求草稿',()=>download({format:'clw.assets.requirements.v1',contract:b.contract},'asset-requirements.json'),{mutating:false}));
 if(b.parent_binding&&b.parent_state!=='current')actions.append(button('核对父任务新版本',()=>openAction('confirm_parent')));
 head.append(actions);host.append(head);
 const available=availableKeys(b);
 for(const item of c.items){
  const card=el('article',null,'asset-item');card.dataset.assetKey=item.key;const h=el('header'),check=el('label',null,'asset-check'),input=el('input');input.type='checkbox';input.dataset.selectKey=item.key;input.disabled=b.status!=='published'||!available.includes(item.key);check.append(input,el('h3',item.key));h.append(check,el('span',b.selected[item.key]?'已有批准候选':`${item.width}×${item.height} / ${item.format}`,'tag'));card.append(h);
  const prompt=el('details');prompt.append(el('summary','查看完整提示词与参考声明'),el('pre',c.style_brief+'\n\n'+item.prompt));for(const r of item.references)prompt.append(el('p',r.name+' / '+r.sha256,'mono'));card.append(prompt);
  for(const a of b.attempts.filter(a=>a.asset_key===item.key)){
   const row=el('section',null,'asset-attempt');row.dataset.attemptId=a.id;row.append(el('b',stateLabel(a.state)),el('p',a.id,'mono'),el('p',`外部引用：${a.external_ref||'未记录'} · 费用：${a.charge.status} ${a.charge.amount??''}`,'asset-info'));
   row.append(button('记录 / 核对原结果',()=>openAction('outcome',{attempt:a}),{cls:'link-button'}));
   if(a.state==='completed')row.append(button('导入候选图片',()=>openAction('upload',{attempt:a}),{cls:'button secondary'}));card.append(row);
  }
  const gallery=el('div',null,'asset-candidates');
  for(const candidate of b.candidates.filter(x=>x.asset_key===item.key)){
   const box=el('article',null,'asset-candidate'+(b.selected[item.key]===candidate.id?' approved':''));box.dataset.candidateId=candidate.id;const img=el('img');img.src=imageUrl(b.id,candidate.id);img.alt=item.key+' 候选 '+candidate.original_name;img.loading='lazy';img.onclick=()=>zoom(b,candidate);box.append(img);
   const status=candidate.review?.outcome||'尚未人工审阅';box.append(el('p',`${candidate.width}×${candidate.height} / ${candidate.format} · ${candidate.validation.status==='passed'?'技术校验通过':'技术校验不符'}`),el('span',status,'tag '+(status==='approved'?'ok':candidate.validation.status!=='passed'?'bad':'warn')));
   if(candidate.validation.issues.length)box.append(el('p',candidate.validation.issues.join('；'),'asset-bill-warning'));if(candidate.review)box.append(el('p',candidate.review.note));
   const details=el('details');details.append(el('summary','原文件 / 图片哈希'),el('p','原文件 '+candidate.source_sha256,'mono'),el('p','规范化 '+candidate.sha256,'mono'));box.append(details);
   const buttons=el('div',null,'asset-actions');buttons.append(button('批准',()=>openAction('review',{candidate,outcome:'approved'}),{cls:'button',disabled:candidate.validation.status!=='passed'}),button('退回修改',()=>openAction('review',{candidate,outcome:'changes_requested'}),{cls:'link-button'}),button('拒绝',()=>openAction('review',{candidate,outcome:'rejected'}),{cls:'link-button'}));box.append(buttons);gallery.append(box);
  }
  if(gallery.children.length)card.append(gallery);else card.append(el('p','尚无候选图片。外部完成后，先记录原结果，再选择文件导入。','hint'));host.append(card);
 }
 const history=el('section',null,'panel');history.append(button('查看审计记录',()=>loadHistory(b.id,0,history),{mutating:false,cls:'link-button'}));host.append(history);controls();
}
const imageUrl=(id,candidate)=>'./api/assets/image?'+new URLSearchParams({id,candidate});
function zoom(b,c){$('assetZoomImage').src=imageUrl(b.id,c.id);$('assetZoomInfo').textContent=`${c.original_name} · ${c.width}×${c.height} · ${c.sha256}`;$('assetZoom').showModal();}
async function loadHistory(id,after,host){const epoch=selectionEpoch,r=await api.read('events',{id,after});if(epoch!==selectionEpoch||id!==selected)return;host.replaceChildren(el('h3','审计记录 · 当前分页'));for(const e of r.events)host.append(el('p',`${e.sequence} · ${e.at} · ${e.action} · ${e.actor}`,'asset-info'));if(r.next_after)host.append(button('下一页审计',()=>loadHistory(id,r.next_after,host),{mutating:false,cls:'link-button'}));}
async function exportHandoff(format){const id=selected,epoch=selectionEpoch,r=await api.read('handoff',{id,format});if(epoch!==selectionEpoch||selected!==id)throw Error('所选批次已改变，没有下载旧批次。');download(r.content,format==='json'?'asset-handoff.json':'asset-handoff.md',format==='json'?'application/json':'text/markdown');}
async function exportDelivery(){const id=selected,epoch=selectionEpoch,r=await fetch('./api/assets/delivery?'+new URLSearchParams({id}),{cache:'no-store',credentials:'omit'});if(!r.ok){const data=await r.json();throw Error(data.message||'交付未就绪');}const data=await r.blob();if(id!==selected||epoch!==selectionEpoch)throw Error('选择已改变，没有下载旧批次。');download(data,'clw-approved-assets.zip');}
function addSpecRow(item=null){
 const index=$('assetSpecItems').children.length;if(index>=32)throw Error('每批最多32项');
 const i=item||{key:'asset_'+(index+1),prompt:'',width:1024,height:1024,format:'png',transparency:'any',references:[]},row=el('section',null,'asset-spec-row');
 function f(k,label,value,type='text'){const n=field('',label,value,type);n.lastChild.dataset.key=k;if(['key','prompt'].includes(k))n.lastChild.required=true;return n;}
 row.append(f('key','素材 ID（英文小写，不是生产文件路径）',i.key),f('prompt','完整提示词',i.prompt,'textarea'));
 const dimensions=el('div',null,'asset-fields spec-dimensions');dimensions.append(f('width','宽度',i.width,'number'),f('height','高度',i.height,'number'));
 for(const [k,label,values]of [['format','格式',[['png','PNG'],['jpg','JPEG'],['webp','WebP']]],['transparency','透明要求',[['any','不限'],['required','必须含透明像素'],['opaque','不允许透明']]]]){const wrap=choice('',label,values,i[k]);wrap.lastChild.dataset.key=k;dimensions.append(wrap);}row.append(dimensions);
 const refs=f('references','参考清单（每行 名称 = SHA256；原文件需另附）',i.references.map(r=>r.name+' = '+r.sha256).join('\n'),'textarea');refs.lastChild.rows=2;row.append(refs,button('移除该要求',()=>row.remove(),{mutating:false,cls:'link-button'}));$('assetSpecItems').append(row);
}
function openEditor(c=null,b=null){
 editable();editorEpoch++;editing=b?structuredClone(b):null;
 const spec=c||{title:'',project_id:'',project_root:'',task_id:'',style_brief:'',executor:'manual',provider:'人工导入',model:'不适用',account_alias:'本机素材',budget:null,items:[]};
 $('assetEditorTitle').textContent=b?'编辑未发布草稿':'新建素材批次';
 for(const [k,id]of Object.entries({title:'assetTitle',project_id:'assetProject',project_root:'assetRoot',task_id:'assetTask',style_brief:'assetStyle',executor:'assetExecutor',provider:'assetProvider',model:'assetModel',account_alias:'assetAccount'}))$(id).value=spec[k]||'';
 for(const [k,id,defaultValue]of [['currency','assetCurrency','USD'],['max_total','assetBudget','1.00'],['per_attempt','assetPerAttempt','0.10']])$(id).value=spec.budget?.[k]??defaultValue;
 $('assetBudgetFields').hidden=spec.executor!=='external_api';$('assetSpecItems').replaceChildren();if(spec.items.length)spec.items.forEach(addSpecRow);else addSpecRow();$('assetEditorError').textContent='';$('assetEditor').showModal();
}
function readSpec(){
 const c={};for(const [k,id]of Object.entries({title:'assetTitle',project_id:'assetProject',project_root:'assetRoot',task_id:'assetTask',style_brief:'assetStyle',executor:'assetExecutor',provider:'assetProvider',model:'assetModel',account_alias:'assetAccount'}))c[k]=$(id).value;
 c.billing_bucket=channels[c.executor];c.budget=c.executor==='external_api'?{currency:$('assetCurrency').value,max_total:$('assetBudget').value,per_attempt:$('assetPerAttempt').value}:null;
 c.items=[...$('assetSpecItems').children].map(row=>{const item={};for(const n of row.querySelectorAll('[data-key]'))item[n.dataset.key]=n.value;item.width=Number(item.width);item.height=Number(item.height);item.references=item.references.trim()?item.references.trim().split('\n').map(line=>{const split=line.lastIndexOf('=');if(split<1)throw Error('参考清单需要 名称 = SHA256');return {name:line.slice(0,split).trim(),sha256:line.slice(split+1).trim()};}):[];return item;});return c;
}
async function afterWrite(r,target,epoch){await refreshList();if(epoch===selectionEpoch&&(selected===target||!target))await selectBatch(r.batch.id);controls();}
$('assetEditorForm').onsubmit=async event=>{
 event.preventDefault();const edit=editing,token=editorEpoch,target=selected,epoch=selectionEpoch;
 try{editable();const promise=api.command(edit?'update':'create',{contract:readSpec()},{actor:$('assetActor').value,...(edit?{batch_id:edit.id,expected_version:edit.version}:{})});controls();const r=await promise;if(token===editorEpoch)$('assetEditor').close();note('草稿已保存，没有启动生成。');await afterWrite(r,target,epoch);}
 catch(e){if(token===editorEpoch)$('assetEditorError').textContent=e.message;note(e.message);}finally{pendingView();}
};
function openAction(kind,extra={}){
 editable();if(!current)return;const b=structuredClone(current);action={kind,b,extra,selectionEpoch};actionEpoch++;const fields=$('assetActionFields');fields.replaceChildren();$('assetActionError').textContent='';
 const titles={publish:'发布并冻结完整需求',reserve:'领取所选素材（不发送）',clone:'复制为新修订草稿',outcome:'核对原外部执行与费用',upload:'导入真实候选图片',review:'记录候选审阅',confirm_parent:'确认父任务的新版本'};
 $('assetActionTitle').textContent=titles[kind];$('assetActionTarget').textContent=`${b.contract.title} / ${b.id} / v${b.version}`;
 if(kind==='reserve'){
  action.keys=[...document.querySelectorAll('[data-select-key]:checked')].map(n=>n.dataset.selectKey);if(!action.keys.length)throw Error('先勾选需要领取的素材。');fields.append(el('p','所选：'+action.keys.join('、')),el('p',b.contract.budget?`每项预留 ${b.contract.budget.per_attempt} ${b.contract.budget.currency}；不是已扣费。`:'订阅或人工素材：不自动调用、不换算金额。'));
 }else if(kind==='clone')fields.append(field('assetCloneTitle','新草稿标题',b.contract.title+' · 修订'));
 else if(kind==='outcome'){
  const a=extra.attempt;fields.append(el('p',a.id+' / '+a.external_key,'mono'));fields.append(choice('assetOutcome','原执行结果',[['in_progress','外部已开始'],['outcome_unknown','结果未知'],['completed','外部已完成'],['failed','外部失败'],['not_sent','有证据确认未发送']],a.state==='reserved'?'in_progress':a.state),field('assetExternalRef','原供应方回执 / 会话引用',a.external_ref));
  if(b.contract.budget){fields.append(choice('assetChargeState','费用状态',[['unknown','未知，待核对'],['known','有明确实际金额'],['not_charged','有依据未计费']],a.charge.status==='reserved'?'unknown':a.charge.status),field('assetChargeAmount','实际金额（未知留空）',a.charge.amount||''));}
  fields.append(field('assetEvidence','原结果与费用核对依据','','textarea'));
 }else if(kind==='upload'){
  fields.append(el('p','将图片加入原 Attempt：'+extra.attempt.id,'mono'));const f=field('assetInputFile','PNG / JPEG / WebP，单张最多8 MiB','','file');f.lastChild.accept='image/png,image/jpeg,image/webp';f.lastChild.multiple=true;f.lastChild.required=true;fields.append(f,el('p','按顺序导入多张候选；某张失败或结果未知就停下，不盲重传。尺寸不符可留作对比，但不能批准。'));
 }else if(kind==='review'){
  fields.append(el('p',`${extra.candidate.asset_key} · ${extra.outcome}`),field('assetEvidence','视觉、内容、边缘与使用许可审阅依据','','textarea'));
 }else if(kind==='confirm_parent')fields.append(field('assetEvidence','已核对父任务目标与本批次仍一致的依据','','textarea'));
 else fields.append(el('p','发布后需求、模型声明、预算和参考哈希冻结；调整要求需复制为新草稿。'));
 fields.append(consent(kind==='review'?'我已实际查看候选并核对适用性和使用许可；技术校验不替代视觉审阅。':'我已核对本次目标、原身份与证据，确认此记录。'));$('assetAction').showModal();
}
$('assetActionForm').onsubmit=async event=>{
 event.preventDefault();const s=action,token=actionEpoch;if(!s)return;
 try{editable();if(!$('assetConsent').checked)throw Error('需要明确确认');const b=s.b,identity={actor:$('assetActor').value,batch_id:b.id,expected_version:b.version};let d={},r,stopped=false;
  if(s.kind==='upload'){
   const files=[...$('assetInputFile').files];if(!files.length)throw Error('请选择原图片');let version=b.version;
   for(let index=0;index<files.length;index++){
    // Returning/closing the dialog stops unsent files, never rolls back an accepted upload.
    if(token!==actionEpoch||selected!==b.id||s.selectionEpoch!==selectionEpoch){stopped=true;break;}
    const promise=api.upload(files[index],{...identity,expected_version:version,attempt_id:s.extra.attempt.id,spec_hash:b.spec_hash});controls();r=await promise;version=r.batch.version;s.b.version=version;
    if(token===actionEpoch){$('assetActionError').textContent=`已导入 ${index+1}/${files.length}`;$('assetActionTarget').textContent=`${s.b.contract.title} / ${s.b.id} / v${version}`;}
   }
  }else{
   if(s.kind==='publish')d={confirmed:true};
   if(s.kind==='reserve')d={asset_keys:s.keys};
   if(s.kind==='clone')d={title:$('assetCloneTitle').value};
   if(s.kind==='outcome')d={attempt_id:s.extra.attempt.id,state:$('assetOutcome').value,external_ref:$('assetExternalRef').value,evidence:$('assetEvidence').value,charge:{status:b.contract.budget?$('assetChargeState').value:'not_applicable',amount:b.contract.budget&&$('assetChargeState').value==='known'?$('assetChargeAmount').value:null},confirmed:true};
   if(s.kind==='review')d={candidate_id:s.extra.candidate.id,outcome:s.extra.outcome,note:$('assetEvidence').value,confirmed:true};
   if(s.kind==='confirm_parent')d={note:$('assetEvidence').value,confirmed:true};
   const promise=api.command(s.kind,d,identity);controls();r=await promise;
  }
  if(token===actionEpoch){$('assetAction').close();action=null;}
  note(stopped?'已停止后续图片导入；已接受的上传和原回执保留，不回滚、不重复发送。':'记录已保存；没有派发模型或覆盖项目资源。');
  if(r)await afterWrite(r,b.id,s.selectionEpoch);
 }catch(e){
  if(token===actionEpoch){$('assetActionError').textContent=e.message+(s.kind==='upload'?' 已确认的图片保留，请只重选尚未成功的文件；结果未知先核对原回执。':'');if(s.kind==='upload')$('assetInputFile').value='';}
  note(e.message);
  if(s.kind==='upload'&&selected===s.b.id){try{await selectBatch(s.b.id);s.selectionEpoch=selectionEpoch;}catch{/* Keep original expected version and receipt; no retry. */}}
 }finally{pendingView();}
};
$('newAssetBatch').onclick=()=>{try{openEditor();}catch(e){note(e.message);}};
$('addAssetItem').onclick=()=>{try{addSpecRow();}catch(e){$('assetEditorError').textContent=e.message;}};
$('assetExecutor').onchange=()=>{$('assetBudgetFields').hidden=$('assetExecutor').value!=='external_api';};
$('closeAssetEditor').onclick=()=>{editorEpoch++;$('assetEditor').close();};$('assetEditor').addEventListener('cancel',()=>editorEpoch++);
$('closeAssetAction').onclick=()=>{actionEpoch++;action=null;$('assetAction').close();};$('assetAction').addEventListener('cancel',()=>{actionEpoch++;action=null;});
$('closeAssetZoom').onclick=()=>{$('assetZoom').close();$('assetZoomImage').removeAttribute('src');};
$('refreshAssets').onclick=async()=>{try{await refreshList();if(selected)await selectBatch(selected);}catch(e){current=null;$('assetDetail').replaceChildren(el('div','读取失败，不能使用旧批次操作。','empty'));note(e.message);}};
$('assetSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();refreshList().catch(e=>note(e.message));}};$('moreAssets').onclick=()=>refreshList(false).catch(e=>note(e.message));
$('discoverAssetProjects').onclick=async()=>{const epoch=editorEpoch;try{const r=await api.read('projects');if(epoch!==editorEpoch)return;projects=r.projects;$('assetProjectChoices').replaceChildren(opt('','选择已观察项目'),...projects.map(p=>opt(p.id,p.name+' · '+p.path)));$('assetEditorError').textContent=`已观察 ${projects.length} 项，仍需核对确切工作目录；不是扩权。`;}catch(e){if(epoch===editorEpoch)$('assetEditorError').textContent=e.message;}};
$('assetProjectChoices').onchange=()=>{const p=projects.find(p=>p.id===$('assetProjectChoices').value);if(p){$('assetProject').value=p.id;$('assetRoot').value=p.path;}};
$('importAssetSpec').onchange=async e=>{try{editable();const f=e.target.files[0];if(!f)return;if(f.size>2*1024*1024)throw Error('需求清单超过2 MiB');openEditor(importedContract(JSON.parse(await f.text())));note('只载入需求草稿，不继承运行、费用和批准状态。');}catch(err){note(err.message);}finally{e.target.value='';}};
$('recoverAsset').onclick=async()=>{try{const r=api.pending().upload?await api.recoverUpload():await api.recoverMetadata(false);note(r?'原回执已确认，没有第二次写入。':'未找到原回执，请核对后明确重试。');await refreshList();if(selected)await selectBatch(selected);}catch(e){note(e.message);}finally{pendingView();}};
$('retryAssetMetadata').onclick=async()=>{try{await api.recoverMetadata(true);note('原记录请求已核对。');await refreshList();if(selected)await selectBatch(selected);}catch(e){note(e.message);}finally{pendingView();}};
$('retryAssetFile').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;await api.retryUpload(f);note('原图片上传已核对，没有新建请求。');await refreshList();if(selected)await selectBatch(selected);}catch(err){note(err.message);}finally{e.target.value='';pendingView();}};
try{await api.init();$('assetServiceState').textContent='本机素材库已连接 · 外部交接模式 · 不自动调用模型';await refreshList();controls();}catch(e){note(e.message);$('assetServiceState').textContent='素材接口未连接：只重开Control Center加载新版本，不重启Tunnel。';}
