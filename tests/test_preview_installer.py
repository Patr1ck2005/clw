"""Isolated preview lifecycle fixtures; no browser, backend, or account starts."""
from pathlib import Path
import copy
import json
import hashlib
import io
import os
import subprocess
import sys
import tomllib
import unittest
import uuid
import zipfile
from unittest.mock import patch
from contextlib import redirect_stdout
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import preview_installer as installer
import preview_installation as installation
import preview_connection_watch as watch
import web_workspace_release as release
from product_runtime import ProductError
import test_web_workspace_release as candidate_fixtures

class PreviewTests(unittest.TestCase):
    setUp=candidate_fixtures.CandidateTests.setUp
    tearDown=candidate_fixtures.CandidateTests.tearDown
    preserved_data=candidate_fixtures.CandidateTests.preserved_data

    def payload(self):
        paths={release.PRIVATE_RUNTIME['private_python'],release.PRIVATE_RUNTIME['powershell'],*release.PRIVATE_RUNTIME['native'].values()}
        sources={}
        for name in paths:
            source=self.base/'private-runtime'/name;source.parent.mkdir(parents=True,exist_ok=True)
            source.write_bytes(('isolated runtime '+name).encode());sources[name]=str(source)
        license_path=self.base/'private-runtime/LICENSE.txt';license_path.write_bytes(b'fixture license')
        sources['licenses/fixture/LICENSE.txt']=str(license_path)
        return {'schema':1,'components':[{'name':'test-private-core','version':'1','source':'https://example.test/official-runtime',
            'license':'fixture','license_files':['licenses/fixture/LICENSE.txt'],'files':sources}]}

    def prepared(self):
        return release.prepare(self.root,self.out,self.files['licenses/bun/LICENSE.md'],plan=(self.files,self.components),
            source_commit='a'*40,runtime_payload=self.payload())

    def installed(self):
        report=self.prepared()
        installer.install_preview(report['archive'],self.install_root,report['sha256'],initialize=False,owner_probe=lambda _:None)
        return report

    def test_private_manifest_and_legacy_archive_both_validate(self):
        legacy=release.prepare(self.root,self.out,self.files['licenses/bun/LICENSE.md'],plan=(self.files,self.components),source_commit='a'*40)
        old=release.verify_archive(legacy['archive']);new=release.verify_archive(self.prepared()['archive'])
        self.assertNotIn('private_python',old['runtime_contract'])
        self.assertEqual(new['runtime_contract']['private_python'],'runtime/python/python.exe')
        self.assertEqual(new['runtime_contract']['native'],release.PRIVATE_RUNTIME['native'])

    def test_new_preview_records_mit_and_preserves_third_party_license(self):
        item=self.prepared();manifest=release.verify_archive(item['archive'],item['sha256'])
        self.assertEqual(manifest['project_distribution_license'],'MIT')
        self.assertEqual(manifest['distribution'],'free-open-source-unsigned-preview')
        self.assertEqual(manifest['components'][0],self.components[0])
        with zipfile.ZipFile(item['archive']) as archive:
            self.assertEqual(archive.read('LICENSE'),self.files['LICENSE'].read_bytes())
            notice=archive.read('NOTICE.md').decode()
        self.assertIn('MIT License',notice);self.assertIn('Copyright (c) 2026 CLW contributors',notice)
        self.assertIn('Third-party components retain their own licenses and rights.',notice)
        self.assertIn('| fixture-runtime | test | fixture-only | licenses/bun/LICENSE.md |',notice)
        self.assertNotIn('proprietary Free Preview License',notice)

    def test_old_closed_preview_installs_with_original_license_notice_and_manifest(self):
        old_license=b'CLW Free Preview License\nVersion 2026-10-17\n'
        old_notice=b'CLW-owned code is distributed under the included proprietary Free Preview License.\n'
        def legacy(entries):
            entries['LICENSE']=old_license;entries['NOTICE.md']=old_notice
            manifest=json.loads(entries[release.MANIFEST])
            manifest['project_distribution_license']='proprietary-free-preview'
            manifest['distribution']='free-closed-source-unsigned-preview'
            for name in ('LICENSE','NOTICE.md'):manifest['files'][name]={'sha256':release.sha(entries[name]),'bytes':len(entries[name])}
            manifest['payload_sha256']=release.sha(release.canonical(manifest['files']))
            entries[release.MANIFEST]=release.canonical(manifest)
        archive=candidate_fixtures.CandidateTests.rewritten_archive(self,legacy);original=archive.read_bytes()
        manifest=release.verify_archive(archive)
        installer.install_preview(archive,self.install_root,release.sha(original),initialize=False,owner_probe=lambda _:None)
        code=self.install_root/'versions'/manifest['build_id'];installed=release.verify_version(code,self.install_root/'data')
        self.assertEqual(installed['project_distribution_license'],'proprietary-free-preview')
        self.assertEqual(installed['distribution'],'free-closed-source-unsigned-preview')
        self.assertEqual((code/'LICENSE').read_bytes(),old_license);self.assertEqual((code/'NOTICE.md').read_bytes(),old_notice)
        self.assertEqual(archive.read_bytes(),original)

    def test_private_runtime_must_be_complete_and_cannot_adopt_credentials(self):
        for key in ['runtime/python/python.exe','config/tunnel-config.json']:
            payload=self.payload()
            if key.startswith('runtime/'):payload['components'][0]['files'].pop(key)
            else:payload['components'][0]['files'][key]=str(self.base/'private-runtime/LICENSE.txt')
            with self.assertRaises(ProductError):release.add_runtime_payload({},[],payload)

    def test_private_runtime_contract_tampering_is_rejected(self):
        manifest=release.verify_archive(self.prepared()['archive'])
        for key in ('private_python','powershell','native'):
            with self.subTest(path=key):
                changed=copy.deepcopy(manifest)
                if key=='native':changed['runtime_contract']['native']['runner']='C:/foreign/webcodex-runner.exe'
                else:changed['runtime_contract'][key]='C:/foreign/runtime.exe'
                with self.assertRaisesRegex(ProductError,'candidate_runtime_contract_invalid'):release.validate_manifest(changed)

    def new_native_candidate(self):
        original_payload=self.payload
        def changed_payload():
            payload=original_payload()
            for name in release.PRIVATE_RUNTIME['native'].values():
                Path(payload['components'][0]['files'][name]).write_bytes(('updated private native '+name).encode())
            return payload
        with patch.object(self,'payload',side_effect=changed_payload):return self.prepared()

    def owned_runtime_fixture(self):
        # The rollback target really has the old two-argument API. Loading it
        # for maintenance instead of the current audited implementation fails.
        source=self.root/'scripts/preview_installation.py'
        source.write_text('class PreviewError(ValueError): pass\ndef initialize(root, binaries):\n raise AssertionError("old bootstrap must not execute maintenance")\n')
        self.files['scripts/preview_installation.py']=source
        first=self.installed();code=self.install_root/'versions'/first['build_id'];data=self.install_root/'data'
        binaries={key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        with patch.object(installation,'secure_private'):
            manifest=installation.initialize(code,binaries)['manifest']
        project=self.base/'authorized-project';project.mkdir()
        manifest={**manifest,'projectRoots':[str(project)]}
        installation.atomic_json(data/'preview-installation.json',manifest)
        home=installation.private_home(code);home.mkdir(exist_ok=True)
        env=home/'server.env';env.write_bytes(b'original local token and server data location')
        token=home/'bootstrap-token';token.write_bytes(b'original local bootstrap token')
        registry=home/'project-registry';registry.mkdir();database=registry/'original.db';database.write_bytes(b'original native registry database')
        credential=home/'account-A.dpapi';credential.write_bytes(b'original encrypted credential fixture')
        marker=home/'bootstrap.json';marker.write_text(json.dumps({'schema':1,'installation_id':manifest['installation_id'],
            'client_id':'original-client','enrolled':True,'applied_projectRoots':manifest['projectRoots']}))
        runner=home/'runner.toml';runner.write_text('client_id = "original-client"\nallow_cwd_anywhere = true\nallowed_roots = '+json.dumps(manifest['projectRoots'])+'\n')
        installation.configure_runner_shell(code,manifest,runner)
        initial=home/'runner-initial.toml';initial.write_bytes(runner.read_bytes())
        launch=data/'web-host/backend-launch.json';launch.parent.mkdir(exist_ok=True)
        launch.write_text(json.dumps({'version':1,**{key:binaries[key] for key in ('cli','server','runner')},
            'origin':manifest['backend']['origin'],'env_file':str(env),'runner_config':str(runner),'network':manifest['network']}))
        preserved={path:path.read_bytes() for path in (env,token,database,credential,marker)}
        preserved.update(self.preserved_data())
        original_config=tomllib.loads(runner.read_text());original_config.pop('shell')
        # The next frozen candidate carries the new implementation.
        source.write_bytes((candidate_fixtures.PROJECT/'scripts/preview_installation.py').read_bytes())
        return first,code,manifest,preserved,original_config

    def assert_native_binding(self,code,original,preserved,config):
        manifest=installation.load(code)
        self.assertEqual({key:value for key,value in manifest.items() if key!='binaries'},
                         {key:value for key,value in original.items() if key!='binaries'})
        self.assertEqual(manifest['binaries'],{key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()})
        launch=json.loads((self.install_root/'data/web-host/backend-launch.json').read_text())
        for key in ('cli','server','runner'):self.assertEqual(launch[key],manifest['binaries'][key])
        self.assertEqual(launch['origin'],original['backend']['origin'])
        for name in ('runner.toml','runner-initial.toml'):
            current=tomllib.loads((installation.private_home(code)/name).read_text())
            self.assertEqual(current.pop('shell')['program'],str(code/'runtime/powershell/pwsh.exe'))
            self.assertEqual(current,config)
        for path,value in preserved.items():self.assertEqual(path.read_bytes(),value)

    def registered_startup_fixture(self):
        source=self.root/'scripts/preview_connection_watch.py'
        source.write_bytes((candidate_fixtures.PROJECT/'scripts/preview_connection_watch.py').read_bytes())
        self.files['scripts/preview_connection_watch.py']=source
        first,code,original,preserved,config=self.owned_runtime_fixture()
        appdata=self.base/'isolated-appdata';startup=appdata/'Microsoft/Windows/Start Menu/Programs/Startup';startup.mkdir(parents=True)
        with patch.dict(os.environ,{'APPDATA':str(appdata)}),patch.object(watch,'__file__',str(code/'scripts/preview_connection_watch.py')),patch.object(sys,'executable',str(code/'runtime/python/python.exe')):
            watch.configure_startup(code,original)
        path=startup/('CLW-Preview-'+original['installation_id']+'.vbs')
        return first,code,original,preserved,config,appdata,path

    def assert_registered_startup_target(self,code,path,original):
        text=path.read_text(encoding='utf-16');receipt=json.loads((installation.private_home(code)/'startup.json').read_text())
        for target in (code/'runtime/python/python.exe',code/'scripts/preview_connection_watch.py',code):self.assertIn(str(target),text)
        self.assertEqual(receipt['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(receipt['installation_id'],original['installation_id']);self.assertTrue(receipt['enabled'])
        self.assertTrue(installation.load(code)['auto_connect'])

    @unittest.skipUnless(os.name=='nt','Windows startup contract')
    def test_registered_startup_follows_three_versions_without_launch_and_survives_pruning(self):
        first,old,original,preserved,config,appdata,path=self.registered_startup_fixture()
        with patch.dict(os.environ,{'APPDATA':str(appdata)}),patch('windows_process_owner.process_inventory',return_value=[]),patch.object(watch,'ensure_started',side_effect=AssertionError('maintenance must not start watch')):
            second=self.new_native_candidate();installer.install_preview(second['archive'],self.install_root,second['sha256'],owner_probe=lambda _:None)
            self.assert_registered_startup_target(self.install_root/'versions'/second['build_id'],path,original)
            third=self.new_native_candidate();installer.install_preview(third['archive'],self.install_root,third['sha256'],owner_probe=lambda _:None)
        code=self.install_root/'versions'/third['build_id'];self.assertFalse(old.exists())
        self.assert_registered_startup_target(code,path,original)
        self.assertNotIn(str(old),path.read_text(encoding='utf-16'))
        self.assert_native_binding(code,original,preserved,config)

    @unittest.skipUnless(os.name=='nt','Windows startup contract')
    def test_registered_startup_rollback_uses_legacy_target_paths_not_current_implementation(self):
        first,old,original,preserved,config,appdata,path=self.registered_startup_fixture();new=self.new_native_candidate()
        with patch.dict(os.environ,{'APPDATA':str(appdata)}),patch('windows_process_owner.process_inventory',return_value=[]):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assert_registered_startup_target(self.install_root/'versions'/new['build_id'],path,original)
            installer.rollback(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        self.assert_registered_startup_target(old,path,original)
        self.assertNotIn(str(self.install_root/'versions'/new['build_id']),path.read_text(encoding='utf-16'))
        self.assert_native_binding(old,original,preserved,config)

    @unittest.skipUnless(os.name=='nt','Windows startup contract')
    def test_startup_two_file_interruption_resumes_only_journaled_target_and_rejects_foreign_bytes(self):
        first,old,original,preserved,config,appdata,path=self.registered_startup_fixture();new=self.new_native_candidate()
        pointer=(self.install_root/'active.json').read_bytes();receipt_path=installation.private_home(old)/'startup.json'
        old_receipt=receipt_path.read_bytes();old_sha=hashlib.sha256(path.read_bytes()).hexdigest();atomic=watch.atomic_json
        def interrupted(target,value):
            if target==receipt_path:raise OSError('fixture startup receipt publication interrupted')
            return atomic(target,value)
        with patch.dict(os.environ,{'APPDATA':str(appdata)}),patch('windows_process_owner.process_inventory',return_value=[]):
            with patch.object(watch,'atomic_json',side_effect=interrupted),self.assertRaisesRegex(OSError,'startup receipt publication interrupted'):
                installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual((self.install_root/'active.json').read_bytes(),pointer);self.assertEqual(receipt_path.read_bytes(),old_receipt)
            journal=self.install_root/'data/preview-runtime-rebind.json';pending=json.loads(journal.read_text());target_bytes=path.read_bytes()
            self.assertEqual(pending['state'],'prepared');self.assertEqual(pending['startup']['previous_sha256'],old_sha)
            self.assertEqual(pending['startup']['target_sha256'],hashlib.sha256(target_bytes).hexdigest())
            self.assertEqual(pending['startup']['installation_id'],original['installation_id'])
            path.write_bytes(target_bytes+b'foreign change')
            with self.assertRaisesRegex(ProductError,'preview_startup_owner_changed'):
                installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual(path.read_bytes(),target_bytes+b'foreign change');self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
            path.write_bytes(target_bytes);mtime=path.stat().st_mtime_ns
            with self.assertRaisesRegex(installation.PreviewError,'preview_runtime_rebind_original_operation_pending'):
                installation.initialize(old,original['binaries'],maintenance=True)
            self.assertEqual(json.loads(journal.read_text()),pending)
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual(path.stat().st_mtime_ns,mtime,'resume receipts without rewriting the accepted VBS')
        code=self.install_root/'versions'/new['build_id'];self.assert_registered_startup_target(code,path,original)
        self.assertEqual(json.loads(journal.read_text())['state'],'completed');self.assert_native_binding(code,original,preserved,config)

    @unittest.skipUnless(os.name=='nt','Windows startup contract')
    def test_registered_startup_survives_selection_failure_and_same_package_retry(self):
        first,old,original,preserved,config,appdata,path=self.registered_startup_fixture();new=self.new_native_candidate()
        pointer=(self.install_root/'active.json').read_bytes();atomic=release.atomic_json
        def interrupted(target,value):
            if Path(target)==self.install_root/'active.json':raise OSError('fixture startup selection publication interrupted')
            return atomic(target,value)
        with patch.dict(os.environ,{'APPDATA':str(appdata)}),patch('windows_process_owner.process_inventory',return_value=[]):
            with patch.object(release,'atomic_json',side_effect=interrupted),self.assertRaisesRegex(OSError,'startup selection publication interrupted'):
                installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
            code=self.install_root/'versions'/new['build_id'];self.assert_registered_startup_target(code,path,original)
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
        self.assert_registered_startup_target(code,path,original);self.assert_native_binding(code,original,preserved,config)

    def test_real_installer_upgrade_and_legacy_target_rollback_rebind_owned_native(self):
        first,old_code,original,preserved,config=self.owned_runtime_fixture();new=self.new_native_candidate()
        new_code=self.install_root/'versions'/new['build_id']
        with patch('windows_process_owner.process_inventory',return_value=[]) as census:
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertTrue(census.called)
            self.assert_native_binding(new_code,original,preserved,config)
            with patch('windows_process_owner.process_inventory',side_effect=AssertionError('ordinary initialize cannot rebind')):
                self.assertEqual(installation.initialize(old_code,original['binaries'])['manifest']['binaries'],installation.load(new_code)['binaries'])
            installer.rollback(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        self.assert_native_binding(old_code,original,preserved,config)
        self.assertEqual(json.loads((self.install_root/'data/preview-runtime-rebind.json').read_text())['state'],'completed')

    def test_installer_rebind_refuses_live_owner_job_unknown_or_unavailable_before_selection(self):
        first,old_code,original,preserved,config=self.owned_runtime_fixture();new=self.new_native_candidate()
        pointer=(self.install_root/'active.json').read_bytes();data=self.install_root/'data'
        cases=[('owner',[{'ProcessId':8675309,'ExecutablePath':original['binaries']['server']}],'preview_runtime_rebind_owner_running'),
               ('job',[{'ProcessId':8675310,'ExecutablePath':str(old_code/'runtime/powershell/pwsh.exe')}],'preview_runtime_rebind_owner_running'),
               ('unknown',[],'preview_runtime_rebind_completion_unknown'),
               ('unavailable',RuntimeError('fixture census unavailable'),'preview_runtime_rebind_observation_unavailable')]
        for name,rows,error in cases:
            with self.subTest(reason=name):
                if name=='unknown':installation.atomic_json(data/'preview-launch.json',{'completion_unknown':True})
                options={'side_effect':rows} if isinstance(rows,Exception) else {'return_value':rows}
                with patch('windows_process_owner.process_inventory',**options),self.assertRaisesRegex(ProductError,error):
                    installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
                self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
                self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
                self.assert_native_binding(old_code,original,preserved,config)
                self.assertFalse((data/'preview-runtime-rebind.json').exists())
                if name=='unknown':installation.atomic_json(data/'preview-launch.json',{'completion_unknown':False})

    def test_installer_rebind_failure_keeps_original_selection_and_resumes_only_original_target(self):
        first,old_code,original,preserved,config=self.owned_runtime_fixture();new=self.new_native_candidate()
        pointer=(self.install_root/'active.json').read_bytes();data=self.install_root/'data';new_code=self.install_root/'versions'/new['build_id']
        atomic=installation.atomic_json
        def interrupted(path,value):
            if path.name=='preview-installation.json':raise OSError('fixture interrupted maintenance rebind')
            return atomic(path,value)
        # Exercise the same implementation but inject an I/O failure at the
        # existing journal's metadata publication boundary.
        with patch.object(installer,'installed_configuration',return_value=installation),patch('windows_process_owner.process_inventory',return_value=[]):
            with patch.object(installation,'atomic_json',side_effect=interrupted),self.assertRaisesRegex(OSError,'interrupted maintenance rebind'):
                installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
            self.assertEqual(installation.load(old_code)['binaries'],original['binaries'])
            pending=json.loads((data/'preview-runtime-rebind.json').read_text());self.assertEqual(pending['state'],'prepared')
            with self.assertRaisesRegex(installation.PreviewError,'preview_runtime_rebind_original_operation_pending'):
                installation.initialize(old_code,original['binaries'],maintenance=True)
            self.assertEqual(json.loads((data/'preview-runtime-rebind.json').read_text()),pending)
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
        self.assert_native_binding(new_code,original,preserved,config)

    def test_installer_rebind_does_not_take_over_external_backend(self):
        first,old_code,original,preserved,config=self.owned_runtime_fixture();data=self.install_root/'data'
        original={**original,'backend':{**original['backend'],'mode':'external'}}
        installation.atomic_json(data/'preview-installation.json',original)
        before=(data/'preview-installation.json').read_bytes();new=self.new_native_candidate()
        with patch('windows_process_owner.process_inventory',side_effect=AssertionError('external backend must not be observed')):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            installer.rollback(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        self.assertEqual((data/'preview-installation.json').read_bytes(),before)
        self.assertFalse((data/'preview-runtime-rebind.json').exists())
        for path,value in preserved.items():self.assertEqual(path.read_bytes(),value)

    def test_selection_publication_failure_retains_verified_rebound_runtime_and_same_install_resumes(self):
        first,old_code,original,preserved,config=self.owned_runtime_fixture();new=self.new_native_candidate()
        pointer=(self.install_root/'active.json').read_bytes();new_code=self.install_root/'versions'/new['build_id'];atomic=release.atomic_json
        def interrupted(path,value):
            if Path(path)==self.install_root/'active.json':raise OSError('fixture pointer publication interrupted')
            return atomic(path,value)
        with patch('windows_process_owner.process_inventory',return_value=[]):
            with patch.object(release,'atomic_json',side_effect=interrupted),self.assertRaisesRegex(OSError,'pointer publication interrupted'):
                installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
            self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
            self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
            self.assert_native_binding(new_code,original,preserved,config)
            release.verify_version(new_code,self.install_root/'data')
            installer.install_preview(new['archive'],self.install_root,new['sha256'],owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
        self.assert_native_binding(new_code,original,preserved,config)

    def test_private_native_upgrade_stages_verified_files_before_switch_and_can_rollback(self):
        first=self.installed();preserved=self.preserved_data();new=self.new_native_candidate()
        before=release.verify_archive(first['archive']);after=release.verify_archive(new['archive'])
        self.assertNotEqual(before['runtime_contract']['private_runtime_sha256'],after['runtime_contract']['private_runtime_sha256'])
        old_code=self.install_root/'versions'/first['build_id'];new_code=self.install_root/'versions'/new['build_id']
        select=release.select;switches=[]
        def checked_select(directory,build,expected_current,**options):
            self.assertEqual(release.selected(directory)['build_id'],first['build_id'])
            self.assertEqual(release.verify_version(new_code,directory/'data'),after)
            switches.append(build);return select(directory,build,expected_current,**options)
        with patch.object(release,'select',side_effect=checked_select):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None)
        self.assertEqual(switches,[new['build_id']]);self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
        self.assertEqual(release.verify_version(old_code,self.install_root/'data'),before)
        installer.rollback(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        self.assertEqual(release.selected(self.install_root)['previous'],new['build_id'])
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_private_runtime_failed_selection_preserves_old_data_and_same_archive_can_resume(self):
        first=self.installed();preserved=self.preserved_data();pointer=(self.install_root/'active.json').read_bytes()
        new=self.new_native_candidate();atomic=release.atomic_json
        def interrupted(path,value):
            if Path(path)==self.install_root/'active.json':raise OSError('fixture selection publication interrupted')
            return atomic(path,value)
        with patch.object(release,'atomic_json',side_effect=interrupted),self.assertRaisesRegex(OSError,'selection publication interrupted'):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None)
        self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        release.verify_version(self.install_root/'versions'/new['build_id'],self.install_root/'data')
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)
        installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_private_runtime_change_cannot_select_a_damaged_new_binary(self):
        first=self.installed();preserved=self.preserved_data();pointer=(self.install_root/'active.json').read_bytes()
        new=self.new_native_candidate()
        def damage(phase):
            if phase=='select':
                (self.install_root/'versions'/new['build_id']/'runtime/native/webcodex-runner.exe').write_bytes(b'late corruption')
        with self.assertRaisesRegex(ProductError,'candidate_version_file_changed'):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None,on_phase=damage)
        self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
        self.assertEqual(release.selected(self.install_root)['build_id'],first['build_id'])
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_private_upgrade_still_rejects_changed_shared_bun_or_electron(self):
        self.installed();preserved=self.preserved_data();pointer=(self.install_root/'active.json').read_bytes()
        for name in ('runtime/bun-1.4.0/bun.exe','apps/web-host/node_modules/electron/dist/electron.exe'):
            with self.subTest(runtime=name):
                source=self.files[name];original=source.read_bytes();source.write_bytes(b'changed shared runtime')
                try:new=self.new_native_candidate()
                finally:source.write_bytes(original)
                with self.assertRaisesRegex(ProductError,'candidate_runtime_change_requires_migration'):
                    installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None)
                self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
                for path,content in preserved.items():self.assertEqual(path.read_bytes(),content)

    def test_private_upgrade_still_requires_explicit_data_epoch_migration(self):
        self.installed();preserved=self.preserved_data();pointer=(self.install_root/'active.json').read_bytes()
        package=self.files['package.json'];metadata=json.loads(package.read_text());metadata['clw_data_epoch']=2;package.write_text(json.dumps(metadata))
        new=self.new_native_candidate()
        with self.assertRaisesRegex(ProductError,'candidate_data_epoch_requires_migration'):
            installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,owner_probe=lambda _:None)
        self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_install_maps_root_and_version_data_and_launches_no_process(self):
        with patch.object(installer,'initialize_preview') as bootstrap,patch.object(release.subprocess,'run',wraps=release.subprocess.run) as run:
            item=self.installed()
        bootstrap.assert_not_called()
        self.assertEqual((self.install_root/'.local').resolve(),(self.install_root/'data').resolve())
        report=release.inspect(self.install_root)
        self.assertEqual(report['python'],str(self.install_root/'versions'/item['build_id']/'runtime/python/python.exe'))
        self.assertEqual((self.install_root/'CLW.cmd').read_bytes(),installer.PREVIEW_LAUNCHER)
        self.assertIn(b'active.json',installer.PREVIEW_LAUNCHER)
        self.assertIn(b'"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',installer.PREVIEW_LAUNCHER)
        self.assertEqual((self.install_root/'CLW.vbs').read_bytes(),installer.PREVIEW_GUI_LAUNCHER)
        self.assertEqual((self.install_root/'MAINTENANCE.cmd').read_bytes(),installer.MAINTENANCE_LAUNCHER)

    def test_upgrade_retains_current_and_one_rollback_version_and_preserves_data(self):
        first=self.installed();preserved=self.preserved_data()
        self.files['apps/web-host/main.cjs'].write_bytes(b'second');second=self.installed()
        self.files['apps/web-host/main.cjs'].write_bytes(b'third');third=self.installed()
        self.assertFalse((self.install_root/'versions'/first['build_id']).exists())
        self.assertEqual({p.name for p in (self.install_root/'versions').iterdir()},{second['build_id'],third['build_id']})
        installer.rollback(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(release.inspect(self.install_root)['build_id'],second['build_id'])
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_busy_ownership_defers_pruning_without_stopping_a_process(self):
        self.installed();unknown=self.install_root/'versions/manual-evidence';unknown.mkdir()
        busy=lambda _:(_ for _ in ()).throw(ProductError('candidate_owned_process_running'))
        result=installer.prune_versions(self.install_root,owner_probe=busy)
        self.assertTrue(result['deferred']);self.assertTrue(unknown.is_dir())

    def test_uninstall_keeps_data_and_independent_jobs(self):
        self.installed();preserved=self.preserved_data()
        jobs=self.install_root/'data/independent-jobs.json';jobs.write_bytes(b'{"job":"retained"}')
        report=installer.uninstall_preview(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(report['state'],'preview_unregistered');self.assertFalse(report['versions_retained'])
        self.assertFalse((self.install_root/'active.json').exists());self.assertFalse((self.install_root/'CLW.cmd').exists())
        self.assertEqual(jobs.read_bytes(),b'{"job":"retained"}')
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)
        self.installed();self.assertEqual(jobs.read_bytes(),b'{"job":"retained"}')

    def test_uninstall_retains_in_use_code_and_all_data(self):
        item=self.installed();preserved=self.preserved_data()
        busy=lambda _:(_ for _ in ()).throw(ProductError('candidate_owned_process_running'))
        result=installer.uninstall_preview(self.install_root,owner_probe=busy)
        self.assertTrue(result['versions_retained']);self.assertFalse(result['processes_stopped'])
        self.assertTrue((self.install_root/'versions'/item['build_id']).is_dir())
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_three_build_reinstall_rebinds_missing_runtime_and_keeps_physical_data_identity(self):
        first=self.installed();data=(self.install_root/'data').resolve()
        code=self.install_root/'versions'/first['build_id']
        binaries=lambda selected:{key:str(selected/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        with patch.object(installation,'secure_private'):
            original=installation.initialize(code,binaries(code))['manifest']
        self.assertEqual(installation.local(code),data)
        home=installation.private_home(code);home.mkdir(exist_ok=True)
        env=home/'server.env';env.write_bytes(b'fixture native environment retained verbatim')
        runner=home/'runner.toml';runner.write_bytes(b'fixture enrolled runner retained verbatim')
        marker=home/'bootstrap.json';marker.write_text(json.dumps({'installation_id':original['installation_id'],
            'client_id':'same-enrolled-client','enrolled':True,'applied_projectRoots':[]}))
        launch=data/'web-host/backend-launch.json';launch.parent.mkdir(exist_ok=True)
        launch.write_text(json.dumps({'version':1,**{key:original['binaries'][key] for key in ('cli','server','runner')},
            'origin':original['backend']['origin'],'env_file':str(env),'runner_config':str(runner),'network':original['network']}))
        session=data/'session-fixture.json';session.write_bytes(b'accepted independent session retained')
        preserved={path:path.read_bytes() for path in (env,runner,marker,session)}
        self.files['apps/web-host/main.cjs'].write_bytes(b'upgrade preserves old native runtime');second=self.installed()
        next_code=self.install_root/'versions'/second['build_id']
        with patch('windows_process_owner.process_inventory',side_effect=AssertionError('ordinary upgrade must not rebind')):
            self.assertEqual(installation.initialize(next_code,binaries(next_code))['manifest']['binaries'],original['binaries'])
        with patch.object(installer,'installed_configuration',return_value=installation),patch.object(installation,'secure_private'):
            removed=installer.uninstall_preview(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(removed['state'],'preview_unregistered')
        self.assertFalse(code.exists());self.assertFalse(next_code.exists())
        self.files['apps/web-host/main.cjs'].write_bytes(b'different third build after idle uninstall');third=self.installed()
        third_code=self.install_root/'versions'/third['build_id']
        with patch('windows_process_owner.process_inventory',return_value=[]) as census:
            repaired=installation.initialize(third_code,binaries(third_code))['manifest']
        self.assertTrue(census.called);self.assertEqual(repaired['binaries'],binaries(third_code))
        for key in original:
            if key not in ('binaries','auto_connect'):self.assertEqual(repaired[key],original[key])
        self.assertFalse(repaired['auto_connect'])
        config=json.loads(launch.read_text());self.assertEqual(config['runner'],binaries(third_code)['runner'])
        self.assertEqual(config['env_file'],str(env));self.assertEqual(config['runner_config'],str(runner))
        for path,content in preserved.items():self.assertEqual(path.read_bytes(),content)

    def test_missing_runtime_rebind_refuses_original_owner_unknown_operation_and_observation_failure(self):
        item=self.installed();code=self.install_root/'versions'/item['build_id'];data=self.install_root/'data'
        binaries={key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        with patch.object(installation,'secure_private'):
            manifest=installation.initialize(code,binaries)['manifest']
        missing=code/'runtime/native/webcodex-server.exe';missing.unlink()
        replacement=self.base/'replacement-native';replacement.mkdir()
        new={}
        for key,name in installation.BINARY_NAMES.items():
            path=replacement/name;path.write_bytes(b'fixture replacement');new[key]=str(path)
        owner={'pid':8675309,'creation_filetime':'12345','executable':binaries['server']}
        (data/'preview-owners.json').write_text(json.dumps({'installation_id':manifest['installation_id'],'owners':{'server':owner}}))
        row={'ProcessId':owner['pid'],'CreationFiletime':'12345','ExecutablePath':binaries['server'],'CommandLine':binaries['server']}
        with patch('windows_process_owner.process_inventory',return_value=[row]):
            with self.assertRaisesRegex(installation.PreviewError,'preview_runtime_rebind_owner_running'):installation.initialize(code,new)
        (data/'preview-launch.json').write_text('{"completion_unknown":true}')
        with self.assertRaisesRegex(installation.PreviewError,'preview_runtime_rebind_completion_unknown'):installation.initialize(code,new)
        (data/'preview-launch.json').write_text('{"completion_unknown":false}')
        with patch('windows_process_owner.process_inventory',side_effect=RuntimeError('fixture unavailable')):
            with self.assertRaisesRegex(installation.PreviewError,'preview_runtime_rebind_observation_unavailable'):installation.initialize(code,new)
        self.assertEqual(installation.load(code)['binaries'],manifest['binaries'])

    def test_reinstall_resumes_only_the_original_prepared_runtime_rebind(self):
        item=self.installed();code=self.install_root/'versions'/item['build_id'];data=self.install_root/'data'
        binaries={key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        with patch.object(installation,'secure_private'):
            original=installation.initialize(code,binaries)['manifest']
        Path(binaries['server']).unlink();replacement=self.base/'rebind-original-operation';replacement.mkdir()
        new={key:str(replacement/name) for key,name in installation.BINARY_NAMES.items()}
        for path in new.values():Path(path).write_bytes(b'fixture new runtime')
        atomic=installation.atomic_json
        def interrupted(path,value):
            if path.name=='preview-installation.json':raise OSError('fixture interrupted metadata publication')
            return atomic(path,value)
        with patch('windows_process_owner.process_inventory',return_value=[]),patch.object(installation,'atomic_json',side_effect=interrupted):
            with self.assertRaises(OSError):installation.initialize(code,new)
        self.assertEqual(json.loads((data/'preview-runtime-rebind.json').read_text())['state'],'prepared')
        with patch('windows_process_owner.process_inventory',return_value=[]):
            resumed=installation.initialize(code,binaries)['manifest']
        self.assertEqual(resumed['binaries'],new,'resume the accepted operation, never adopt a different runtime request')
        self.assertEqual(resumed['installation_id'],original['installation_id'])
        self.assertEqual(json.loads((data/'preview-runtime-rebind.json').read_text())['state'],'completed')

    def test_missing_historical_project_root_allows_uninstall_reinstall_and_explicit_settings_repair(self):
        item=self.installed();code=self.install_root/'versions'/item['build_id']
        binaries=lambda selected:{key:str(selected/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        granted=self.base/'granted-project';granted.mkdir()
        with patch.object(installation,'secure_private'):
            manifest=installation.initialize(code,binaries(code))['manifest']
            manifest=installation.save(code,{'manifest':{**manifest,'projectRoots':[str(granted)]}})['manifest']
        granted.rmdir()
        self.assertEqual(installation.read(code)['manifest']['projectRoots'],[str(granted)])
        with self.assertRaisesRegex(installation.PreviewError,'preview_project_root_missing'):
            installation.save(code,{'manifest':manifest})
        with patch.object(installer,'installed_configuration',return_value=installation):
            result=installer.uninstall_preview(self.install_root,owner_probe=lambda _:None)
        self.assertEqual(result['state'],'preview_unregistered')
        self.files['apps/web-host/main.cjs'].write_bytes(b'different build with a missing historical project');new=self.installed()
        selected=self.install_root/'versions'/new['build_id']
        with patch('windows_process_owner.process_inventory',return_value=[]):
            restored=installation.initialize(selected,binaries(selected))['manifest']
        self.assertEqual(restored['installation_id'],manifest['installation_id'])
        self.assertEqual(restored['projectRoots'],[str(granted)])
        replacement=self.base/'moved-project';replacement.mkdir()
        with patch.object(installation,'secure_private'):
            repaired=installation.save(selected,{'manifest':{**restored,'projectRoots':[str(replacement)]}})['manifest']
        self.assertEqual(repaired['projectRoots'],[str(replacement)])

    def test_busy_uninstall_reports_failure_and_preserves_an_actionable_installation(self):
        item=self.installed();code=self.install_root/'versions'/item['build_id']
        binaries={key:str(code/value) for key,value in release.PRIVATE_RUNTIME['native'].items()}
        with patch.object(installation,'secure_private'):
            manifest=installation.initialize(code,binaries)['manifest']
        busy=lambda _:(_ for _ in ()).throw(ProductError('candidate_owned_process_running'))
        with patch.object(installer,'installed_configuration',return_value=installation):
            result=installer.uninstall_preview(self.install_root,owner_probe=busy)
        self.assertEqual(result['state'],'preview_unregistered_cleanup_deferred')
        self.assertTrue((self.install_root/'active.json').is_file());self.assertTrue(code.is_dir())
        self.assertEqual(installation.load(code),manifest,'a refused uninstall must not change startup settings')
        argv=['preview_installer','uninstall','--install-root',str(self.install_root)]
        with patch.object(sys,'argv',argv),patch.object(installer,'uninstall_preview',return_value=result),redirect_stdout(io.StringIO()):
            self.assertEqual(installer.main(),2)

    def test_owned_backend_and_watch_allow_upgrade_and_keep_referenced_runtime(self):
        for name in ('preview_installation.py','preview_connections.py','preview_connection_watch.py'):
            source=self.root/'scripts'/name;source.write_bytes(b'# isolated owner fixture\n');self.files['scripts/'+name]=source
        first=self.installed();code=self.install_root/'versions'/first['build_id'];data=self.install_root/'data'
        binary=str(code/'runtime/native/webcodex-server.exe');python=str(code/'runtime/python/python.exe')
        installation_id=str(uuid.uuid4())
        (data/'preview-installation.json').write_text(json.dumps({'schema':1,'installation_id':installation_id,'binaries':{'server':binary}}))
        (data/'preview-owners.json').write_text(json.dumps({'installation_id':installation_id,'owners':{
            'server':{'pid':701,'creation_filetime':'12345','executable':binary}}}))
        folder=data/'preview-watch';folder.mkdir()
        digest=hashlib.sha256()
        for name in ('preview_installation.py','preview_connections.py','preview_connection_watch.py'):digest.update((code/'scripts'/name).read_bytes())
        (folder/'owner.json').write_text(json.dumps({'pid':702,'creation_filetime':'12346','executable':python,'source_sha256':digest.hexdigest()}))
        rows=[{'ProcessId':701,'CreationFiletime':'12345','ExecutablePath':binary,'CommandLine':subprocess.list2cmdline([binary])},
              {'ProcessId':702,'CreationFiletime':'12346','ExecutablePath':python,
               'CommandLine':subprocess.list2cmdline([python,'-B',str(code/'scripts/preview_connection_watch.py'),'--root',str(code)])}]
        self.assertEqual(installer.workspace_idle(self.install_root,rows)['retained_owner_pids'],[701,702])
        runner=str(code/'runtime/native/webcodex-runner.exe');runner_config=str(data/'preview-private/runner.toml')
        manifest=json.loads((data/'preview-installation.json').read_text());manifest['binaries']['runner']=runner
        (data/'preview-installation.json').write_text(json.dumps(manifest))
        owners=json.loads((data/'preview-owners.json').read_text());owners['owners']['runner']={'pid':704,'creation_filetime':'12345','executable':runner}
        (data/'preview-owners.json').write_text(json.dumps(owners))
        (data/'web-host').mkdir(exist_ok=True);(data/'web-host/backend-launch.json').write_text(json.dumps({'runner_config':runner_config}))
        rows.extend([{'ProcessId':704,'CreationFiletime':'12345','ExecutablePath':runner,'CommandLine':subprocess.list2cmdline([runner,'--config',runner_config])},
            {'ProcessId':705,'ParentProcessId':704,'CreationFiletime':'12347','ExecutablePath':python,'CommandLine':subprocess.list2cmdline([python,'-c','pass'])}])
        self.assertEqual(installer.workspace_idle(self.install_root,rows)['retained_owner_pids'],[701,702,704,705])
        for content in (b'upgrade with owned backend',b'third code version'):
            self.files['apps/web-host/main.cjs'].write_bytes(content);new=self.prepared()
            installer.install_preview(new['archive'],self.install_root,new['sha256'],initialize=False,
                owner_probe=lambda directory:installer.workspace_idle(directory,rows))
        self.assertEqual(release.inspect(self.install_root)['build_id'],new['build_id'])
        self.assertTrue(code.is_dir(),'the manifest-referenced native runtime must survive retention')
        gui=str(code/'apps/web-host/node_modules/electron/dist/electron.exe')
        with self.assertRaisesRegex(ProductError,'candidate_owned_process_running'):
            installer.workspace_idle(self.install_root,rows+[{'ProcessId':703,'ExecutablePath':gui,'CommandLine':subprocess.list2cmdline([gui])}])
        (data/'preview-launch.json').write_text('{"completion_unknown":true}')
        with self.assertRaisesRegex(ProductError,'preview_launch_completion_unknown'):installer.workspace_idle(self.install_root,rows)

    def test_maintenance_entry_can_verify_and_roll_back_without_changing_data(self):
        first=self.installed();preserved=self.preserved_data()
        self.files['apps/web-host/main.cjs'].write_bytes(b'maintenance update');self.installed()
        choices=iter(['1','2','3']);output=[]
        report=installer.maintenance_menu(self.install_root,read_input=lambda _:next(choices),write=output.append)
        self.assertEqual(report['state'],'preview_maintenance_closed')
        self.assertEqual(release.inspect(self.install_root)['build_id'],first['build_id'])
        self.assertTrue(any('Rollback:' in value for value in output))
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)

    def test_preview_inventory_requests_native_backend_identities(self):
        with patch('windows_process_owner.process_inventory',return_value=[]) as inventory:
            self.assertEqual(self.real_process_rows(self.install_root,include_native=True),[])
        names=inventory.call_args.kwargs['target_names']
        self.assertTrue({'webcodex-server.exe','webcodex-runner.exe','tunnel-client.exe','python.exe'}.issubset(names))

    def test_native_environment_explicitly_disables_private_python_bytecode(self):
        manifest=installation.defaults(self.root)
        for inherited in ({'PATH':''},{'PATH':'','PYTHONDONTWRITEBYTECODE':'0'}):
            with self.subTest(inherited=inherited),patch.dict(os.environ,inherited,clear=True):
                environment=installation.environment(manifest)
            self.assertEqual(environment['PYTHONDONTWRITEBYTECODE'],'1')
            self.assertEqual(environment['PYTHONNOUSERSITE'],'1')

    def test_publication_retries_only_the_same_unperformed_rename_and_never_overwrites_unknown(self):
        source=self.base/'publishing';source.mkdir();(source/'payload').write_bytes(b'original snapshot')
        target=self.base/'published';calls=[];delays=[]
        def rename(original,destination):
            calls.append((original,destination))
            if len(calls)==1:
                error=PermissionError('fixture sharing violation');error.winerror=32;raise error
            os.replace(original,destination)
        release.publish_directory(source,target,sleep=delays.append,replace=rename)
        self.assertEqual(len(calls),2);self.assertEqual(delays,[.1]);self.assertFalse(source.exists())
        self.assertEqual((target/'payload').read_bytes(),b'original snapshot')
        source.mkdir();(source/'payload').write_bytes(b'new snapshot')
        with self.assertRaisesRegex(ProductError,'candidate_publish_target_changed'):release.publish_directory(source,target)
        self.assertEqual((source/'payload').read_bytes(),b'new snapshot')
        self.assertEqual((target/'payload').read_bytes(),b'original snapshot')

    def test_publication_has_ten_attempt_limit_and_does_not_adopt_a_new_target(self):
        source=self.base/'bounded-publish';source.mkdir();target=self.base/'bounded-published';calls=[];delays=[]
        def blocked(original,destination):
            calls.append((original,destination));error=PermissionError('fixture locked directory');error.winerror=32;raise error
        with self.assertRaises(PermissionError):release.publish_directory(source,target,replace=blocked,sleep=delays.append)
        self.assertEqual(len(calls),10);self.assertEqual(sum(delays),29);self.assertTrue(source.is_dir());self.assertFalse(target.exists())
        calls.clear()
        def appeared(original,destination):
            calls.append((original,destination));destination.mkdir();(destination/'unknown-user-data').write_bytes(b'preserve')
            error=PermissionError('fixture racing target');error.winerror=32;raise error
        with self.assertRaises(PermissionError):release.publish_directory(source,target,replace=appeared,sleep=delays.append)
        self.assertEqual(len(calls),1);self.assertEqual((target/'unknown-user-data').read_bytes(),b'preserve');self.assertTrue(source.is_dir())

    def test_windows_junction_uses_absolute_os_shell_with_empty_path(self):
        if os.name!='nt':self.skipTest('Windows bootstrap contract')
        target=self.base/'junction-target';target.mkdir();link=self.base/'junction-link'
        with patch.dict(os.environ,{'PATH':''}),patch.object(release.subprocess,'run',wraps=release.subprocess.run) as run:
            release.junction(link,target)
        command=run.call_args.args[0]
        self.assertEqual(Path(command[0]),Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe')
        self.assertEqual(link.resolve(),target.resolve())

    def test_inno_per_user_install_allows_its_verified_data_junction(self):
        template=(Path(__file__).resolve().parents[1]/'packaging/preview.iss').read_text(encoding='utf8')
        section=template.split('[Setup]',1)[1].split('[Tasks]',1)[0]
        settings=dict(line.split('=',1) for line in section.splitlines() if '=' in line and not line.lstrip().startswith(';'))
        self.assertEqual(settings['PrivilegesRequired'],'lowest')
        self.assertEqual(settings['RedirectionGuard'],'no')
        self.assertEqual(settings['MinVersion'],'10.0.17763')

    def test_bootstrap_local_import_closure_adoption_and_isolated_imports(self):
        project=Path(__file__).resolve().parents[1]
        closure={path.relative_to(project).as_posix() for path in release.local_modules(project,{'preview_installer'})}
        self.assertEqual(closure,release.BOOTSTRAP_SCRIPTS)
        for name in release.BOOTSTRAP_SCRIPTS:
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes((project/name).read_bytes());self.files[name]=target
        report=self.prepared();manifest=release.verify_archive(report['archive'])
        bootstrap=self.install_root/'installer/bootstrap';scripts=bootstrap/'scripts'
        with zipfile.ZipFile(report['archive']) as archive:
            for name in manifest['files']:
                if name.startswith('runtime/python/') or name in release.BOOTSTRAP_SCRIPTS:
                    target=bootstrap/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.read(name))
        installer.adopt_inno_shell(self.install_root,manifest)
        data=self.install_root/'data';data.mkdir()
        (data/'preview-installation.json').write_text(json.dumps({'schema':1,'installation_id':str(uuid.uuid4()),'binaries':{}}))
        command="import json,pathlib,sys; sys.path.insert(0,sys.argv[1]); import preview_installer; print(json.dumps(sorted(preview_installer.retained_owner_ids(pathlib.Path(sys.argv[2]),[]))))"
        result=subprocess.run([sys.executable,'-I','-S','-c',command,str(scripts),str(self.install_root)],
            capture_output=True,text=True,timeout=30,env={**os.environ,'PATH':''})
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),[])

    def test_install_phase_and_errno_report_does_not_expose_exception_paths(self):
        result=self.base/'safe-phase-result.json'
        argv=['preview_installer','install','--archive',str(self.base/'archive.zip'),'--sha256','a'*64,'--install-root',str(self.install_root),'--result-file',str(result)]
        for failed_phase in ('verify_pending','junction','verify_linked','publish','manager','select','init'):
            def fail(*args,on_phase=None,**kwargs):
                on_phase(failed_phase);error=PermissionError(13,'SECRET_EXCEPTION_TEXT','SECRET_PATH');error.winerror=32;raise error
            output=io.StringIO()
            with patch.object(sys,'argv',argv),patch.object(installer,'install_preview',side_effect=fail),redirect_stdout(output):
                self.assertEqual(installer.main(),2)
            value=json.loads(result.read_text());self.assertEqual(value['phase'],failed_phase);self.assertEqual(value['errno'],13);self.assertEqual(value['winerror'],32)
            self.assertNotIn('SECRET',result.read_text()+output.getvalue())

    def test_lifecycle_result_file_records_verified_success_and_fixed_failure_code(self):
        item=self.installed();result=self.base/'lifecycle-result.json'
        argv=['preview_installer','inspect','--install-root',str(self.install_root),'--result-file',str(result)]
        with patch.object(sys,'argv',argv),redirect_stdout(io.StringIO()):self.assertEqual(installer.main(),0)
        self.assertEqual(json.loads(result.read_text())['build_id'],item['build_id'])
        argv=['preview_installer','inspect','--install-root',str(self.base/'missing'),'--result-file',str(result)]
        with patch.object(sys,'argv',argv),redirect_stdout(io.StringIO()):self.assertEqual(installer.main(),2)
        failure=json.loads(result.read_text());self.assertEqual(failure['state'],'rejected');self.assertFalse(failure['processes_stopped'])

if __name__=='__main__':unittest.main()
