"""Candidate-only packaging tests. No installed application or model is started."""
from pathlib import Path
import copy, hashlib, json, os, shutil, sqlite3, sys, tempfile, unittest, zipfile
from contextlib import closing
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import web_workspace_release as release
from product_runtime import FileLease, ProductError

PROJECT=Path(__file__).resolve().parents[1]

class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.root=self.base/'source';self.root.mkdir();self.out=self.base/'archives';self.install_root=self.base/'isolated-install'
        self.files={}
        for name in release.REQUIRED-{'NOTICE.md'}:
            path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('fixture:'+name).encode())
            self.files[name]=path
        for name in ['web_workspace_release.py','product_runtime.py']:
            self.files['scripts/'+name].write_bytes((PROJECT/'scripts'/name).read_bytes())
        helper=self.root/'scripts/windows_process_owner.py';helper.write_bytes((PROJECT/'scripts/windows_process_owner.py').read_bytes());self.files['scripts/windows_process_owner.py']=helper
        for name in ['package.json','apps/web-host/package.json']:
            self.files[name].write_text(json.dumps({'name':'clw-web-workspace','version':'0.8.0-candidate','clw_data_epoch':1,'license':'MIT','private':True}))
        license_path=self.root/'LICENSE';license_path.write_bytes((PROJECT/'LICENSE').read_bytes());self.files['LICENSE']=license_path
        self.components=[{'name':'fixture-runtime','version':'test','license':'fixture-only',
          'path':'runtime/bun-1.4.0','license_files':['licenses/bun/LICENSE.md']}]
        self.real_process_rows=release.process_rows;self.owner_probe=patch.object(release,'process_rows',return_value=[]);self.owner_probe.start();self.addCleanup(self.owner_probe.stop)
    def tearDown(self):self.temp.cleanup()
    def prepared(self):
        return release.prepare(self.root,self.out,self.files['licenses/bun/LICENSE.md'],
          plan=(self.files,self.components),source_commit='a'*40)
    def installed(self):
        candidate=self.prepared();release.install(candidate['archive'],self.install_root,candidate['sha256']);return candidate
    def selected(self):
        candidate=self.installed();release.select(self.install_root,candidate['build_id'],None,owner_probe=lambda _:None);return candidate
    def preserved_data(self):
        data=self.install_root/'data';(data/'harness').mkdir(parents=True,exist_ok=True)
        db=data/'harness/harness.sqlite3'
        with closing(sqlite3.connect(db)) as con:
            con.execute('CREATE TABLE IF NOT EXISTS managed_goals(objective TEXT,review TEXT,original_key TEXT)')
            con.execute('INSERT INTO managed_goals VALUES(?,?,?)',('User goal','human acceptance','original-operation'))
            con.commit()
        profile=data/'web-host/Partitions/account/Profile';profile.parent.mkdir(parents=True);profile.write_bytes(b'private fake fixture profile')
        goal=data/'saved-goal.json';goal.write_bytes(b'{"review":"human","operation_id":"original","pending":"unknown"}')
        return {p:p.read_bytes() for p in [db,profile,goal]}
    def test_active_staging_can_be_separate_from_archive_storage(self):
        active=self.base/'active-ssd'
        item=release.prepare(self.root,self.out,self.files['licenses/bun/LICENSE.md'],
            plan=(self.files,self.components),source_commit='a'*40,staging=active)
        self.assertEqual(Path(item['archive']).parent,self.out)
        self.assertEqual(len(list(active.glob('preparing-*'))),1)
        self.assertFalse(list(self.out.glob('preparing-*')))
        self.assertEqual(release.verify_archive(item['archive'],item['sha256'])['build_id'],item['build_id'])
    def test_freeze_is_current_bytes_not_head_and_every_member_is_verified(self):
        self.files['apps/web-host/main.cjs'].write_bytes(b'current dirty worktree implementation')
        item=self.prepared();manifest=release.verify_archive(item['archive'],item['sha256'])
        self.assertEqual(manifest['source_kind'],'frozen_current_worktree');self.assertFalse(manifest['user_data_included'])
        self.assertEqual(manifest['files']['apps/web-host/main.cjs']['sha256'],hashlib.sha256(b'current dirty worktree implementation').hexdigest())
        self.assertEqual(item['model_sends'],0);self.assertEqual(set(manifest['files']),set(self.files)|{'NOTICE.md'})
    def test_new_candidate_records_mit_and_preserves_third_party_license(self):
        item=self.prepared();manifest=release.verify_archive(item['archive'],item['sha256'])
        self.assertEqual(manifest['project_distribution_license'],'MIT')
        self.assertEqual(manifest['distribution'],'open-source-unsigned-candidate')
        self.assertEqual(manifest['components'],self.components)
        with zipfile.ZipFile(item['archive']) as archive:
            self.assertEqual(archive.read('LICENSE'),(PROJECT/'LICENSE').read_bytes())
            notice=archive.read('NOTICE.md').decode()
        self.assertIn('MIT License',notice);self.assertIn('Copyright (c) 2026 CLW contributors',notice)
        self.assertIn('Third-party components retain their own licenses and rights.',notice)
        self.assertIn('| fixture-runtime | test | fixture-only | licenses/bun/LICENSE.md |',notice)
        self.assertNotIn('license has not been selected',notice)
    def test_old_unselected_candidate_installs_without_rewriting_license_metadata(self):
        old_notice=b'Internal unsigned candidate. The CLW project distribution license has not been selected.\n'
        def legacy(entries):
            entries.pop('LICENSE')
            entries['NOTICE.md']=old_notice
            manifest=json.loads(entries[release.MANIFEST]);manifest['project_distribution_license']='unselected';manifest.pop('distribution')
            manifest['files'].pop('LICENSE');manifest['files']['NOTICE.md']={'sha256':release.sha(old_notice),'bytes':len(old_notice)}
            manifest['payload_sha256']=release.sha(release.canonical(manifest['files']))
            entries[release.MANIFEST]=release.canonical(manifest)
        archive=self.rewritten_archive(legacy);original=archive.read_bytes()
        manifest=release.verify_archive(archive);release.install(archive,self.install_root,release.sha(original))
        installed=release.verify_version(self.install_root/'versions'/manifest['build_id'],self.install_root/'data')
        self.assertEqual(installed['project_distribution_license'],'unselected');self.assertNotIn('distribution',installed)
        self.assertEqual((self.install_root/'versions'/manifest['build_id']/'NOTICE.md').read_bytes(),old_notice)
        self.assertEqual(archive.read_bytes(),original)
    def test_new_login_helper_can_ship_without_rejecting_prior_archives(self):
        legacy=self.prepared()
        helper='scripts/install_local_mcp_startup.ps1'
        self.assertNotIn(helper,release.verify_archive(legacy['archive'])['files'])
        path=self.root/helper;path.write_bytes(b'param([switch]$CheckOnly)\n# fixture: no registration\n')
        self.files[helper]=path
        current=self.prepared()
        self.assertEqual(release.verify_archive(current['archive'])['files'][helper],release.file_hash(path))
        release.install(legacy['archive'],self.install_root,legacy['sha256'])
        self.assertNotIn(helper,release.verify_archive(legacy['archive'])['files'])
    def test_public_start_guide_is_bundle_readme_without_development_instance_documents(self):
        public=self.root/'docs/WEB_WORKSPACE_START.md';public.parent.mkdir(exist_ok=True);public.write_bytes(b'public first-run and data instructions')
        self.files['README.md']=public
        guide=self.root/'docs/product-receivers/MANAGED_WEB.md';guide.parent.mkdir();guide.write_bytes(b'public protocol with placeholder identities')
        self.files['docs/harness/MANAGED_WEB.md']=guide
        (self.root/'README.md').write_bytes(b'development-only private evidence links')
        (self.root/'CURRENT.md').write_bytes(b'private instance Session and task status')
        item=self.prepared();manifest=release.verify_archive(item['archive'])
        self.assertEqual(manifest['documentation_sources'],{'README.md':'docs/WEB_WORKSPACE_START.md','docs/harness/MANAGED_WEB.md':'docs/product-receivers/MANAGED_WEB.md'})
        self.assertNotIn('CURRENT.md',manifest['files'])
        with zipfile.ZipFile(item['archive']) as archive:
            self.assertEqual(archive.read('README.md'),public.read_bytes())
            self.assertEqual(archive.read('docs/harness/MANAGED_WEB.md'),guide.read_bytes())
    def test_install_unselected_and_upgrade_rollback_preserve_sql_profile_goal_bytes(self):
        old=self.selected();preserved=self.preserved_data()
        self.files['apps/web-host/main.cjs'].write_bytes(b'updated candidate implementation')
        new=self.installed();self.assertEqual(release.selected(self.install_root)['build_id'],old['build_id'])
        release.select(self.install_root,new['build_id'],old['build_id'],owner_probe=lambda _:None)
        self.assertEqual(release.inspect(self.install_root)['build_id'],new['build_id'])
        release.select(self.install_root,old['build_id'],new['build_id'],owner_probe=lambda _:None)
        self.assertEqual(release.inspect(self.install_root)['build_id'],old['build_id'])
        for path,original in preserved.items():self.assertEqual(path.read_bytes(),original)
        for item in [old,new]:self.assertTrue((self.install_root/'versions'/item['build_id']/'.local').is_dir())
        self.assertEqual((self.install_root/'versions'/new['build_id']/'.local').resolve(),(self.install_root/'data').resolve())
    def test_wrong_archive_digest_never_installs_code_or_user_data(self):
        item=self.prepared()
        with self.assertRaisesRegex(ProductError,'candidate_archive_sha_mismatch'):release.install(item['archive'],self.install_root,'0'*64)
        self.assertFalse((self.install_root/'data').exists())
    def rewritten_archive(self,mutate):
        item=self.prepared();output=self.base/'changed.zip'
        with zipfile.ZipFile(item['archive']) as src,zipfile.ZipFile(output,'w') as out:
            entries={name:src.read(name) for name in src.namelist()};mutate(entries)
            for name,value in entries.items():out.writestr(name,value)
        return output
    def test_changed_file_without_changed_manifest_is_rejected(self):
        archive=self.rewritten_archive(lambda entries:entries.update({'apps/web-host/main.cjs':b'tampered'}))
        with self.assertRaisesRegex(ProductError,'candidate_archive_file_mismatch'):release.verify_archive(archive)
    def test_extra_traversal_and_case_alias_zip_members_are_rejected(self):
        for name in ['../outside.txt','apps/web-host/MAIN.cjs','C:/outside.txt']:
            archive=self.rewritten_archive(lambda entries:entries.update({name:b'extra'}))
            with self.assertRaisesRegex(ProductError,'candidate_archive_members_invalid'):release.verify_archive(archive)
    def test_private_data_or_connection_config_cannot_enter_a_valid_manifest(self):
        manifest=release.verify_archive(self.prepared()['archive'])
        for name in ['.local/web-host/Cookies','config/connection.json','config/web-user-authorization.json','data/foreign.sqlite3','accounts/profile.json',
          'Config/web-user-authorization.json','Secrets/token.txt','.LOCAL/web-host/Cookies',
          'CURRENT.md','Evidence/private-status.json','data/private-profile.json','.env.production','data/ledger.sqlite3-wal']:
            candidate=copy.deepcopy(manifest);candidate['files'][name]={'sha256':'0'*64,'bytes':0};candidate['payload_sha256']=release.sha(release.canonical(candidate['files']))
            with self.assertRaisesRegex(ProductError,'candidate_private_payload_forbidden'):release.validate_manifest(candidate)
    def test_selection_cas_refuses_late_upgrade_without_touching_pointer_or_data(self):
        old=self.selected();new=self.installed();preserved=self.preserved_data();pointer=(self.install_root/'active.json').read_bytes()
        with self.assertRaisesRegex(ProductError,'candidate_selection_changed'):release.select(self.install_root,new['build_id'],None,owner_probe=lambda _:None)
        self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
        for path,value in preserved.items():self.assertEqual(path.read_bytes(),value)
    def test_changed_runtime_and_epoch_require_explicit_migration_and_do_not_replace_bun(self):
        old=self.selected();original=(self.install_root/'data/runtimes/bun-1.4.0/bun.exe').read_bytes()
        self.files['runtime/bun-1.4.0/bun.exe'].write_bytes(b'changed runtime');new=self.installed()
        with self.assertRaisesRegex(ProductError,'candidate_runtime_change_requires_migration'):release.select(self.install_root,new['build_id'],old['build_id'],owner_probe=lambda _:None)
        self.assertEqual((self.install_root/'data/runtimes/bun-1.4.0/bun.exe').read_bytes(),original)
        self.files['runtime/bun-1.4.0/bun.exe'].write_bytes(original)
        for name in ['package.json','apps/web-host/package.json']:
            self.files[name].write_text(json.dumps({'name':'clw-web-workspace','version':'0.8.0-candidate','clw_data_epoch':2}))
        incompatible=self.installed()
        with self.assertRaisesRegex(ProductError,'candidate_data_epoch_requires_migration'):release.select(self.install_root,incompatible['build_id'],old['build_id'],owner_probe=lambda _:None)
    def test_kernel_lease_prevents_version_switch_while_product_launcher_owns_data(self):
        old=self.selected();new=self.installed()
        with FileLease(self.install_root/'data/.run.lock'):
            with self.assertRaisesRegex(ProductError,'data_in_use_no_process_stopped'):release.select(self.install_root,new['build_id'],old['build_id'],owner_probe=lambda _:None)
        self.assertEqual(release.selected(self.install_root)['build_id'],old['build_id'])
    def test_exact_owned_process_and_unknown_retained_live_pid_both_block_switch(self):
        old=self.selected();new=self.installed();pointer=(self.install_root/'active.json').read_bytes()
        rows=[{'ProcessId':91,'CommandLine':'python "'+str(self.install_root/'versions'/old['build_id']/'scripts/web_host_launcher.py')+'"'}]
        with self.assertRaisesRegex(ProductError,'candidate_owned_process_running'):release.select(self.install_root,new['build_id'],old['build_id'],owner_probe=lambda root:release.require_idle(root,rows))
        folder=self.install_root/'data/web-host';folder.mkdir(exist_ok=True)
        (folder/'supervisor.json').write_text(json.dumps({'pid':92,'state':'running'}))
        with self.assertRaisesRegex(ProductError,'candidate_owner_pid_ambiguous'):release.select(self.install_root,new['build_id'],old['build_id'],owner_probe=lambda root:release.require_idle(root,[{'ProcessId':92,'CommandLine':None}]))
        self.assertEqual((self.install_root/'active.json').read_bytes(),pointer)
    def test_process_probe_failure_is_not_idleness(self):
        old=self.selected()
        with patch.object(release,'process_rows',side_effect=ProductError('candidate_process_ownership_unavailable')):
            with self.assertRaisesRegex(ProductError,'candidate_process_ownership_unavailable'):release.select(self.install_root,old['build_id'],old['build_id'])
    def test_retained_runtime_junction_is_rejected_before_creating_any_external_directory(self):
        item=self.installed();outside=self.base/'outside-runtime';outside.mkdir()
        release.junction(self.install_root/'data/runtimes',outside)
        with self.assertRaisesRegex(ProductError,'candidate_install_directory_link'):release.select(self.install_root,item['build_id'],None,owner_probe=lambda _:None)
        self.assertEqual(list(outside.iterdir()),[]);self.assertFalse((self.install_root/'active.json').exists())
    def test_owner_or_harness_junction_cannot_be_read_or_locked_as_product_data(self):
        for relative in ['web-host','harness']:
            item=self.installed();outside=self.base/('outside-'+relative);outside.mkdir()
            release.junction(self.install_root/'data'/relative,outside)
            with self.assertRaisesRegex(ProductError,'candidate_install_directory_link'):
                release.select(self.install_root,item['build_id'],None,owner_probe=lambda root:release.require_idle(root,[]))
            self.assertEqual(list(outside.iterdir()),[])
            # Windows directory junction removal removes the link itself only.
            link=self.install_root/'data'/relative
            if os.name=='nt':link.rmdir()
            else:link.unlink()
    def test_install_never_adopts_preexisting_unknown_user_data(self):
        (self.install_root/'data').mkdir(parents=True);foreign=self.install_root/'data/foreign-profile';foreign.write_bytes(b'preserve')
        item=self.prepared()
        with self.assertRaisesRegex(ProductError,'candidate_existing_data_not_adopted'):release.install(item['archive'],self.install_root,item['sha256'])
        self.assertEqual(foreign.read_bytes(),b'preserve')
    def test_first_install_does_not_overwrite_an_existing_launcher(self):
        self.install_root.mkdir();launcher=self.install_root/'LAUNCH.cmd';launcher.write_bytes(b'foreign user launcher')
        item=self.prepared()
        with self.assertRaisesRegex(ProductError,'candidate_existing_root_not_adopted'):release.install(item['archive'],self.install_root,item['sha256'])
        self.assertEqual(launcher.read_bytes(),b'foreign user launcher')
    def test_data_root_junction_is_rejected_before_any_external_lease_write(self):
        old=self.selected();data=self.install_root/'data';saved=self.install_root/'retained-data';data.rename(saved)
        outside=self.base/'outside-data';outside.mkdir();release.junction(data,outside)
        for call in [lambda:release.select(self.install_root,old['build_id'],old['build_id'],owner_probe=lambda _:None),lambda:release.launch(self.install_root,True)]:
            with self.assertRaisesRegex(ProductError,'candidate_install_directory_link'):call()
            self.assertEqual(list(outside.iterdir()),[])
    def test_data_link_or_code_manager_tamper_blocks_inspection(self):
        old=self.selected();code=self.install_root/'versions'/old['build_id'];(code/'apps/web-host/main.cjs').write_bytes(b'changed')
        with self.assertRaisesRegex(ProductError,'candidate_version_file_changed'):release.inspect(self.install_root)
        (code/'apps/web-host/main.cjs').write_bytes(self.files['apps/web-host/main.cjs'].read_bytes())
        (self.install_root/'manager/web_workspace_release.py').write_bytes(b'changed manager')
        with self.assertRaisesRegex(ProductError,'candidate_manager_changed'):release.inspect(self.install_root)
    def test_missing_selected_data_junction_is_rejected_without_creating_a_new_empty_ledger(self):
        old=self.selected();code=self.install_root/'versions'/old['build_id'];link=code/'.local'
        if os.name=='nt':link.rmdir()
        else:link.unlink()
        for call in [lambda:release.inspect(self.install_root),lambda:release.launch(self.install_root,True)]:
            with self.assertRaisesRegex(ProductError,'candidate_data_link_identity_invalid'):call()
            self.assertFalse(link.exists())
    def test_linked_version_root_is_rejected_before_reading_external_metadata(self):
        outside=self.base/'foreign-version';outside.mkdir()
        link=self.install_root/'versions'/'linked-version';link.parent.mkdir(parents=True)
        release.junction(link,outside)
        with patch.object(release,'read_json',side_effect=AssertionError('external metadata read')):
            with self.assertRaisesRegex(ProductError,'candidate_install_directory_link'):release.verify_version(link)
        self.assertEqual(list(outside.iterdir()),[])
    def test_interrupted_first_bun_copy_can_retry_without_replacing_existing_runtime(self):
        item=self.installed();bun=self.install_root/'data/runtimes/bun-1.4.0/bun.exe'
        def interrupted(source,target):
            Path(target).write_bytes(b'partial copy')
            raise OSError('fixture_copy_interrupted')
        with patch.object(release.shutil,'copyfile',side_effect=interrupted):
            with self.assertRaisesRegex(OSError,'fixture_copy_interrupted'):
                release.select(self.install_root,item['build_id'],None,owner_probe=lambda _:None)
        self.assertFalse(bun.exists());self.assertFalse((self.install_root/'active.json').exists())
        self.assertEqual(list(bun.parent.iterdir()),[])
        release.select(self.install_root,item['build_id'],None,owner_probe=lambda _:None)
        self.assertEqual(bun.read_bytes(),self.files['runtime/bun-1.4.0/bun.exe'].read_bytes())
        bun.write_bytes(b'foreign runtime')
        with self.assertRaisesRegex(ProductError,'candidate_shared_runtime_changed'):
            release.select(self.install_root,item['build_id'],item['build_id'],owner_probe=lambda _:None)
        self.assertEqual(bun.read_bytes(),b'foreign runtime')
    def test_same_archive_replay_recovers_manager_after_an_interrupted_initial_install(self):
        item=self.prepared()
        with patch.object(release,'ensure_manager',side_effect=ProductError('fixture_interrupted')):
            with self.assertRaisesRegex(ProductError,'fixture_interrupted'):release.install(item['archive'],self.install_root,item['sha256'])
        self.assertTrue((self.install_root/'versions'/item['build_id']).exists());self.assertFalse((self.install_root/'manager').exists())
        result=release.install(item['archive'],self.install_root,item['sha256'])
        self.assertTrue(result['replayed']);release.verify_manager(self.install_root)
        release.select(self.install_root,item['build_id'],None,owner_probe=lambda _:None)
        self.assertFalse(release.inspect(self.install_root)['application_started'])
    def test_install_replay_recreates_only_a_missing_known_launcher_and_preserves_unknown_manager(self):
        item=self.installed();launcher=self.install_root/'LAUNCH.cmd';launcher.unlink()
        release.install(item['archive'],self.install_root,item['sha256']);self.assertEqual(launcher.read_bytes(),release.LAUNCHER)
        (self.install_root/'manager/product_runtime.py').write_bytes(b'unknown modification')
        with self.assertRaisesRegex(ProductError,'candidate_install_incomplete'):release.install(item['archive'],self.install_root,item['sha256'])
        self.assertEqual((self.install_root/'manager/product_runtime.py').read_bytes(),b'unknown modification')
    def test_local_runtime_json_reference_cannot_be_dropped_from_source_manifest(self):
        source=self.root/'apps/example.cjs';source.parent.mkdir(exist_ok=True);source.write_text("require('./reported-blockers.json')")
        selected={'apps/example.cjs':source}
        with self.assertRaisesRegex(ProductError,'candidate_local_module_missing'):release.verify_local_code_references(self.root,selected)
        rules=source.parent/'reported-blockers.json';rules.write_text('{}');selected['apps/reported-blockers.json']=rules
        release.verify_local_code_references(self.root,selected)
    def test_inspect_only_validates_real_selection_without_invoking_existing_supervisor(self):
        old=self.selected()
        with patch.object(release,'require_idle'),patch.object(release.subprocess,'run',side_effect=AssertionError('application started')):
            report=release.launch(self.install_root,inspect_only=True)
        self.assertEqual(report['build_id'],old['build_id']);self.assertFalse(report['application_started']);self.assertEqual(report['model_sends'],0)
    def test_daily_launch_uses_installation_locks_without_global_maintenance_inventory(self):
        old=self.selected();calls=[]
        def run(*args,**kwargs):
            calls.append((args,kwargs))
            with FileLease(self.install_root/'.release.lock'):pass
            with self.assertRaisesRegex(ProductError,'data_in_use_no_process_stopped'):
                with FileLease(self.install_root/'data/.run.lock'):pass
            return type('Completed',(),{'returncode':0})()
        with patch.object(release,'process_rows',side_effect=AssertionError('global process inventory')),patch.object(release,'require_idle',side_effect=AssertionError('maintenance idle gate')),patch('preview_installer.workspace_idle',side_effect=AssertionError('maintenance preview gate')),patch.object(release.subprocess,'run',side_effect=run):
            result=release.launch(self.install_root)
        self.assertEqual(result['state'],'candidate_supervisor_exited');self.assertEqual(result['build_id'],old['build_id']);self.assertEqual(len(calls),1)
    def test_busy_launch_lease_only_focuses_proven_original_and_never_runs_launcher(self):
        self.selected()
        with FileLease(self.install_root/'data/.run.lock'),patch.object(release,'focus_running_workspace',return_value=0) as focus,patch.object(release.subprocess,'run',side_effect=AssertionError('duplicate launcher')):
            self.assertEqual(release.launch(self.install_root)['state'],'candidate_existing_focused')
        focus.assert_called_once()
        with FileLease(self.install_root/'data/.run.lock'),patch.object(release,'focus_running_workspace',side_effect=ProductError('web_workspace_original_owner_unverified')),patch.object(release.subprocess,'run',side_effect=AssertionError('unknown owner launcher')):
            with self.assertRaisesRegex(ProductError,'original_owner_unverified'):release.launch(self.install_root)
    def test_unknown_original_start_and_busy_harness_refuse_before_any_spawn(self):
        self.selected()
        for relative in ('preview-launch.json','web-host/shared-entry-start.json'):
            path=self.install_root/'data'/relative;path.parent.mkdir(parents=True,exist_ok=True);release.atomic_json(path,{'completion_unknown':True})
            with patch.object(release.subprocess,'run',side_effect=AssertionError('unknown startup replay')):
                with self.assertRaisesRegex(ProductError,'completion_unknown'):release.launch(self.install_root)
            path.unlink()
        with FileLease(self.install_root/'data/harness/.instance.lock'),patch.object(release.subprocess,'run',side_effect=AssertionError('active harness start')):
            with self.assertRaisesRegex(ProductError,'data_in_use_no_process_stopped'):release.launch(self.install_root)
        with FileLease(self.install_root/'data/.run.lock'):pass
    def test_local_python_closure_follows_conditional_and_literal_dynamic_imports(self):
        scripts=self.root/'scripts';(scripts/'seed.py').write_text("import importlib\nif False: import branch\nimportlib.import_module('dynamic')\n__import__('literal')")
        for name in ['branch','dynamic','literal']:(scripts/(name+'.py')).write_text('import json')
        names={p.stem for p in release.local_modules(self.root,{'seed'})}
        self.assertEqual(names,{'seed','branch','dynamic','literal'})
    def test_installed_production_closure_excludes_dev_and_unknown_directories(self):
        entry=self.root/'apps/fake';entry.mkdir();(entry/'package.json').write_text(json.dumps({'dependencies':{'prod':'1'},'devDependencies':{'dev':'1'}}))
        for name,dependencies in [('prod',{'transitive':'1'}),('transitive',{}),('dev',{}),('unrelated',{})]:
            pkg=entry/'node_modules'/name;pkg.mkdir(parents=True);(pkg/'package.json').write_text(json.dumps({'name':name,'version':'1.0.0','license':'MIT','dependencies':dependencies}));(pkg/'LICENSE').write_text('fixture license')
        files={};components=[];seen=release.production_packages(self.root,entry,files,components)
        self.assertEqual(seen,{'prod','transitive'});self.assertFalse(any('/dev/' in n or '/unrelated/' in n for n in files))
        self.assertTrue(all(c['license_files'] for c in components))
    def test_formal_prepare_records_real_browser_inventory_in_manifest_and_notice(self):
        vendor=self.root/release.BROWSER_VENDOR_PATH;shutil.copytree(PROJECT/release.BROWSER_VENDOR_PATH,vendor)
        release.collect_tree(vendor,self.root,self.files);release.browser_vendors(self.root,self.files,self.components)
        item=self.prepared();manifest=release.verify_archive(item['archive'],item['sha256'])
        browser=[c for c in manifest['components'] if c.get('metadata_file')];self.assertEqual(len(browser),3)
        with zipfile.ZipFile(item['archive']) as archive:
            notice=archive.read('NOTICE.md').decode()
            for component in browser:
                meta=json.loads(archive.read(component['metadata_file']))
                self.assertEqual(manifest['files'][component['metadata_file']],{'sha256':component['metadata_sha256'],'bytes':component['metadata_bytes']})
                for relative,entry in meta['files'].items():self.assertEqual(manifest['files'][component['path']+'/'+relative],entry)
                self.assertIn(component['metadata_file'],notice)
    def test_formal_prepare_rejects_original_vendor_drift_and_a_late_copy_tamper(self):
        vendor=self.root/release.BROWSER_VENDOR_PATH;shutil.copytree(PROJECT/release.BROWSER_VENDOR_PATH,vendor)
        release.collect_tree(vendor,self.root,self.files);release.browser_vendors(self.root,self.files,self.components)
        font=vendor/'katex/fonts/KaTeX_Main-Regular.woff2';original=font.read_bytes();font.write_bytes(original+b'drift')
        with self.assertRaisesRegex(ProductError,'vendor_file_mismatch'):self.prepared()
        font.write_bytes(original);copy_original=release.shutil.copyfile
        def tamper(source,destination):
            result=copy_original(source,destination)
            if Path(destination).name=='katex.min.js':Path(destination).write_bytes(Path(destination).read_bytes()+b'late copied change')
            return result
        with patch.object(release.shutil,'copyfile',side_effect=tamper),self.assertRaisesRegex(ProductError,'source_changed_during_freeze'):self.prepared()
        self.assertFalse(list(self.out.glob('*.zip')))
    def test_misaligned_root_and_web_version_cannot_be_frozen(self):
        self.files['apps/web-host/package.json'].write_text(json.dumps({'version':'different'}))
        with self.assertRaisesRegex(ProductError,'candidate_product_versions_differ'):self.prepared()
    def legacy_manager(self):
        helper=self.files.pop('scripts/windows_process_owner.py');old=self.installed();self.files['scripts/windows_process_owner.py']=helper
        identity=release.verify_manager(self.install_root);self.assertNotIn('manager/windows_process_owner.py',identity['files'])
        before={p.name:p.read_bytes() for p in (self.install_root/'manager').iterdir()};return old,before
    def test_fresh_native_manager_contains_verified_helper_and_literal_python_closure(self):
        self.installed();identity=release.verify_manager(self.install_root)
        self.assertIn('manager/windows_process_owner.py',identity['files'])
        self.assertEqual((self.install_root/'manager/windows_process_owner.py').read_bytes(),(PROJECT/'scripts/windows_process_owner.py').read_bytes())
        self.assertIn('windows_process_owner',{p.stem for p in release.local_modules(self.root,{'web_workspace_release'})})
    def test_verified_modern_manager_upgrade_uses_full_release_transaction_and_old_replay_cannot_downgrade(self):
        old=self.installed();before={p.name:p.read_bytes() for p in (self.install_root/'manager').iterdir()}
        self.files['scripts/web_workspace_release.py'].write_bytes(self.files['scripts/web_workspace_release.py'].read_bytes()+b'\n# later verified manager\n')
        new=self.prepared();release.install(new['archive'],self.install_root,new['sha256'])
        identity=release.verify_manager(self.install_root);receipt=release.read_json(self.install_root/'.manager-upgrade.json')
        self.assertEqual(receipt['purpose'],'verified_release');self.assertEqual(receipt['state'],'completed')
        self.assertEqual(identity['files']['manager/web_workspace_release.py'],release.file_hash(self.files['scripts/web_workspace_release.py']))
        self.assertEqual({p.name:p.read_bytes() for p in (self.install_root/receipt['backup']).iterdir()},before)
        release.install(old['archive'],self.install_root,old['sha256']);self.assertEqual(release.verify_manager(self.install_root),identity)
        release.select(self.install_root,new['build_id'],None,owner_probe=lambda _:None)
        release.select(self.install_root,old['build_id'],new['build_id'],owner_probe=lambda _:None)
        self.assertEqual(release.verify_manager(self.install_root),identity)
    def test_modern_upgrade_reverifies_full_new_release_after_staging_before_publish(self):
        self.installed();before=(self.install_root/'manager/identity.json').read_bytes()
        self.files['scripts/web_workspace_release.py'].write_bytes(self.files['scripts/web_workspace_release.py'].read_bytes()+b'\n# next verified source\n');new=self.prepared();stage=release.stage_manager
        def damage(directory,code):
            result=stage(directory,code);(code/'apps/web-host/main.cjs').write_bytes(b'late non-manager source damage');return result
        with patch.object(release,'stage_manager',side_effect=damage),self.assertRaisesRegex(ProductError,'candidate_version_file_changed'):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((self.install_root/'manager/identity.json').read_bytes(),before);release.verify_manager(self.install_root)
    def test_rehashed_unknown_modern_manager_and_damaged_full_old_release_cannot_authorize_upgrade(self):
        for damage in ('manager','release'):
            with self.subTest(damage=damage):
                self.install_root=self.base/('modern-'+damage);old=self.installed();manager=self.install_root/'manager'
                if damage=='manager':
                    (manager/'web_workspace_release.py').write_bytes(b'unknown modern code')
                    identity=release.read_json(manager/'identity.json');identity['files']['manager/web_workspace_release.py']=release.file_hash(manager/'web_workspace_release.py');release.atomic_json(manager/'identity.json',identity)
                else:(self.install_root/'versions'/old['build_id']/'apps/web-host/main.cjs').write_bytes(b'unknown old release bytes')
                before={p.name:p.read_bytes() for p in manager.iterdir()}
                self.files['scripts/web_workspace_release.py'].write_bytes(self.files['scripts/web_workspace_release.py'].read_bytes()+b'\n# later\n')
                new=self.prepared()
                with self.assertRaisesRegex(ProductError,'original_unknown|version_file_changed'):release.install(new['archive'],self.install_root,new['sha256'])
                self.assertEqual({p.name:p.read_bytes() for p in manager.iterdir()},before)
                self.assertFalse((self.install_root/'.manager-upgrade.json').exists())
    def test_modern_manager_interruption_recovers_original_verified_stage_only(self):
        self.installed();self.files['scripts/web_workspace_release.py'].write_bytes(self.files['scripts/web_workspace_release.py'].read_bytes()+b'\n# later modern\n');new=self.prepared();replace=release.os.replace
        def interrupted(source,target):
            if Path(source).name.startswith('manager-preparing-') and Path(target).name=='manager':raise KeyboardInterrupt('fixture interruption')
            return replace(source,target)
        with patch.object(release.os,'replace',side_effect=interrupted),self.assertRaises(KeyboardInterrupt):release.install(new['archive'],self.install_root,new['sha256'])
        transaction=release.read_json(self.install_root/'.manager-upgrade.json');self.assertEqual(transaction['state'],'prepared');self.assertFalse((self.install_root/'manager').exists())
        release.install(new['archive'],self.install_root,new['sha256']);self.assertEqual(release.read_json(self.install_root/'.manager-upgrade.json')['state'],'completed')
        self.assertEqual(release.verify_manager(self.install_root),transaction['new_identity'])
    def test_verified_legacy_manager_upgrade_preserves_exact_old_bytes_and_replays_new_manager(self):
        old,before=self.legacy_manager();new=self.prepared();release.install(new['archive'],self.install_root,new['sha256'])
        identity=release.verify_manager(self.install_root);self.assertIn('manager/windows_process_owner.py',identity['files'])
        receipt=release.read_json(self.install_root/'.manager-upgrade.json');self.assertEqual(receipt['state'],'completed')
        backup=self.install_root/receipt['backup'];self.assertEqual({p.name:p.read_bytes() for p in backup.iterdir()},before)
        release.install(old['archive'],self.install_root,old['sha256']);self.assertEqual(release.verify_manager(self.install_root),identity)
    def test_legacy_manager_with_changed_code_even_rehashed_identity_is_not_an_upgrade_source(self):
        self.legacy_manager();manager=self.install_root/'manager';(manager/'web_workspace_release.py').write_bytes(b'unknown manager code')
        identity=release.read_json(manager/'identity.json');identity['files']['manager/web_workspace_release.py']=release.file_hash(manager/'web_workspace_release.py');release.atomic_json(manager/'identity.json',identity)
        new=self.prepared()
        with self.assertRaisesRegex(ProductError,'upgrade_original_unknown'):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((manager/'web_workspace_release.py').read_bytes(),b'unknown manager code');self.assertFalse((manager/'windows_process_owner.py').exists())
    def test_legacy_manager_source_version_nonmanager_damage_cannot_authorize_upgrade(self):
        old,before=self.legacy_manager();code=self.install_root/'versions'/old['build_id']
        (code/'apps/web-host/main.cjs').write_bytes(b'damaged original release')
        new=self.prepared()
        with self.assertRaisesRegex(ProductError,'candidate_version_file_changed'):
            release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual({p.name:p.read_bytes() for p in (self.install_root/'manager').iterdir()},before)
        self.assertFalse((self.install_root/'.manager-upgrade.json').exists())
    def test_active_or_retained_ambiguous_owner_refuses_manager_upgrade_before_stage(self):
        self.legacy_manager();new=self.prepared();before=(self.install_root/'manager/identity.json').read_bytes()
        with patch.object(release,'process_rows',return_value=[{'ProcessId':92,'CommandLine':str(self.install_root/'versions'/'old'/'app')}]),self.assertRaisesRegex(ProductError,'owned_process_running'):
            release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((self.install_root/'manager/identity.json').read_bytes(),before);self.assertFalse((self.install_root/'.manager-upgrade.json').exists())
    def test_concurrent_original_manager_change_during_staging_is_preserved_and_not_published(self):
        self.legacy_manager();new=self.prepared();stage_original=release.stage_manager;manager=self.install_root/'manager';changed=b'concurrent original modification'
        def stage(*args):
            result=stage_original(*args);(manager/'web_workspace_release.py').write_bytes(changed);return result
        with patch.object(release,'stage_manager',side_effect=stage),self.assertRaisesRegex(ProductError,'manager_changed'):
            release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((manager/'web_workspace_release.py').read_bytes(),changed);self.assertFalse((manager/'windows_process_owner.py').exists())
    def test_partial_stage_write_leaves_original_manager_whole(self):
        self.legacy_manager();new=self.prepared();before=(self.install_root/'manager/identity.json').read_bytes();copy_original=release.shutil.copyfile
        def copy(source,destination):
            if Path(destination).name=='windows_process_owner.py':Path(destination).write_bytes(b'partial');raise OSError('fixture partial write')
            return copy_original(source,destination)
        with patch.object(release.shutil,'copyfile',side_effect=copy),self.assertRaises(OSError):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((self.install_root/'manager/identity.json').read_bytes(),before);release.verify_manager(self.install_root)
    def test_atomic_publish_failure_restores_original_directory_and_retains_staged_proof(self):
        self.legacy_manager();new=self.prepared();before=(self.install_root/'manager/identity.json').read_bytes();replace_original=release.os.replace
        def replace(source,destination):
            if Path(source).name.startswith('manager-preparing-') and Path(destination).name=='manager':raise OSError('fixture publish failure')
            return replace_original(source,destination)
        with patch.object(release.os,'replace',side_effect=replace),self.assertRaises(OSError):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertEqual((self.install_root/'manager/identity.json').read_bytes(),before);self.assertEqual(release.read_json(self.install_root/'.manager-upgrade.json')['state'],'rolled_back');release.verify_manager(self.install_root)
    def test_interruption_between_directory_renames_recovers_only_original_recorded_stage(self):
        self.legacy_manager();new=self.prepared();replace_original=release.os.replace
        def replace(source,destination):
            if Path(source).name.startswith('manager-preparing-') and Path(destination).name=='manager':raise KeyboardInterrupt('fixture process interruption')
            return replace_original(source,destination)
        with patch.object(release.os,'replace',side_effect=replace),self.assertRaises(KeyboardInterrupt):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertFalse((self.install_root/'manager').exists());self.assertEqual(release.read_json(self.install_root/'.manager-upgrade.json')['state'],'prepared')
        release.install(new['archive'],self.install_root,new['sha256']);self.assertIn('manager/windows_process_owner.py',release.verify_manager(self.install_root)['files']);self.assertEqual(release.read_json(self.install_root/'.manager-upgrade.json')['state'],'completed')
    def test_original_edit_in_the_last_directory_rename_window_is_restored_and_preserved(self):
        self.legacy_manager();new=self.prepared();replace_original=release.os.replace;manager=self.install_root/'manager';changed=b'late original edit'
        def replace(source,destination):
            if Path(source)==manager:(manager/'web_workspace_release.py').write_bytes(changed)
            return replace_original(source,destination)
        with patch.object(release.os,'replace',side_effect=replace),self.assertRaisesRegex(ProductError,'manager_changed'):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertTrue(manager.exists());self.assertEqual((manager/'web_workspace_release.py').read_bytes(),changed);self.assertFalse((manager/'windows_process_owner.py').exists())
    def test_uncommitted_complete_new_manager_is_reconciled_without_replacing_its_bytes(self):
        self.legacy_manager();new=self.prepared();write_original=release.atomic_json
        def write(path,value):
            if Path(path).name=='.manager-upgrade.json' and value.get('state')=='completed':raise OSError('fixture final audit write')
            return write_original(path,value)
        with patch.object(release,'atomic_json',side_effect=write),self.assertRaises(OSError):release.install(new['archive'],self.install_root,new['sha256'])
        before={p.name:p.read_bytes() for p in (self.install_root/'manager').iterdir()};release.verify_manager(self.install_root)
        release.install(new['archive'],self.install_root,new['sha256']);self.assertEqual({p.name:p.read_bytes() for p in (self.install_root/'manager').iterdir()},before);self.assertEqual(release.read_json(self.install_root/'.manager-upgrade.json')['state'],'completed')
    def test_changed_recorded_stage_after_interruption_is_not_adopted_as_a_manager(self):
        self.legacy_manager();new=self.prepared();replace_original=release.os.replace
        def replace(source,destination):
            if Path(source).name.startswith('manager-preparing-') and Path(destination).name=='manager':raise KeyboardInterrupt('fixture interruption')
            return replace_original(source,destination)
        with patch.object(release.os,'replace',side_effect=replace),self.assertRaises(KeyboardInterrupt):release.install(new['archive'],self.install_root,new['sha256'])
        receipt=release.read_json(self.install_root/'.manager-upgrade.json');stage=self.install_root/receipt['stage'];(stage/'windows_process_owner.py').write_bytes(b'unknown staged change')
        with self.assertRaisesRegex(ProductError,'manager_changed|stage_changed'):release.install(new['archive'],self.install_root,new['sha256'])
        self.assertFalse((self.install_root/'manager').exists());self.assertEqual((stage/'windows_process_owner.py').read_bytes(),b'unknown staged change');self.assertTrue((self.install_root/receipt['backup']).exists())
    def test_manager_native_read_failure_remains_unavailable_without_cim_fallback(self):
        import windows_process_owner as owners
        with patch.object(owners,'process_inventory',side_effect=owners.OwnershipUnavailable()),patch.object(release.os,'name','nt'),patch.object(release.subprocess,'run',side_effect=AssertionError('CIM fallback')):
            with self.assertRaisesRegex(ProductError,'candidate_process_ownership_unavailable'):self.real_process_rows()

    @unittest.skipUnless(os.name=='nt','Windows native process census')
    def test_actual_foreign_python_exit_allows_select_and_inspect_only_without_launch(self):
        import windows_process_owner as owners
        old=self.selected();new=self.installed()
        for operation in ('select','inspect'):
            child=release.subprocess.Popen([sys.executable,'-B','-c','import time;time.sleep(1)'],
              stdin=release.subprocess.DEVNULL,stdout=release.subprocess.DEVNULL,stderr=release.subprocess.DEVNULL,
              close_fds=True,creationflags=getattr(release.subprocess,'CREATE_NO_WINDOW',0))
            try:
                api=owners._NativeApi();snapshot=api.snapshot;calls=[]
                def scoped_snapshot():
                    if calls:child.wait(timeout=4)
                    calls.append(1)
                    return {pid:row for pid,row in snapshot().items() if pid in {os.getpid(),child.pid}}
                api.snapshot=scoped_snapshot
                with patch.object(owners,'_NativeApi',return_value=api),patch.object(release,'process_rows',self.real_process_rows),patch.object(release.subprocess,'run',side_effect=AssertionError('application launched')):
                    if operation=='select':
                        release.select(self.install_root,new['build_id'],old['build_id'])
                        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])
                    else:
                        report=release.launch(self.install_root,inspect_only=True)
                        self.assertEqual(report['build_id'],new['build_id']);self.assertFalse(report['application_started']);self.assertEqual(report['model_sends'],0)
                self.assertEqual(calls,[1,1] if operation=='select' else [])
                child.wait(timeout=4);self.assertEqual(child.returncode,0)
            finally:
                if child.poll() is None:child.kill();child.wait(timeout=4) # This exact isolated fixture only.

    @unittest.skipUnless(os.name=='nt','Windows native process census')
    def test_transient_observation_retry_does_not_repeat_selection_publication(self):
        import windows_process_owner as owners
        old=self.selected();new=self.installed();calls=[];delays=[];writes=[];write=release.atomic_json
        def observe(**kwargs):
            calls.append(kwargs)
            if len(calls)<3:raise owners.OwnershipUnavailable()
            foreign={'ProcessId':19,'CommandLine':'python unrelated.py','ExecutablePath':r'C:\Python\python.exe'}
            self.assertFalse(kwargs['candidate_filter'](foreign));return []
        def publish(path,value):
            if Path(path).name=='active.json':writes.append(value)
            return write(path,value)
        def rows(install):return self.real_process_rows(install,sleep=delays.append)
        with patch.object(owners,'process_inventory',side_effect=observe),patch.object(release,'process_rows',rows),patch.object(release,'atomic_json',side_effect=publish):
            release.select(self.install_root,new['build_id'],old['build_id'])
        self.assertEqual(len(calls),3);self.assertEqual(delays,[.025,.075]);self.assertEqual(len(writes),1)
        self.assertEqual(release.selected(self.install_root)['build_id'],new['build_id'])


