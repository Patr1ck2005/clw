from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import copy,hashlib,json,sqlite3,sys,tempfile,unittest,uuid
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from account_store import AccountStore
from ingress_health import IngressSources
from task_domain import TaskError
from task_store import TaskStore
from account_fixture import Observe,Health,source_entries,P1,P2,S1,S2,CONNECTION

class AccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'accounts.sqlite3';self.sources=IngressSources(source_entries(self.tmp.name));self.observer=Observe();self.health=Health();self.store=AccountStore(self.path,self.sources,self.observer,self.health)
    def tearDown(self):self.tmp.cleanup()
    def cmd(self,action,data,a=None,rid=None):
        raw={'request_id':rid or str(uuid.uuid4()),'action':action,'actor':'操作者','data':data}
        if a:raw.update(account_id=a['id'],expected_version=a['version'])
        return self.store.command(raw)['account']
    def create(self,src='A'):return self.cmd('create',{'source_id':src,'name':'账号'+src,'browser_hint':'浏览器'+src,'notes':'操作者声明'})
    def binding_data(self,project=P1,session=S1):return {'project_id':project,'session_id':session,'connection_id':CONNECTION,'role':'M','notes':'从账号该对话核对到ID','confirmed':True}
    def bind(self,a=None):return self.cmd('bind',self.binding_data(),a or self.create())
    def test_profile_and_binding_persist_after_reopen(self):
        a=self.bind();s=AccountStore(self.path,self.sources,self.observer,self.health);self.assertEqual(s.get(a['id']),a);self.assertEqual(s.store_id,self.store.store_id);self.assertEqual(len(s.bindings(a['id'])),1)
    def test_source_account_and_session_are_not_authentication(self):
        a=self.bind();b=self.store.bindings(a['id'])[0];self.assertEqual(a['identity_source'],'local_operator_profile_not_openai_auth');self.assertEqual(b['attribution'],'operator_confirmed_not_ingress_proof')
    def test_no_automatic_binding_on_discovery(self):
        a=self.create();self.store.inspect(a['id'],P1);self.assertEqual(self.store.bindings(a['id']),[])
    def test_same_request_persists_only_once(self):
        rid=str(uuid.uuid4());data={'source_id':'A','name':'A','browser_hint':'','notes':''};a=self.cmd('create',data,rid=rid);b=self.cmd('create',data,rid=rid);self.assertEqual(a,b);self.assertEqual(len(self.store.history(a['id'])['events']),1)
    def test_lost_reply_can_query_receipt(self):
        rid=str(uuid.uuid4());self.cmd('create',{'source_id':'A','name':'A','browser_hint':'','notes':''},rid=rid);self.assertTrue(self.store.receipt(rid)['found'])
    def test_same_id_different_params_rejected(self):
        rid=str(uuid.uuid4());data={'source_id':'A','name':'A','browser_hint':'','notes':''};self.cmd('create',data,rid=rid)
        with self.assertRaises(TaskError) as e:self.cmd('create',data|{'name':'changed'},rid=rid)
        self.assertEqual(e.exception.code,'request_conflict')
    def test_duplicate_source_rejected(self):
        self.create()
        with self.assertRaises(TaskError):self.create()
    def test_bind_cannot_steal_other_account(self):
        a=self.bind();b=self.create('B')
        with self.assertRaises(TaskError) as e:self.cmd('bind',self.binding_data(),b)
        self.assertEqual(e.exception.code,'binding_conflict');self.assertEqual(len(self.store.bindings(a['id'])),1)
    def test_explicit_unbind_allows_later_reassignment(self):
        a=self.bind();bid=self.store.bindings(a['id'])[0]['id'];self.cmd('unbind',{'binding_id':bid,'reason':'已明确交接'},a);b=self.cmd('bind',self.binding_data(),self.create('B'));self.assertEqual(len(self.store.bindings(b['id'])),1)
    def test_boolean_confirmation_required(self):
        a=self.create()
        with self.assertRaises(TaskError):self.cmd('bind',self.binding_data()|{'confirmed':False},a)
        self.assertEqual(self.observer.calls,[])
    def test_cross_project_session_rejected(self):
        a=self.create()
        with self.assertRaises(TaskError):self.cmd('bind',self.binding_data(P1,S2),a)
    def test_cross_backend_rejected(self):
        a=self.create();self.observer.connection='other'
        with self.assertRaises(TaskError):self.cmd('bind',self.binding_data(),a)
    def test_stale_observation_is_not_binding_evidence(self):
        a=self.create();self.observer.state_name='stale'
        with self.assertRaises(TaskError):self.cmd('bind',self.binding_data(),a)
    def test_auth_denied_does_not_expose_old_activity(self):
        a=self.bind();bid=self.store.bindings(a['id'])[0]['id'];self.observer.denied=True
        with self.assertRaises(TaskError):self.store.activity(a['id'],bid)
    def test_two_accounts_have_independent_session_views(self):
        a=self.bind();b=self.cmd('bind',self.binding_data(P2,S2),self.create('B'));ab=self.store.bindings(a['id'])[0];bb=self.store.bindings(b['id'])[0]
        self.assertEqual(self.store.activity(a['id'],ab['id'])['session']['id'],S1)
        self.assertEqual(self.store.activity(b['id'],bb['id'])['session']['id'],S2)
        with self.assertRaises(TaskError):self.store.activity(b['id'],ab['id'])
    def test_counts_are_registered_subset_not_platform_count(self):
        a=self.bind();d=self.store.dashboard(a['id']);self.assertIsNone(d['all_conversation_count']);self.assertEqual(d['model_state'],'unobserved')
    def test_archive_does_not_stop_anything_and_retains_bindings(self):
        a=self.bind();a=self.cmd('archive',{'reason':'本地整理'},a);self.assertEqual(self.store.dashboard(a['id'])['health']['state'],'archived');self.assertEqual(self.health.calls,[]);self.assertEqual(len(self.store.bindings(a['id'])),1)
        with self.assertRaises(TaskError):self.store.inspect(a['id'],P1)
        a=self.cmd('restore',{'reason':'恢复本地记录'},a);self.assertFalse(a['archived'])
    def test_concurrent_update_refuses_stale_version(self):
        a=self.create();d={'name':'new','browser_hint':'b','notes':'n'};b=self.cmd('update',d,a)
        with self.assertRaises(TaskError):self.cmd('update',d|{'name':'lost'},a)
        self.assertEqual(self.store.get(a['id']),b)
    def test_concurrent_same_request_creates_one_row(self):
        rid=str(uuid.uuid4());d={'source_id':'A','name':'A','browser_hint':'','notes':''}
        with ThreadPoolExecutor(4) as pool:values=list(pool.map(lambda _:self.cmd('create',d,rid=rid),range(4)))
        self.assertEqual(len({a['id'] for a in values}),1)
    def test_changed_source_requires_reconfirmation_and_rebinding(self):
        a=self.bind();bid=self.store.bindings(a['id'])[0]['id'];entries=source_entries(self.tmp.name);entries[0]['backend_note']='changed';self.store.sources=IngressSources(entries)
        self.assertFalse(self.store.dashboard(a['id'])['bindings'][0]['source_current'])
        with self.assertRaises(TaskError):self.store.activity(a['id'],bid)
        a=self.cmd('reconfirm_source',{'confirmed':True,'reason':'核对了新引用'},a)
        with self.assertRaises(TaskError):self.store.activity(a['id'],bid)
        self.cmd('bind',self.binding_data(),a);self.assertEqual(self.store.activity(a['id'],bid)['session']['id'],S1)
    def test_foreign_database_not_reused(self):
        p=Path(self.tmp.name)/'foreign.sqlite';db=sqlite3.connect(p);db.execute('CREATE TABLE secret_data(x)');db.commit();db.close();before=hashlib.sha256(p.read_bytes()).digest()
        with self.assertRaises(TaskError):AccountStore(p,self.sources)
        self.assertEqual(hashlib.sha256(p.read_bytes()).digest(),before)
    def test_secret_fields_and_prototype_rejected(self):
        for key in ['api_key','cookie','__proto__']:
            with self.assertRaises(TaskError):self.cmd('create',{'source_id':'A','name':'A','browser_hint':'','notes':'',key:'x'})
    def test_export_is_metadata_without_source_path(self):
        self.bind();s=json.dumps(self.store.export());self.assertNotIn('health_url_file',s);self.assertNotIn(self.tmp.name,s);self.assertIn('no credentials',s)
    def test_history_paging_keeps_chronology(self):
        a=self.create()
        for i in range(51):a=self.cmd('update',{'name':'A'+str(i),'browser_hint':'','notes':''},a)
        r=self.store.history(a['id']);self.assertEqual(len(r['events']),50);self.assertEqual(len(self.store.history(a['id'],r['next_after'])['events']),2)
    def test_unknown_model_or_process_action_rejected(self):
        a=self.create()
        for action in ['start','stop','switch_model','authorize']:
            with self.assertRaises(TaskError):self.cmd(action,{},a)
    def test_repeated_bind_same_owner_updates_existing_record(self):
        a=self.bind();before=self.store.bindings(a['id'])[0]['id'];self.cmd('bind',self.binding_data()|{'role':'review'},a);self.assertEqual(self.store.bindings(a['id'])[0]['id'],before);self.assertEqual(len(self.store.bindings(a['id'])),1)
    def test_matching_existing_task_role_is_observed_not_modified(self):
        from test_task_store import example
        tasks=TaskStore(Path(self.tmp.name)/'tasks.sqlite3',self.observer);self.store.tasks=tasks;c=example('web',path='D:/sandbox/p1');c['roles'][0]['project_id']=P1
        t=None
        for action,data in [('create',{'contract':c}),('publish',{}),('bind',{'role_id':'A','session_id':S1,'connection_id':CONNECTION})]:
            raw={'request_id':str(uuid.uuid4()),'action':action,'actor':'test','data':data}
            if t:raw.update(task_id=t['id'],expected_version=t['version'])
            t=tasks.command(raw)['task']
        before=tasks.get(t['id']);a=self.bind();bid=self.store.bindings(a['id'])[0]['id'];view=self.store.activity(a['id'],bid)
        self.assertEqual(view['tasks'][0]['task_id'],t['id']);self.assertEqual(view['tasks'][0]['role'],'A');self.assertEqual(tasks.get(t['id']),before)
if __name__=='__main__':unittest.main(verbosity=2)
