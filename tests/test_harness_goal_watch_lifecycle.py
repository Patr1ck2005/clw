"""Frozen-source watcher handover on isolated ledgers, no real app/model calls."""
from contextlib import contextmanager, closing
from pathlib import Path
from types import SimpleNamespace
import json, os, sqlite3, sys, tempfile, unittest
from unittest.mock import Mock, patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / 'scripts'), str(Path(__file__).parent)]
import harness_goal_watch as module
from product_runtime import ProductError, atomic_json
from windows_process_owner import OwnershipUnavailable
import test_personal_runtime as personal_fixture


class StopLoop(Exception):pass


class LocalGoals:
    def __init__(self, root):
        self.root = root
        self.path = root / '.local/harness/harness.sqlite3'
        self.path.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.path)) as db:
            with db:
                db.executescript("CREATE TABLE managed_next_round_notes(batch_id TEXT);"
                                 "CREATE TABLE managed_next_round_batches(id TEXT,state TEXT);"
                                 "INSERT INTO managed_next_round_notes VALUES(NULL);")
        self.tick = Mock()
    @contextmanager
    def db(self):
        db=sqlite3.connect(self.path)
        try:
            with db:yield db
        finally:db.close()
    def status(self):return []


class WatchLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve();self.goals = LocalGoals(self.root)
        (self.root / 'scripts').mkdir()
        for name in module.WATCH_SOURCES:(self.root / 'scripts' / name).write_text(name, encoding='utf8')
        self.version = module.source_version(self.root)
        self.owner = {'pid': os.getpid(), 'creation_filetime': '134361087833933029'}
        self.status = {**self.owner, 'protocol': 1, 'root': str(self.root), 'source_sha256': self.version, 'phase': 'idle'}
        self.status_path = self.root / '.local/harness/goal-watch.json'
        self.request_path = self.root / '.local/harness/goal-watch-reload.json'
        self.native = patch('windows_process_owner.process_identity', return_value={
            'ProcessId': self.owner['pid'], 'ProcessName': 'python.exe', 'CreationFiletime': self.owner['creation_filetime']})
        self.native.start();self.addCleanup(self.native.stop)
        self.constructor = patch.object(module, 'Goals', return_value=self.goals)
        self.constructor.start();self.addCleanup(self.constructor.stop)
        module._STARTING.clear();self.addCleanup(module._STARTING.clear)
    def saved(self, **change):
        status = {**self.status, **change};atomic_json(self.status_path, status);return status
    def freeze_new_source(self):
        (self.root / 'scripts/harness_next_round.py').write_text('new frozen queue source', encoding='utf8')
        return module.source_version(self.root)
    def legacy_row(self, **change):
        return {'ProcessId': self.owner['pid'], 'ProcessName': 'python.exe',
                'CreationFiletime': self.owner['creation_filetime'],
                'CommandLine': f'"C:\\Python\\python.exe" -X utf8 "{self.root / "scripts/harness_goal_watch.py"}" --root "{self.root}" watch', **change}
    def test_matching_live_source_is_reused_even_while_tick_is_inflight(self):
        self.saved(phase='inflight')
        with patch.object(module, '_spawn_watcher') as spawn:
            for _ in range(2):self.assertEqual(module.start_if_enabled(self.root)['state'], 'watcher_reused')
        spawn.assert_not_called();self.assertFalse(self.request_path.exists())
    def test_legacy_owner_mismatch_is_visible_and_never_killed_or_spawned_over(self):
        atomic_json(self.status_path, {'pid': self.owner['pid'], 'at': 1, 'goals': []})
        with patch('windows_process_owner.process_inventory', return_value=[self.legacy_row()]) as inventory, \
             patch.object(module, '_spawn_watcher') as spawn:
            result = module.start_if_enabled(self.root)
        self.assertEqual(result['state'], 'requires_original_idle_update')
        self.assertEqual(result['creation_filetime'], self.owner['creation_filetime'])
        self.assertTrue(inventory.call_args.kwargs['candidate_filter'](self.legacy_row()))
        self.assertFalse(inventory.call_args.kwargs['candidate_filter'](self.legacy_row(ProcessId=1)))
        spawn.assert_not_called();self.assertFalse(self.request_path.exists())
    def test_frozen_source_mismatch_requests_same_original_owner_without_spawn(self):
        self.saved();new = self.freeze_new_source()
        with patch.object(module, '_spawn_watcher') as spawn:
            first = module.start_if_enabled(self.root);second = module.start_if_enabled(self.root)
        self.assertEqual(first, second);self.assertEqual(first['state'], 'watcher_idle_reload_requested')
        self.assertEqual(json.loads(self.request_path.read_text()), {
            **self.owner, 'protocol': 1, 'root': str(self.root), 'previous_source_sha256': self.version, 'source_sha256': new})
        spawn.assert_not_called()
    def test_reused_pid_or_foreign_legacy_argv_never_requests_reload(self):
        self.saved();self.freeze_new_source()
        with patch('windows_process_owner.process_identity', return_value={
            'ProcessId': self.owner['pid'], 'ProcessName': 'python.exe', 'CreationFiletime': '999'}):
            with self.assertRaisesRegex(ValueError, 'watcher_owner_changed'):module.start_if_enabled(self.root)
        atomic_json(self.status_path, {'pid': self.owner['pid']})
        foreign = self.legacy_row(CommandLine='"C:\\Python\\python.exe" other.py --root elsewhere watch')
        with patch('windows_process_owner.process_inventory', return_value=[foreign]):
            with self.assertRaisesRegex(ValueError, 'watcher_owner_changed'):module.start_if_enabled(self.root)
        self.assertFalse(self.request_path.exists())
    def test_dead_owner_starts_one_pending_child_with_exact_frozen_hash(self):
        self.saved();child = Mock(pid=789,poll=Mock(return_value=None))
        with patch('windows_process_owner.process_identity', side_effect=OwnershipUnavailable()), \
             patch('windows_process_owner.process_inventory', return_value=[]), patch('subprocess.Popen', return_value=child) as spawn:
            first = module.start_if_enabled(self.root);second = module.start_if_enabled(self.root)
        self.assertEqual(first, second);self.assertEqual(spawn.call_count, 1)
        self.assertEqual(spawn.call_args.args[0], [sys.executable, '-X', 'utf8', '-B',
            str(self.root / 'scripts/harness_goal_watch.py'), '--root', str(self.root),
            '--expected-source-sha256', self.version, 'watch'])
    def test_ensure_does_not_keep_the_old_permanent_started_success(self):
        host = SimpleNamespace(root=self.root,state=SimpleNamespace(path=self.goals.path),_personal_goal_watch_started=True)
        responses = [{'state':'requires_original_idle_update'}, {'state':'watcher_reused'}]
        with patch.object(module,'start_if_enabled',side_effect=responses) as ensure:
            self.assertEqual(module.ensure_watcher(host),responses[0])
            self.assertEqual(module.ensure_watcher(host),responses[1])
        self.assertEqual(ensure.call_count,2);self.assertEqual(host._personal_goal_watch_status,responses[1])
    def test_idle_handover_waits_for_tick_and_releases_the_real_lock_before_spawn(self):
        events=[]
        def tick():
            events.append('tick-start');self.assertEqual(json.loads(self.status_path.read_text())['phase'],'inflight')
            with self.assertRaises(ProductError):
                with module.singleton(self.root / '.local/harness/goal-watch.lock'):pass
            self.freeze_new_source();result=module.start_if_enabled(self.root)
            self.assertEqual(result['state'],'watcher_idle_reload_requested');events.append('tick-return')
        self.goals.tick.side_effect=tick
        def spawn(root,version):
            self.assertEqual(events,['tick-start','tick-return'])
            self.assertEqual(json.loads(self.status_path.read_text())['phase'],'reloading')
            with module.singleton(root / '.local/harness/goal-watch.lock'):events.append('lock-released')
            return {'state':'watcher_start_requested','source_sha256':version}
        def sleep(seconds):
            self.assertEqual(seconds,20);self.assertEqual(json.loads(self.status_path.read_text())['phase'],'idle')
        with patch.object(module,'_spawn_watcher',side_effect=spawn) as spawned:
            result=module.watch(self.goals,expected_source=self.version,sleep=sleep)
        self.assertEqual(result['source_sha256'],module.source_version(self.root))
        self.assertEqual(spawned.call_count,1);self.assertEqual(self.goals.tick.call_count,1)
    def test_source_edit_without_explicit_startup_request_never_hot_reloads(self):
        self.goals.tick.side_effect=self.freeze_new_source
        with patch.object(module,'_spawn_watcher') as spawn:
            with self.assertRaises(StopLoop):module.watch(self.goals,sleep=lambda _: (_ for _ in ()).throw(StopLoop()))
        self.assertEqual(self.goals.tick.call_count,1);spawn.assert_not_called()
    def test_foreign_reload_and_changed_frozen_request_never_start_a_peer(self):
        for mismatch in ('owner','source'):
            with self.subTest(mismatch=mismatch):
                request={**self.status,'previous_source_sha256':self.version,'source_sha256':'a'*64}
                if mismatch=='owner':request['pid']=1
                atomic_json(self.request_path,request);self.goals.tick.reset_mock()
                with patch.object(module,'_spawn_watcher') as spawn:
                    with self.assertRaises(StopLoop):module.watch(self.goals,sleep=lambda _: (_ for _ in ()).throw(StopLoop()))
                spawn.assert_not_called()
                self.assertEqual(self.goals.tick.call_count,1 if mismatch=='owner' else 0)
    def test_launch_hash_mismatch_never_calls_tick_or_claims_a_lock(self):
        with self.assertRaisesRegex(ValueError,'watcher_source_changed'):module.watch(self.goals,expected_source='f'*64)
        self.goals.tick.assert_not_called();self.assertFalse(self.status_path.exists())


