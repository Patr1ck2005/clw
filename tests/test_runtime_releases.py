"""G0 generic runtime release/ownership tests using only temporary repositories and data."""
from contextlib import closing
from copy import deepcopy
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import re
import http.client
import threading
import unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from product_runtime import (PRODUCT,MANIFEST,DATA_EPOCH,RuntimeIdentity,ProductError,StateLease,FileLease,
    snapshot_payload,verify_release,read_json,json_bytes,atomic_json,digest,payload_path)
from workbench_release import Releases,unpack_payload,port_busy
from task_store import TaskStore
from serve_control_center import create_server

def command(repo,*args):
    p=subprocess.run(['git','-C',str(repo),'-c','user.name=CLW isolated test','-c','user.email=isolated@example.invalid',*args],capture_output=True,timeout=20)
    if p.returncode:raise AssertionError(p.stderr.decode(errors='replace'))
    return p.stdout.decode().strip()

def fixture_contract():
    return {'title':'跨领域完整任务','goal':'保持原目标','constraints':'仅测试库','baseline':'input-v1','sources':'fixture','coordinator':'M','mode':'hybrid','acceptance':['审阅'],
     'roles':[{'id':'A','name':'审阅者','objective':'完整审阅','executor':'manual','project_id':'agent:fixture:paper','project_root':'D:/fixture/paper','worktree':'D:/fixture/paper','access':'read','scopes':[],'depends_on':[]}]}

def create_task(store,request='request-preserved-0001'):
    return store.command({'request_id':request,'action':'create','actor':'fixture','data':{'contract':fixture_contract()}})

class RunningApplication:
    def __init__(self, args, log):self.args=args;self.log=Path(log);self.process=None;self.handle=None;self.url=None
    def __enter__(self):
        env=dict(os.environ,PYTHONUTF8='1');env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
        self.handle=self.log.open('wb')
        self.process=subprocess.Popen(self.args,stdin=subprocess.DEVNULL,stdout=self.handle,stderr=subprocess.STDOUT,env=env)
        try:
            deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                text=self.log.read_text(encoding='utf-8',errors='replace')
                match=re.search(r'CLW Control Center: (http://127\.0\.0\.1:\d+)/',text)
                if match:self.url=match[1];return self
                if self.process.poll() is not None:raise AssertionError('candidate failed: '+text[-2000:])
                time.sleep(.04)
            raise AssertionError('candidate startup timed out')
        except BaseException:self.__exit__(None,None,None);raise
    def __exit__(self,*args):
        if self.process and self.process.poll() is None:
            self.process.terminate();self.process.wait(timeout=10)  # Own isolated process only; tests crash recovery.
        if self.handle:self.handle.close()
    def get(self,path):
        with urlopen(self.url+path,timeout=8) as r:return json.load(r)
    def command(self,payload,discard_response=False):
        info=self.get('/api/tasks/info');body=json.dumps(payload).encode('utf-8')
        headers={'Content-Type':'application/json','Origin':self.url,'X-CLW-Intent':info['intent']}
        if discard_response:
            conn=http.client.HTTPConnection('127.0.0.1',int(self.url.rsplit(':',1)[1]),timeout=8)
            conn.request('POST','/api/tasks/command',body=body,headers=headers);conn.close()
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                value=self.get('/api/tasks/receipt?request_id='+payload['request_id'])
                if value.get('found'):return value['receipt']
                time.sleep(.04)
            raise AssertionError('original committed receipt not observed')
        with urlopen(Request(self.url+'/api/tasks/command',data=body,headers=headers),timeout=8) as r:return json.load(r)

