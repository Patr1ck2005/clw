"""Real loopback HTTP, CLI subprocesses and explicit-root file checks; no real workers."""
from contextlib import closing
from pathlib import Path
import hashlib
import http.client
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from task_store import TaskStore
from task_domain import TaskError, absolute, fingerprint
from serve_control_center import create_server
from task_worker import Client, WorkerError, explicit_root, load, save_new, prepare, check_files, hash_files
from test_task_store import example


class WorkerTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.local').mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='g1-worker-',dir=ROOT/'.local');self.root=Path(self.temp.name)
        self.store=TaskStore(self.root/'db/tasks.sqlite3');self.server=create_server(task_store=self.store)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_address[1]}'
        self.client=Client(self.origin,self.store.store_id)
        (self.root/'results').mkdir();(self.root/'results/output.txt').write_bytes(b'content')
        self.t=self.command('create',data={'contract':example(ids=('A','B'),path=str(self.root))})
        self.t=self.command('collaborate',self.t,{'confirm_schema_upgrade':True});self.t=self.command('publish',self.t)
        for rid in ('A','B'):self.t=self.command('claim',self.t,{'role_id':rid,'external_ref':'fixture-'+rid})
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def command(self,action,t=None,data=None):
        r={'request_id':str(uuid.uuid4()),'action':action,'actor':'fixture M','data':data or {}}
        if t:r.update(task_id=t['id'],expected_version=t['version'])
        return self.store.command(r)['task']
    def result(self):return {'summary':'完成文件','changes':'隔离结果','tests':'fixture-only','limitations':'未用真实模型','input_baseline':'known input','head_commit':None,'account_label':'B declared fixture','original_jobs':[],'stopped_writing':True,'artifacts':['results/output.txt']}
    def envelope(self,rid='A'):
        p=self.client.get('assignment',{'id':self.t['id'],'role':rid})['assignment']
        return prepare(p,self.result(),self.root,self.origin,'fixture worker '+rid)
    def cli(self,*args):
        env=dict(os.environ,PYTHONUTF8='1');env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
        return subprocess.run([sys.executable,'-B','scripts/task_worker.py',*args],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',timeout=25)
    def common(self):return ['--origin',self.origin,'--store-id',self.store.store_id,'--root',str(self.root)]
    def test_cli_assignment_prepare_send_reconcile_and_check_files(self):
        result=self.cli('assignment',*self.common(),'--task',self.t['id'],'--role','A','--out','assignment.json');self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        save_new(self.root,'result.json',self.result())
        result=self.cli('prepare-delivery',*self.common(),'--packet','assignment.json','--result','result.json','--actor','B-worker-fixture','--out','delivery.json');self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        envelope=load(self.root,'delivery.json');self.assertFalse(self.store.receipt(envelope['command']['request_id'])['found'])
        result=self.cli('send',*self.common(),'--envelope','delivery.json');self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        again=self.cli('receipt',*self.common(),'--envelope','delivery.json');self.assertEqual(again.returncode,0,again.stdout+again.stderr);self.assertTrue(json.loads(again.stdout)['found'])
        checked=self.cli('check-artifacts','--root',str(self.root),'--envelope','delivery.json');self.assertEqual(checked.returncode,0,checked.stdout+checked.stderr)
        self.assertEqual(len(self.store.inbox()['items'][0]['items']),1)
    def test_real_two_cli_senders_share_parent_without_duplicate_work(self):
        save_new(self.root,'A.json',self.envelope('A'));save_new(self.root,'B.json',self.envelope('B'))
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda f:self.cli('send',*self.common(),'--envelope',f),['A.json','B.json']))
        for r in results:self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual(len(self.store.inbox()['items'][0]['items']),2)
    def test_lost_http_response_reconciles_original_fingerprint_without_repost(self):
        e=self.envelope();cmd=e['command'];conn=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=5)
        conn.request('POST','/api/tasks/command',body=json.dumps(cmd).encode(),headers={'Origin':self.origin,'Content-Type':'application/json','X-CLW-Intent':self.client.info['intent']})
        response=conn.getresponse();self.assertEqual(response.status,200);conn.close()  # deliberately discard body
        with patch.object(self.client,'request',wraps=self.client.request) as calls:
            reply=self.client.send(e,self.root)
        self.assertTrue(reply['found']);self.assertEqual([c.args[0] for c in calls.call_args_list],['receipt'])
        self.assertEqual(reply['receipt']['request_fingerprint'],fingerprint(cmd))
    def test_known_receipt_survives_later_file_changes(self):
        e=self.envelope();self.client.send(e,self.root);(self.root/'results/output.txt').write_text('new content')
        self.assertTrue(self.client.send(e,self.root)['found'])
    def test_unknown_result_with_changed_files_is_not_sent(self):
        e=self.envelope();(self.root/'results/output.txt').write_text('new content')
        with self.assertRaises(WorkerError):self.client.send(e,self.root)
        self.assertFalse(self.store.receipt(e['command']['request_id'])['found'])
    def test_wrong_store_does_not_send_or_adopt(self):
        before=self.store.get(self.t['id'])
        with self.assertRaises(WorkerError):Client(self.origin,'e'*32)
        self.assertEqual(self.store.get(self.t['id']),before)
    def test_changed_envelope_command_refused_before_network(self):
        e=self.envelope();e['command']['data']['summary']='tampered'
        with patch.object(self.client,'request',wraps=self.client.request) as calls:
            with self.assertRaises(WorkerError):self.client.send(e,self.root)
        self.assertEqual(calls.call_count,0)
    def test_reused_request_id_with_different_contents_is_not_mistaken_for_success(self):
        a=self.envelope();self.client.send(a,self.root);b=self.envelope('B');b['command']['request_id']=a['command']['request_id'];b['command_sha256']=fingerprint(b['command'])
        with self.assertRaises(WorkerError) as e:self.client.send(b,self.root)
        self.assertEqual(str(e.exception),'original_request_conflict_no_send')
    def test_stale_feedback_packet_does_not_release_role(self):
        e=self.envelope();t=self.command('feedback',self.t,{'role_id':'A','scope':'local','note':'用户追加意见'})
        with self.assertRaises(WorkerError):self.client.send(e,self.root)
        self.assertFalse(self.store.receipt(e['command']['request_id'])['found']);self.assertEqual(self.store.get(self.t['id']),t)
    def test_persistence_across_server_restart_and_receipt_query(self):
        e=self.envelope();first=self.client.send(e,self.root)
        self.server.shutdown();self.server.server_close();self.thread.join()
        self.store=TaskStore(self.store.path);self.server=create_server(port=int(self.origin.rsplit(':',1)[1]),task_store=self.store)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();new=Client(self.origin,self.store.store_id)
        self.assertNotEqual(self.client.info['intent'],new.info['intent']);self.assertEqual(new.reconcile(e)['receipt']['request_id'],first['request_id'])
    def test_no_cross_origin_or_stale_intent_write(self):
        e=self.envelope();base={'Content-Type':'application/json','Origin':self.origin,'X-CLW-Intent':self.client.info['intent']}
        for override in ({'Origin':'https://foreign.invalid'},{'X-CLW-Intent':'stale'}):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(self.origin+'/api/tasks/command',data=json.dumps(e['command']).encode(),headers={**base,**override}),timeout=5)
            self.assertEqual(error.exception.code,403);error.exception.close()
        self.assertFalse(self.store.receipt(e['command']['request_id'])['found'])
    def test_foreign_host_origin_and_credentials_in_url_rejected(self):
        for origin in ('https://127.0.0.1:123','http://localhost:123','http://127.0.0.1:123/','http://127.0.0.1:0','http://127.0.0.1:99999','http://user@127.0.0.1:123','http://example.com:123'):
            with self.subTest(origin=origin),self.assertRaises(WorkerError):Client(origin,self.store.store_id)
    def test_redirect_response_is_not_followed(self):
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        class Redirect(BaseHTTPRequestHandler):
            def do_GET(s):s.send_response(302);s.send_header('Location','http://example.invalid/collect');s.end_headers()
            def log_message(s,*args):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Redirect);thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            with self.assertRaises(WorkerError) as e:Client(f'http://127.0.0.1:{server.server_address[1]}',self.store.store_id)
            self.assertEqual(str(e.exception),'redirect_rejected')
        finally:server.shutdown();server.server_close();thread.join()
    def test_explicit_paths_only_no_traversal_or_private_paths(self):
        for names in (['../outside'],['C:/Windows/system.ini'],['.local/connection.json'],['.env'],['results/output.txt','RESULTS/output.txt']):
            with self.assertRaises((WorkerError,TaskError)):hash_files(self.root,names)
    def test_symlinks_and_hardlinks_not_read_as_regular_artifacts(self):
        original=self.root/'results/output.txt';hard=self.root/'results/hard.txt';os.link(original,hard)
        with self.assertRaises(WorkerError):hash_files(self.root,['results/hard.txt'])
        hard.unlink()
        # Windows junctions may be made without symlink privileges.
        junction=self.root/'results/junction'
        if os.name=='nt':
            result=subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(junction),str(self.root/'results')],capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            try:
                with self.assertRaises(WorkerError):hash_files(self.root,['results/junction/output.txt'])
            finally:os.rmdir(junction)
    def test_changed_root_and_exclusive_envelope_protect_original(self):
        e=self.envelope();save_new(self.root,'delivery.json',e)
        with self.assertRaises(FileExistsError):save_new(self.root,'delivery.json',{'replacement':True})
        self.assertEqual(load(self.root,'delivery.json'),e)
        with self.assertRaises(WorkerError):self.client.send(e,self.root/'results')
        self.assertFalse(self.store.receipt(e['command']['request_id'])['found'])
    def test_bounded_and_missing_artifacts_are_not_silently_dropped(self):
        p=self.root/'results/large.txt'
        with p.open('wb') as out:out.truncate(16*1024*1024+1)
        for names in (['results/missing.txt'],['results/large.txt'],[]):
            with self.assertRaises(WorkerError):hash_files(self.root,names)
    def test_independent_hash_check_reports_mismatch_not_quality_pass(self):
        e=self.envelope();rows=e['command']['data']['artifacts'];self.assertTrue(check_files(self.root,rows)['passed'])
        (self.root/'results/output.txt').write_bytes(b'changed');self.assertFalse(check_files(self.root,rows)['passed'])
    def test_http_inbox_and_assignment_reject_arbitrary_file_parameters(self):
        for path in ('/api/tasks/inbox?path=secrets','/api/tasks/assignment?id='+self.t['id']+'&role=A&root=C:/'):
            with self.assertRaises(HTTPError) as e:urlopen(self.origin+path,timeout=5)
            self.assertEqual(e.exception.code,404);e.exception.close()
    def test_exported_role_guide_uses_actual_endpoint_and_current_feedback(self):
        self.t=self.command('feedback',self.t,{'role_id':'A','scope':'local','note':'必须保留的用户意见'})
        with urlopen(self.origin+'/api/tasks/export?id='+self.t['id']+'&role=A&format=markdown',timeout=5) as response:result=json.load(response)
        text=result['content'];self.assertIn(self.origin,text);self.assertIn(self.store.store_id,text)
        self.assertIn('必须保留的用户意见',text);self.assertIn('prepare-delivery',text);self.assertIn('check-artifacts',text)
        self.assertNotIn(self.client.info['intent'],text);self.assertNotIn('wc_pat_',text)

    def test_export_uses_one_snapshot_for_contract_and_worker_instructions(self):
        from copy import deepcopy
        current=self.store.get(self.t['id']);changed=deepcopy(current)
        changed['contract']['roles'][0]['worktree']='d:\\changed-during-export'
        with patch.object(self.store,'get',side_effect=[current,changed]) as reads:
            with urlopen(self.origin+'/api/tasks/export?id='+self.t['id']+'&role=A&format=markdown',timeout=5) as response:text=json.load(response)['content']
        self.assertEqual(reads.call_count,1,'Contract and worker argv must come from the same snapshot')
        self.assertNotIn('changed-during-export',text)

    def test_localhost_export_still_provides_cli_supported_loopback(self):
        origin=self.origin.replace('127.0.0.1','localhost')
        with urlopen(origin+'/api/tasks/export?id='+self.t['id']+'&role=A&format=markdown',timeout=5) as response:text=json.load(response)['content']
        self.assertIn(self.origin,text)
        self.assertNotIn('http://localhost:',text)

    def test_post_successful_delivery_is_not_implicit_parent_acceptance(self):
        e=self.envelope();self.client.send(e,self.root);t=self.client.get('get',{'id':self.t['id']})['task']
        self.assertEqual(t['status'],'open');self.assertEqual(t['roles']['A']['status'],'submitted');self.assertIsNone(t['acceptance_review'])

if __name__=='__main__':unittest.main(verbosity=2)
