"""Fixed portable distribution and reversible shortcuts, all in isolated folders."""
from pathlib import Path
from contextlib import redirect_stdout
from io import StringIO
import json,os,shutil,socket,subprocess,sys,tempfile,unittest,zipfile
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT/'scripts'),str(ROOT/'tests')]
from desktop_bundle import package,bundle_identity,doctor,portable_main,create_shortcuts,remove_shortcuts
from product_runtime import PRODUCT,ProductError,snapshot_payload,read_json,atomic_json
from workbench_release import Releases
from test_runtime_releases import command,RunningApplication


class PortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        (ROOT/'.local').mkdir(exist_ok=True);cls.template_tmp=tempfile.TemporaryDirectory(prefix='portable-source-',dir=ROOT/'.local');cls.template=Path(cls.template_tmp.name)
        for name,data in snapshot_payload(ROOT).items():
            p=cls.template/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        metadata=read_json(cls.template/'package.json');metadata['name']=PRODUCT
        atomic_json(cls.template/'package.json',metadata)
        command(cls.template,'init','-q');command(cls.template,'config','core.autocrlf','false');command(cls.template,'add','--','package.json','scripts','apps','config');command(cls.template,'commit','-qm','portable fixture')
        cls.commit=command(cls.template,'rev-parse','HEAD');cls.zip=cls.template/'fixture.zip';cls.report=package(cls.template,cls.commit,cls.zip)
    @classmethod
    def tearDownClass(cls):cls.template_tmp.cleanup()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='portable-use-',dir=ROOT/'.local');self.base=Path(self.tmp.name)
        with zipfile.ZipFile(self.zip) as z:z.extractall(self.base)
        self.root=next(p for p in self.base.iterdir() if p.is_dir());self.receipt=self.root/'.local/desktop-shortcuts.json'
    def tearDown(self):self.tmp.cleanup()
    def test_package_contains_only_fixed_application_and_bootstrap(self):
        with zipfile.ZipFile(self.zip) as z:
            names=z.namelist();self.assertFalse(any('/.git/' in n or '/evidence/' in n or '/tests/' in n or n.endswith(('.sqlite3','connection.json')) for n in names));self.assertEqual(len(names),self.report['entries'])
        root,metadata=bundle_identity(self.root);self.assertEqual(metadata['source_commit'],self.commit);self.assertFalse(metadata['credentials_included']);self.assertFalse((root/'.git').exists())
    def test_real_portable_doctor_runs_with_no_git_or_node_on_path(self):
        env=dict(os.environ,PATH=str(Path(sys.executable).parent));env.pop('PYTHONPATH',None)
        p=subprocess.run([sys.executable,'-B',str(self.root/'clw-launcher.py'),'doctor'],cwd=self.base,env=env,capture_output=True,text=True,encoding='utf-8',timeout=15)
        self.assertEqual(p.returncode,0,p.stderr+p.stdout);report=json.loads(p.stdout);self.assertTrue(report['fixed_payload_verified']);self.assertFalse(report['git_or_ide_required']);self.assertFalse(report['service_started']);self.assertFalse((self.root/'.local/control-center').exists())
    def test_bootstrap_plans_fixed_native_start_without_git(self):
        with socket.socket() as socket_:socket_.bind(('127.0.0.1',0));port=socket_.getsockname()[1]
        with patch('sys.argv',['clw-launcher.py','start','--port',str(port)]),patch('desktop_bundle.subprocess.call',return_value=0) as launch,patch('workbench_release.git',side_effect=AssertionError('Git must not run')):
            self.assertEqual(portable_main(self.root),0);args=launch.call_args.args[0]
        with RunningApplication(args,self.base/'portable-app.log') as app:
            info=app.get('/api/product/info');self.assertEqual(info['source_commit'],self.commit);self.assertEqual(info['channel'],'stable');self.assertTrue(all(info['capabilities'].values()))
            self.assertFalse(app.get('/api/tasks/info')['communication']['dispatch_enabled']);self.assertEqual(app.get('/api/tasks/list')['tasks'],[])
        self.assertIsNotNone(app.process.poll())
    def test_occupied_port_leaves_existing_listener_and_no_state(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen();port=listener.getsockname()[1]
            with patch('sys.argv',['clw-launcher.py','start','--port',str(port)]),redirect_stdout(StringIO()) as output:
                self.assertEqual(portable_main(self.root),1)
            self.assertIn('port_occupied',output.getvalue());self.assertEqual(listener.getsockname()[1],port)
        self.assertFalse((self.root/'.local/control-center').exists())
    def test_port_zero_is_rejected_before_selection_or_database_creation(self):
        with patch('sys.argv',['clw-launcher.py','start','--port','0']),redirect_stdout(StringIO()) as output:
            self.assertEqual(portable_main(self.root),1)
        self.assertIn('invalid_port',output.getvalue());self.assertFalse((self.root/'.local/control-center').exists())

    def test_mutated_launcher_is_rejected(self):
        (self.root/'clw-launcher.py').write_text('changed',encoding='utf-8')
        with self.assertRaises(ProductError):bundle_identity(self.root)
    def test_mutated_fixed_payload_is_rejected(self):
        payload=self.root/'.local/workbench-releases/payloads'/self.commit/'apps/control-center/tasks.html';payload.write_text('changed',encoding='utf-8')
        with self.assertRaises(ProductError):bundle_identity(self.root)
    def test_existing_archive_is_never_overwritten(self):
        path=self.base/'existing.zip';path.write_bytes(b'original')
        with self.assertRaises(ProductError):package(self.template,self.commit,path)
        self.assertEqual(path.read_bytes(),b'original')
    def test_no_previous_release_is_not_faked_rollback(self):
        with patch('sys.argv',['clw-launcher.py','rollback']),redirect_stdout(StringIO()) as output:self.assertEqual(portable_main(self.root),1)
        self.assertIn('no_previous_fixed_release',output.getvalue());self.assertFalse((self.root/'.local/control-center').exists())
    def test_notifications_have_separate_entry_not_default_authorization(self):
        self.assertNotIn('--enable-workflow-routing',(self.root/'START_WORKBENCH.cmd').read_text())
        self.assertIn('--enable-workflow-routing',(self.root/'START_WITH_NOTIFICATIONS.cmd').read_text())
    def test_shortcuts_create_and_remove_only_owned_links(self):
        target=self.base/'chosen shortcuts';target.mkdir();(target/'unrelated.txt').write_text('retain',encoding='utf-8')
        result=create_shortcuts(self.root,target);self.assertEqual(result['shortcut_count'],2);self.assertFalse(result['registry_modified'])
        sentinel=self.root/'.local/control-center/keep.txt';sentinel.parent.mkdir();sentinel.write_text('application data')
        result=remove_shortcuts(self.root);self.assertFalse(result['application_data_deleted']);self.assertEqual((target/'unrelated.txt').read_text(),'retain');self.assertEqual(sentinel.read_text(),'application data');self.assertEqual(list(target.glob('*.lnk')),[])
    def test_existing_shortcut_is_not_adopted(self):
        target=self.base/'chosen';target.mkdir();old=target/'CLW Control Center.lnk';old.write_bytes(b'user original')
        with self.assertRaises(ProductError):create_shortcuts(self.root,target)
        self.assertEqual(old.read_bytes(),b'user original');self.assertFalse(self.receipt.exists())
    def test_modified_shortcut_blocks_all_removal(self):
        target=self.base/'chosen';target.mkdir();create_shortcuts(self.root,target);changed=target/'CLW Readiness.lnk';changed.write_bytes(b'user changed')
        with self.assertRaises(ProductError):remove_shortcuts(self.root)
        self.assertTrue((target/'CLW Control Center.lnk').exists());self.assertEqual(changed.read_bytes(),b'user changed')
    def test_receipt_prevents_unknown_install_replay(self):
        target=self.base/'chosen';target.mkdir();create_shortcuts(self.root,target);before=self.receipt.read_bytes()
        with self.assertRaises(ProductError):create_shortcuts(self.root,target)
        self.assertEqual(self.receipt.read_bytes(),before)

if __name__=='__main__':unittest.main(verbosity=2)
