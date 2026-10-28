"""Offline cooperative admission tests; no browser/model/Local-MCP calls."""
from pathlib import Path
from contextlib import closing
from datetime import datetime, timezone
from types import SimpleNamespace
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from native_work_admission import (AdmissionError, _native_conflict, conflicts_pure_scope,
                                   mark_terminal, overlaps, poll, recover, request, settle, start, status)


def journal(path):
    with closing(sqlite3.connect(path)) as db:
        db.executescript('''
        CREATE TABLE threads(id TEXT PRIMARY KEY,status TEXT NOT NULL);
        CREATE TABLE operations(id TEXT DEFAULT '',action TEXT NOT NULL,state TEXT NOT NULL);
        CREATE TABLE control_attempts(thread_id TEXT,request_id TEXT,state TEXT);
        CREATE TABLE host_requests(id TEXT PRIMARY KEY,phase TEXT);
        CREATE TABLE host_team_scopes(thread_id TEXT PRIMARY KEY,root TEXT,access TEXT,
                                      write_paths TEXT,resources TEXT);
        CREATE TABLE host_team_leases(thread_id TEXT,resources TEXT,root TEXT,access TEXT);
        CREATE TABLE host_team_git_scopes(thread_id TEXT PRIMARY KEY,head TEXT,common_dir TEXT);
        ''')


