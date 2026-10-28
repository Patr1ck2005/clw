"""Narrow WebCodex 0.4.1 ACP bridge; no subprocesses, provider install or write retries."""
from __future__ import annotations
from copy import deepcopy
import json
import re
import time
from urllib.error import HTTPError
from urllib.request import Request
from task_domain import bounded, fail, fingerprint, now, txt, absolute
from live_transport import MAX_BODY

RUN = re.compile(r'wc_agent_run_[A-Za-z0-9_.-]{1,80}\Z')
FINAL = {'completed', 'failed', 'cancelled', 'not_started', 'abandoned'}
STATES = {'starting','running','waiting_permission','completed','failed','cancelled','lost'}

class NativeAgentBridge:
    def __init__(self, transport=None, *, enabled=False, provider_ids=()):
        self.transport = transport
        self.enabled = enabled
        # 0.4.1 list_runners omits private registry Provider records. An operator
        # may declare exact logical IDs locally; this NEVER fabricates an observed
        # Provider instance or bypasses native pre-prompt authority/config checks.
        if not isinstance(provider_ids,(list,tuple)) or len(provider_ids)>8:
            raise ValueError('Use at most eight explicit local provider IDs')
        if any(not isinstance(p,str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',p) for p in provider_ids):
            raise ValueError('Invalid explicit local provider ID')
        self.provider_ids=tuple(dict.fromkeys(provider_ids))
    @property
    def namespace(self):
        return self.transport.namespace if self.transport else None
    def call(self, tool, params):
        if tool not in {'list_runners','coding_agent_start','coding_agent_observe','coding_agent_cancel'}:
            fail('tool','不支持的原生动作')
        if not self.transport: fail('not_configured','未配置本机连接',409)
        if tool in {'coding_agent_start','coding_agent_cancel'} and not self.enabled:
            fail('disabled','专项执行未由本机操作者启用',403)
        # Crucially do not route writes through Transport.post's read retry loop.
        body=json.dumps({'tool':tool,'params':params},ensure_ascii=False).encode('utf-8')
        req=Request(self.transport.origin+'/api/tools/call',data=body,method='POST',headers={
            'Authorization':'Bearer '+self.transport._token,'Content-Type':'application/json','Accept':'application/json'})
        try:
            try: response=self.transport.opener.open(req,timeout=40)
            except HTTPError as exc:
                # Auth/permission refusal is not evidence that an older attempt did not commit.
                if exc.code in (401,403): exc.close();fail('access_denied','当前授权已失效或不足；保留原 Run，不重发',403)
                if exc.code!=400: exc.close();fail('native_unavailable','原生响应未确认；保留原请求',503)
                response=exc
            with response:
                if response.headers.get_content_type()!='application/json' or response.headers.get('Content-Encoding','identity')!='identity':
                    fail('native_invalid','原生响应格式不符',503)
                chunks=[];size=0;deadline=time.monotonic()+40
                while True:
                    if time.monotonic()>deadline:fail('native_unavailable','原生响应超过读取期限',503)
                    part=response.read1(min(65536,MAX_BODY+1-size))
                    if not part:break
                    size+=len(part)
                    if size>MAX_BODY:fail('native_invalid','原生响应超过上限',503)
                    chunks.append(part)
                raw=b''.join(chunks)
            result=json.loads(raw)
            if not isinstance(result,dict) or type(result.get('success')) is not bool or not isinstance(result.get('output'),dict):
                fail('native_invalid','原生响应信封不符',503)
            return result
        except (OSError,ValueError) as exc:
            from task_domain import TaskError
            if isinstance(exc,TaskError): raise
            fail('native_unavailable','原生结果未确认；不会自动重试',503)
    def discover(self, project):
        if not self.transport:
            return {'available':False,'enabled':False,'providers':[],'reason':'未配置只读连接','observed_at':now()}
        status=self.transport.post('status',{'compact':True},time.monotonic()+15)
        if status.get('version')!='0.4.1': fail('version','只接受已核对的 WebCodex 0.4.1',409)
        client=project.split(':',2)[1] if project.startswith('agent:') and project.count(':')>=2 else ''
        if not client: fail('project','必须使用完整已登记的 Project ID')
        raw=self.call('list_runners',{'client_id':client,'include_projects':False,'summary_only':False})
        if not raw['success']: fail('native_unavailable','未能观察指定 Runner',409)
        agents=raw['output'].get('agents')
        if not isinstance(agents,list) or len(agents)>8: fail('native_invalid','Runner 列表格式无效',503)
        runner=next((a for a in agents if a.get('client_id')==client),None)
        providers=[]
        capable=bool(runner and runner.get('connected') is True and runner.get('capabilities',{}).get('coding_agent_runs') is True)
        details=bool(runner and isinstance(runner.get('coding_agent_providers'),list))
        if capable:
            advertised=runner.get('coding_agent_providers',[])
            if not isinstance(advertised,list) or len(advertised)>8: fail('native_invalid','Provider 列表超限',503)
            for p in advertised:
                pid=txt(p.get('provider_id'),'Provider',64)
                stamp={'connection':self.namespace,'runner':txt(runner.get('agent_instance_id'),'Runner身份',128),
                       'provider':pid,'instance':txt(p.get('provider_instance_id'),'Provider身份',128)}
                providers.append({'id':pid,'name':txt(p.get('name',pid),'Provider名称',128),'binding':fingerprint(stamp),'source':'runner_advertisement','advertisement_verified':True})
            if not details:
                for pid in self.provider_ids:
                    stamp={'connection':self.namespace,'runner':txt(runner.get('agent_instance_id'),'Runner身份',128),'provider':pid,'source':'operator_declared_native_preflight'}
                    providers.append({'id':pid,'name':pid+'（本机声明，原生派发前核验）','binding':fingerprint(stamp),'source':'operator_declared_native_preflight','advertisement_verified':False})
        reason='原生选项在 prompt 前协商；有效模型当前未回传'
        if capable and not details:
            reason='0.4.1只读投影未提供Provider明细。'+('候选ID来自明确本机配置，不是已验证Provider；原生在prompt前核验并拒绝未知值。' if providers else '未指定本机Provider ID；不会猜测或启动替代执行器。')
        elif not providers:reason='指定 Runner 未公布可用 ACP 能力/provider；未启动替代执行器'
        return {'available':bool(providers),'enabled':self.enabled,'providers':providers,'connection':self.namespace,
                'native_run_capability':capable,'provider_details_available':details,'observed_at':now(),'reason':reason}

def safe_projection(raw, delegation):
    """Allowlist bounded native metadata. Do not persist reasoning, tools' bodies or errors."""
    output=raw.get('output',{})
    rid=output.get('run_id')
    if rid is not None and (not isinstance(rid,str) or not RUN.fullmatch(rid)): fail('native_identity','Run 身份格式无效',503)
    if delegation.get('run_id') and rid!=delegation['run_id']: fail('native_identity','不是原 Run 回执',503)
    if raw.get('success') is False:
        # Only a structured exact-protocol pre-dispatch failure proves nonexecution.
        if output.get('execution_state')=='not_started' and delegation.get('phase')=='prepared' and not delegation.get('ever_started'):
            return {'phase':'not_started','run_id':rid,'error_code':txt(output.get('error_kind','rejected'),'错误种类',100),'observed_at':now()}
        return {'phase':'unknown','run_id':delegation.get('run_id'),'error_code':'native_outcome_unknown','observed_at':now()}
    if not rid or output.get('project')!=delegation['project'] or output.get('provider_id')!=delegation['provider']:
        fail('native_identity','Project / Provider / Run 不匹配',503)
    state=output.get('state');execution=output.get('execution_state')
    if state not in STATES or execution not in {'not_started','started','outcome_unknown','completed'}: fail('native_invalid','未知原生状态',503)
    terminal=output.get('terminal')
    if terminal is not None:
        if not isinstance(terminal,dict) or type(terminal.get('completed_at')) is not int or terminal['completed_at']<=0:
            fail('native_invalid','缺少原生终态时间证据',503)
        if state=='completed' and terminal.get('stop_reason')!='end_turn':fail('native_invalid','完成状态与停止原因不一致',503)
        if state=='cancelled' and execution=='completed' and terminal.get('stop_reason')!='cancelled':fail('native_invalid','取消终态未相关确认',503)
    phase=state
    if execution=='outcome_unknown' or state=='lost': phase='unknown'
    if state in {'completed','failed','cancelled'} and (execution!='completed' or not isinstance(terminal,dict)):
        phase='unknown'
    # A correlated retained pre-prompt terminal is authoritative; a later admission
    # denial above is not evidence about an earlier possibly dispatched attempt.
    if state in {'failed','cancelled'} and execution=='not_started' and isinstance(terminal,dict) and not delegation.get('ever_started'):
        phase='not_started'
    result={'phase':phase,'run_id':rid,'native_state':state,'execution_state':execution,'ever_started':delegation.get('ever_started',False) or execution in {'started','completed','outcome_unknown'},'observed_at':now()}
    if terminal is not None:
        if not isinstance(terminal,dict): fail('native_invalid','终态格式无效',503)
        result['terminal']={k:v for k,v in terminal.items() if k in {'stop_reason','error_code','completed_at'} and isinstance(v,(str,int)) and len(str(v))<200}
    token=output.get('observation_token')
    if token is not None: result['observation_token']=txt(token,'观察游标',192)
    events=output.get('events',[])
    if not isinstance(events,list) or len(events)>64: fail('native_invalid','事件范围不符',503)
    last=delegation.get('usage_sequence',0)
    for event in events:
        if not isinstance(event,dict) or type(event.get('sequence')) is not int: fail('native_invalid','事件序号无效',503)
        if event.get('kind')=='usage' and isinstance(event.get('usage'),dict) and event['sequence']>last:
            usage={}
            for k in ('used_tokens','context_window_tokens'):
                v=event['usage'].get(k)
                if v is not None:
                    if type(v) is not int or not 0<=v<=2**53-1: fail('native_invalid','上下文用量格式无效',503)
                    usage[k]=v
            from usage_store import amount
            cost=event['usage'].get('cost_amount')
            currency=event['usage'].get('cost_currency')
            if cost is not None: usage['cost_amount']=amount(cost)
            if currency is not None: usage['cost_currency']=txt(currency,'报告币种',16)
            usage.update(source='native_acp_observation',observed_at=now(),semantics='current_context_and_cumulative_session_cost_not_quota_or_invoice')
            result.update(usage=usage,usage_sequence=event['sequence']);last=event['sequence']
    result['has_more']=output.get('has_more') is True
    result['history_lost']=output.get('history_lost') is True
    result['effective_model']=None;result['effective_effort']=None
    result['observation_error']=None
    bounded(result)
    return result
