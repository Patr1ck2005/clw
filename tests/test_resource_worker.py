"""Actual file and loopback tests for begin intents; no model or pilot execution."""
from pathlib import Path
import json,sys,threading,unittest
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from test_resources import ResourceCase
from task_domain import fingerprint,absolute
from task_worker import Client,hash_files,WorkerError,save_new
from task_resource_worker import prepare_begin,verify_inputs,send,reconcile
from serve_control_center import create_server

class ResourceWorkerTests(ResourceCase):
    def setUp(self):
        super().setUp();self.root=Path(self.tmp.name)/'work';self.root.mkdir();(self.root/'input.txt').write_text('fixed input',encoding='utf-8')
        self.task=self.start(ids=('A',),path=str(self.root));self.task,self.key=self.define(self.task,freeze=True);self.observe(self.task,self.key)
        self.request(self.task,'A',[self.key],[{'role_id':'A','artifacts':hash_files(self.root,['input.txt'])}])
        self.packet=self.store.assignment(self.task['id'],'A');self.allowed=[{'role_id':'A','root':str(self.root)}]
        self.server=create_server(task_store=self.store);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.origin=f'http://127.0.0.1:{self.server.server_address[1]}';self.client=Client(self.origin,self.store.store_id)
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();super().tearDown()
    def prepare(self):return prepare_begin(self.packet,self.allowed,self.root,self.origin,self.store.store_id,'fixture','original guard checked in fixture')
    def test_prepare_checks_real_bytes_but_never_starts(self):
        envelope=self.prepare();self.assertEqual(self.group(self.task)['phase'],'reserved');self.assertTrue(envelope['input_check']['passed'])
        self.assertFalse(self.store.receipt(envelope['command']['request_id'])['found'])
    def test_separate_explicit_root_permission_required(self):
        with self.assertRaises(WorkerError):verify_inputs(self.packet['resource_request'],[])
        other=Path(self.tmp.name)/'other';other.mkdir()
        with self.assertRaises(WorkerError):verify_inputs(self.packet['resource_request'],[{'role_id':'A','root':str(other)}])
    def test_changed_bytes_after_preparation_prevent_send(self):
        envelope=self.prepare();(self.root/'input.txt').write_text('changed',encoding='utf-8')
        with self.assertRaises(WorkerError):send(self.client,envelope,self.root,self.allowed)
        self.assertFalse(self.store.receipt(envelope['command']['request_id'])['found']);self.assertEqual(self.group(self.task)['phase'],'reserved')
    def test_unknown_reply_reconciles_original_before_file_recheck(self):
        envelope=self.prepare();save_new(self.root,'intent.json',envelope);reply=send(self.client,envelope,self.root,self.allowed)
        (self.root/'input.txt').write_text('later change',encoding='utf-8')
        recovered=send(self.client,envelope,self.root,self.allowed);self.assertTrue(recovered['found']);self.assertEqual(recovered['receipt']['request_id'],reply['request_id'])
        actions=[x['action'] for x in self.store.events(self.task['id'])['events']];self.assertEqual(actions.count('resource.begin'),1)
    def test_corrupt_envelope_rejected(self):
        envelope=self.prepare();envelope['command']['data']['resource_fence']='0'*64
        with self.assertRaises(WorkerError):send(self.client,envelope,self.root,self.allowed)
    def test_false_input_snapshot_hash_rejected(self):
        group=self.packet['resource_request'];group['input_snapshot_hash']='0'*64
        with self.assertRaises(WorkerError):verify_inputs(group,self.allowed)
    def test_no_implicit_symlink_or_hardlink_reads(self):
        import os
        original=self.root/'input.txt';second=self.root/'alias.txt';os.link(original,second)
        try:
            with self.assertRaises(WorkerError):self.prepare()
        finally:second.unlink()
    def test_output_is_exclusive_and_retains_original_intent(self):
        envelope=self.prepare();save_new(self.root,'intent.json',envelope)
        with self.assertRaises(FileExistsError):save_new(self.root,'intent.json',self.prepare())
        self.assertEqual(json.loads((self.root/'intent.json').read_text(encoding='utf-8'))['command']['request_id'],envelope['command']['request_id'])
    def test_new_feedback_rejects_existing_prepared_begin(self):
        envelope=self.prepare();self.cmd('feedback',self.latest(self.task),{'role_id':'A','scope':'local','note':'new requirement'})
        with self.assertRaises(WorkerError):send(self.client,envelope,self.root,self.allowed)
        self.assertEqual(self.group(self.task)['phase'],'reserved')
    def test_two_sources_with_unauthorized_second_never_send(self):
        group=self.packet['resource_request'];group['inputs'].append({**group['inputs'][0],'role_id':'B'});group['input_snapshot_hash']=fingerprint(group['inputs'])
        with self.assertRaises(WorkerError):verify_inputs(group,self.allowed)
    def test_mismatched_task_root_cannot_prepare(self):
        other=Path(self.tmp.name)/'other';other.mkdir()
        with self.assertRaises(WorkerError):prepare_begin(self.packet,self.allowed,other,self.origin,self.store.store_id,'fixture','guard')
    def test_receipt_only_never_records_an_intent(self):
        envelope=self.prepare();self.assertFalse(reconcile(self.client,envelope,self.root)['found']);self.assertEqual(self.group(self.task)['phase'],'reserved')

if __name__=='__main__':unittest.main(verbosity=2)
