import sqlite3,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from harness_team_timing import result_timing

class TimingTests(unittest.TestCase):
    def test_round_time_excludes_queue_gaps_and_labels_delayed_dom_collection(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close);db.row_factory=sqlite3.Row
        db.executescript('''CREATE TABLE control_attempts(id,request_id,offered,acknowledged,epoch);
          CREATE TABLE control_browser_receipts(attempt_id,completed);
          CREATE TABLE managed_artifacts(id,source,created);
          INSERT INTO control_attempts VALUES('a','original',1,100,0),('b','original',900,1000,-1),('c','original',2000,NULL,2),('foreign','other',1,10,0);
          INSERT INTO control_browser_receipts VALUES('a',800),('b',1400);
          INSERT INTO managed_artifacts VALUES('a-tool','local_mcp_public_result',400);''')
        r=result_timing(db,'original')
        self.assertEqual(r['saved_round_seconds'],700)
        self.assertEqual(r['short_completed_rounds'],['a'])
        self.assertEqual(r['confirmed_sends'],2);self.assertEqual(r['recovery_sends'],1)
        self.assertEqual(r['rounds'][1]['timing_quality'],'collection_upper_bound')
        self.assertIsNone(r['rounds'][2]['observed_seconds'])
        self.assertEqual(len(r['rounds']),3)
    def test_legacy_missing_evidence_is_unknown_not_zero_work(self):
        db=sqlite3.connect(':memory:');self.addCleanup(db.close)
        self.assertEqual(result_timing(db,'legacy')['state'],'unavailable')

if __name__=='__main__':unittest.main()
