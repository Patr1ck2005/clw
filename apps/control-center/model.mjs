// Pure, bounded view-model. No credentials, execution, inference calls or storage.
export const MAX_BYTES = 2 * 1024 * 1024;
// Exact spelling only, not account authentication. Absolute end rejects a final newline.
export const NATIVE_SESSION_RE = /^wc_sess_(?:[A-Za-z0-9_]{1,112}|[A-Za-z0-9_-]{16})$(?![\s\S])/;
const own = (v,k) => Object.hasOwn(v,k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = message => { throw new Error(message); };
function record(v,label) { if (!object(v)) fail(`${label} 必须为对象`); return v; }
function text(v,label,max=512) { if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(v)) fail(`${label} 文本无效`); return v; }
function id(v,label) { const out=text(v,label,600); if(!out.trim()) fail(`${label} 不能为空`); return out; }
function integer(v,label) { if (!Number.isSafeInteger(v) || v < 0 || v > 1e12) fail(`${label} 数值无效`); return v; }
function optionalNumber(v,label) { return v == null ? null : integer(v,label); }
function array(v,label,max) { if(!Array.isArray(v) || v.length>max) fail(`${label} 条数超限或格式不符`); return v; }
function choice(v,values,label) { if(!values.includes(v)) fail(`${label} 值未知`); return v; }
function unique(items,label) { const ids=items.map(x=>x.id); if(new Set(ids).size!==ids.length) fail(`${label} ID重复`); }
function forbidden(v,depth=0) {
  if(depth>24) fail('JSON层级过深');
  if(v && typeof v==='object') for(const [k,val] of Object.entries(v)) {
    if(['__proto__','constructor','prototype','access_token','refresh_token','api_key','authorization','cookie','password'].includes(k.toLowerCase())) fail(`不接受凭据或危险字段: ${k}`);
    forbidden(val,depth+1);
  }
}
function activitiesFor(s) {
  const items=array(s.activities??[],'上游活动',200).map(a=>{
    record(a,'上游活动');
    return {kind:text(a.kind,'活动类型',80),tool:text(a.tool??'','活动工具',120),state:text(a.state,'活动状态',80),
      execution_state:text(a.execution_state??'','执行状态',80),job_handoff:a.job_handoff===true,
      started_at:integer(a.started_at,'活动时间'),finished_at:optionalNumber(a.finished_at,'结束时间'),
      duration_ms:optionalNumber(a.duration_ms,'活动耗时'),exit_code:a.exit_code==null?null:(Number.isInteger(a.exit_code)&&Math.abs(a.exit_code)<2**32?a.exit_code:fail('退出码无效')),
      job_id:text(a.job_id??'','关联Job',128),summary:text(a.summary??'','活动摘要',500),paths:array(a.paths??[],'活动路径',8).map(p=>text(p,'活动路径',2048)),group_count:optionalNumber(a.group_count,'合并项数')};
  });
  const total=integer(s.activity_total??0,'保留活动总数');
  if(total<items.length||(total>items.length&&s.activity_truncated!==true))fail('活动保留范围不一致');
  return {activities:items,activities_loaded:s.activities_loaded===true,activity_total:total,activity_truncated:s.activity_truncated===true};
}
export function validateSnapshot(raw) {
  if(new TextEncoder().encode(JSON.stringify(raw)).length>MAX_BYTES) fail('观测包超过2 MiB');
  forbidden(raw); record(raw,'观测包');
  if(raw.schema_version!==1) fail('不支持的观测包版本');
  const src=record(raw.source,'source'), rt=record(raw.runtime,'runtime');
  const date=text(src.observed_at,'观测时间',50);
  if(!date.endsWith('Z')||!Number.isFinite(Date.parse(date))) fail('必须提供有效UTC观测时间');
  const source={kind:choice(src.kind,['tool_observation','demo'],'来源'),observed_at:date,scope:text(src.scope,'观测范围',1200),live:false};
  const runtime={id:id(rt.id,'后端ID'),version:text(rt.version,'版本',80),runner_id:id(rt.runner_id,'Runner ID'),runner_state:choice(rt.runner_state,['online','offline','unknown'],'Runner状态'),job_capacity:optionalNumber(rt.job_capacity,'Job容量')};
  const projects=array(raw.projects,'项目',1000).map(p=>{record(p,'项目');return {id:id(p.id,'Project ID'),name:text(p.name,'项目名',200),path:text(p.path,'项目路径',2048),enabled:p.enabled===true};});
  unique(projects,'项目'); const projectIds=new Set(projects.map(p=>p.id));
  let totalEvents=0;
  const sessions=array(raw.sessions,'Session',1000).map(s=>{
    record(s,'Session'); const sid=id(s.id,'Session ID'),pid=id(s.project_id,'Session Project');
    if(!projectIds.has(pid)) fail('Session引用未提供的项目');
    const counts=record(s.counts,'Session计数');
    const events=array(s.events,'事件',1000).map(e=>{
      record(e,'事件'); if(e.session_id!==sid) fail('跨Session事件归属不符');
      return {id:id(e.id,'事件ID'),session_id:sid,logical_id:e.logical_id==null?null:id(e.logical_id,'逻辑调用ID'),role:choice(e.role,['business','recorder','unspecified'],'记录角色'),kind:choice(e.kind,['started','finished'],'事件类型'),tool:text(e.tool,'工具名',120),timestamp:integer(e.timestamp,'事件时间'),status:e.status==null?null:choice(e.status,['succeeded','failed','unknown'],'调用状态'),duration_ms:optionalNumber(e.duration_ms,'处理耗时'),exit_code:e.exit_code==null?null:(Number.isInteger(e.exit_code)&&Math.abs(e.exit_code)<2**32?e.exit_code:fail('退出码无效')),job_id:e.job_id==null?null:id(e.job_id,'Job ID'),error_class:e.error_class==null?null:text(e.error_class,'错误类型',120)};
    });
    unique(events,'Session事件'); totalEvents+=events.length;
    const total=integer(s.events_total,'事件总数');
    if(total<events.length || (total>events.length && s.events_truncated!==true)) fail('事件覆盖范围与截断声明不一致');
    if(integer(counts.succeeded,'成功调用')+integer(counts.failed,'失败调用')>integer(counts.tool_calls,'工具调用数')) fail('成功/失败计数超过调用总数');
    return {id:sid,project_id:pid,title:text(s.title,'任务标题',500),lifecycle:choice(s.lifecycle,['active','closed','unknown'],'Session生命周期'),counts:{tool_calls:integer(counts.tool_calls,'工具调用数'),succeeded:integer(counts.succeeded,'成功调用'),failed:integer(counts.failed,'失败调用')},events_total:integer(s.events_total,'事件总数'),events_truncated:s.events_truncated===true,events,
      counts_available:s.counts_available!==false,...activitiesFor(s),updated_at:optionalNumber(s.updated_at,'会话更新时间'),running_call:s.running_call===true,running_jobs:optionalNumber(s.running_jobs,'运行Job数'),running_jobs_complete:s.running_jobs_complete===true};
  });
  unique(sessions,'Session'); if(totalEvents>4000) fail('总事件条数超限');
  const jobs=array(raw.jobs,'Job',1000).map(j=>{
    record(j,'Job');const pid=id(j.project_id,'Job Project');if(!projectIds.has(pid)) fail('Job引用未提供项目');
    const sid=j.session_id==null?null:id(j.session_id,'Job Session');
    if(sid&&!sessions.some(s=>s.id===sid&&s.project_id===pid))fail('Job会话/项目关联不符');
    const owner=j.owner_session_id==null?sid:id(j.owner_session_id,'Job所属Session');
    if(sid&&owner!==sid)fail('Job来源Session身份冲突');
    return {id:id(j.id,'Job ID'),project_id:pid,session_id:sid,owner_session_id:owner,status:choice(j.status,['running','queued','completed','failed','cancelled','unknown'],'Job状态'),exit_code:j.exit_code==null?null:(Number.isInteger(j.exit_code)&&Math.abs(j.exit_code)<2**32?j.exit_code:fail('退出码无效'))};
  });unique(jobs,'Job');
  return {schema_version:1,source,runtime,projects,sessions,jobs};
}
export function safeParseSnapshot(value) { if(typeof value!=='string'||new TextEncoder().encode(value).length>MAX_BYTES) fail('观测包超过2 MiB');return validateSnapshot(JSON.parse(value)); }
export function emptyAnnotations(runtimeId) { return {schema_version:1,runtime_id:runtimeId,bindings:[],groups:[]}; }
export function validateAnnotations(raw,snapshot,{retainDetached=false}={}) {
  if(new TextEncoder().encode(JSON.stringify(raw)).length>MAX_BYTES) fail('标注包超过2 MiB');
  record(raw,'标注');forbidden(raw);
  if(raw.schema_version!==1||raw.runtime_id!==snapshot.runtime.id) fail('标注属于不同后端/版本');
  const bindings=array(raw.bindings,'标注',1000).map(b=>{
    record(b,'标注');const sid=id(b.session_id,'标注Session');if(!NATIVE_SESSION_RE.test(sid)||(!retainDetached&&!snapshot.sessions.some(s=>s.id===sid)))fail('不能给未知Session绑定账号');
    return {session_id:sid,account_alias:text(b.account_alias,'本地别名',80),role:text(b.role,'角色',80),model_label:text(b.model_label??'','自报模型',100),source:'user_label_not_identity',updated_at:text(b.updated_at,'标注时间',50)};
  });
  if(new Set(bindings.map(b=>b.session_id)).size!==bindings.length)fail('重复Session标注');
  const groups=array(raw.groups??[],'分组',1000).map(g=>{
    record(g,'分组');const pid=id(g.project_id,'分组Project');if(!retainDetached&&!snapshot.projects.some(p=>p.id===pid))fail('未知Project分组');
    return {project_id:pid,name:text(g.name,'分组名',80)};
  });
  if(new Set(groups.map(g=>g.project_id)).size!==groups.length)fail('重复Project分组');
  return {schema_version:1,runtime_id:snapshot.runtime.id,bindings,groups};
}
export function setBinding(annotations,snapshot,value,options={}) {
  if(!snapshot.sessions.some(s=>s.id===value.session_id))fail('不能给未知Session绑定账号');
  return validateAnnotations({...annotations,bindings:[...annotations.bindings.filter(b=>b.session_id!==value.session_id),value]},snapshot,options);
}
export function setGroup(annotations,snapshot,value,options={}) {
  record(value,'分组');const project_id=id(value.project_id,'分组Project'),name=text(value.name,'分组名',80).trim();
  if(!snapshot.projects.some(p=>p.id===project_id))fail('未知Project分组');
  return validateAnnotations({...annotations,groups:[...annotations.groups.filter(g=>g.project_id!==project_id),...(name?[{project_id,name}]:[])]},snapshot,options);
}
export function defaultGroup(p) {
  // Navigation suggestion only. Does not establish a task role, repository or grant.
  if(/example-game-alpha/i.test(p.path))return 'Spirefall';
  if(/example-game-beta|example-assets/i.test(p.path))return 'Unity';
  if(/example-project-11|math-research/i.test(p.path))return '研究';
  if(p.name==='example-project-07')return 'CLW 产品';
  return '通用目录';
}
export function projectGroup(p,annotations) { return annotations.groups.find(g=>g.project_id===p.id)?.name||defaultGroup(p); }
export function visibleSessions(snapshot,annotations,{project='',alias='',query=''}={}) {
  const q=query.toLocaleLowerCase();
  return snapshot.sessions.filter(s=>{
    const b=annotations.bindings.find(b=>b.session_id===s.id);
    return (!project||s.project_id===project)&&(!alias||(alias==='__unbound__'?!b?.account_alias:b?.account_alias===alias))&&(!q||[s.title,s.id,b?.role??''].join(' ').toLocaleLowerCase().includes(q));
  });
}
export function completedCalls(events) {
  // Started/recorder/business records are not separate user invocations.
  const result=new Map();
  for(const e of events)if(e.kind==='finished'){
    const key=e.session_id+'|'+(e.logical_id||e.id), old=result.get(key);
    if(!old || (e.role==='business'&&old.role!=='business') || (e.role===old.role&&e.timestamp>old.timestamp))result.set(key,e);
  }
  return [...result.values()].sort((a,b)=>b.timestamp-a.timestamp);
}
export function classifyCall(e) {
  if(e.status==='unknown')return {label:'结果未知',tone:'warn'};
  if(e.error_class==='command_exit_nonzero'||(e.exit_code!=null&&e.exit_code!==0))return {label:'程序失败',tone:'bad'};
  if(e.status==='failed')return {label:'调用失败',tone:'bad'};
  if(e.status==='succeeded'&&e.job_id&&e.exit_code==null)return {label:'已接受 · 非完成',tone:'warn'};
  if(e.status==='succeeded')return {label:'调用成功',tone:'ok'};
  return {label:'待核对',tone:'muted'};
}
export function routeAdvice(kind) {
  const routes={
    implementation:{target:'Web 主导',reason:'目标与接口清晰的大实现，保留完整约束与验收；不重复派给Codex重做。'},
    deterministic:{target:'普通本机 Job',reason:'固定测试、统计、打包、图片后处理用程序；不需要模型持续轮询。'},
    integration:{target:'Codex 专项（显式选择）',reason:'仅交付具体冲突/失败包；不重复加载全仓库与四个会话全文。'},
    interaction:{target:'Codex 专项或人工联调',reason:'高频编辑器反馈/跨系统定位时使用；核查相关本机工具能力与额度。'},
    research:{target:'Web 独立研究 + 验证 Job',reason:'推导与独立审查在Web；编译/计算交给Job，Codex只处理具体实现难题。'},
    images:{target:'独立素材流程',reason:'先样例审阅再批量；Codex内置出图占Codex额度，Image API另计费，不能静默切换。'}
  };
  if(!own(routes,kind))fail('未知任务类型');return routes[kind];
}
export function makeTaskPacket({project,goal,acceptance,kind}) {
  text(goal,'完整目标',32768);text(acceptance,'验收标准',32768);
  if(!object(project)||!project.id||!goal.trim()||!acceptance.trim())fail('请填写项目、完整目标与验收');
  const route=routeAdvice(kind);
  return `# CLW 完整任务包\n\n> 本地生成的建议，不是执行或新增授权；不改变任何账号/模型设置。\n\nProject: ${project.id}\n目录: ${project.path}\n建议执行者: ${route.target}\n\n## 完整目标\n${goal}\n\n## 验收\n${acceptance}\n\n## 不变规则\n读取本项目规则和实际HEAD/工作区；保留原目标。检查点保存后继续，不按时长拆分或停轮。已接受或结果未知的操作核对原ID，不换键重放。只在获准范围工作；模型/账户/付费API改变须明确选择。\n\n## 交回\n实际base/head、变化范围、原Job、测试与未验证项、产物路径/hash、后续动作。\n`;
}