class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'.local').mkdir(exist_ok=True)
        cls.original=tempfile.TemporaryDirectory(prefix='g0-template-',dir=ROOT/'.local');cls.template=Path(cls.original.name)
        for name,data in snapshot_payload(ROOT).items():
            p=cls.template/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        # This suite exercises the historical Control Center release contract.
        # Its isolated fixture must keep that product name as the main package evolves.
        package=read_json(cls.template/'package.json');package['name']=PRODUCT
        (cls.template/'package.json').write_bytes(json_bytes(package))
        command(cls.template,'init','-q');command(cls.template,'add','--','package.json','scripts','apps','config');command(cls.template,'commit','-qm','fixture A')
        cls.a=command(cls.template,'rev-parse','HEAD')
        package=read_json(cls.template/'package.json');package['version']='0.6.0-g0.fixtureB';(cls.template/'package.json').write_bytes(json_bytes(package))
        command(cls.template,'add','--','package.json');command(cls.template,'commit','-qm','fixture B');cls.b=command(cls.template,'rev-parse','HEAD')
        release=Releases(cls.template);release.prepare(cls.a);release.prepare(cls.b)
    @classmethod
    def tearDownClass(cls):cls.original.cleanup()
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='g0-',dir=ROOT/'.local');self.root=Path(self.temp.name)/'app';shutil.copytree(self.template,self.root);self.r=Releases(self.root)
        self.sock=socket.socket();self.sock.bind(('127.0.0.1',0));self.free_port=self.sock.getsockname()[1];self.sock.close()
    def tearDown(self):self.temp.cleanup()
    def select_a(self):return self.r.select(self.a,None,self.free_port)
    def test_real_process_switch_keeps_lost_reply_receipt_and_current_data(self):
        self.select_a();request={'request_id':'actual-lost-reply-0001','action':'create','actor':'fixture','data':{'contract':fixture_contract()}}
        with RunningApplication(self.r.launch_args('stable',port=0),self.root/'runA.log') as a:
            first=a.get('/api/product/info');self.assertEqual(first['source_commit'],self.a)
            self.assertTrue(all(first['capabilities'].values()))
            receipt=a.command(request,discard_response=True);state=first['state_id']
        self.r.select(self.b,self.a,self.free_port)
        with RunningApplication(self.r.launch_args('stable',port=0),self.root/'runB.log') as b:
            info=b.get('/api/product/info');self.assertEqual(info['source_commit'],self.b);self.assertEqual(info['state_id'],state)
            self.assertNotEqual(info['instance_id'],first['instance_id'])
            recovered=b.get('/api/tasks/receipt?request_id='+request['request_id']);self.assertEqual(recovered['receipt'],receipt)
            self.assertEqual(b.command(request)['task']['id'],receipt['task']['id'])
            self.assertEqual(len(b.get('/api/tasks/list')['tasks']),1)
        self.r.rollback(self.free_port)
        with RunningApplication(self.r.launch_args('stable',port=0),self.root/'runRollback.log') as a2:
            self.assertEqual(a2.get('/api/product/info')['source_commit'],self.a)
            self.assertEqual(a2.get('/api/tasks/receipt?request_id='+request['request_id'])['receipt'],receipt)

    def test_real_candidate_and_stable_share_no_database(self):
        self.select_a()
        with RunningApplication(self.r.launch_args('stable',port=0),self.root/'stable.log') as s:
            with RunningApplication(self.r.launch_args('candidate',self.b,port=0),self.root/'candidate.log') as c:
                self.assertNotEqual(s.get('/api/product/info')['state_id'],c.get('/api/product/info')['state_id'])
                request={'request_id':'candidate-only-0001','action':'create','actor':'fixture','data':{'contract':fixture_contract()}}
                c.command(request)
                self.assertEqual(len(c.get('/api/tasks/list')['tasks']),1);self.assertEqual(len(s.get('/api/tasks/list')['tasks']),0)

    def test_second_real_process_cannot_share_first_data_at_another_port(self):
        self.select_a()
        with RunningApplication(self.r.launch_args('stable',port=0),self.root/'onlyOwner.log') as first:
            p=subprocess.run(self.r.launch_args('stable',port=0),capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15)
            self.assertNotEqual(p.returncode,0);self.assertIn('data_in_use_no_process_stopped',p.stdout+p.stderr)
            self.assertTrue(first.get('/api/product/info')['success'])

    def test_occupied_port_prevents_database_initialization(self):
        self.select_a()
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));s.listen();port=s.getsockname()[1]
            p=subprocess.run(self.r.launch_args('stable',port=port),capture_output=True,timeout=15)
            self.assertNotEqual(p.returncode,0);self.assertFalse((self.r.state/'tasks.sqlite3').exists());self.assertTrue(port_busy(port))

    def test_boolean_state_schema_is_not_version_one(self):
        with StateLease(self.r.state):pass
        path=self.r.state/'_clw_state.json';raw=read_json(path);raw['schema_version']=True;atomic_json(path,raw)
        with self.assertRaises(ProductError):
            with StateLease(self.r.state):pass

    def test_prepare_exact_commit_not_dirty_worktree(self):
        p=self.root/'apps/control-center/index.html';p.write_text('uncommitted',encoding='utf-8')
        info=self.r.prepare(self.a);self.assertEqual(info['source_commit'],self.a)
        path,_=self.r.release(self.a);self.assertNotEqual((path/'apps/control-center/index.html').read_text(encoding='utf-8'),'uncommitted')
    def test_repeat_prepare_does_not_overwrite(self):
        p=self.r.payloads/self.a/MANIFEST;before=p.stat().st_mtime_ns
        self.r.prepare(self.a);self.assertEqual(before,p.stat().st_mtime_ns)
    def test_release_excludes_private_runtime_and_test_files(self):
        m=self.r.prepare(self.a);self.assertFalse(any(k.startswith(('tests/','.local/','evidence/')) for k in m['files']))
        self.assertNotIn('scripts/verify_runtime_releases.py',m['files'])
    def test_tampered_release_refuses_start(self):
        p=self.r.payloads/self.a/'apps/control-center/index.html';p.write_text('changed')
        with self.assertRaises(ProductError):self.r.release(self.a)
    def test_tampered_release_not_repaired_silently(self):
        p=self.r.payloads/self.a/'scripts/product_runtime.py';p.write_text('changed')
        with self.assertRaises(ProductError):self.r.prepare(self.a)
        self.assertEqual(p.read_text(),'changed')
    def test_extra_importable_package_rejected(self):
        p=self.r.payloads/self.a/'scripts/sqlite3/__init__.py';p.parent.mkdir();p.write_text('raise RuntimeError()')
        with self.assertRaises(ProductError):self.r.release(self.a)
    def test_stable_requires_fixed_manifest(self):
        with self.assertRaises(ProductError):RuntimeIdentity(self.root,'stable')
    def test_runtime_commit_and_version_frozen_at_start(self):
        runtime=RuntimeIdentity(self.root,'development');before=runtime.info()
        package=read_json(self.root/'package.json');package['version']='9.9.9';(self.root/'package.json').write_bytes(json_bytes(package));runtime._until=0
        after=runtime.info();self.assertEqual(before['version'],after['version']);self.assertEqual(after['disk_status'],'changed');self.assertTrue(after['restart_required'])
        self.assertFalse(after['commit_describes_payload'])
    def test_fixed_release_displays_exact_identity(self):
        path,m=self.r.release(self.a);info=RuntimeIdentity(path,'candidate').info()
        self.assertTrue(info['fixed_release']);self.assertEqual(info['payload_sha256'],m['payload_sha256']);self.assertEqual(info['source_commit'],self.a)
    def test_selection_does_not_launch(self):
        result=self.select_a();self.assertEqual(result['commit'],self.a);self.assertFalse(port_busy(self.free_port))
    def test_selection_compare_and_swap(self):
        self.select_a()
        with self.assertRaises(ProductError):self.r.select(self.b,None,self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
    def test_identical_selection_is_idempotent(self):
        a=self.select_a();b=self.r.select(self.a,None,self.free_port);self.assertEqual(a,b)
        self.assertEqual(len(list((self.r.directory/'backups').iterdir())),1)
    def test_live_port_is_not_stopped_or_overwritten(self):
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));s.listen();port=s.getsockname()[1]
            with self.assertRaises(ProductError):self.r.select(self.a,None,port)
            self.assertTrue(port_busy(port));self.assertFalse(self.r.pointer.exists());self.assertFalse((self.r.state/'tasks.sqlite3').exists())
    def test_live_state_lease_blocks_switch_even_on_other_port(self):
        self.select_a()
        with StateLease(self.r.state):
            with self.assertRaises(ProductError):self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
    def test_upgrade_and_rollback_preserve_original_receipt_and_new_work(self):
        self.select_a();store=TaskStore(self.r.state/'tasks.sqlite3');original=create_task(store);sid=store.store_id
        self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(TaskStore(store.path).receipt('request-preserved-0001')['receipt'],original)
        second=create_task(TaskStore(store.path),'request-preserved-0002');self.r.rollback(self.free_port)
        after=TaskStore(store.path);self.assertEqual(after.store_id,sid);self.assertEqual(len(after.listing()['tasks']),2)
        self.assertEqual(after.receipt('request-preserved-0002')['receipt'],second)
    def test_backup_contains_database_not_credential(self):
        self.select_a();store=TaskStore(self.r.state/'tasks.sqlite3');create_task(store)
        (self.r.state/'connection.json').write_text('sensitive-reference-fixture');(self.r.state/'private-token').write_text('not-a-real-credential')
        selected=self.r.select(self.b,self.a,self.free_port);backup=self.r.directory/selected['backup']
        self.assertEqual({p.name for p in backup.iterdir()},{'backup.json','tasks.sqlite3'})
        with closing(sqlite3.connect(backup/'tasks.sqlite3')) as db:self.assertEqual(db.execute('select count(*) from receipts').fetchone()[0],1)
    def test_foreign_database_rejected_without_alteration(self):
        self.r.state.mkdir(parents=True);dbpath=self.r.state/'tasks.sqlite3'
        with closing(sqlite3.connect(dbpath)) as db:db.execute('create table unrelated(x)');db.commit()
        before=dbpath.read_bytes()
        with self.assertRaises(ProductError):self.select_a()
        self.assertEqual(before,dbpath.read_bytes());self.assertFalse(self.r.pointer.exists())
    def test_unrecognized_database_blocks_switch_instead_of_incomplete_backup(self):
        self.select_a();path=self.r.state/'custom.sqlite3'
        with closing(sqlite3.connect(path)) as db:
            db.execute('create table user_records(value)');db.execute("insert into user_records values('retain')");db.commit()
        before=path.read_bytes()
        with self.assertRaises(ProductError):self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
        self.assertEqual(path.read_bytes(),before)

    def test_future_schema_not_downgraded(self):
        self.select_a();store=TaskStore(self.r.state/'tasks.sqlite3')
        with closing(sqlite3.connect(store.path)) as db:db.execute("update metadata set value='5' where key='schema_version'");db.commit()
        with self.assertRaises(ProductError):self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
    def test_rollback_refuses_older_task_capability_after_collaboration(self):
        package=read_json(self.root/'package.json');package.pop('clw_task_schema_max',None)
        (self.root/'package.json').write_bytes(json_bytes(package));command(self.root,'add','--','package.json');command(self.root,'commit','-qm','legacy capability fixture')
        older=command(self.root,'rev-parse','HEAD');self.r.prepare(older);self.r.select(older,None,self.free_port)
        self.r.select(self.a,older,self.free_port)
        store=TaskStore(self.r.state/'tasks.sqlite3');created=create_task(store)['task']
        store.command({'request_id':'enable-schema2-0001','action':'collaborate','task_id':created['id'],'expected_version':created['version'],'actor':'fixture','data':{'confirm_schema_upgrade':True}})
        with self.assertRaises(ProductError):self.r.rollback(self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
        self.assertEqual(len(TaskStore(store.path).listing()['tasks']),1)

    def test_resource_schema_three_survives_switch_but_refuses_g1_rollback(self):
        package=read_json(self.root/'package.json');package['clw_task_schema_max']=2
        (self.root/'package.json').write_bytes(json_bytes(package));command(self.root,'add','--','package.json');command(self.root,'commit','-qm','G1 capability fixture')
        older=command(self.root,'rev-parse','HEAD');self.r.prepare(older);self.r.select(older,None,self.free_port)
        self.r.select(self.a,older,self.free_port)
        store=TaskStore(self.r.state/'tasks.sqlite3');created=create_task(store)['task']
        created=store.command({'request_id':'enable-resources-0001','action':'collaborate','task_id':created['id'],'expected_version':created['version'],'actor':'fixture','data':{'confirm_schema_upgrade':True}})['task']
        store.command({'request_id':'define-resources-0001','action':'resource.define','task_id':created['id'],'expected_version':created['version'],'actor':'fixture','data':{'namespace':'isolated','name':'review-seat','label':'Review','capacity':1,'requires_frozen_inputs':False,'authority_ref':'fixture','confirm_schema_upgrade':True,'expected_resource_version':None}})
        with self.assertRaises(ProductError):self.r.rollback(self.free_port)
        self.assertEqual(self.r.selected()['commit'],self.a)
        self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(len(TaskStore(store.path).resources()['resources']),1)

    def test_goal_schema_four_preserved_and_g4_rollback_refused(self):
        package=read_json(self.root/'package.json');package['clw_task_schema_max']=3
        (self.root/'package.json').write_bytes(json_bytes(package));command(self.root,'add','--','package.json');command(self.root,'commit','-qm','G4 capability fixture')
        older=command(self.root,'rev-parse','HEAD');self.r.prepare(older);self.r.select(older,None,self.free_port);self.r.select(self.a,older,self.free_port)
        store=TaskStore(self.r.state/'tasks.sqlite3');t=create_task(store)['task']
        for action,data in [('collaborate',{'confirm_schema_upgrade':True}),('goal.enable',{'confirm_schema_upgrade':True,'max_cycles':3,'failure_limit':2})]:
            t=store.command({'request_id':'goal-capability-'+action.replace('.','-'),'action':action,'task_id':t['id'],'expected_version':t['version'],'actor':'fixture','data':data})['task']
        with self.assertRaises(ProductError):self.r.rollback(self.free_port)
        self.r.select(self.b,self.a,self.free_port)
        self.assertEqual(TaskStore(store.path).get(t['id'])['goal']['intent_hash'],t['goal']['intent_hash'])

    def test_target_task_schema_boolean_is_not_a_version(self):
        package=read_json(self.root/'package.json');package['clw_task_schema_max']=True
        (self.root/'package.json').write_bytes(json_bytes(package));command(self.root,'add','--','package.json');command(self.root,'commit','-qm','invalid capability fixture')
        invalid=command(self.root,'rev-parse','HEAD');self.r.prepare(invalid)
        with self.assertRaises(ProductError):self.r.select(invalid,None,self.free_port)
        self.assertFalse(self.r.pointer.exists())

    def test_candidate_data_is_separate(self):
        self.select_a();stable=self.r.launch_args('stable');candidate=self.r.launch_args('candidate',self.b);dev=self.r.launch_args('development')
        states=[x[x.index('--state-dir')+1] for x in (stable,candidate,dev)];self.assertEqual(len(set(states)),3)
    def test_rollback_requires_actual_previous_release(self):
        self.select_a()
        with self.assertRaises(ProductError):self.r.rollback(self.free_port)
    def test_replaced_state_is_not_adopted_by_selected_release(self):
        self.select_a();p=self.r.state/'_clw_state.json';raw=read_json(p);raw['state_id']='f'*32;atomic_json(p,raw)
        with self.assertRaises(ProductError):self.r.launch_args('stable')
    def assert_stale_launch_rejected(self, args):
        env=dict(os.environ,PYTHONUTF8='1');env.pop('CLW_WEBCODEX_TOKEN',None);env.pop('PYTHONPATH',None)
        process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env)
        try:
            output,_=process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate();output,_=process.communicate(timeout=10)
            self.fail('Stale launch started a server instead of rejecting replaced state: '+output.decode('utf-8',errors='replace')[-1200:])
        self.assertNotEqual(process.returncode,0)
        self.assertIn('state_replaced_relink_explicitly',output.decode('utf-8',errors='replace'))
        self.assertFalse((self.r.state/'tasks.sqlite3').exists())

    def test_state_replaced_after_launch_planning_is_rejected_by_child(self):
        self.select_a();args=self.r.launch_args('stable',port=0)
        marker=self.r.state/'_clw_state.json';raw=read_json(marker);raw['state_id']='e'*32;atomic_json(marker,raw);before=marker.read_bytes()
        self.assert_stale_launch_rejected(args)
        self.assertEqual(marker.read_bytes(),before)

    def test_state_removed_after_launch_planning_is_not_reinitialized(self):
        self.select_a();args=self.r.launch_args('stable',port=0)
        marker=self.r.state/'_clw_state.json';marker.unlink()
        self.assert_stale_launch_rejected(args)
        self.assertFalse(marker.exists())

    def test_selection_does_not_recreate_missing_selected_state(self):
        selected=self.select_a();marker=self.r.state/'_clw_state.json';marker.unlink()
        with self.assertRaisesRegex(ProductError,'state_replaced_relink_explicitly'):
            self.r.select(self.b,self.a,self.free_port)
        self.assertFalse(marker.exists());self.assertEqual(self.r.selected(),selected)

    def test_identity_fence_precedes_connection_configuration_read(self):
        self.select_a();args=self.r.launch_args('stable',port=0)
        marker=self.r.state/'_clw_state.json';raw=read_json(marker);raw['state_id']='d'*32;atomic_json(marker,raw)
        config=self.r.state/'connection.json';config.write_text('malformed fixture; must not be loaded',encoding='utf-8')
        self.assert_stale_launch_rejected(args)
        self.assertEqual(config.read_text(encoding='utf-8'),'malformed fixture; must not be loaded')

    def test_stable_start_cannot_omit_selected_identity(self):
        self.select_a();args=self.r.launch_args('stable',port=0);index=args.index('--expected-state-id');del args[index:index+2]
        result=subprocess.run(args,capture_output=True,timeout=10)
        self.assertNotEqual(result.returncode,0);self.assertIn(b'expected-state-id',result.stderr)
        self.assertFalse((self.r.state/'tasks.sqlite3').exists())

    def test_state_lock_is_exclusive_and_released(self):
        with StateLease(self.r.state) as a:
            sid=a.identity
            with self.assertRaises(ProductError):
                with StateLease(self.r.state):pass
        with StateLease(self.r.state) as b:self.assertEqual(sid,b.identity)
    def test_state_lock_holds_across_processes(self):
        code='from pathlib import Path;from product_runtime import StateLease,ProductError;import sys\ntry:\n with StateLease(Path(sys.argv[1])):pass\nexcept ProductError:sys.exit(9)'
        with StateLease(self.r.state):
            p=subprocess.run([sys.executable,'-B','-c',code,str(self.r.state)],cwd=ROOT/'scripts',capture_output=True,timeout=10)
            self.assertEqual(p.returncode,9,p.stderr)
    def test_incompatible_state_marker_does_not_get_rewritten(self):
        with StateLease(self.r.state):pass
        p=self.r.state/'_clw_state.json';raw=read_json(p);raw['data_epoch']=2;atomic_json(p,raw);before=p.read_bytes()
        with self.assertRaises(ProductError):
            with StateLease(self.r.state):pass
        self.assertEqual(before,p.read_bytes())
    def test_invalid_revision_cannot_be_git_option(self):
        with self.assertRaises(ProductError):self.r.prepare('--help')
    def test_symlink_archive_member_rejected(self):
        stream=BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as tf:
            i=tarfile.TarInfo('scripts/product_runtime.py');i.type=tarfile.SYMTYPE;i.linkname='outside';tf.addfile(i)
        with self.assertRaises(ProductError):unpack_payload(stream.getvalue())
    def test_payload_paths_do_not_traverse(self):
        for p in ('../secret','scripts/../secret.py','scripts\\secret.py','C:/secret','scripts/a.py:stream','.local/key','evidence/out.json'):
            self.assertFalse(payload_path(p))

class IdentityHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server=create_server();self.url=f'http://127.0.0.1:{self.server.server_address[1]}';self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def request(self,path='/',**kwargs):return urlopen(Request(self.url+path,**kwargs),timeout=10)
    def test_identity_is_actual_process_and_registered_features(self):
        with self.request('/api/product/info') as r:info=json.load(r)
        self.assertEqual(info['pid'],os.getpid());self.assertFalse(info['capabilities']['tasks']);self.assertEqual(info['channel'],'test')
    def test_not_an_arbitrary_file_reader(self):
        with self.assertRaises(HTTPError) as e:self.request('/api/product/info?path=secrets')
        self.assertEqual(e.exception.code,400)
    def test_no_cross_site_identity(self):
        with self.assertRaises(HTTPError) as e:self.request('/api/product/info',headers={'Origin':'https://outside.invalid'})
        self.assertEqual(e.exception.code,403)
    def test_no_http_upgrade_or_restart(self):
        with self.assertRaises(HTTPError) as e:self.request('/api/product/info',method='POST',data=b'{}')
        self.assertEqual(e.exception.code,405)
    def test_static_output_is_startup_snapshot(self):
        original=self.server.static_assets['apps/control-center/index.html']
        with self.request('/') as r:self.assertEqual(r.read(),original)
        self.assertIn(b'product-status.mjs',original)
    def test_only_loopback(self):self.assertEqual(self.server.server_address[0],'127.0.0.1')

if __name__=='__main__':unittest.main(verbosity=2)
