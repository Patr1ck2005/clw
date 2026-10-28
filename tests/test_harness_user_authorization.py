from pathlib import Path
import json,sys,tempfile,unittest,subprocess
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_user_authorization import authorization_path,read_policy,user_authorization,ended_turn_recovery_authorized,confirmation_authorized

class UserAuthorizationTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def write(self,relative,value):
        path=self.root/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value));return path
    def policy(self,text='Original user consent'):return {'version':1,'enabled':True,'text':text,'recover_ended_turns':True,'auto_approve_returned_files':True}
    def test_fresh_install_confirms_tools_and_files_without_enabling_recovery_or_writing_policy(self):
        text=user_authorization(self.root)
        self.assertTrue(text.strip());self.assertLess(len(text),100)
        self.assertTrue(confirmation_authorized('tool',self.root))
        self.assertTrue(confirmation_authorized('returned_file',self.root))
        self.assertFalse(confirmation_authorized('login',self.root))
        self.assertFalse(ended_turn_recovery_authorized(self.root))
        self.assertEqual(authorization_path(self.root),self.root/'.local/web-user-authorization.json');self.assertEqual(list(self.root.iterdir()),[])
        changed=read_policy(self.root);changed['auto_approve_tools']=False
        self.assertTrue(read_policy(self.root)['auto_approve_tools'])
    def test_existing_legacy_development_consent_is_retained(self):
        file=self.write('config/web-user-authorization.json',self.policy())
        self.assertEqual(authorization_path(self.root),file);self.assertEqual(user_authorization(self.root),'Original user consent\n')
        self.assertTrue(ended_turn_recovery_authorized(self.root))
    def test_private_stable_data_policy_precedes_legacy_and_disabled_does_not_fall_back(self):
        self.write('config/web-user-authorization.json',self.policy('Legacy'))
        file=self.write('.local/web-user-authorization.json',{'version':1,'enabled':False})
        self.assertEqual(authorization_path(self.root),file);self.assertEqual(user_authorization(self.root),'');self.assertFalse(ended_turn_recovery_authorized(self.root))
        self.assertFalse(confirmation_authorized('tool',self.root));self.assertFalse(confirmation_authorized('returned_file',self.root))
    def test_malformed_existing_private_policy_is_an_error_even_when_legacy_is_enabled(self):
        self.write('config/web-user-authorization.json',self.policy())
        file=self.write('.local/web-user-authorization.json',self.policy());file.write_text('{invalid')
        for read in [user_authorization,ended_turn_recovery_authorized]:
            with self.assertRaises(ValueError):read(self.root)
    def test_unreadable_existing_policy_does_not_fall_back(self):
        self.write('.local/web-user-authorization.json',self.policy())
        with patch.object(Path,'read_text',side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):user_authorization(self.root)
            with self.assertRaises(PermissionError):ended_turn_recovery_authorized(self.root)
    def test_missing_read_for_a_present_policy_is_not_a_default_grant(self):
        self.write('.local/web-user-authorization.json',self.policy())
        with patch.object(Path,'read_text',side_effect=FileNotFoundError('present link target missing')):
            with self.assertRaises(FileNotFoundError):confirmation_authorized('tool',self.root)
    def test_invalid_grant_flags_and_nonobject_are_rejected(self):
        for value in [[],{'version':1,'enabled':'true'},self.policy()|{'version':True},self.policy()|{'auto_approve_returned_files':'true'},self.policy()|{'recover_ended_turns':1}]:
            self.write('.local/web-user-authorization.json',value)
            with self.assertRaises(ValueError):user_authorization(self.root)

    def test_tool_and_file_confirmations_have_distinct_live_owner_choices(self):
        self.write('config/web-user-authorization.json',self.policy()|{'auto_approve_tools':False})
        self.assertTrue(confirmation_authorized('returned_file',self.root))
        self.assertFalse(confirmation_authorized('tool',self.root))
        self.write('.local/web-user-authorization.json',self.policy()|{'auto_approve_tools':True,'auto_approve_returned_files':False})
        self.assertTrue(confirmation_authorized('tool',self.root))
        self.assertFalse(confirmation_authorized('returned_file',self.root))
        self.assertFalse(confirmation_authorized('login',self.root))
        self.write('.local/web-user-authorization.json',self.policy()|{'auto_approve_tools':'true'})
        with self.assertRaises(ValueError):confirmation_authorized('tool',self.root)
    def test_legacy_text_and_explicit_recovery_are_retained_while_missing_confirmation_flags_default_on(self):
        original={'version':1,'enabled':True,'text':'Original task consent','recover_ended_turns':True}
        file=self.write('config/web-user-authorization.json',original);before=file.read_bytes()
        self.assertTrue(confirmation_authorized('tool',self.root));self.assertTrue(confirmation_authorized('returned_file',self.root))
        self.assertTrue(ended_turn_recovery_authorized(self.root));self.assertEqual(user_authorization(self.root),'Original task consent\n')
        self.assertEqual(file.read_bytes(),before)
    def test_web_and_python_policy_readers_share_defaults_and_explicit_owner_choices(self):
        module=Path(__file__).resolve().parents[1]/'apps/codex-web-bridge/bridge-config.cjs'
        code='process.stdout.write(JSON.stringify(require(process.argv[1]).readUserAuthorization(process.argv[2])))'
        for value in (None,{'version':1,'enabled':False},self.policy()|{'auto_approve_tools':False,'auto_approve_returned_files':False}):
            with self.subTest(policy=value):
                if value is not None:self.write('.local/web-user-authorization.json',value)
                actual=subprocess.check_output(['node','-e',code,str(module),str(self.root)],encoding='utf8',timeout=10)
                self.assertEqual(json.loads(actual),read_policy(self.root))

if __name__=='__main__':unittest.main()
