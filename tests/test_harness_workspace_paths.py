"""Real directory scope declarations; no filesystem grant or model calls."""
from pathlib import Path
from contextlib import closing
from unittest.mock import patch
import io,json,sys,unittest,uuid
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'scripts'),str(Path(__file__).parent)]
from harness_workspace_paths import relative_write_path,write_paths,normalize_scope_payload
from harness_state import HarnessError
from task_collaboration import artifact_path
from task_domain import TaskError


class ScopePathTests(unittest.TestCase):
    def test_project_directory_suffixes_are_canonical_without_scope_expansion(self):
        for value,expected in [('game/Assets/CampDemo/Runtime/RegionalWorld/','game/Assets/CampDemo/Runtime/RegionalWorld'),
                               ('game\\Assets\\CampDemo\\Runtime\\RegionalWorld\\','game/Assets/CampDemo/Runtime/RegionalWorld'),
                               ('delivery/WORLD/','delivery/WORLD'),('game/artifacts/','game/artifacts')]:
            with self.subTest(value=value):self.assertEqual(relative_write_path(value),expected)
    def test_internal_project_directories_are_valid_scopes_but_still_not_exportable_artifacts(self):
        for value in ('.local/workers','node_modules/pkg','__pycache__','config/.env.development'):
            with self.subTest(value=value):
                self.assertEqual(relative_write_path(value),value)
                with self.assertRaises(TaskError):artifact_path(value)
    def test_invalid_syntax_is_400_parameter_error_instead_of_403_authorization(self):
        for value in ('','/outside','C:/outside','../outside','src/../other','src//nested','src//',
                      './src','src/.','src/..','src/*','src/**','src/file?','CON','src/LPT1.log','src/aux',
                      'src/trailing.','src/trailing ','src/ab\0cd','\\\\server\\share'):
            with self.subTest(value=value),self.assertRaises(HarnessError) as caught:relative_write_path(value)
            self.assertEqual(caught.exception.code,'team_write_path_invalid');self.assertEqual(caught.exception.status,400)
    def test_whole_project_scope_is_explicit_and_not_global_or_mixed(self):
        self.assertEqual(write_paths('write',['.']),['.'])
        for paths in (['.','src'],['./'],['.\\']):
            with self.subTest(paths=paths),self.assertRaises(HarnessError):write_paths('write',paths)
        with self.assertRaises(HarnessError):write_paths('write',['src/','SRC'])
    def test_normalizer_preserves_default_inheritance_and_explicit_read(self):
        self.assertEqual(normalize_scope_payload({'root':'original'}),{'root':'original'})
        self.assertEqual(normalize_scope_payload({'access':'read','write_paths':[]}),{'access':'read','write_paths':[]})
        self.assertEqual(normalize_scope_payload({'access':'write'}),{'access':'write'})
        with self.assertRaises(HarnessError):normalize_scope_payload({'write_paths':['src/']})
    def test_scope_length_remains_compatible_with_original_host_and_native_admission(self):
        self.assertEqual(relative_write_path('x'*512+'/'),'x'*512)
        with self.assertRaises(HarnessError):relative_write_path('x'*513)


class WorkerDirectoryDeclarationTests(unittest.TestCase):
    def setUp(self):
        import test_harness_managed as f
        self.f=f.ManagedTests();self.f.setUp()
    def tearDown(self):self.f.tearDown()
    def test_real_create_accepts_world_paths_and_preserves_full_parent_scope(self):
        page,b=self.f.enroll(access='write',write_paths=['.'])
        root=self.f.f.root/'.local/authoring/world';root.mkdir(parents=True)
        paths=['game/Assets/CampDemo/Runtime/RegionalWorld/','game/Assets/CampDemo/Runtime/WorldCliffEntrance.cs',
               'game/Assets/CampDemo/Editor/RegionalWorld/','tools/tests/RegionalWorldTests.cs',
               'delivery/WORLD/','game/artifacts/']
        payload={'page_id':'web-'+str(uuid.uuid4()),'title':'WORLD','root':str(root),'access':'write','write_paths':paths}
        child=self.f.private(page,'create',payload)
        self.assertEqual(child['write_paths'],[p.rstrip('/') for p in paths])
        with closing(self.f.h.state.connect()) as db:
            parent=self.f.h.team.scopes.scope(db,b['thread_id'])
            self.assertEqual(json.loads(parent['write_paths']),['.']);self.assertEqual(parent['access'],'write')
            self.assertEqual(db.execute('SELECT count(*) FROM host_requests').fetchone()[0],0)
    def test_fresh_client_sends_canonical_world_paths_to_an_existing_older_host(self):
        import harness_managed_client as client
        captured=[]
        class Receiver:
            def __init__(self,*a):pass
            def call(self,action,**kwargs):
                captured.append((action,kwargs));return {'state':'fixture_metadata_only'}
        payload={'root':'C:/authorized/child','title':'WORLD','access':'write',
                 'write_paths':['game/Assets/CampDemo/Runtime/RegionalWorld/','delivery/WORLD/']}
        argv=['client','create','--store-id','original-store','--target','original-target',
              '--session-id','original-session','--operation-id','original-confirmed-unsent-key',
              '--payload-json',json.dumps(payload)]
        with patch.object(sys,'argv',argv),patch.object(client,'Client',Receiver),patch('sys.stdout',io.StringIO()):client.main()
        body=captured[0][1]
        self.assertEqual(body['operation_id'],'original-confirmed-unsent-key')
        self.assertEqual(body['payload']['write_paths'],['game/Assets/CampDemo/Runtime/RegionalWorld','delivery/WORLD'])
        self.assertEqual(body['payload']['root'],payload['root'])

if __name__=='__main__':unittest.main()
