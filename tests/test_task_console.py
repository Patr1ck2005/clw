"""Coordinator CLI isolated metadata and recovery tests; not an actual AI coordinator."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_store import TaskStore
from serve_control_center import create_server
from task_worker import Client, WorkerError, save_new, load
from task_console import prepare, send, reconcile
from task_domain import fingerprint, TaskError
from test_task_store import example


class ConsoleTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.local').mkdir(exist_ok=True);self.temp=tempfile.TemporaryDirectory(prefix='g1-console-',dir=ROOT/'.local');self.root=Path(self.temp.name)
        self.store=TaskStore(self.root/'db/tasks.sqlite3');self.server=create_server(task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_address[1]}';self.client=Client(self.origin,self.store.store_id)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def raw(self):return {'action':'create','actor':'B-declared-coordinator','data':{'contract':example(path=str(self.root))}}
    def cli(self,*args):
        env=dict(os.environ,PYTHONUTF8='1');env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
        return subprocess.run([sys.executable,'-B','scripts/task_console.py',*args],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',timeout=20)
    def common(self):return ['--origin',self.origin,'--store-id',self.store.store_id,'--root',str(self.root)]
    def test_cli_prepare_does_not_send_then_same_envelope_recovers(self):
        save_new(self.root,'input.json',self.raw());r=self.cli('prepare',*self.common(),'--input','input.json','--out','request.json');self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertEqual(self.store.listing()['tasks'],[])
        r=self.cli('send',*self.common(),'--envelope','request.json','--out','first.json');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        r=self.cli('send',*self.common(),'--envelope','request.json','--out','recovered.json');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertTrue(load(self.root,'recovered.json')['found']);self.assertEqual(len(self.store.listing()['tasks']),1)
    def test_read_snapshot_contains_current_version_without_csrf(self):
        r=self.cli('read',*self.common(),'--route','info','--out','info.json');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        value=load(self.root,'info.json');self.assertNotIn('intent',value);self.assertEqual(value['store_id'],self.store.store_id)
    def test_coordinator_enables_publishes_claims_and_records_feedback(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);t=send(self.client,e,self.root)['task']
        for action,data in [('collaborate',{'confirm_schema_upgrade':True}),('publish',{}),('claim',{'role_id':'A','external_ref':'fixture worker'}),('feedback',{'role_id':'A','scope':'local','note':'完整纳入新要求'})]:
            e=prepare({'action':action,'actor':'M','task_id':t['id'],'expected_version':t['version'],'data':data},self.origin,self.store.store_id,self.root)
            t=send(self.client,e,self.root)['task']
        self.assertEqual(t['roles']['A']['feedback_revision'],1);self.assertEqual(t['roles']['A']['status'],'running')
    def test_no_runtime_or_model_actions_in_console(self):
        for action in ('run_shell','specialist.start','deliver','tool','agent.create','restart'):
            with self.subTest(action=action),self.assertRaises(WorkerError):prepare({**self.raw(),'action':action},self.origin,self.store.store_id,self.root)
    def test_mutation_requires_exact_task_version_and_actor(self):
        for raw in ({'action':'publish','actor':'M','data':{}},{'action':'pause','actor':'','data':{}},{'action':'create','actor':'M','task_id':'external','data':{}}):
            with self.assertRaises((WorkerError,TaskError)):prepare(raw,self.origin,self.store.store_id,self.root)
    def test_unknown_request_can_be_queried_without_sending(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);self.assertFalse(reconcile(self.client,e,self.root)['found']);self.assertEqual(self.store.listing()['tasks'],[])
    def test_stale_coordinator_action_is_not_applied_to_new_version(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);t=send(self.client,e,self.root)['task']
        raw={'action':'publish','actor':'M','data':{},'task_id':t['id'],'expected_version':t['version']}
        a=prepare(raw,self.origin,self.store.store_id,self.root);b=prepare(raw,self.origin,self.store.store_id,self.root);send(self.client,a,self.root)
        with self.assertRaises(WorkerError):send(self.client,b,self.root)
        self.assertFalse(reconcile(self.client,b,self.root)['found']);self.assertEqual(self.store.get(t['id'])['version'],2)
    def test_original_fingerprint_conflict_is_not_success(self):
        a=prepare(self.raw(),self.origin,self.store.store_id,self.root);send(self.client,a,self.root)
        b=prepare(self.raw(),self.origin,self.store.store_id,self.root);b['command']['actor']='different';b['command']['request_id']=a['command']['request_id'];b['command_sha256']=fingerprint(b['command'])
        with self.assertRaises(WorkerError):send(self.client,b,self.root)
    def test_tampered_envelope_is_rejected_before_request(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);e['command']['actor']='changed'
        with patch.object(self.client,'request',wraps=self.client.request) as calls:
            with self.assertRaises(WorkerError):send(self.client,e,self.root)
        self.assertEqual(calls.call_count,0)
    def test_existing_response_output_prevents_new_send(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);save_new(self.root,'request.json',e);save_new(self.root,'response.json',{'original':'retain'})
        result=self.cli('send',*self.common(),'--envelope','request.json','--out','response.json');self.assertEqual(result.returncode,1);self.assertFalse(self.store.receipt(e['command']['request_id'])['found'])
        self.assertEqual(load(self.root,'response.json'),{'original':'retain'})
    def test_wrong_journal_root_does_not_send(self):
        e=prepare(self.raw(),self.origin,self.store.store_id,self.root);other=self.root/'other';other.mkdir()
        with self.assertRaises(WorkerError):send(self.client,e,other)
        self.assertEqual(self.store.listing()['tasks'],[])
    def test_cli_bad_read_parameters_and_newline_url_rejected(self):
        save_new(self.root,'params.json',{'file':'C:/outside'})
        r=self.cli('read',*self.common(),'--route','get','--params','params.json','--out','snapshot.json');self.assertEqual(r.returncode,1)
        with self.assertRaises(WorkerError):prepare(self.raw(),'http://127.0.0.1:123\n',self.store.store_id,self.root)

if __name__=='__main__':unittest.main(verbosity=2)