class OriginalUnknownHandoverTests(unittest.TestCase):
    def test_real_original_unknown_batch_survives_idle_reload_and_is_only_queried(self):
        fixture=personal_fixture.PersonalRuntimeTests();fixture.setUp();self.addCleanup(fixture.tearDown)
        root=fixture.watch.root;(root/'scripts').mkdir(exist_ok=True)
        (root/'.local/harness').mkdir(parents=True,exist_ok=True)
        for name in module.WATCH_SOURCES:(root/'scripts'/name).write_text(name,encoding='utf8')
        version=module.source_version(root)
        fixture.start();fixture.append('First original');fixture.append('Second original');fixture.end()
        batch=fixture.m.browser('next-round-prepare',{'page_id':fixture.page})['batch']
        raw={'request_id':batch['id'],'thread_id':fixture.thread,'action':'message.send','data':{'text':batch['text']}}
        fixture.h.state.begin(batch['id'],raw)
        with fixture.watch.db() as db:
            db.execute("UPDATE operations SET state='unknown' WHERE id=?",(batch['id'],))
        with fixture.watch.db() as db:before=list(db.iterdump())
        receipt_reads=[];original=fixture.operator.request
        def request(route,*args):
            if route.startswith('receipt?'):
                receipt_reads.append(route)
                status=json.loads((root/'.local/harness/goal-watch.json').read_text())
                self.assertEqual(status['phase'],'inflight')
                (root/'scripts/harness_next_round.py').write_text('new frozen queue',encoding='utf8')
                atomic_json(root/'.local/harness/goal-watch-reload.json',{
                    **{k:status[k] for k in ('protocol','root','pid','creation_filetime')},
                    'previous_source_sha256':version,'source_sha256':module.source_version(root)})
            return original(route,*args)
        def spawn(updated_root,new_source):
            with module.singleton(updated_root/'.local/harness/goal-watch.lock'):pass
            return {'state':'watcher_start_requested','source_sha256':new_source}
        fixture.operator.request=request
        with patch('windows_process_owner.process_identity',return_value={'CreationFiletime':'123456'}), \
             patch.object(fixture.watch,'health',return_value=True),patch.object(module,'_spawn_watcher',side_effect=spawn):
            module.watch(fixture.watch,expected_source=version,sleep=lambda _:None)
        fixture.operator.request=original;fixture.tick()
        self.assertEqual(receipt_reads,['receipt?request_id='+batch['id']]);self.assertEqual(fixture.operator.posts,[])
        with fixture.watch.db() as db:self.assertEqual(list(db.iterdump()),before)
        self.assertEqual(fixture.view()['next_round']['state'],'delivery_unknown')
        self.assertEqual([x['text'] for x in fixture.view()['next_round']['messages']],['First original','Second original'])


if __name__=='__main__':unittest.main()
