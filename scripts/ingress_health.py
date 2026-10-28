"""Explicit, non-secret tunnel health references. GET-only, loopback-only, never a proxy."""
from __future__ import annotations
from copy import deepcopy
from pathlib import Path
from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request
from urllib.error import HTTPError, URLError
import json, math, re, threading, time
from task_domain import bounded, obj, txt, fail, fingerprint, now

MAX_METRICS=2*1024*1024
TUNNEL=re.compile(r'tunnel_[a-f0-9]{32}\Z')
SOURCE=re.compile(r'[a-zA-Z][a-zA-Z0-9_-]{0,63}\Z')
URL=re.compile(r'http://127\.0\.0\.1:([1-9][0-9]{0,4})/?\Z')
LABEL=re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"')
METRIC=re.compile(r'([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+[^\s]+)?\Z')
NAMES={'commands_poll_last_successful_timestamp_seconds','process_start_time_seconds','commands_poll_cycles_total','commands_poll_errors_total','liveness','readiness','proxy_health_state','command_end_to_end_latency_milliseconds_count'}

class ProbeError(ValueError):pass

def origin(value):
    m=URL.fullmatch(value) if isinstance(value,str) else None
    if not m or int(m[1])>65535:raise ProbeError('invalid_health_origin')
    return value.rstrip('/')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ProbeError('redirect_rejected')

def http_get(base,path,cap=MAX_METRICS,timeout=2):
    if path not in {'/healthz','/readyz','/metrics'}:raise ProbeError('invalid_health_route')
    opener=build_opener(ProxyHandler({}),NoRedirect())
    request=Request(origin(base)+path,headers={'Accept':'text/plain','User-Agent':'CLW-Ingress-Observer/1'})
    deadline=time.monotonic()+timeout
    try:
        response=opener.open(request,timeout=timeout)
    except HTTPError as exc:
        response=exc
    except ProbeError:raise
    except (URLError,OSError,TimeoutError):raise ProbeError('endpoint_unreachable') from None
    try:
        with response:
            if response.headers.get('Content-Encoding') not in (None,'identity'):raise ProbeError('unexpected_encoding')
            chunks=[];size=0
            while True:
                if time.monotonic()>deadline:raise ProbeError('health_deadline')
                part=response.read1(min(65536,cap+1-size))
                if not part:break
                chunks.append(part);size+=len(part)
                if size>cap:raise ProbeError('health_response_too_large')
            data=b''.join(chunks)
            return response.status,data.decode('utf-8',errors='strict')
    except UnicodeError:raise ProbeError('invalid_health_encoding') from None

def parse_metrics(body,expected_tunnel,clock):
    if not isinstance(body,str) or len(body.encode('utf-8'))>MAX_METRICS:raise ProbeError('metrics_too_large')
    records=[];ids=set()
    for line in body.splitlines():
        if not line or line.startswith('#'):continue
        if len(line)>8192:raise ProbeError('metric_line_too_long')
        m=METRIC.fullmatch(line)
        if not m:raise ProbeError('malformed_metrics')
        labels={};raw=m[2] or '';pos=0
        for lm in LABEL.finditer(raw):
            if raw[pos:lm.start()] not in ('',','):raise ProbeError('malformed_labels')
            if lm[1] in labels:raise ProbeError('duplicate_label')
            try:labels[lm[1]]=json.loads('"'+lm[2]+'"')
            except ValueError:raise ProbeError('malformed_labels') from None
            pos=lm.end()
        if raw[pos:]:raise ProbeError('malformed_labels')
        if 'tunnel_id' in labels:
            if not TUNNEL.fullmatch(labels['tunnel_id']):raise ProbeError('invalid_tunnel_label')
            ids.add(labels['tunnel_id'])
        if m[1] not in NAMES:continue
        try:value=float(m[3])
        except ValueError:raise ProbeError('invalid_metric_value') from None
        if not math.isfinite(value) or value<0 or value>1e16:raise ProbeError('invalid_metric_value')
        records.append((m[1],labels,value))
    if ids and ids!={expected_tunnel}:raise ProbeError('tunnel_identity_mismatch')
    def single(name):
        values=[v for n,l,v in records if n==name]
        if len(values)>1:raise ProbeError('ambiguous_metric')
        return values[0] if values else None
    start=single('process_start_time_seconds');poll=single('commands_poll_last_successful_timestamp_seconds')
    if start is not None and (start<=0 or start>clock+5):raise ProbeError('clock_invalid')
    if poll is not None and (poll>clock+5 or (poll>0 and start is not None and poll<start-5)):raise ProbeError('clock_invalid')
    cycles=single('commands_poll_cycles_total')
    errors=[v for n,l,v in records if n=='commands_poll_errors_total']
    discovery=sum(v for n,l,v in records if n=='command_end_to_end_latency_milliseconds_count' and l.get('tunnel_id')==expected_tunnel and l.get('request_method')=='tools/list' and l.get('tunnel_service_status')=='200')
    return {'tunnel_identity':'metric_match' if ids else 'not_observed','process_started_at':start,'last_poll_at':poll if poll and poll>0 else None,'poll_cycles':cycles,'poll_errors':sum(errors) if errors else None,'tools_list_http_200':discovery if discovery else None,'liveness_metric':single('liveness'),'readiness_metric':single('readiness')}

