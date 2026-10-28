// Presentation facts: neither a running process nor a local label proves OpenAI identity.
export function healthLabel(h={}) {
 const labels={polling:'云端轮询正常',checking:'正在观察',unavailable:'入口不可核验',observation_stale:'观测已过期',identity_unverified:'入口身份未核验',local_not_ready:'本机尚未就绪',poll_not_seen:'尚无成功云端轮询',poll_stale:'云端轮询已过期',source_changed:'入口引用需重新确认',archived:'记录已归档'};
 return labels[h.state]||'尚未观察';
}
export function healthTone(h={}) {return h.state==='polling'?'ok':h.state==='checking'?'muted':'warn';}
export function age(seconds){return Number.isFinite(seconds)?`${Math.floor(Math.max(0,seconds))} 秒前`:'未知';}
export function profileMatches(a,query){return [a.name,a.browser_hint,a.notes,a.tunnel_id].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase());}
export function createSelectionGate(){
 let seq=0,current='';
 return {select(value){current=value;seq++;return {seq,current};},ticket(){return {seq,current};},valid(t){return !!t&&t.seq===seq&&t.current===current;},current(){return current;}};
}
export function activityOutcome(row){
 if(row.exit_code!=null&&row.exit_code!==0)return '程序非零退出';
 if(row.job_handoff)return '已交给 Job · 另查终态';
 return row.execution_state||row.state||'未知';
}
