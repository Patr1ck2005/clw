from copy import deepcopy
from pathlib import Path
import time
from ingress_health import IngressSources
from live_transport import ObservationError

T1='tunnel_'+('a'*32);T2='tunnel_'+('b'*32)
P1='agent:test:p1';P2='agent:test:p2';S1='wc_sess_test_a';S2='wc_sess_test_b';CONNECTION='wc-live-account-fixture'
def source_entries(root):
    entries=[]
    for id,tunnel in [('A',T1),('B',T2)]:
        p=Path(root)/id/'health-url.txt';p.parent.mkdir(parents=True,exist_ok=True);p.write_text('http://127.0.0.1:45678')
        entries.append({'id':id,'name':'入口'+id,'tunnel_id':tunnel,'health_url_file':str(p.resolve()),'connection_id':CONNECTION,'backend_note':'same test backend','proxy_note':'operator description only'})
    return entries

def metrics(tunnel=T1,clock=None,poll=True):
    clock=clock or time.time()
    return '\n'.join(['process_start_time_seconds '+str(clock-1000), 'liveness{otel_scope_name="health"} 1','readiness{otel_scope_name="health"} 1',
     'command_end_to_end_latency_milliseconds_count{request_method="tools/list",tunnel_id="'+tunnel+'",tunnel_service_status="200"} 2']+
     (['commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} '+str(clock-3)] if poll else []))+'\n'

class Observe:
    def __init__(self):self.calls=[];self.state_name='connected';self.connection=CONNECTION;self.denied=False
    def info(self):return {'configured':True,'connection_id':self.connection}
    def state(self,project='',session='',**kwargs):
        self.calls.append((project,session))
        if self.denied:raise ObservationError('access_denied')
        projects=[{'id':P1,'name':'项目甲','path':'D:/sandbox/p1','enabled':True},{'id':P2,'name':'项目乙','path':'D:/sandbox/p2','enabled':True}]
        sessions=[]
        for p,s,title in [(P1,S1,'A 独立实现'),(P2,S2,'B 独立审查')]:
            if project!=p:continue
            sessions.append({'id':s,'project_id':p,'title':title,'lifecycle':'active','running_call':False,'running_jobs':0,'activities':[{'kind':'tool','tool':'read_files','state':'succeeded','execution_state':'completed','duration_ms':15,'exit_code':0,'job_id':'job-'+s,'paths':['README.md'],'started_at':1789966000}], 'activities_loaded':bool(session),'activity_total':1,'activity_truncated':False})
        jobs=[{'id':'job-'+s['id'],'project_id':project,'session_id':s['id'],'owner_session_id':s['id'],'status':'completed','exit_code':0} for s in sessions]
        return {'state':self.state_name,'connection_id':self.connection,'observed_at':'2026-09-21T00:00:00Z','coverage':{'sessions':{'returned':len(sessions),'total':len(sessions),'truncated':False},'jobs':{'returned':len(jobs),'truncated':False}},'projection':{'projects':projects,'sessions':sessions,'jobs':jobs}}
class Health:
    def __init__(self):self.state_name='polling';self.calls=[]
    def observe(self,id):
        self.calls.append(id);return {'source_id':id,'state':self.state_name,'checked_at':'2026-09-21T00:00:00Z','health_live':True,'health_ready':True,'poll_age_secs':3,'tunnel_identity':'metric_match','process_started_at':1789965000,'account_authentication':False}
