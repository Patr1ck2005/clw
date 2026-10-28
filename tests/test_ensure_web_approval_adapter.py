import contextlib,hashlib,importlib.util,io,json,sys,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'scripts/ensure_web_approval_adapter.py'
BUILD='20261025T142540Z-819fe004fa61-70e5bd47'

class ControlError(RuntimeError):
 def __init__(self,message,accepted=None,original_receipt=None):super().__init__(message);self.accepted=accepted;self.original_receipt=original_receipt

class ApprovalUpdateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.install=Path(self.temp.name)/'install';self.code=self.install/'versions'/BUILD;self.profile=self.install/'data/web-host';self.payload=self.profile/'approval-adapter'
  (self.code/'apps/web-host').mkdir(parents=True);(self.code/'scripts').mkdir();self.payload.mkdir(parents=True)
  (self.install/'active.json').write_text(json.dumps({'build_id':BUILD}))
  self.original={'page-dom.cjs':b'original dom','public-approval.cjs':b'original approval'}
  self.candidate={'page-dom.cjs':b'candidate dom','public-approval.cjs':b'candidate approval'}
  for name in self.original:(self.code/'apps/web-host'/name).write_bytes(self.original[name]);(self.payload/name).write_bytes(self.candidate[name])
  self.hashes={name:hashlib.sha256(value).hexdigest() for name,value in self.candidate.items()}
  self.manifest={'version':1,'files':self.hashes,'baseBuildId':BUILD};self.write_manifest()
  self.state={'pid':123,'root':str(self.code),'app_instance_id':'original-instance','runtime_generation':1,'selected':'account','connected':True,'task_state_ready':True,'runtime':{'pid':456},'page_adapter':{'sha256':'0'*64,'revision':1},'tasks':[{'id':'account','renderer_id':5,'phase':None,'identity':{}}]}
  self.mode='success';self.commands=[];self.control_opens=0;self.wait_seconds=0;owner=self
  class Control:
   def __init__(self,*args,**kwargs):
    owner.control_opens+=1
    if owner.mode=='starting' and owner.control_opens==1:raise ControlError('app_control_not_available_in_running_version')
   def state(self):return {**owner.state,'page_adapter':dict(owner.state['page_adapter'])}
   def command(self,request,**kwargs):
    owner.commands.append(request)
    if request['action']=='task-observation':return {'state':'completed','result':{'snapshot':{'readiness':{'approvalImplementationVersion':2}}}}
    for name,value in owner.candidate.items():owner.assertEqual((owner.code/'apps/web-host'/name).read_bytes(),value)
    if owner.mode=='reject':return {'state':'rejected','error':'app_page_adapter_preparation_pending'}
    if owner.mode=='unknown':raise ControlError('transport_unknown',accepted=True)
    owner.state['page_adapter']={'sha256':owner.hashes['page-dom.cjs'],'revision':2};return {'state':'completed'}
   def operation(self,*args,**kwargs):return {'state':'running'}
  self.modules={'product_runtime':types.SimpleNamespace(FileLease=lambda *_:contextlib.nullcontext()),'web_host_control':types.SimpleNamespace(AppControl=Control,ControlError=ControlError)}
  spec=importlib.util.spec_from_file_location('approval_update_test',SOURCE);self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
 def write_manifest(self):(self.payload/'manifest.json').write_text(json.dumps(self.manifest))
 def run_update(self):
  with patch.dict(sys.modules,self.modules),patch.object(sys,'argv',['ensure','--install-root',str(self.install),'--wait-seconds',str(self.wait_seconds)]),patch.object(self.module.time,'sleep',lambda _:None),contextlib.redirect_stdout(io.StringIO()) as output:self.module.main()
  return json.loads(output.getvalue())
 def test_live_update_restores_base_and_reports_actual_loaded_function(self):
  result=self.run_update();self.assertEqual(result['approvalImplementationVersion'],2);self.assertTrue(result['originalOwnersPreserved']);self.assertTrue(result['installedBaseRestored']);self.assertEqual(result['modelSends'],0)
  for name,value in self.original.items():self.assertEqual((self.code/'apps/web-host'/name).read_bytes(),value)
  self.assertFalse((self.payload/'pending.json').exists());self.assertEqual(len(self.commands),2)
 def test_already_loaded_does_not_rewrite_or_send(self):
  (self.payload/'last-result.json').write_text(json.dumps({'approvalSourceSha256':self.hashes['public-approval.cjs']}))
  self.state['page_adapter']['sha256']=self.hashes['page-dom.cjs'];self.assertEqual(self.run_update()['state'],'approval_adapter_already_current');self.assertEqual(self.commands,[])
 def test_normal_startup_reopens_the_descriptor_after_a_missing_original_instance(self):
  self.mode='starting';self.wait_seconds=2
  self.assertEqual(self.run_update()['state'],'approval_adapter_updated');self.assertGreaterEqual(self.control_opens,2)
 def test_approval_only_change_is_not_hidden_by_unchanged_DOM_hash(self):
  self.state['page_adapter']['sha256']=self.hashes['page-dom.cjs'];(self.payload/'last-result.json').write_text(json.dumps({'approvalSourceSha256':'old-approval-source'}))
  self.assertEqual(self.run_update()['state'],'approval_adapter_updated');self.assertEqual(len(self.commands),2)
 def test_rejection_restores_original_and_preserves_receipt(self):
  self.mode='reject'
  with self.assertRaises(SystemExit):self.run_update()
  for name,value in self.original.items():self.assertEqual((self.code/'apps/web-host'/name).read_bytes(),value)
  self.assertFalse((self.payload/'pending.json').exists());self.assertEqual(len(list(self.payload.glob('operation-*/receipt.json'))),1)
 def test_unknown_operation_is_not_replayed_or_restored_early(self):
  self.mode='unknown'
  with self.assertRaisesRegex(RuntimeError,'original_receipt_unknown'):self.run_update()
  self.assertEqual(len(self.commands),1);self.assertTrue((self.payload/'pending.json').exists())
  self.assertEqual((self.code/'apps/web-host/page-dom.cjs').read_bytes(),self.candidate['page-dom.cjs'])
  with self.assertRaisesRegex(RuntimeError,'query_original_pending'):self.run_update()
  self.assertEqual(len(self.commands),1)
 def test_changed_payload_never_touches_base(self):
  (self.payload/'public-approval.cjs').write_bytes(b'changed')
  with self.assertRaisesRegex(RuntimeError,'payload_changed'):self.run_update()
  self.assertEqual(self.commands,[])
 def test_future_release_does_not_receive_old_overlay(self):
  self.manifest['baseBuildId']='20261024T142540Z-819fe004fa61-70e5bd47';self.write_manifest()
  self.assertEqual(self.run_update()['state'],'approval_adapter_release_superseded');self.assertEqual(self.commands,[])

if __name__=='__main__':unittest.main()