@unittest.skipUnless(os.name=='nt','Windows native process census')
class InstallationProcessTests(unittest.TestCase):
    def setUp(self):
        import windows_process_owner as owners
        self.owners=owners;self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.install=Path(self.temp.name)/'isolated-install';(self.install/'data').mkdir(parents=True)
    def row(self,pid,*,owned=False,image=None,command=None,name='python.exe'):
        return {'ProcessId':pid,'ParentProcessId':1,'ProcessName':name,'CreationFiletime':'1234',
          'ExecutablePath':image or r'C:\Python\python.exe',
          'CommandLine':command if command is not None else ('python "'+str(self.install/'versions/build/scripts/serve.py')+'"' if owned else 'python unrelated.py')}
    def api(self,first,last=None):
        owners=self.owners
        class Api:
            def __init__(inner):
                inner.calls=0;inner.closed=[];inner.rows={**first,**(last if last is not None else first)}
            def snapshot(inner):
                inner.calls+=1;source=first if inner.calls==1 else (last if last is not None else first)
                return {pid:{'name':row['ProcessName'],'parent':row['ParentProcessId']} for pid,row in source.items()}
            def open(inner,pid):return pid
            def marker(inner,handle):return int(inner.rows[handle]['CreationFiletime'])
            def image(inner,handle):
                value=inner.rows[handle]['ExecutablePath']
                if value is None:raise owners.OwnershipUnavailable()
                return value
            def command_line(inner,handle):
                value=inner.rows[handle]['CommandLine']
                if value is None:raise owners.OwnershipUnavailable()
                return value
            def close(inner,handle):inner.closed.append(handle)
        return Api()
    def test_identified_foreign_exit_keeps_last_complete_pid_census_for_retained_owner(self):
        api=self.api({17:self.row(17),92:self.row(92,name='other.exe',image=r'C:\Other\other.exe')},
                     {92:self.row(92,name='other.exe',image=r'C:\Other\other.exe')})
        with patch.object(self.owners,'_NativeApi',return_value=api):
            rows=release.process_rows(self.install,sleep=lambda _:self.fail('classified foreign exit should not retry'))
        self.assertEqual(rows,[{'ProcessId':92,'CommandLine':None,'ProcessName':'other.exe'}])
        release.require_idle(self.install,rows)
        folder=self.install/'data/web-host';folder.mkdir();(folder/'supervisor.json').write_text(json.dumps({'pid':92,'state':'running'}))
        with self.assertRaisesRegex(ProductError,'candidate_owner_pid_ambiguous'):release.require_idle(self.install,rows)
        self.assertEqual(api.closed,[17])
    def test_target_version_executable_with_bare_argv_still_blocks(self):
        row=self.row(17,image=str(self.install/'versions/build/python.exe'),command='python -B serve.py')
        api=self.api({17:row})
        with patch.object(self.owners,'_NativeApi',return_value=api):
            rows=release.process_rows(self.install)
        self.assertEqual(rows[0]['ExecutablePath'],row['ExecutablePath'])
        with self.assertRaisesRegex(ProductError,'candidate_owned_process_running'):release.require_idle(self.install,rows)
    def test_new_target_candidate_is_classified_before_idle_result(self):
        api=self.api({17:self.row(17)},{17:self.row(17),23:self.row(23,owned=True)})
        with patch.object(self.owners,'_NativeApi',return_value=api):rows=release.process_rows(self.install)
        self.assertEqual(next(row for row in rows if row['ProcessId']==23)['CreationFiletime'],'1234')
        with self.assertRaisesRegex(ProductError,'candidate_owned_process_running'):release.require_idle(self.install,rows)
    def test_related_unreadable_identity_or_creation_change_exhausts_only_three_observations(self):
        for kind in ('argv','image','creation','exit'):
            calls=[];delays=[]
            def native():
                row=self.row(17,owned=True)
                if kind in ('argv','image'):row['CommandLine' if kind=='argv' else 'ExecutablePath']=None
                api=self.api({17:row},{} if kind=='exit' else None);calls.append(api)
                if kind=='creation':
                    markers=[]
                    def marker(handle):markers.append(handle);return 1234 if len(markers)==1 else 5678
                    api.marker=marker
                return api
            with self.subTest(kind=kind),patch.object(self.owners,'_NativeApi',side_effect=native),self.assertRaisesRegex(ProductError,'candidate_process_ownership_unavailable'):
                release.process_rows(self.install,sleep=delays.append)
            self.assertEqual(len(calls),3);self.assertEqual(delays,[.025,.075])
    def test_malformed_classification_cannot_hide_an_unknown_possible_owner(self):
        delays=[]
        def observe(**kwargs):
            kwargs['candidate_filter']({'ProcessId':17,'CommandLine':None,'ExecutablePath':str(self.install/'versions/build/python.exe')})
        with patch.object(self.owners,'process_inventory',side_effect=observe) as inventory,self.assertRaisesRegex(ProductError,'candidate_process_ownership_unavailable'):
            release.process_rows(self.install,sleep=delays.append)
        self.assertEqual(inventory.call_count,3);self.assertEqual(delays,[.025,.075])

class BrowserVendorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)/'source'
        self.vendor=self.root/release.BROWSER_VENDOR_PATH
        shutil.copytree(PROJECT/release.BROWSER_VENDOR_PATH,self.vendor)
    def inventory(self):
        selected={};components=[];release.collect_tree(self.vendor,self.root,selected)
        release.browser_vendors(self.root,selected,components);return selected,components
    def metadata(self,name='markdown-it'):
        return self.vendor/name/'UPSTREAM.json'
    def edit_metadata(self,change,name='markdown-it'):
        file=self.metadata(name);value=release.read_json(file);change(value);file.write_text(json.dumps(value),encoding='utf8')
    def test_real_approved_browser_metadata_is_the_exact_offline_inventory_and_notice(self):
        selected,components=self.inventory();self.assertEqual(len(components),3)
        expected=set()
        for component in components:
            name=component['name'];meta=release.read_json(PROJECT/release.BROWSER_VENDOR_PATH/name/'UPSTREAM.json');prefix=release.BROWSER_VENDOR_PATH+'/'+name+'/'
            self.assertEqual((component['version'],component['license'],component['source']),(meta['version'],meta['license'],meta['source']))
            self.assertEqual(component['files'],sorted(prefix+n for n in meta['files']))
            self.assertEqual(component['license_files'],[prefix+'LICENSE']);self.assertEqual(component['metadata_file'],prefix+'UPSTREAM.json')
            self.assertEqual({'sha256':component['metadata_sha256'],'bytes':component['metadata_bytes']},release.file_hash(self.metadata(name)))
            for relative,entry in meta['files'].items():self.assertEqual(release.file_hash(selected[prefix+relative]),entry)
            expected.update(component['files']);expected.add(component['metadata_file'])
        self.assertEqual(set(selected),expected);release.verify_browser_inventory(self.root,selected,components)
        notice=release.notice(components).decode()
        for component in components:
            self.assertIn('| '+component['name']+' | '+component['version']+' | MIT | '+component['license_files'][0]+' |',notice)
            self.assertIn(component['metadata_file']+'; '+str(len(component['files']))+' selected files; SHA256 '+component['metadata_sha256'],notice)
    def test_modified_or_missing_original_scripts_fonts_and_licenses_refuse_inventory(self):
        for relative in ['markdown-it/markdown-it.min.js','katex/fonts/KaTeX_Main-Regular.woff2','markdown-it-texmath/LICENSE']:
            with self.subTest(file=relative):
                file=self.vendor/relative;original=file.read_bytes();file.write_bytes(original+b'tampered')
                with self.assertRaisesRegex(ProductError,'vendor_file_mismatch'):self.inventory()
                file.write_bytes(original);file.unlink()
                with self.assertRaisesRegex(ProductError,'candidate_source_missing'):self.inventory()
                file.write_bytes(original)
    def test_paths_cannot_escape_vendor_source_or_alias_metadata_files(self):
        original=self.metadata().read_bytes()
        for relative in ['../private.txt','/private.txt','C:/private.txt','fonts\\outside.js','UPSTREAM.json','license']:
            with self.subTest(path=relative):
                self.edit_metadata(lambda meta:meta['files'].update({relative:{'bytes':1,'sha256':'a'*64}}))
                with self.assertRaisesRegex(ProductError,'vendor_file_entry_invalid'):self.inventory()
                self.metadata().write_bytes(original)
    def test_missing_license_unknown_component_identity_and_empty_or_changed_file_records_are_rejected(self):
        original=self.metadata().read_bytes()
        for change in [lambda m:m['files'].pop('LICENSE'),lambda m:m.update(license=''),lambda m:m.update(name='other'),
          lambda m:m.update(version='99.0.0'),lambda m:m['files']['LICENSE'].update(bytes=True),lambda m:m['files']['LICENSE'].update(sha256='bad')]:
            with self.subTest(change=change):
                self.edit_metadata(change)
                with self.assertRaises(ProductError):self.inventory()
                self.metadata().write_bytes(original)
    def test_unlisted_files_and_unapproved_vendor_directories_cannot_silently_ship(self):
        extra=self.vendor/'markdown-it/private-config.json';extra.write_text('{}')
        with self.assertRaisesRegex(ProductError,'vendor_files_changed'):self.inventory()
        extra.unlink();unknown=self.vendor/'unapproved';unknown.mkdir();(unknown/'module.js').write_text('fixture')
        with self.assertRaisesRegex(ProductError,'vendor_directory_invalid'):self.inventory()
    def test_linked_source_and_foreign_selected_mapping_cannot_borrow_the_original_inventory(self):
        selected,components=self.inventory();key=release.BROWSER_VENDOR_PATH+'/markdown-it/LICENSE';foreign=self.root/'foreign.txt';foreign.write_text('outside vendor')
        selected[key]=foreign
        with self.assertRaisesRegex(ProductError,'vendor_inventory_changed'):release.verify_browser_inventory(self.root,selected,components)
        original=self.vendor/'markdown-it/LICENSE';original.unlink()
        if os.name=='nt':
            from subprocess import run
            link=self.vendor/'markdown-it';target=self.root/'relocated-markdown-it';shutil.move(link,target)
            run(['powershell.exe','-NoProfile','-NonInteractive','-Command',"New-Item -ItemType Junction -Path '"+str(link).replace("'","''")+"' -Target '"+str(target).replace("'","''")+"' | Out-Null"],check=True,capture_output=True)
            self.addCleanup(lambda:os.rmdir(link))
        else:os.symlink(foreign,original)
        with self.assertRaisesRegex(ProductError,'vendor_directory_invalid|candidate_source_link'):self.inventory()
    def test_audit_and_copy_windows_preserve_original_component_fingerprint(self):
        selected,components=self.inventory();original=copy.deepcopy(components)
        self.edit_metadata(lambda meta:meta.update(selection='same files, changed provenance note'))
        with self.assertRaisesRegex(ProductError,'vendor_inventory_changed'):release.verify_browser_inventory(self.root,selected,original)
        selected,components=self.inventory();stage=self.root.parent/'stage';shutil.copytree(self.vendor,stage/release.BROWSER_VENDOR_PATH)
        staged={name:stage/name for name in selected};release.verify_browser_inventory(stage,staged,components)
        changed=stage/release.BROWSER_VENDOR_PATH/'katex/katex.min.js';changed.write_bytes(changed.read_bytes()+b'late change')
        with self.assertRaisesRegex(ProductError,'vendor_file_mismatch'):release.verify_browser_inventory(stage,staged,components)
class NativeSourcePayloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.native=self.root/'vendor/native-runtime';self.native.mkdir(parents=True)
        self.entries=[];self.head='0123456789ab'+'0'*28
        for name in ['source-git-6d67dfd132e4.zip','source-git-0123456789ab.zip','patches/0004-timeout.patch']:
            path=self.native/name;path.parent.mkdir(exist_ok=True);path.write_bytes(('fixture:'+name).encode())
            self.entries.append({'path':name,**release.file_hash(path)})
        self.save()
    def save(self):
        (self.native/'manifest.json').write_text(json.dumps({'schema':1,'source_head':self.head,'files':self.entries}),encoding='utf8')
    def test_only_manifest_bound_archives_and_patches_are_selected(self):
        (self.native/'private-config.json').write_text('private fixture')
        (self.native/'patches/unlisted.patch').write_text('unapproved fixture')
        (self.native/'source-git-aaaaaaaaaaaa.zip').write_bytes(b'unlisted fixture')
        selected={};release.native_source_materials(self.root,selected)
        self.assertEqual(set(selected),{'vendor/native-runtime/'+row['path'] for row in self.entries[1:]})
    def test_legacy_manifest_still_selects_its_exact_source_archive(self):
        self.head='6d67dfd132e402d559b8e46465ed2cbcbcac8bd2';self.save()
        selected={};release.native_source_materials(self.root,selected)
        self.assertEqual(set(selected),{'vendor/native-runtime/'+row['path'] for row in (self.entries[0],self.entries[2])})
    def test_unselected_old_archive_and_metadata_are_still_hash_verified(self):
        original=copy.deepcopy(self.entries)
        for name in ['source-git-6d67dfd132e4.zip','README.md']:
            with self.subTest(file=name):
                self.entries=copy.deepcopy(original)
                path=self.native/name;path.write_bytes(b'changed old archive or metadata')
                self.entries=[row for row in self.entries if row['path']!=name]
                self.entries.append({'path':name,'sha256':'a'*64,'bytes':path.stat().st_size});self.save()
                with self.assertRaisesRegex(ProductError,'candidate_native_source_file_mismatch'):
                    release.native_source_materials(self.root,{})
    def test_source_hash_and_size_changes_are_rejected_before_any_additions(self):
        original=copy.deepcopy(self.entries)
        for field,value in [('sha256','a'*64),('bytes',0),('bytes',True),('sha256','bad')]:
            with self.subTest(field=field,value=value):
                self.entries=copy.deepcopy(original);self.entries[-1][field]=value;self.save();selected={}
                with self.assertRaisesRegex(ProductError,'candidate_native_source_(entry_invalid|file_mismatch)'):
                    release.native_source_materials(self.root,selected)
                self.assertEqual(selected,{})
    def test_unsafe_alias_or_unapproved_source_paths_are_rejected(self):
        original=copy.deepcopy(self.entries)
        for name in ['../outside.zip','C:/outside.zip','patches\\outside.patch','patches/nested/extra.patch','private.zip','private-config.json','SOURCE-GIT-6D67DFD132E4.ZIP']:
            with self.subTest(path=name):
                self.entries=copy.deepcopy(original);self.entries.append({'path':name,'bytes':0,'sha256':'a'*64});self.save()
                with self.assertRaisesRegex(ProductError,'candidate_native_source_(entry_invalid|path_invalid)'):
                    release.native_source_materials(self.root,{})
    def test_current_source_archive_is_required_even_when_old_archive_exists(self):
        self.entries.pop(1);self.save()
        with self.assertRaisesRegex(ProductError,'candidate_native_source_current_archive_invalid'):
            release.native_source_materials(self.root,{})
    def test_malformed_manifest_is_rejected(self):
        for value in [[],{'schema':2,'files':self.entries},{'schema':1,'files':{}},{'schema':1,'files':self.entries}]:
            with self.subTest(manifest=value):
                (self.native/'manifest.json').write_text(json.dumps(value),encoding='utf8')
                with self.assertRaisesRegex(ProductError,'candidate_native_source_manifest_invalid'):
                    release.native_source_materials(self.root,{})
    def test_linked_patch_directory_cannot_import_external_source(self):
        selected={};original=release.linked
        with patch.object(release,'linked',side_effect=lambda path: Path(path)==self.native/'patches' or original(path)):
            with self.assertRaisesRegex(ProductError,'candidate_source_link'):
                release.native_source_materials(self.root,selected)
        self.assertEqual(selected,{})

