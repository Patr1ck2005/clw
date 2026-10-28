"""Bounded live view collector. Explicit Project ownership; latest-window replacement, not event replay."""
from __future__ import annotations
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
import re
import threading
import time
import uuid
from live_transport import Transport, ObservationError, MAX_BODY, SAFE_MESSAGES

from native_identity import SESSION_RE
SECRET_RE = re.compile(r'(?:wck_|wc_pat_|wc_oat_|wc_agent_|sk-)[A-Za-z0-9_-]{12,}')
def utc(): return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
def text(v, cap=512, default=''):
    if v is None: return default
    if not isinstance(v, str): raise ObservationError('upstream_invalid')
    return SECRET_RE.sub('[redacted]', ''.join(c for c in v if ord(c)>=32 or c in '\n\t'))[:cap]
def exact(v, cap=600):
    if not isinstance(v,str) or not v or len(v)>cap or any(ord(c)<32 for c in v):
        raise ObservationError('upstream_invalid')
    return v

def number(v, default=0):
    if v is None: return default
    if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 or v>1e12:
        raise ObservationError('upstream_invalid')
    return int(v)

def rows(raw,key,limit):
    value=raw.get(key)
    if not isinstance(value,list) or len(value)>limit or any(not isinstance(v,dict) for v in value):
        raise ObservationError('upstream_invalid')
    return value

def unique(values, key):
    ids=[v[key] for v in values]
    if len(ids)!=len(set(ids)): raise ObservationError('upstream_invalid')

def coverage(raw, key, returned):
    total=number(raw.get(key))
    if total<returned or not isinstance(raw.get('truncated'),bool) or (total>returned and raw['truncated'] is not True):
        raise ObservationError('upstream_invalid')
    return {'returned':returned,'total':total,'truncated':raw['truncated'],'native_paging':False}

def selection(project='',session='',query=''):
    if not all(isinstance(x,str) for x in (project,session,query)) or len(project)>512 or len(query)>200 or any(ord(c)<32 for c in project+query):
        raise ObservationError('invalid_request')
    if session and (not project or not SESSION_RE.fullmatch(session)):
        raise ObservationError('invalid_request')
    return {'project':project,'session':session,'query':query}

def view_key(select):
    return hashlib.sha256(json.dumps(select,sort_keys=True).encode()).hexdigest()[:24]

def project_row(p):
    return {'id':exact(p.get('id'),512),'name':text(p.get('name'),200,'未命名项目'),'path':text(p.get('path'),2048,'路径未提供'),'enabled':True,'connected':p.get('connected') is True}

def session_row(s,pid):
    sid=exact(s.get('session_id'),128)
    if not SESSION_RE.fullmatch(sid): raise ObservationError('upstream_invalid')
    return {'id':sid,'project_id':pid,'title':text(s.get('title'),500),'lifecycle':s.get('lifecycle') if s.get('lifecycle') in ('active','closed') else 'unknown',
        'counts':{'tool_calls':0,'succeeded':0,'failed':0},'counts_available':False,
        'events':[],'events_total':0,'events_truncated':False,
        'activities':[],'activities_loaded':False,'activity_total':0,'activity_truncated':False,
        'updated_at':number(s.get('updated_at')),'running_call':s.get('running_call') is True,
        'running_jobs':number(s.get('running_jobs')),'running_jobs_complete':s.get('running_jobs_complete') is True}

def attach_detail(row,d):
    if d.get('session_id')!=row['id']: raise ObservationError('upstream_invalid')
    activity=[]
    for item in rows(d,'activity',200):
        code=item.get('exit_code')
        if code is not None and (not isinstance(code,int) or isinstance(code,bool) or abs(code)>=2**32): raise ObservationError('upstream_invalid')
        paths=item.get('paths',[])
        if not isinstance(paths,list) or len(paths)>8: raise ObservationError('upstream_invalid')
        activity.append({'kind':text(item.get('kind'),80),'tool':text(item.get('tool'),120),
            'state':text(item.get('state'),80,'unknown'),'execution_state':text(item.get('execution_state'),80),
            'job_handoff':item.get('job_handoff') is True,'started_at':number(item.get('started_at')),
            'finished_at':number(item.get('finished_at'),None),'duration_ms':number(item.get('duration_ms'),None),
            'exit_code':code,'job_id':text(item.get('job_id'),128),'summary':text(item.get('summary'),500),
            'paths':[text(p,2048) for p in paths],'group_count':number(item.get('group_count'),None)})
    total=number(d.get('activity_total'))
    if total<len(activity) or number(d.get('activity_returned'))!=len(activity) or (total>len(activity) and d.get('activity_truncated') is not True):
        raise ObservationError('upstream_invalid')
    row.update(activities=activity,activities_loaded=True,activity_total=total,activity_truncated=d.get('activity_truncated') is True,
               running_call=d.get('running_call') is True, running_jobs=number(d.get('running_jobs')),updated_at=number(d.get('updated_at')))