class IngressSources:
    def __init__(self,entries=()):
        self.entries={}
        for raw in entries:
            bounded(raw);obj(raw,{'id','name','tunnel_id','health_url_file','connection_id','backend_note','proxy_note'},{'id','name','tunnel_id','health_url_file','connection_id'})
            item={k:txt(raw.get(k,''),k,2048 if k=='health_url_file' else 300,k not in ('backend_note','proxy_note')) for k in ('id','name','tunnel_id','health_url_file','connection_id','backend_note','proxy_note')}
            if not SOURCE.fullmatch(item['id']) or not TUNNEL.fullmatch(item['tunnel_id']):fail('source','入口ID无效')
            ref=Path(item['health_url_file'])
            if not ref.is_absolute() or ref.name not in {'health-url.txt','openai-tunnel-health-url','health.url'}:fail('source','只接受明确的绝对健康URL文件引用，不读取其他配置')
            item['health_url_file']=str(ref);item['fingerprint']=fingerprint(item)
            if item['id'] in self.entries or any(e['tunnel_id']==item['tunnel_id'] for e in self.entries.values()):fail('duplicate','入口或Tunnel重复')
            self.entries[item['id']]=item
        if len(self.entries)>16:fail('capacity','本版最多16个明确入口')
    @classmethod
    def load(cls,path):
        path=Path(path)
        if not path.exists():return cls()
        if path.stat().st_size>65536:fail('source','入口引用配置过大')
        raw=json.loads(path.read_text(encoding='utf-8-sig'));bounded(raw);obj(raw,{'schema_version','sources'},{'schema_version','sources'})
        if raw['schema_version']!=1 or not isinstance(raw['sources'],list):fail('source','入口引用格式不支持')
        return cls(raw['sources'])
    def get(self,sid):
        if not isinstance(sid,str) or sid not in self.entries:fail('source','入口未由本机配置，不能提供任意URL或路径',404)
        return deepcopy(self.entries[sid])
    def public(self):
        return [{k:v for k,v in e.items() if k!='health_url_file'} for e in self.entries.values()]

class IngressHealth:
    def __init__(self,sources,getter=http_get,clock=time.time,cache_secs=5):
        self.sources=sources;self.getter=getter;self.clock=clock;self.cache_secs=cache_secs
        self.lock=threading.Lock();self.slots={};self.capacity=threading.BoundedSemaphore(2)
    def _probe(self,e):
        result={'source_id':e['id'],'source_fingerprint':e['fingerprint'],'expected_tunnel_id':e['tunnel_id'],'checked_at':now(),'checked_epoch':self.clock(),'health_live':None,'health_ready':None,'state':'unknown','error_code':None,'tunnel_identity':'not_observed','mcp_target_state':'not_independently_observed','account_authentication':False,'process_pid':None}
        try:
            p=Path(e['health_url_file'])
            if not p.is_file():raise ProbeError('health_reference_missing')
            with p.open('rb') as f:raw=f.read(257)
            if len(raw)>256:raise ProbeError('health_reference_invalid')
            base=origin(raw.decode('utf-8-sig').strip())
            # Endpoint and identity are evaluated on this same bounded observation.
            a,body=self.getter(base,'/healthz',256);result['health_live']=a==200 and body.strip()=='live'
            b,body=self.getter(base,'/readyz',256);result['health_ready']=b==200 and body.strip()=='ready'
            c,body=self.getter(base,'/metrics',MAX_METRICS)
            if c!=200:raise ProbeError('metrics_unavailable')
            result.update(parse_metrics(body,e['tunnel_id'],self.clock()))
            with p.open('rb') as f:after=f.read(257)
            if raw!=after:raise ProbeError('health_reference_changed')
            result['endpoint']=base;result['process_fingerprint']=fingerprint([base,result['process_started_at']]) if result['process_started_at'] else None
        except ProbeError as exc:result['error_code']=str(exc)
        except (OSError,UnicodeError,ValueError):result['error_code']='health_reference_invalid'
        return result
    def _view(self,result):
        r=deepcopy(result);clock=self.clock();r['observation_age_secs']=max(0,clock-r['checked_epoch']);poll=r.get('last_poll_at');r['poll_age_secs']=max(0,clock-poll) if poll else None
        if r['error_code']:r['state']='unavailable'
        elif r['observation_age_secs']>15:r['state']='observation_stale'
        elif r.get('tunnel_identity')!='metric_match' or not r.get('process_started_at'):r['state']='identity_unverified'
        elif not r['health_live'] or not r['health_ready']:r['state']='local_not_ready'
        elif not poll:r['state']='poll_not_seen'
        elif r['poll_age_secs']>90:r['state']='poll_stale'
        else:r['state']='polling'
        r['refresh_ms']=5000;return r
    def observe(self,sid):
        e=self.sources.get(sid)
        with self.lock:slot=self.slots.setdefault((sid,e['fingerprint']),{'lock':threading.Lock(),'result':None,'deadline':0})
        if time.monotonic()>=slot['deadline'] and slot['lock'].acquire(False):
            try:
                if self.capacity.acquire(False):
                    try:
                        value=self._probe(e)
                        with self.lock:slot['result']=value;slot['deadline']=time.monotonic()+self.cache_secs
                    finally:self.capacity.release()
            finally:slot['lock'].release()
        with self.lock:value=deepcopy(slot['result'])
        if value is None:return {'state':'checking','source_id':sid,'source_fingerprint':e['fingerprint'],'refresh_ms':5000,'account_authentication':False}
        return self._view(value)
