"""Current assignment and active handoff boundaries; no browser/model actions."""
from pathlib import Path
import sqlite3,sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_managed_stop_scope import stop_scope

class StopScopeTests(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row;self.addCleanup(self.db.close)
        self.db.executescript('''
        CREATE TABLE host_requests(id TEXT PRIMARY KEY,thread_id TEXT);
        CREATE TABLE host_runs(id TEXT PRIMARY KEY,controller_request TEXT,controller_thread TEXT);
        CREATE TABLE host_team_work(request_id TEXT PRIMARY KEY,run_id TEXT);
        CREATE TABLE host_delegations(child_request_id TEXT PRIMARY KEY,child_thread_id TEXT,child_target_id TEXT,parent_request_id TEXT,parent_thread_id TEXT);
        CREATE TABLE host_bindings(thread_id TEXT PRIMARY KEY,target_id TEXT);
        CREATE TABLE managed_pages(page_id TEXT PRIMARY KEY,target_id TEXT,thread_id TEXT);
        CREATE TABLE managed_handoffs(source_request TEXT,run_id TEXT,state TEXT,successor_page TEXT,successor_request TEXT);
        INSERT INTO host_requests VALUES('m-old','tm-old'),('m-new','tm-new'),('child-old','tc'),('child-new','tc');
        INSERT INTO host_runs VALUES('old-run','m-old','tm-old'),('new-run','m-new','tm-new');
        INSERT INTO host_bindings VALUES('tm-old','target-m'),('tm-new','target-successor'),('tc','target-child');
        INSERT INTO managed_pages VALUES('page-successor','target-successor','tm-new');
        INSERT INTO host_team_work VALUES('child-old','old-run'),('child-new','new-run');
        INSERT INTO host_delegations VALUES('child-old','tc','target-child','m-old','tm-old'),('child-new','tc','target-child','m-new','tm-new');
        ''')
        self.page={'page_id':'page-child','target_id':'target-child','thread_id':'tc','parent_target':'target-m'}

    def test_reassigned_worker_uses_current_request_not_its_first_assignment(self):
        old=stop_scope(self.db,self.page,{'id':'child-old'})
        self.assertEqual((old['run_id'],old['parent_request_id']),('old-run','m-old'))
        # The current assignment belongs to another controller. Stale physical
        # parent metadata cannot authorize stopping it from the former task.
        self.assertIsNone(stop_scope(self.db,self.page,{'id':'child-new'}))
        self.page['parent_target']='target-successor'
        new=stop_scope(self.db,self.page,{'id':'child-new'})
        self.assertEqual((new['run_id'],new['controller_target'],new['parent_request_id']),('new-run','target-successor','m-new'))

    def test_enrolling_handoff_retains_old_owner_then_only_active_same_run_transfers(self):
        self.db.execute("INSERT INTO managed_handoffs VALUES('m-old','old-run','enrolling','page-successor','m-new')")
        self.assertEqual(stop_scope(self.db,self.page,{'id':'child-old'})['parent_target'],'target-m')
        self.db.execute("UPDATE managed_handoffs SET state='active'")
        self.db.execute("UPDATE host_runs SET controller_request='m-new',controller_thread='tm-new' WHERE id='old-run'")
        current=stop_scope(self.db,self.page,{'id':'child-old'})
        self.assertEqual((current['controller_target'],current['parent_target'],current['parent_request_id']),('target-successor','target-successor','m-new'))
        self.assertEqual(current['original_parent_request_id'],'m-old')
        self.db.execute("UPDATE managed_handoffs SET run_id='foreign-run'")
        self.assertEqual(stop_scope(self.db,self.page,{'id':'child-old'})['parent_target'],'target-m')

    def test_missing_or_foreign_request_delegation_and_successor_never_guess_a_scope(self):
        self.assertIsNone(stop_scope(self.db,self.page,{'id':'unknown'}))
        self.assertIsNone(stop_scope(self.db,self.page,{'id':'m-old'}))
        self.db.execute("UPDATE host_delegations SET child_target_id='foreign' WHERE child_request_id='child-old'")
        self.assertIsNone(stop_scope(self.db,self.page,{'id':'child-old'}))
        self.db.execute("UPDATE host_delegations SET child_target_id='target-child' WHERE child_request_id='child-old'")
        self.db.execute("INSERT INTO managed_handoffs VALUES('m-old','old-run','active','missing-page','m-new')")
        self.assertIsNone(stop_scope(self.db,self.page,{'id':'child-old'}))

    def test_controller_scope_binds_exact_thread_and_current_request(self):
        page={'page_id':'page-m','target_id':'target-m','thread_id':'tm-old','parent_target':None}
        value=stop_scope(self.db,page,{'id':'m-old'})
        self.assertEqual(value['controller_request'],'m-old');self.assertIsNone(value['parent_request_id'])
        self.assertIsNone(stop_scope(self.db,page,{'id':'m-new'}))

if __name__=='__main__':unittest.main()