@dataclass
class Slot:
    lock: threading.Lock = field(default_factory=threading.Lock)
    # Cache eviction destroys the baseline. A recreated slot must never reuse
    # a revision token still held by an older browser view (the ABA problem).
    incarnation: str = field(default_factory=lambda: uuid.uuid4().hex)
    data: dict|None = None
    checked_at: str|None = None
    observed_at: str|None = None
    deadline: float = 0
    fresh_time: float = 0
    revision: int = 0
    digest: str = ''
    error: str|None = None
    retry_after: float = 5
    failures: int = 0

class Observer:
    def __init__(self, transport: Transport|None, *, cache_secs=4.5, cycle_budget=22):
        self.transport=transport
        self.epoch=uuid.uuid4().hex
        self.cache_secs=cache_secs
        self.cycle_budget=cycle_budget
        self.slots=OrderedDict()
        self.guard=threading.RLock()
        self.capacity=threading.BoundedSemaphore(2)
        self.auth_blocked=False

    def info(self):
        return {'configured':self.transport is not None,'adapter':'webcodex-console-v041',
                'connection_id':self.transport.namespace if self.transport else None,'epoch':self.epoch,
                'read_only':True,'automatic_actions':False,'refresh_ms':5000,
                'note':SAFE_MESSAGES['not_configured'] if not self.transport else '本机运行凭据由服务持有；不是OpenAI账号认证。'}

    def _collect(self, sel):
        t=self.transport; end=time.monotonic()+self.cycle_budget
        status=t.post('status',{'compact':True,**({'client_id':t.client_id} if t.client_id else {})},end)
        if status.get('service')!='webcodex' or status.get('version')!='0.4.1': raise ObservationError('incompatible_version')
        p=t.post('projects',{'limit':100,**({'client_id':t.client_id} if t.client_id else {}),**({'query':sel['query']} if sel['query'] else {})},end)
        projects=[project_row(x) for x in rows(p,'projects',100)];unique(projects,'id');pc=coverage(p,'total',len(projects))
        # Query narrowing is a view constraint, never an implicit authorization expansion.
        if sel['project'] and not any(x['id']==sel['project'] for x in projects):raise ObservationError('not_found')
        sessions=[];jobs=[];sc=None;jc=None
        if sel['project']:
            pid=sel['project'];s=t.post('sessions',{'project':pid,'limit':50},end)
            sessions=[session_row(x,pid) for x in rows(s,'sessions',50)];unique(sessions,'id');sc=coverage(s,'total',len(sessions))
            if number(s.get('returned'))!=len(sessions):raise ObservationError('upstream_invalid')
            if sel['session']:
                d=t.post('detail',{'project':pid,'session_id':sel['session'],'limit':200},end)
                row=next((x for x in sessions if x['id']==sel['session']),None)
                if row is None:
                    row=session_row(d,pid);sessions.append(row)
                    sc['exact_lookup_extra']=1
                attach_detail(row,d)
            j=t.post('jobs',{'project':pid,'limit':100},end)
            seen={s['id'] for s in sessions}
            for item in rows(j,'jobs',100):
                if item.get('project')!=pid:raise ObservationError('upstream_invalid')
                owner=item.get('session_id')
                if owner is not None and not SESSION_RE.fullmatch(exact(owner,128)):raise ObservationError('upstream_invalid')
                code=item.get('exit_code')
                if code is not None and (not isinstance(code,int) or isinstance(code,bool) or abs(code)>=2**32):raise ObservationError('upstream_invalid')
                jobs.append({'id':exact(item.get('job_id'),128),'project_id':pid,'session_id':owner if owner in seen else None,
                    'owner_session_id':owner,'status':item.get('status') if item.get('status') in ('queued','running','completed','failed','cancelled') else 'unknown',
                    'exit_code':code,'elapsed_secs':number(item.get('elapsed_secs'),None)})
            unique(jobs,'id');jc=coverage(j,'matched_count',len(jobs))
        focus=status.get('focus') or {};concurrency=focus.get('job_concurrency') or {}
        data={'schema_version':1,'source':{'kind':'tool_observation','observed_at':utc(),'live':False,
            'scope':'正式只读HTTP；Project最新窗口≤100，选定Project Session≤50，确切详情≤200项活动，Job≤100；不同查询非事务快照。'},
            'runtime':{'id':t.namespace,'version':'0.4.1','runner_id':t.client_id or 'fleet',
                'runner_state':focus.get('status') if focus.get('status') in ('online','offline') else 'unknown','job_capacity':number(concurrency.get('limit'),None)},
            'projects':projects,'sessions':sessions,'jobs':jobs}
        covered={'projects':pc,'sessions':sc,'jobs':jc,'detail_session':sel['session'] or None,
            'semantics':'latest_window_replacement','native_event_cursor':False,'all_chat_transcripts':False}
        if len(json.dumps(data,ensure_ascii=False).encode())>MAX_BODY:raise ObservationError('upstream_invalid')
        return data,covered

    def state(self, project='', session='', query='', after=''):
        sel=selection(project,session,query);key=view_key(sel)
        if not isinstance(after,str) or len(after)>120:raise ObservationError('invalid_request')
        if self.transport is None:
            return {'schema_version':1,'selection':sel,'state':'not_configured','error_code':'not_configured','message':SAFE_MESSAGES['not_configured'],'projection':None,'unchanged':False}
        with self.guard:
            if key not in self.slots:
                if len(self.slots)>=24:
                    disposable=next((k for k,v in self.slots.items() if not v.lock.locked()),None)
                    if disposable is None:raise ObservationError('busy')
                    self.slots.pop(disposable)
                self.slots[key]=Slot()
            slot=self.slots[key];self.slots.move_to_end(key)
        if not self.auth_blocked and time.monotonic()>=slot.deadline and slot.lock.acquire(blocking=False):
            try:
                if not self.capacity.acquire(blocking=False):
                    slot.error='busy';slot.deadline=time.monotonic()+1
                else:
                    try:
                        try:data,covered=self._collect(sel)
                        except (ValueError,TypeError,KeyError,AttributeError,OverflowError,RecursionError):
                            raise ObservationError('upstream_invalid') from None
                        with self.guard:
                            if not self.auth_blocked:
                                fingerprint={'data':data,'coverage':covered}
                                fingerprint['data']['source'].pop('observed_at')
                                digest=hashlib.sha256(json.dumps(fingerprint,sort_keys=True).encode()).hexdigest()
                                data['source']['observed_at']=utc()
                                if digest!=slot.digest:slot.revision+=1;slot.digest=digest
                                slot.data={'projection':data,'coverage':covered};slot.observed_at=data['source']['observed_at'];slot.fresh_time=time.monotonic();slot.error=None;slot.failures=0;slot.retry_after=5
                    except ObservationError as exc:
                        with self.guard:
                            slot.error=exc.code;slot.failures+=1;slot.retry_after=max(min(60,5*2**min(4,slot.failures-1)),exc.retry_after)
                            if exc.code in ('auth_required','access_denied','not_found','incompatible_version','upstream_invalid','redirect_rejected'):
                                slot.data=None;slot.digest='';slot.revision+=1
                            if exc.code=='auth_required':
                                self.auth_blocked=True
                                for other in self.slots.values():other.data=None;other.digest='';other.revision+=1;other.error='auth_required'
                    finally:self.capacity.release()
                slot.checked_at=utc();slot.deadline=time.monotonic()+(slot.retry_after if slot.error else self.cache_secs)
            finally:slot.lock.release()
        with self.guard:
            blocked=self.auth_blocked;code='auth_required' if blocked else slot.error
            state='auth_required' if blocked else ('connecting' if slot.data is None and not code else ('stale' if slot.data is not None and code else (code or 'connected')))
            token=f'{self.epoch}:{key}:{slot.incarnation}:{slot.revision}'
            unchanged=not code and slot.data is not None and after==token
            result={'schema_version':1,'connection_id':self.transport.namespace,'epoch':self.epoch,'selection':sel,'view_key':key,'revision':token,
                'state':state,'error_code':code,'message':SAFE_MESSAGES.get(code,'正式只读观测；不等于模型在线。'),
                'observed_at':slot.observed_at,'checked_at':slot.checked_at,'age_ms':int(max(0,time.monotonic()-slot.fresh_time)*1000) if slot.fresh_time else None,
                'refresh_after_ms':int(max(1.0,slot.deadline-time.monotonic())*1000),
                'updating':slot.lock.locked(),'unchanged':unchanged,'projection':None,'coverage':slot.data['coverage'] if slot.data else None}
            if slot.data and not unchanged and not blocked:result['projection']=slot.data['projection']
            # This exact view alone is returned. Neither stale mode nor IDs broaden access.
            return result
