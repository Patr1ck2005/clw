"""Local linking regression with synthetic credentials; never read a real profile."""
from pathlib import Path
import json,sys,tempfile,unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'));sys.path.insert(0,str(ROOT/'tests'))
from live_transport import runner_configuration,runner_profile_kind,configuration
from link_workbench import link_profile,write_reference,select_and_link,LinkError
from live_fixture import Fixture,TOKEN
PAT='wc_pat_synthetic_workbench_link_0123456789'
AGENT='wc_agent_synthetic_runner_only_0123456789'

class LinkTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.runner=self.base/'runner.toml';self.pat=self.base/'webcodex-user-token';self.out=self.base/'product/connection.json';self.fixture=Fixture()
  self.runner.write_text('server_url = '+json.dumps(self.fixture.origin)+'\ntoken = '+json.dumps(AGENT)+'\nclient_id = "test-runner"\n',encoding='utf-8');self.pat.write_text(PAT+'\n',encoding='utf-8')
 def tearDown(self):self.fixture.close();self.temp.cleanup()
 def test_managed_kind_does_not_read_user_credential(self):
  self.pat.unlink();self.assertEqual(runner_profile_kind(self.runner),'managed')
 def test_managed_requires_second_explicit_reference(self):
  with self.assertRaises(ValueError):runner_configuration(self.runner)
  self.assertEqual(self.fixture.requests,[])
 def test_managed_user_pat_not_runner_token_is_transmitted(self):
  before=self.runner.read_bytes()
  with patch('live_fixture.TOKEN',PAT):
   transport,receipt=link_profile(self.out,self.runner,self.pat)
   self.assertTrue(receipt['linked']);self.assertTrue(receipt['created']);self.assertEqual(receipt['project_count'],2)
  self.assertEqual(self.runner.read_bytes(),before)
  self.assertTrue(all(x['authorization_ok'] for x in self.fixture.requests))
  self.assertNotIn(PAT,self.out.read_text());self.assertNotIn(AGENT,self.out.read_text())
  self.assertEqual(configuration(self.out).namespace,transport.namespace)
 def test_same_link_is_idempotent_not_replacement(self):
  with patch('live_fixture.TOKEN',PAT):
   link_profile(self.out,self.runner,self.pat);before=self.out.stat().st_mtime_ns
   _,receipt=link_profile(self.out,self.runner,self.pat)
  self.assertFalse(receipt['created']);self.assertEqual(self.out.stat().st_mtime_ns,before)
 def test_wrong_account_directory_is_rejected(self):
  other=self.base/'other';other.mkdir();p=other/'webcodex-user-token';p.write_text(PAT)
  with self.assertRaises(ValueError):runner_configuration(self.runner,p)
  self.assertEqual(self.fixture.requests,[])
 def test_agent_token_cannot_be_relabelled_as_user_token(self):
  self.pat.write_text(AGENT)
  with self.assertRaises(ValueError):runner_configuration(self.runner,self.pat)
  self.assertEqual(self.fixture.requests,[])
 def test_an_openai_key_is_not_runtime_auth(self):
  self.pat.write_text('sk-synthetic_not_for_runtime_0123456789')
  with self.assertRaises(ValueError):runner_configuration(self.runner,self.pat)
 def test_auth_rejection_never_saves_link(self):
  with self.assertRaises(LinkError):link_profile(self.out,self.runner,self.pat)
  self.assertFalse(self.out.exists());self.assertEqual(len(self.fixture.requests),1)
 def test_different_existing_reference_is_preserved(self):
  self.out.parent.mkdir();self.out.write_text('{"schema_version":1,"runner_config":"different"}')
  before=self.out.read_bytes()
  with patch('live_fixture.TOKEN',PAT):
   with self.assertRaises(LinkError):link_profile(self.out,self.runner,self.pat)
  self.assertEqual(self.out.read_bytes(),before)
 def test_corrupt_existing_reference_is_preserved(self):
  self.out.parent.mkdir();self.out.write_text('broken')
  with self.assertRaises(LinkError):write_reference(self.out,{'schema_version':1})
  self.assertEqual(self.out.read_text(),'broken')
 def test_concurrent_same_reference_saves_once_without_partial_json(self):
  reference={'schema_version':1,'runner_config':str(self.runner.resolve()),'user_token_file':str(self.pat.resolve())}
  with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(lambda _:write_reference(self.out,reference),range(4)))
  self.assertEqual(results.count(True),1);self.assertEqual(json.loads(self.out.read_text()),reference)
  self.assertEqual(list(self.out.parent.glob('.connection-*.tmp')),[])
 def test_shared_key_path_remains_supported(self):
  self.runner.write_text('server_url = '+json.dumps(self.fixture.origin)+'\ntoken = '+json.dumps(TOKEN)+'\n')
  _,receipt=link_profile(self.out,self.runner);self.assertTrue(receipt['linked']);self.assertNotIn('user_token_file',json.loads(self.out.read_text()))
 def test_mixed_shared_and_user_credentials_rejected(self):
  self.runner.write_text('server_url = '+json.dumps(self.fixture.origin)+'\ntoken = '+json.dumps(TOKEN)+'\n')
  with self.assertRaises(ValueError):runner_configuration(self.runner,self.pat)
 def test_consent_decline_never_calls_linker(self):
  with patch('tkinter.Tk'),patch('tkinter.filedialog.askopenfilename',return_value=str(self.runner)),patch('tkinter.messagebox.askyesno',return_value=False),patch('link_workbench.link_profile') as linker:
   self.assertIsNone(select_and_link(self.out));linker.assert_not_called()
 def test_consent_accept_passes_exact_pair(self):
  with patch('tkinter.Tk'),patch('tkinter.filedialog.askopenfilename',return_value=str(self.runner)),patch('tkinter.messagebox.askyesno',return_value=True),patch('link_workbench.link_profile',return_value=('transport',{})) as linker:
   self.assertEqual(select_and_link(self.out),('transport',{}));linker.assert_called_once_with(self.out,self.runner.resolve(),self.pat.resolve())
 def test_reference_schema_cannot_mix_user_pat_with_environment(self):
  self.out.parent.mkdir();self.out.write_text(json.dumps({'schema_version':1,'runner_config':str(self.runner.resolve()),'user_token_file':str(self.pat.resolve()),'token_env':'CLW_BAD'}))
  with self.assertRaises(ValueError):configuration(self.out)

if __name__=='__main__':unittest.main(verbosity=2)
