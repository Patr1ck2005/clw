"""Read-only maintenance preflight; paused business requests remain preserved."""
from pathlib import Path
import sqlite3,json,sys
from contextlib import closing

def inspect(path):
    with closing(sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True)) as db:
        # A retained processing request / deadline drain is not proof of an
        # executing model. Paused carriers cannot admit another Send. Actual
        # native turns, MCP calls and Runner Jobs are checked separately.
        rows=db.execute("""SELECT r.state,COALESCE(p.paused,0) FROM host_runs r
          LEFT JOIN managed_pages p ON p.thread_id=r.controller_thread
          WHERE r.state NOT IN ('paused','closed')""").fetchall()
        return {'activeRuns':sum(not paused for _,paused in rows),
                'preservedPausedRuns':sum(bool(paused) for _,paused in rows),
                'unsettledMaintenance':db.execute("SELECT count(*) FROM host_team_maintenance WHERE state='holding'").fetchone()[0]}

if __name__=='__main__':
    print(json.dumps(inspect(sys.argv[1])))
