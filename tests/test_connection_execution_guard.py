import hashlib,sqlite3,tempfile,unittest
from pathlib import Path
from connection_execution_guard import execution_idle,ConnectionGuardError

SCHEMA='''
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO metadata VALUES('id','fixture-store');
CREATE TABLE threads(id TEXT PRIMARY KEY,provider TEXT,status TEXT,active_turn TEXT);
CREATE TABLE operations(id TEXT PRIMARY KEY,action TEXT,thread_id TEXT,state TEXT);
CREATE TABLE host_requests(id TEXT PRIMARY KEY,thread_id TEXT,phase TEXT);
CREATE TABLE host_runs(id TEXT PRIMARY KEY,state TEXT);
CREATE TABLE host_team_leases(request_id TEXT,run_id TEXT);
CREATE TABLE host_team_work(request_id TEXT,run_id TEXT);
CREATE TABLE control_attempts(request_id TEXT,state TEXT);
CREATE TABLE native_work_claims(claim_id TEXT,state TEXT);
CREATE TABLE host_delegations(child_request_id TEXT);
CREATE TABLE recovery_attempts(request_id TEXT,state TEXT);
'''
class ExecutionGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='clw-idle-');self.root=Path(self.temp.name);self.file=self.root/'.local/harness/harness.sqlite3';self.file.parent.mkdir(parents=True)
        with self.db() as db:db.executescript(SCHEMA)
    def tearDown(self):self.temp.cleanup()
    def db(self):
        from contextlib import closing
        return closing(sqlite3.connect(self.file))
    def sql(self,script):
        with self.db() as db:db.executescript(script)
    def read(self):return execution_idle(self.root,'fixture-store')
    def unchanged_rejected(self,code='connection_original_execution_unresolved'):
        before=hashlib.sha256(self.file.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ConnectionGuardError,code):self.read()
        self.assertEqual(hashlib.sha256(self.file.read_bytes()).hexdigest(),before)
    def test_fresh_missing_and_proven_empty_database_are_distinct(self):
        self.assertTrue(self.read()['storeVerified']);self.file.unlink();self.assertEqual(execution_idle(self.root)['database'],'absent')
        with self.assertRaisesRegex(ConnectionGuardError,'store_changed'):self.read()
    def test_all_unreleased_native_claims_reject_even_after_native_session_terminal(self):
        for state in ['queued','reserved','running','terminal_pending','unknown','unrecognized']:
            with self.subTest(state=state):
                self.sql("DELETE FROM native_work_claims;INSERT INTO native_work_claims VALUES('original','"+state+"');");self.unchanged_rejected()
        self.sql("UPDATE native_work_claims SET state='released';");self.assertTrue(self.read()['idle'])
    def test_request_run_and_lease_have_separate_idle_conditions(self):
        scripts=["INSERT INTO host_requests VALUES('original','controller','processing');","INSERT INTO host_runs VALUES('original-run','draining');","INSERT INTO host_team_leases VALUES('original','original-run');","INSERT INTO threads VALUES('native','codex','unknown',NULL);","INSERT INTO threads VALUES('native','codex','idle','active-turn');"]
        for script in scripts:
            with self.subTest(script=script):
                self.sql('DELETE FROM host_requests;DELETE FROM host_runs;DELETE FROM host_team_leases;DELETE FROM threads;'+script);self.unchanged_rejected()
    def test_unknown_or_reserved_operation_is_never_erased_by_closed_request(self):
        self.sql("INSERT INTO host_requests VALUES('original','controller','completed');")
        for state in ['reserved','dispatching','unknown','unrecognized']:
            with self.subTest(state=state):
                self.sql("DELETE FROM operations;INSERT INTO operations VALUES('original','message.send','controller','"+state+"');");self.unchanged_rejected()
    def test_historical_accepted_receipts_join_exact_terminal_requests(self):
        self.sql("INSERT INTO threads VALUES('controller','chatgpt_web_host','idle',NULL);INSERT INTO host_requests VALUES('original','controller','completed');INSERT INTO host_runs VALUES('original-run','closed');INSERT INTO host_team_work VALUES('original','original-run');INSERT INTO operations VALUES('original','message.send','controller','completed');INSERT INTO control_attempts VALUES('original','sent');INSERT INTO native_work_claims VALUES('prior-native','released');")
        before=self.file.read_bytes();self.assertTrue(self.read()['idle']);self.assertEqual(self.file.read_bytes(),before)
        self.sql("UPDATE host_requests SET thread_id='foreign-thread';");self.unchanged_rejected()
    def test_accepted_native_receipt_uses_original_idle_thread_without_a_host_request(self):
        self.sql("INSERT INTO threads VALUES('native','codex','idle',NULL);INSERT INTO operations VALUES('native-op','message.send','native','completed');")
        self.assertTrue(self.read()['idle']);self.sql("UPDATE threads SET provider='chatgpt_web_host';");self.unchanged_rejected()
    def test_orphan_child_and_unknown_control_receipt_remain_blockers(self):
        self.sql("INSERT INTO host_delegations VALUES('missing-child');");self.unchanged_rejected()
        self.sql("DELETE FROM host_delegations;INSERT INTO host_requests VALUES('original','controller','completed');INSERT INTO control_attempts VALUES('original','unknown');");self.unchanged_rejected()
    def test_replaced_store_corrupt_schema_and_locked_database_are_not_empty(self):
        self.sql("UPDATE metadata SET value='other-store';");self.unchanged_rejected('store_changed')
        self.sql("UPDATE metadata SET value='fixture-store';DROP TABLE host_runs;");self.unchanged_rejected('schema_unavailable')
        self.file.write_bytes(b'not a sqlite ledger');self.unchanged_rejected('ledger_unavailable')
    def test_lock_timeout_preserves_existing_ledger(self):
        with self.db() as db:
            db.execute('BEGIN EXCLUSIVE');self.unchanged_rejected('ledger_unavailable');db.rollback()

if __name__=='__main__':unittest.main()
