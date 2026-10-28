"""Explicit task-bound ACP delegation. All durable transitions use the task DB transaction."""
from __future__ import annotations
from copy import deepcopy
import threading
import uuid
from task_domain import ACTIVE, bounded, encoded, fail, fingerprint, now, obj, role_of, txt, absolute
from coding_agent_bridge import FINAL, safe_projection

class Specialists:
    def __init__(self, store, bridge):
        self.store=store;self.bridge=bridge
        self.lock=threading.Lock()
    def capabilities(self, task_id, role_id):
        task=self.store.get(task_id);role,_=role_of(task,role_id)
        return self.bridge.discover(role['project_id'])
    def command(self, raw):
        bounded(raw);obj(raw,{'request_id','action','task_id','expected_version','actor','data'}, {'request_id','action','task_id','expected_version','actor','data'})
        data=raw['data'];action=raw['action'];obj(data,{'role_id','provider','binding','config','billing','account_alias','confirmed'}, {'role_id'})
        rid=data['role_id'];task=self.store.get(raw['task_id']);role,state=role_of(task,rid)
        tagged=deepcopy(raw);tagged['action']='specialist.'+txt(action,'专项动作',32)
        # Replaying a recorded UI request only returns the local receipt. It NEVER sends again.
        receipt=self.store.specialist_receipt(tagged)
        if receipt is not None: return receipt
        if not self.lock.acquire(blocking=False): fail('busy','另一个专项请求正在核对，稍后查看原记录',409)
        try:
            if action=='prepare':
                obj(data,{'role_id','provider','binding','config','billing','account_alias'}, {'role_id','provider','binding','config','billing','account_alias'})
                if role['executor']!='codex' or state['status']!='running' or task['status']!='open': fail('state','先登记本 Codex 角色开工，再准备专项',409)
                if state.get('delegation',{}).get('phase','abandoned') not in FINAL: fail('active','已有专项或未知结果，先核对原 Run',409)
                if role['worktree']!=role['project_root']: fail('scope','原生 cwd 为 Project 根；该工作树需独立登记为 Project',409)
                if role['access']=='write' and role['scopes']!=['.']:
                    fail('scope','自动写入专项需独立登记工作树并明确占用整个根(.)；局部写域只保留人工交接，不冒充路径沙箱',409)
                observed=self.store.observer.state(role['project_id']) if self.store.observer else {}
                projects=observed.get('projection',{}).get('projects',[]) if observed.get('state')=='connected' else []
                project=next((p for p in projects if p['id']==role['project_id']),None)
                if not project or absolute(project['path'])!=role['worktree']: fail('identity','实际 Project 根未核对',409)
                caps=self.bridge.discover(role['project_id']);p=next((p for p in caps['providers'] if p['id']==data['provider'] and p['binding']==data['binding']),None)
                if not p: fail('provider','Provider 广告已变化或不可用',409)
                config=data['config'];obj(config,{'model','reasoning_effort','mode'}, {'model','reasoning_effort','mode'})
                config={k:txt(v,'请求 '+k,200) for k,v in config.items()}
                if role['access']=='read' and config['mode']!='read-only': fail('scope','只读角色只接受显式 read-only 请求',409)
                if data['billing']!='work_codex': fail('billing','本版不派发独立 API 计费专项',409)
                alias=txt(data['account_alias'],'操作者声明账号',100)
                instruction=self.store.export(task['id'],rid,'markdown')['content']
                instruction+='\n\n## 执行边界\n只完成本角色。先核对真实根、HEAD 与现有差异；不按时长结束目标。不得读取凭据、改其他角色或扩大写域。结束时提交可验证交接；不自行声明父任务验收。\n'
                if len(instruction.encode('utf-8'))>65536: fail('too_large','完整启动包超过原生64 KiB；请精简引用，不会截断合同',413)
                delegation={'id':uuid.uuid4().hex,'phase':'prepared','key':'clw-specialist-'+uuid.uuid4().hex,'instruction':instruction,'instruction_hash':fingerprint(instruction),
                    'project':role['project_id'],'provider':p['id'],'provider_binding':p['binding'],'provider_source':p.get('source','runner_advertisement'),'provider_advertisement_verified':p.get('advertisement_verified',True),'connection':self.bridge.namespace,'config':config,
                    'billing':data['billing'],'billing_source':'operator_declared_unverified','account_alias':alias,'contract_version':task['contract_version'],
                    'contract_hash':task['contract_hash'],'role_attempt':state['attempt'],'timeout_secs':3600,'run_id':None,'prepared_at':now(),'effective_model':None,'effective_effort':None,'usage':None}
                return self.store.specialist_edit(tagged,lambda t,s:s.update(delegation=delegation))
            obj(data,{'role_id','confirmed'},{'role_id'})
            d=state.get('delegation')
            if not d: fail('state','本角色尚无专项记录',409)
            if action=='abandon':
                if d['phase']!='prepared': fail('state','仅未派发的准备包可放弃',409)
                return self.store.specialist_edit(tagged,lambda t,s:s['delegation'].update(phase='abandoned'))
            if action not in {'start','retry_start','observe','cancel'}: fail('action','未知专项动作')
            if d['connection']!=self.bridge.namespace: fail('identity','原连接身份已变化；不向新账号查询或重发',409)
            if action in {'start','retry_start','cancel'}:
                if data.get('confirmed') is not True: fail('consent','需要逐次明确确认执行或取消')
                if not self.bridge.enabled: fail('disabled','本机终端未启用专项执行',403)
            if action in {'start','retry_start'}:
                if task['status']!='open' or state['status']!='running': fail('state','只有工作中角色可以派发',409)
                if d['contract_hash']!=task['contract_hash'] or d['role_attempt']!=state['attempt']: fail('state','任务版本或登记次序变化',409)
                if (action=='start' and d['phase']!='prepared') or (action=='retry_start' and (d['phase'] not in {'dispatching','unknown'} or d.get('run_id'))):
                    fail('state','请核对原 Run；不能以新派发代替恢复',409)
                observed=self.store.observer.state(d['project']) if self.store.observer else {}
                projected=observed.get('projection') or {}
                actual=next((p for p in projected.get('projects',[]) if p['id']==d['project']),None)
                if observed.get('state')!='connected' or not actual or absolute(actual['path'])!=role['worktree']:
                    fail('identity','派发前实际 Project 根已变化或无法核对',409)
                caps=self.bridge.discover(d['project'])
                if not any(p['id']==d['provider'] and p['binding']==d['provider_binding'] for p in caps['providers']): fail('identity','原 Provider / Runner 已变化；不转移未知派发',409)
            elif not d.get('run_id'): fail('state','没有原 Run ID；需要按原键核对，不可猜测',409)
            elif action=='cancel' and d['phase'] in FINAL: fail('state','原 Run 已终止，无需取消',409)
            # Reserve this operation atomically before any possible remote effect.
            def reserve(t,s):
                current=s['delegation']
                if current['id']!=d['id']: fail('version','专项已改变',409)
                current['operation']=raw['request_id']
                if action in {'start','retry_start'}: current['phase']='dispatching'
                if action=='cancel': current['cancel_requested']=True
            receipt=self.store.specialist_edit(tagged,reserve)
            if receipt.get('replayed'): return receipt
            try:
                if action in {'start','retry_start'}:
                    value=self.bridge.call('coding_agent_start',{'project':d['project'],'provider_id':d['provider'],'idempotency_key':d['key'],'instruction':d['instruction'],'config':d['config'],'timeout_secs':d['timeout_secs']})
                elif action=='observe':
                    value=self.bridge.call('coding_agent_observe',{'run_id':d['run_id'],'wait_secs':0,**({'after_observation_token':d['observation_token']} if d.get('observation_token') else {})})
                else: value=self.bridge.call('coding_agent_cancel',{'run_id':d['run_id']})
                update=safe_projection(value,d)
                if action=='cancel':
                    update['cancel_requested']=True
                    # Cancellation acknowledgements are not terminal observation proof.
                    update['phase']=d['phase'];update.pop('terminal',None)
                if d['phase'] in FINAL and update['phase'] not in FINAL: fail('native_stale','迟到的非终态没有覆盖已知终态',409)
            except Exception:
                # Never guess nonexecution after an exception, even an HTTP 403 on retry.
                update={'observation_error':'未确认原生结果；原请求与写域保留','observed_at':now()}
                if action in {'start','retry_start'}: update['phase']='unknown'
            self.store.specialist_result(task['id'],rid,d['id'],raw['request_id'],update)
            return receipt
        finally: self.lock.release()
