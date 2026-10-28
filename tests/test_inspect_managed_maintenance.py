import unittest,tempfile,sqlite3,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from inspect_managed_maintenance import inspect

class MaintenanceInspection(unittest.TestCase):
    def test_preserved_claim_is_not_a_running_model_and_missing_carrier_stays_held(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'state.sqlite3'
            with sqlite3.connect(file) as db:
                db.executescript('CREATE TABLE host_runs(state,controller_thread); CREATE TABLE managed_pages(thread_id,paused); CREATE TABLE host_team_maintenance(state);')
                db.executemany('INSERT INTO host_runs VALUES(?,?)',[('draining','old'),('running','live'),('waiting','unknown'),('paused','paused')])
                db.executemany('INSERT INTO managed_pages VALUES(?,?)',[('old',1),('live',0)])
                db.execute("INSERT INTO host_team_maintenance VALUES('holding')")
            db.close()
            before=file.read_bytes();result=inspect(file)
            self.assertEqual(result,{'activeRuns':2,'preservedPausedRuns':1,'unsettledMaintenance':1})
            self.assertEqual(file.read_bytes(),before)

if __name__=='__main__':unittest.main()