class NativeAdmissionTests(unittest.TestCase):
    def test_explicit_git_read_only_allows_disjoint_paths_but_keeps_overlap_and_writer_exclusion(self):
        subprocess.run(['git','-C',str(self.a),'init','-q'],check=True,capture_output=True)
        def candidate(name,path,owner):
            result=self.root/('parallel-'+name);result.mkdir()
            return request(self.db,workspace=str(self.a),result_path=str(result),owner_pid=owner,
                write_paths=[path],git_write=False)
        first=candidate('a','candidate/a',1001)
        self.assertEqual(first['state'],'reserved')
        self.assertEqual(candidate('b','candidate/b',1002)['state'],'reserved')
        self.assertEqual(candidate('overlap','candidate/a/child',1003)['state'],'queued')
        result=self.root/'git-writer';result.mkdir()
        writer=request(self.db,workspace=str(self.a),result_path=str(result),owner_pid=1004,write_paths=['candidate/c'])
        self.assertEqual(writer['state'],'queued')

    def test_original_claims_can_declare_no_git_write_without_recreation_or_prompt_edits(self):
        from native_work_admission import declare_git_read_only
        subprocess.run(['git','-C',str(self.a),'init','-q'],check=True,capture_output=True)
        packages=[]
        for name,pid in [('a',1001),('b',1002)]:
            result=self.root/('declaration-'+name);result.mkdir()
            claim=request(self.db,workspace=str(self.a),result_path=str(result),owner_pid=pid,write_paths=['candidate/'+name])
            receipt={'admissionId':claim['claim_id'],'resultDirectory':str(result),'ownerPid':pid,
                'state':'starting' if claim['state']=='reserved' else 'queued_local'}
            (result/'execution.json').write_text(json.dumps(receipt),encoding='utf8')
            packages.append((result,claim,pid,(result/'execution.json').read_bytes()))
        with patch('native_work_admission.claim_owner_live',return_value=True):
            for result,claim,pid,raw in packages:
                answer=declare_git_read_only(self.db,result,owner_pid=pid)
                self.assertEqual(answer['claim_id'],claim['claim_id'])
                self.assertFalse(answer['gitWrite'])
                self.assertEqual((result/'execution.json').read_bytes(),raw)
        result,claim,pid,_=packages[1]
        self.assertEqual(poll(self.db,claim['claim_id'],pid)['state'],'reserved')

    def test_git_read_only_does_not_remove_exclusive_resource_conflicts(self):
        first=self.root/'resource-a';first.mkdir();second=self.root/'resource-b';second.mkdir()
        a=request(self.db,workspace=str(self.a),result_path=str(first),owner_pid=1001,
            write_paths=['a'],resources=['unity-editor'],git_write=False)
        b=request(self.db,workspace=str(self.a),result_path=str(second),owner_pid=1002,
            write_paths=['b'],resources=['UnityEditor'],git_write=False)
        self.assertEqual((a['state'],b['state']),('reserved','queued'))

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='clw-native-admission-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'harness.sqlite3'
        journal(self.db)
        self.a = self.root / 'project-a'; self.a.mkdir()
        self.b = self.root / 'project-b'; self.b.mkdir()

    def package(self, name, workspace=None, *, owner=1001, paths=None, resources=None):
        result = self.root / ('result-' + name); result.mkdir()
        claim = request(self.db, workspace=str(workspace or self.a), result_path=str(result),
                        owner_pid=owner, write_paths=paths, resources=resources)
        return result, claim

    def record_legacy_root_identity(self, root, thread='legacy-web'):
        observed = root.stat()
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('ALTER TABLE host_team_scopes ADD COLUMN device INTEGER')
            db.execute('ALTER TABLE host_team_scopes ADD COLUMN inode INTEGER')
            db.execute('UPDATE host_team_scopes SET device=?,inode=? WHERE thread_id=?',
                       (observed.st_dev, observed.st_ino, thread))
            db.commit()

    @staticmethod
    def terminal(result, claim, *, native='turn.completed'):
        (result / 'execution.json').write_text(json.dumps({
            'admissionId': claim['claim_id'], 'resultDirectory': str(result),
            'state': 'turn_completed', 'endedAt': '2026-09-26T12:00:00Z', 'exitCode': 0,
        }), encoding='utf8')
        (result / 'events.jsonl').write_text(json.dumps({'type': native}) + '\n', encoding='utf8')

    def test_conflicting_original_stays_queued_until_verified_terminal_and_zero_jobs(self):
        first, a = self.package('a')
        second, b = self.package('b', owner=1002)
        self.assertEqual((a['state'], b['state']), ('reserved', 'queued'))
        self.assertEqual(start(self.db, a['claim_id'], 1001)['state'], 'running')
        self.assertEqual(poll(self.db, b['claim_id'], 1002)['state'], 'queued')
        self.terminal(first, a)
        self.assertEqual(mark_terminal(self.db, a['claim_id'], 1001)['state'], 'terminal_pending')
        with self.assertRaisesRegex(AdmissionError, 'local_jobs_active_or_unknown'):
            settle(self.db, first, job_probe=lambda: False)
        self.assertEqual(poll(self.db, b['claim_id'], 1002)['state'], 'queued')
        self.assertEqual(settle(self.db, first, job_probe=lambda: True)['state'], 'released')
        self.assertEqual(poll(self.db, b['claim_id'], 1002)['state'], 'reserved')
        self.assertEqual(status(self.db, first)['state'], 'released')

    def test_cli_and_interruption_share_the_same_admission_error_class(self):
        result, claim = self.package('cli-exception-identity')
        self.terminal(result, claim)
        start(self.db, claim['claim_id'], 1001)
        mark_terminal(self.db, claim['claim_id'], 1001)
        script = Path(__file__).resolve().parents[1] / 'scripts/native_work_admission.py'
        runner = '''import runpy, sys, types
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
module = types.ModuleType('native_work_interruption')
def tool_free_failure_evidence(row):
    import native_work_admission as admission
    raise admission.AdmissionError('native_tools_require_terminal_reconciliation')
module.tool_free_failure_evidence = tool_free_failure_evidence
sys.modules['native_work_interruption'] = module
terminal = types.ModuleType('native_work_terminal')
terminal.terminal_work_evidence = lambda row: {'originalNativeTerminal': True, 'nativeToolsTerminal': True}
terminal.verify_terminal_work_evidence = lambda row, evidence: None
sys.modules['native_work_terminal'] = terminal
sys.argv = [sys.argv[1], 'settle', '--database', sys.argv[2], '--result-path', sys.argv[3]]
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        completed = subprocess.run([sys.executable, '-c', runner, str(script), str(self.db), str(result)],
                                   capture_output=True, encoding='utf8', timeout=15)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)['state'], 'released')
        self.assertEqual(status(self.db, result)['state'], 'released')

    def test_disjoint_projects_have_no_worker_count_cap(self):
        projects = []
        for index in range(7):
            directory = self.root / f'project-{index}'; directory.mkdir()
            projects.append(self.package(str(index), directory)[1])
        self.assertEqual([entry['state'] for entry in projects], ['reserved'] * 7)

    def test_ancestor_paths_and_explicit_resources_conflict(self):
        nested = self.a / 'nested'; nested.mkdir()
        _, first = self.package('parent', self.a, paths=['nested'])
        _, second = self.package('child', nested, owner=1002)
        self.assertEqual((first['state'], second['state']), ('reserved', 'queued'))
        _, third = self.package('other', self.b, owner=1003, resources=['unity-editor'])
        _, fourth = self.package('other-2', self.root / 'project-b', owner=1004,
                                 paths=['somewhere'], resources=['unity-editor'])
        self.assertEqual((third['state'], fourth['state']), ('reserved', 'queued'))
        self.assertTrue(overlaps(str(nested), str(self.a)))

    def test_pure_web_lease_and_active_unscoped_thread_block_native(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('web-a', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)', ('web-a', '[]', str(self.a), 'write'))
            db.commit()
        _, claim = self.package('after-pure')
        self.assertEqual(claim['state'], 'queued')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DELETE FROM host_team_leases')
            db.execute('INSERT INTO threads VALUES(?,?)', ('legacy-unscoped', 'unknown'))
            db.commit()
        self.assertEqual(poll(self.db, claim['claim_id'], 1001)['state'], 'queued')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DELETE FROM threads')
            db.commit()
        self.assertEqual(poll(self.db, claim['claim_id'], 1001)['state'], 'reserved')

    def test_legacy_pure_git_scope_is_probed_without_releasing_its_lease(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        _, unrelated = self.package('independent-git', self.b)
        self.assertEqual(unrelated['state'], 'reserved')
        _, same_root = self.package('same-git', self.a, owner=1002)
        self.assertEqual(same_root['state'], 'queued')
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases').fetchone()[0], 1)

    def nested_legacy_writer(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        nested = self.a / '.local' / 'diagnostic'
        nested.mkdir(parents=True)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(nested), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(nested), 'write'))
            db.commit()
        self.record_legacy_root_identity(nested)
        return nested

    def test_nested_legacy_writer_allows_other_repo_but_holds_shared_git(self):
        self.nested_legacy_writer()
        _, unrelated = self.package('independent-nested', self.b)
        self.assertEqual(unrelated['state'], 'reserved')
        sibling = self.a / 'src'; sibling.mkdir()
        _, shared_git = self.package('shared-nested', sibling, owner=1002)
        self.assertEqual(shared_git['state'], 'queued')
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM host_team_leases').fetchone()[0], 1)

    def test_nested_legacy_new_nearer_git_pointer_stays_queued(self):
        nested = self.nested_legacy_writer()
        from native_work_admission import _legacy_git_overrides

        def changed_git(database, candidate):
            observed = _legacy_git_overrides(database, candidate)
            self.assertIn('legacy-web', observed)
            (nested.parent / '.git').write_text(f"gitdir: {self.b / '.git'}\n", encoding='utf8')
            return observed

        with patch('native_work_admission._legacy_git_overrides', side_effect=changed_git):
            _, claim = self.package('nested-pointer-changed', self.b)
        self.assertEqual(claim['state'], 'queued')

    def test_nested_legacy_ancestor_git_replaced_stays_queued(self):
        self.nested_legacy_writer()
        from native_work_admission import _legacy_git_overrides

        def changed_git(database, candidate):
            observed = _legacy_git_overrides(database, candidate)
            self.assertIn('legacy-web', observed)
            (self.a / '.git').rename(self.root / 'original-git')
            (self.a / '.git').write_text(f"gitdir: {self.b / '.git'}\n", encoding='utf8')
            return observed

        with patch('native_work_admission._legacy_git_overrides', side_effect=changed_git):
            _, claim = self.package('ancestor-git-replaced', self.b)
        self.assertEqual(claim['state'], 'queued')

    def test_non_git_probe_does_not_ignore_new_ancestor_repository(self):
        from native_work_admission import stable_git_marker
        nested = self.a / 'nested'; nested.mkdir()
        self.assertIsNotNone(stable_git_marker(str(nested), None))
        subprocess.run(['git', '-C', str(self.a), 'init', '-q'], check=True,
                       capture_output=True, timeout=8)
        self.assertIsNone(stable_git_marker(str(nested), None))

    def test_legacy_git_probe_failure_or_changed_scope_stays_queued(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        from native_work_admission import _git_common_dir, _legacy_git_overrides
        def failing_probe(root, timeout=8):
            if Path(root).resolve() == self.a.resolve():
                raise AdmissionError('git_identity_probe_unavailable')
            return _git_common_dir(root, timeout=timeout)
        with patch('native_work_admission._git_common_dir', side_effect=failing_probe):
            _, failed = self.package('probe-failed', self.b)
        self.assertEqual(failed['state'], 'queued')

        def changed_scope(database, candidate):
            observed = _legacy_git_overrides(database, candidate)
            with closing(sqlite3.connect(database)) as db:
                db.execute('UPDATE host_team_scopes SET resources=? WHERE thread_id=?',
                           ('["changed"]', 'legacy-web'))
                db.commit()
            return observed
        with patch('native_work_admission._legacy_git_overrides', side_effect=changed_scope):
            _, stale = self.package('scope-changed', self.b, owner=1002)
        self.assertEqual(stale['state'], 'queued')

    def test_legacy_git_pointer_changed_after_probe_stays_queued(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        from native_work_admission import _git_common_dir, _legacy_git_overrides

        def changed_git(database, candidate):
            observed = _legacy_git_overrides(database, candidate)
            (self.a / '.git').rename(self.root / 'old-a-git')
            (self.a / '.git').write_text(f"gitdir: {self.b / '.git'}\n", encoding='utf8')
            return observed

        with patch('native_work_admission._legacy_git_overrides', side_effect=changed_git):
            _, claim = self.package('after-git-pointer-change', self.b)
        self.assertEqual(_git_common_dir(str(self.a)), _git_common_dir(str(self.b)))
        self.assertEqual(claim['state'], 'queued')

    def test_legacy_writer_in_sibling_worktree_still_conflicts(self):
        subprocess.run(['git', '-C', str(self.a), 'init', '-q'], check=True,
                       capture_output=True, timeout=8)
        sibling = self.root / 'sibling-worktree'
        subprocess.run(['git', '-C', str(self.a), 'worktree', 'add', '-q', '--orphan',
                        '-b', 'sibling', str(sibling)], check=True, capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        _, claim = self.package('shared-worktree', sibling)
        self.assertEqual(claim['state'], 'queued')

    def test_legacy_git_probe_is_outside_shared_write_transaction(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        from native_work_admission import _git_common_dir
        def probe(root, timeout=8):
            if Path(root).resolve() == self.a.resolve():
                with closing(sqlite3.connect(self.db, timeout=.2)) as db:
                    db.execute("INSERT INTO operations(action,state) VALUES('probe','completed')")
                    db.commit()
            return _git_common_dir(root, timeout=timeout)
        with patch('native_work_admission._git_common_dir', side_effect=probe):
            _, claim = self.package('outside-lock-git', self.b)
        self.assertEqual(claim['state'], 'reserved')

    def test_replaced_legacy_pure_root_keeps_unknown_git_fence(self):
        for path in (self.a, self.b):
            subprocess.run(['git', '-C', str(path), 'init', '-q'], check=True,
                           capture_output=True, timeout=8)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('legacy-web', str(self.a), 'write', '["."]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('legacy-web', '[]', str(self.a), 'write'))
            db.commit()
        self.record_legacy_root_identity(self.a)
        self.a.rename(self.root / 'old-project-a')
        self.a.mkdir()
        subprocess.run(['git', '-C', str(self.a), 'init', '-q'], check=True,
                       capture_output=True, timeout=8)
        _, claim = self.package('after-replaced-pure-root', self.b)
        self.assertEqual(claim['state'], 'queued')

    def test_native_claim_blocks_pure_web_scope_and_stale_claim_never_expires(self):
        _, claim = self.package('native')
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            pure = {'root': str(self.a), 'access': 'write', 'write_paths': '["."]',
                    'resources': '[]', 'git': None}
            self.assertTrue(conflicts_pure_scope(db, pure))
            self.assertTrue(conflicts_pure_scope(db, {'root': str(self.a), 'access': 'read',
                        'write_paths': '[]', 'resources': '[]', 'git': None}))
            self.assertFalse(conflicts_pure_scope(db, {'root': str(self.b), 'access': 'read',
                        'write_paths': '[]', 'resources': '[]', 'git': None}))
            db.execute("UPDATE native_work_claims SET state='unknown',created=1 WHERE claim_id=?",
                       (claim['claim_id'],))
            db.commit()
        _, later = self.package('later', owner=1002)
        self.assertEqual(later['state'], 'queued')

    def test_shared_git_common_dir_conflicts_across_disjoint_worktrees(self):
        a = {'write_paths': [str(self.a)], 'resources': [], 'git_common_dir': 'C:/repo/.git'}
        b = {'write_paths': [str(self.b)], 'resources': [], 'git_common_dir': 'C:/repo/.git'}
        self.assertTrue(_native_conflict(a, b))
        b['git_common_dir'] = 'C:/other/.git'
        self.assertFalse(_native_conflict(a, b))

    def test_pure_read_lease_blocks_native_write_but_read_read_is_free(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('reader', str(self.a), 'read', '[]', '[]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('reader', '[]', str(self.a), 'read'))
            db.commit()
        _, write_claim = self.package('writer-after-reader', self.a)
        self.assertEqual(write_claim['state'], 'queued')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DELETE FROM host_team_leases')
            db.commit()
        self.assertEqual(poll(self.db, write_claim['claim_id'], 1001)['state'], 'reserved')

    def test_native_unity_resource_inherited_from_workspace_ancestor(self):
        from native_work_admission import scope
        unity = self.a / 'unity'; assets = unity / 'Assets'
        (unity / 'ProjectSettings').mkdir(parents=True)
        (unity / 'ProjectSettings' / 'ProjectVersion.txt').write_text('m_EditorVersion: test', encoding='utf8')
        assets.mkdir()
        self.assertIn('unity', scope(str(assets))['resources'])
        self.assertNotIn('unity', scope(str(self.b))['resources'])

    def test_incomplete_or_changed_original_terminal_remains_held(self):
        result, claim = self.package('evidence')
        start(self.db, claim['claim_id'], 1001)
        self.terminal(result, claim, native='item.completed')
        with self.assertRaisesRegex(AdmissionError, 'terminal_unverified'):
            mark_terminal(self.db, claim['claim_id'], 1001)
        self.terminal(result, claim)
        mark_terminal(self.db, claim['claim_id'], 1001)
        (result / 'execution.json').write_text('{}', encoding='utf8')
        with self.assertRaises(AdmissionError):
            settle(self.db, result, job_probe=lambda: True)
        self.assertEqual(status(self.db, result)['state'], 'terminal_pending')

    def test_invalid_path_and_original_result_reuse_fail_before_send(self):
        _, claim = self.package('once')
        self.assertEqual(claim['state'], 'reserved')
        with self.assertRaisesRegex(AdmissionError, 'already_claimed'):
            request(self.db, workspace=str(self.a), result_path=str(self.root / 'result-once'),
                    owner_pid=1002)
        result = self.root / 'invalid'; result.mkdir()
        with self.assertRaisesRegex(AdmissionError, 'invalid_write_path'):
            request(self.db, workspace=str(self.a), result_path=str(result), owner_pid=1002,
                    write_paths=['../project-b'])

    def test_no_claim_fast_path_never_probes_pure_workspace(self):
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('CREATE TABLE native_work_claims(state TEXT)')
            db.commit()
            with patch('native_work_admission._pure_scope', side_effect=AssertionError('slow probe')):
                self.assertFalse(conflicts_pure_scope(db, {'root': str(self.a), 'access': 'write',
                                 'write_paths': '["."]', 'resources': '[]'}))

    def test_queued_path_and_git_scope_are_reprobed_before_send(self):
        _, held = self.package('held')
        result, queued = self.package('queued', owner=1002, paths=['output'])
        self.assertEqual(queued['state'], 'queued')
        # A replaced project root is not the admitted directory, even at the
        # same spelling. A dead queue claim remains held for explicit recovery.
        self.a.rename(self.root / 'old-project-a')
        self.a.mkdir()
        with self.assertRaisesRegex(AdmissionError, 'original_write_domain_changed_no_send'):
            poll(self.db, queued['claim_id'], 1002)
        self.assertEqual(status(self.db, result)['state'], 'queued')
        other = self.root / 'git-project'; other.mkdir()
        _, git_claim = self.package('git-change', other, owner=1003)
        self.assertEqual(git_claim['state'], 'reserved')
        subprocess.run(['git', '-C', str(other), 'init', '-q'], check=True,
                       capture_output=True, timeout=8)
        with self.assertRaisesRegex(AdmissionError, 'original_write_domain_changed_no_send'):
            start(self.db, git_claim['claim_id'], 1003)

    def test_event_and_job_probes_do_not_hold_shared_write_transaction(self):
        result, claim = self.package('outside-lock')
        start(self.db, claim['claim_id'], 1001)
        self.terminal(result, claim)
        from native_work_admission import _terminal_receipt
        def event_probe(row):
            with closing(sqlite3.connect(self.db, timeout=.2)) as db:
                db.execute("INSERT INTO operations(action,state) VALUES('audit','completed')")
                db.commit()
            return _terminal_receipt(row)
        with patch('native_work_admission._terminal_receipt', side_effect=event_probe):
            mark_terminal(self.db, claim['claim_id'], 1001)
        def job_probe():
            with closing(sqlite3.connect(self.db, timeout=.2)) as db:
                db.execute("INSERT INTO operations(action,state) VALUES('job-audit','completed')")
                db.commit()
            return True
        self.assertEqual(settle(self.db, result, job_probe=job_probe)['state'], 'released')

    def test_dead_launcher_pre_send_recovery_is_audited_and_never_replays(self):
        result, claim = self.package('pre-send')
        (result / 'execution.json').write_text(json.dumps({
            'admissionId': claim['claim_id'], 'resultDirectory': str(result),
            'ownerPid': 1001, 'state': 'starting',
        }), encoding='utf8')
        with self.assertRaisesRegex(AdmissionError, 'launcher_alive_or_unknown'):
            recover(self.db, result, owner_probe=lambda _: True, job_probe=lambda: True)
        answer = recover(self.db, result, owner_probe=lambda _: False, job_probe=lambda: True)
        self.assertEqual((answer['state'], answer['recovery']), ('released', 'pre_send_cancelled'))
        with closing(sqlite3.connect(self.db)) as db:
            row = db.execute('SELECT kind,evidence FROM native_work_recoveries').fetchone()
            self.assertEqual(row[0], 'pre_send_cancelled')
            self.assertTrue(json.loads(row[1])['localJobsZero'])

    def test_reused_pid_is_not_the_original_launcher(self):
        from native_work_admission import claim_owner_live
        row={'owner_pid':1001,'created':100.5}
        identity=lambda created:lambda _: {1001:{'ProcessId':1001,'CreationFiletime':str(created)}}
        self.assertIs(claim_owner_live(row,identity_probe=identity(116444737010000000)),False)
        self.assertIs(claim_owner_live(row,identity_probe=identity(116444737000000000)),True)
        self.assertIs(claim_owner_live(row,identity_probe=lambda _:{}),False)
        def denied(_):raise RuntimeError('identity unavailable')
        self.assertIsNone(claim_owner_live(row,identity_probe=denied))
        self.assertIsNone(claim_owner_live(row,identity_probe=identity(0)))

    def test_reused_pid_pre_send_recovery_keeps_original_receipt(self):
        result,claim=self.package('reused-owner')
        receipt=result/'execution.json'
        receipt.write_text(json.dumps({'admissionId':claim['claim_id'],'resultDirectory':str(result),
                                      'ownerPid':1001,'state':'starting'}),encoding='utf8')
        original=receipt.read_bytes()
        with patch('native_work_admission.claim_owner_live',return_value=False):
            answer=recover(self.db,result)
        self.assertEqual(answer['recovery'],'pre_send_cancelled')
        self.assertTrue(answer['nativeExecutionNotStarted'])
        self.assertEqual(receipt.read_bytes(),original)
        from read_codex_web_task import inspect
        observed=inspect(result,admission_database=self.db)
        self.assertEqual(observed['state'],'not_sent')
        self.assertFalse(observed['automaticReplay'])

    def test_pre_receipt_crash_can_be_reconciled_but_any_event_blocks_release(self):
        empty, claim = self.package('pre-receipt')
        self.assertEqual(recover(self.db, empty, owner_probe=lambda _: False,
                                 job_probe=lambda: True)['recovery'], 'pre_send_cancelled')
        suspicious, other = self.package('pre-send-event', owner=1002)
        (suspicious / 'events.jsonl').write_text('{"type":"thread.started"}\n', encoding='utf8')
        with self.assertRaisesRegex(AdmissionError, 'pre_send_evidence_incomplete'):
            recover(self.db, suspicious, owner_probe=lambda _: False, job_probe=lambda: True)
        self.assertEqual(status(self.db, suspicious)['state'], other['state'])

    def prepared_package(self, name):
        result=self.root/('result-'+name);result.mkdir()
        (result/'prompt.txt').write_text('原隔离任务的输入',encoding='utf8')
        (result/'launch-intent.json').write_text(json.dumps({
            'account':'A','script':'run-native-fixture.ps1','singleLaunch':True,
            'at':datetime.now(timezone.utc).isoformat()}),encoding='utf8')
        claim=request(self.db,workspace=str(self.a),result_path=str(result),owner_pid=1001)
        return result,claim

    def test_prepared_inputs_before_claim_are_preserved_during_dead_owner_recovery(self):
        result,claim=self.prepared_package('prepared-before-receipt')
        answer=recover(self.db,result,owner_probe=lambda _:False,job_probe=lambda:True)
        self.assertEqual((answer['state'],answer['recovery']),('released','pre_send_cancelled'))
        self.assertTrue((result/'prompt.txt').is_file())
        self.assertFalse((result/'execution.json').exists())
        with closing(sqlite3.connect(self.db)) as db:
            evidence=json.loads(db.execute('SELECT evidence FROM native_work_recoveries WHERE claim_id=?',(claim['claim_id'],)).fetchone()[0])
            self.assertEqual(set(evidence['prepared_files']),{'prompt.txt','launch-intent.json'})
            self.assertEqual(evidence['modelSends'],0)

    def test_prepared_inputs_do_not_hide_execution_or_change_during_job_probe(self):
        result,claim=self.prepared_package('prepared-event')
        (result/'events.jsonl').write_text('{"type":"thread.started"}\n',encoding='utf8')
        with self.assertRaisesRegex(AdmissionError,'pre_send_evidence_incomplete'):
            recover(self.db,result,owner_probe=lambda _:False,job_probe=lambda:True)
        self.assertEqual(status(self.db,result)['state'],claim['state'])
        other,second=self.prepared_package('prepared-changed')
        def change_input():
            (other/'prompt.txt').write_text('修改后的输入',encoding='utf8')
            return True
        with self.assertRaisesRegex(AdmissionError,'pre_send_preparation_unverified|pre_send_evidence_changed'):
            recover(self.db,other,owner_probe=lambda _:False,job_probe=change_input)
        self.assertEqual(status(self.db,other)['state'],second['state'])

    def test_unknown_sent_work_stays_held_until_original_terminal_is_proven(self):
        result, claim = self.package('unknown')
        start(self.db, claim['claim_id'], 1001)
        answer = recover(self.db, result, owner_probe=lambda _: False,
                         job_probe=lambda: self.fail('No Job probe is needed without terminal evidence'))
        self.assertEqual(answer['state'], 'unknown')
        self.assertEqual(status(self.db, result)['state'], 'unknown')
        self.terminal(result, claim)
        answer = recover(self.db, result, owner_probe=lambda _: False, job_probe=lambda: True)
        self.assertEqual((answer['state'], answer['recovery']), ('released', 'original_terminal_observed'))

    def test_unity_aliases_conflict_across_native_and_pure_web(self):
        unity = self.a / 'ProjectSettings'; unity.mkdir()
        (unity / 'ProjectVersion.txt').write_text('m_EditorVersion: fixture', encoding='utf8')
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                       ('unity-reader', str(self.b), 'read', '[]', '["UnityEditor"]'))
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('unity-reader', '["UnityEditor"]', str(self.b), 'read'))
            db.commit()
        _, native = self.package('unity-auto')
        self.assertEqual(native['state'], 'queued')
        from harness_team_scopes import Scopes
        self.assertTrue(Scopes.conflict({'root': str(self.a), 'access': 'read',
                                         'resources': '["UnityEditor"]'},
                                        {'root': str(self.b), 'access': 'read',
                                         'resources': '["unity-editor"]'}))

    def test_two_legacy_pure_web_unity_writers_conflict_without_declared_resources(self):
        from harness_team_scopes import Scopes
        for project in (self.a, self.b):
            marker = project / 'ProjectSettings'; marker.mkdir()
            (marker / 'ProjectVersion.txt').write_text('m_EditorVersion: fixture', encoding='utf8')
        gate = Scopes(SimpleNamespace(host=None))
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            for thread, project in (('pure-a', self.a), ('pure-b', self.b)):
                db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?)',
                           (thread, str(project), 'write', '["."]', '[]'))
            db.execute('INSERT INTO threads VALUES(?,?)', ('pure-b', 'working'))
            db.commit()
            self.assertTrue(gate.busy(db, 'pure-a'))
            db.execute('DELETE FROM threads')
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?)',
                       ('pure-b', '[]', str(self.b), 'write'))
            db.commit()
            self.assertTrue(gate.busy(db, 'pure-a'))
            db.execute('DELETE FROM host_team_leases')
            db.commit()
            self.assertFalse(gate.busy(db, 'pure-a'))


if __name__ == '__main__':
    unittest.main()
