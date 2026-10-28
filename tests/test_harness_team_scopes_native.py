"""Offline pure-Web/native admission tests against an isolated SQLite journal."""
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_team_scopes import Scopes,plain_root
from native_work_admission import AdmissionError,_git_common_dir


class PureWebNativeScopeTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='clw-pure-native-scope-')
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.db_path=self.root/'journal.sqlite3'
        self.a=self.root/'repo-a';self.b=self.root/'repo-b'
        for root in (self.a,self.b):
            root.mkdir()
            subprocess.run(['git','-C',str(root),'init','-q'],check=True,capture_output=True,timeout=8)
        with closing(self.connect()) as db:
            db.executescript('''
              CREATE TABLE threads(id TEXT,status TEXT);
              CREATE TABLE operations(id TEXT,action TEXT,state TEXT);
              CREATE TABLE control_attempts(thread_id TEXT,request_id TEXT,state TEXT);
              CREATE TABLE host_requests(id TEXT,phase TEXT);
              CREATE TABLE native_work_claims(state TEXT,workspace TEXT,write_paths TEXT,
                                             resources TEXT,git_common_dir TEXT,created REAL);
            ''')
            Scopes.schema(db)
            db.commit()
        self.scopes=Scopes(SimpleNamespace(state=SimpleNamespace(path=self.db_path),host=None))

    def connect(self):
        db=sqlite3.connect(self.db_path,timeout=.2)
        db.row_factory=sqlite3.Row
        return db

    def pure(self,root,thread='pure',paths=None):
        root=plain_root(str(root));stat=Path(root).stat()
        with closing(self.connect()) as db:
            db.execute('INSERT INTO host_team_scopes VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (thread,'fixture',root,'write',json.dumps(paths or ['.']),'[]',
                        'fixture-fingerprint','actor',stat.st_dev,stat.st_ino))
            db.commit()

    def native(self,root,paths=None):
        from native_work_admission import _git_common_dir
        with closing(self.connect()) as db:
            db.execute('INSERT INTO native_work_claims VALUES(?,?,?,?,?,?)',
                       ('running',str(root),json.dumps([str(p) for p in (paths or [root])]),
                        '[]',_git_common_dir(str(root)),1.0))
            db.commit()

    def busy(self,probe=None):
        with closing(self.connect()) as db:
            return self.scopes.busy(db,'pure',git_probe=probe)

    def test_unrecorded_git_identity_allows_disjoint_repositories_after_preflight(self):
        self.pure(self.b);self.native(self.a)
        self.assertTrue(self.busy())
        probe=self.scopes.preflight_native_git('pure')
        self.assertIsNotNone(probe)
        self.assertFalse(self.busy(probe))

    def test_shared_git_common_dir_still_blocks_sibling_worktree(self):
        sibling=self.root/'sibling'
        subprocess.run(['git','-C',str(self.a),'worktree','add','-q','--orphan','-b','sibling',
                        str(sibling)],check=True,capture_output=True,timeout=8)
        self.pure(sibling);self.native(self.a)
        self.assertTrue(self.busy(self.scopes.preflight_native_git('pure')))

    def test_nested_pure_root_can_identify_its_repository_before_native_check(self):
        nested=self.b/'.local'/'diagnostic';nested.mkdir(parents=True)
        self.pure(nested);self.native(self.a)
        self.assertTrue(self.busy())
        probe=self.scopes.preflight_native_git('pure')
        self.assertIsNotNone(probe)
        self.assertFalse(self.busy(probe))

    def test_path_overlap_still_blocks_with_valid_git_probe(self):
        self.pure(self.a);self.native(self.a,paths=[self.a/'src'])
        self.assertTrue(self.busy(self.scopes.preflight_native_git('pure')))

    def test_later_native_waiter_does_not_revoke_existing_pure_request_lease(self):
        self.pure(self.a)
        root=plain_root(str(self.a))
        with closing(self.connect()) as db:
            db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)',
                       ('existing-request','run','pure',root,'write','[]',10.0))
            db.execute('INSERT INTO native_work_claims VALUES(?,?,?,?,?,?)',
                       ('queued',root,json.dumps([root]),'[]',_git_common_dir(root),20.0))
            db.commit()
        probe=self.scopes.preflight_native_git('pure')
        with closing(self.connect()) as db:
            self.assertFalse(self.scopes.busy(db,'pure',git_probe=probe,
                                              held_request_id='existing-request'))
            self.assertTrue(self.scopes.busy(db,'pure',git_probe=probe))
            self.assertTrue(self.scopes.busy(db,'pure',git_probe=probe,
                                             held_request_id='different-request'))
            db.execute('UPDATE native_work_claims SET created=5.0')
            self.assertTrue(self.scopes.busy(db,'pure',git_probe=probe,
                                             held_request_id='existing-request'))
            db.execute('UPDATE native_work_claims SET created=20.0')
            db.execute("UPDATE native_work_claims SET state='reserved'")
            db.commit()
        with closing(self.connect()) as db:
            self.assertTrue(self.scopes.busy(db,'pure',git_probe=probe,
                                             held_request_id='existing-request'))

    def test_work_resources_keep_valid_probe_and_still_conflict_when_shared(self):
        self.pure(self.b);self.native(self.a)
        observed=self.scopes.preflight_native_git('pure')
        with closing(self.connect()) as db:
            candidate={**self.scopes.scope(db,'pure'),'resources':'["extra"]'}
            self.assertFalse(self.scopes.native_busy(db,candidate,observed))
            db.execute("UPDATE native_work_claims SET resources='[\"extra\"]'")
            db.commit()
            self.assertTrue(self.scopes.native_busy(db,candidate,observed))

    def test_failed_or_stale_probe_keeps_unknown_git_fence(self):
        self.pure(self.b);self.native(self.a)
        with patch('harness_team_scopes._git_common_dir',side_effect=AdmissionError('probe failed')):
            self.assertIsNone(self.scopes.preflight_native_git('pure'))
        self.assertTrue(self.busy())
        probe=self.scopes.preflight_native_git('pure')
        with closing(self.connect()) as db:
            db.execute("UPDATE host_team_scopes SET resources='[\"changed\"]' WHERE thread_id='pure'")
            db.commit()
        self.assertTrue(self.busy(probe))

    def test_replaced_root_keeps_unknown_git_fence(self):
        self.pure(self.b);self.native(self.a)
        probe=self.scopes.preflight_native_git('pure')
        self.b.rename(self.root/'old-repo-b')
        self.b.mkdir()
        subprocess.run(['git','-C',str(self.b),'init','-q'],check=True,capture_output=True,timeout=8)
        self.assertTrue(self.busy(probe))

    def test_replaced_git_directory_keeps_unknown_git_fence(self):
        self.pure(self.b);self.native(self.a)
        probe=self.scopes.preflight_native_git('pure')
        self.assertIsNotNone(probe)
        self.assertFalse(self.busy(probe))
        original_root_identity=(self.b.stat().st_dev,self.b.stat().st_ino)
        (self.b/'.git').rename(self.b/'.git-original')
        (self.b/'.git').write_text('gitdir: '+str(self.a/'.git')+'\n',encoding='utf-8')
        self.assertEqual((self.b.stat().st_dev,self.b.stat().st_ino),original_root_identity)
        self.assertEqual(_git_common_dir(str(self.b)),_git_common_dir(str(self.a)))
        self.assertTrue(self.busy(probe))

    def test_probe_without_git_marker_cannot_lift_unknown_git_fence(self):
        self.pure(self.b);self.native(self.a)
        probe=self.scopes.preflight_native_git('pure')
        self.assertIsNotNone(probe)
        self.assertFalse(self.busy(probe))
        self.assertTrue(self.busy({key:value for key,value in probe.items() if key!='git_marker'}))

    def test_git_probe_runs_before_sqlite_write_transaction(self):
        self.pure(self.b);self.native(self.a)
        from native_work_admission import _git_common_dir
        def probe(root,timeout=2):
            with closing(self.connect()) as db:
                db.execute("INSERT INTO operations VALUES('probe-check','probe','completed')")
                db.commit()
            return _git_common_dir(root,timeout=timeout)
        with patch('harness_team_scopes._git_common_dir',side_effect=probe):
            observed=self.scopes.preflight_native_git('pure')
        self.assertIsNotNone(observed)
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            self.assertFalse(self.scopes.busy(db,'pure',git_probe=observed))
            db.commit()

    def test_no_native_claim_skips_git_probe(self):
        self.pure(self.b)
        with patch('harness_team_scopes._git_common_dir',side_effect=AssertionError('unneeded probe')):
            self.assertIsNone(self.scopes.preflight_native_git('pure'))


if __name__=='__main__':
    unittest.main()