class PersonalEditionPayloadTests(unittest.TestCase):
    def setUp(self):
        # These two integration checks audit a built, dependency-installed release
        # workspace. A source-only checkout still runs all isolated fixtures.
        required=[
            'apps/codex-web-bridge/upstream/dist/browser-helper.cjs',
            'apps/web-host/node_modules/electron/package.json',
            'apps/web-host/node_modules/electron/dist/electron.exe',
            'apps/web-host/node_modules/electron/dist/version',
            'apps/web-host/node_modules/electron/dist/LICENSE',
            'apps/web-host/node_modules/electron/dist/LICENSES.chromium.html',
            '.local/runtimes/bun-1.4.0/bun.exe',
            '.local/runtimes/bun-1.4.0/SOURCE.json',
        ]
        for folder in ('apps/web-host','apps/codex-web-bridge/upstream'):
            package=json.loads((PROJECT/folder/'package.json').read_text(encoding='utf8'))
            required.extend(folder+'/node_modules/'+name+'/package.json' for name in package.get('dependencies',{}))
        missing=[name for name in required if not (PROJECT/name).is_file()]
        if missing:self.skipTest('Release integration requires built browser helper, installed dependencies/Electron and pinned Bun runtime; missing: '+', '.join(missing))

    def test_real_payload_contains_connection_recovery_and_current_observers_without_live_data(self):
        # Exercise the actual selected source map: a working checkout alone did
        # not prove that a separately installed version could run the Watch.
        with tempfile.TemporaryDirectory() as directory:
            notice=Path(directory)/'bun-notice.md';notice.write_text('fixture provider notice')
            selected,components=release.audit_plan(PROJECT,notice)
        required={
            'LICENSE',
            'scripts/recover_local_mcp.ps1','scripts/start_local_mcp_a.ps1',
            'scripts/start_local_mcp_b.ps1','scripts/local_mcp_watch.py','scripts/local_mcp_credentials.ps1',
            'scripts/webcodex_backend.py','scripts/windows_process_owner.py',
            'scripts/harness_managed_activity.py','scripts/harness_next_round.py',
            'apps/codex-web-bridge/mcp-activity-details.cjs',
            'apps/codex-web-bridge/result-store.cjs',
            'apps/web-host/mcp-activity.js','apps/web-host/work-record.js',
            'scripts/web_companion_control.py','scripts/read_codex_web_task.py',
            'apps/web-recovery-companion/manifest.json','apps/web-recovery-companion/local-control.js',
            'apps/web-recovery-companion/worker.js',
        }
        self.assertTrue(required.issubset(selected),sorted(required-set(selected)))
        for name in ['MANAGED_WEB.md','HOST_RECEIVER.md','WEB_RECEIVER.md']:
            self.assertEqual(selected['docs/harness/'+name],PROJECT/'docs/product-receivers'/name)
        self.assertFalse(any(name.startswith(('.local/','config/web-user-authorization')) for name in selected))
        self.assertTrue(components)

    def test_actual_preview_audit_includes_current_verified_native_archive_and_all_patches(self):
        with tempfile.TemporaryDirectory() as directory:
            notice=Path(directory)/'bun-notice.md';notice.write_text('fixture provider notice')
            selected,_=release.audit_plan(PROJECT,notice,preview=True)
        self.assertEqual(selected['LICENSE'],PROJECT/'LICENSE')
        manifest=release.read_json(PROJECT/'vendor/native-runtime/manifest.json')
        expected={'vendor/native-runtime/'+row['path']:row for row in manifest['files']
                  if row['path'].endswith('.patch') or row['path']=='source-git-'+manifest['source_head'][:12]+'.zip'}
        self.assertTrue(expected)
        for name,row in expected.items():
            self.assertIn(name,selected)
            self.assertEqual(release.file_hash(selected[name]),{'bytes':row['bytes'],'sha256':row['sha256']})
        self.assertEqual({name for name in selected if name.startswith('vendor/native-runtime/') and name.endswith('.zip')},
                         {name for name in expected if name.endswith('.zip')})

if __name__=='__main__':unittest.main()
