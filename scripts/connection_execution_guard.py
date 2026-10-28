"""Read canonical local execution receipts without changing the Harness ledger."""
from contextlib import closing
from pathlib import Path
import argparse,json,sqlite3,time

TERMINAL=('completed','blocked','failed','cancelled')
REQUIRED={'metadata','threads','operations','host_requests','host_runs','host_team_leases','host_team_work','control_attempts'}
class ConnectionGuardError(RuntimeError):pass
def require(value,code):
    if not value:raise ConnectionGuardError(code)
def execution_idle(root,expected_store=None):
    database=Path(root)/'.local/harness/harness.sqlite3'
    try:before=database.stat()
    except FileNotFoundError:
        require(expected_store is None,'connection_execution_store_changed')
        return {'version':1,'source':'canonical_harness_readonly','idle':True,'code':'connection_execution_idle','database':'absent','storeVerified':False}
    require(database.is_file(),'connection_execution_ledger_unavailable')
    require(isinstance(expected_store,str) and 1<=len(expected_store)<=128,'connection_execution_store_unverified')
    try:
        with closing(sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=0.3)) as db:
            deadline=time.monotonic()+3
            db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
            db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
            tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            require(REQUIRED<=tables,'connection_execution_schema_unavailable')
            require(db.execute('PRAGMA quick_check(1)').fetchone()==('ok',),'connection_execution_ledger_unavailable')
            store=db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()
            require(store and store[0]==expected_store,'connection_execution_store_changed')
            def clear(query):require(db.execute(query).fetchone() is None,'connection_original_execution_unresolved')
            if 'native_work_claims' in tables:clear("SELECT 1 FROM native_work_claims WHERE state IS NULL OR state<>'released' LIMIT 1")
            clear('SELECT 1 FROM host_team_leases LIMIT 1')
            clear("SELECT 1 FROM host_runs WHERE state<>'closed' LIMIT 1")
            clear("SELECT 1 FROM host_requests WHERE phase NOT IN ('completed','blocked','failed','cancelled') LIMIT 1")
            clear("SELECT 1 FROM threads WHERE active_turn IS NOT NULL OR status NOT IN ('idle','error','interrupted','host_paused') LIMIT 1")
            clear("SELECT 1 FROM operations WHERE state IS NULL OR state NOT IN ('completed','accepted','sent','rejected','failed','cancelled') LIMIT 1")
            # Completed/accepted sends retain their original receipt forever.
            # Link Host sends to that exact request; native sends to their idle
            # original thread, whose full Session is separately read by the GUI.
            clear("""SELECT 1 FROM operations o LEFT JOIN host_requests r ON r.id=o.id
                LEFT JOIN threads t ON t.id=o.thread_id
                WHERE o.action='message.send' AND o.state IN ('completed','accepted','sent')
                AND ((r.id IS NOT NULL AND r.thread_id<>o.thread_id) OR
                (r.id IS NULL AND (t.id IS NULL OR t.provider<>'codex'
                OR t.active_turn IS NOT NULL OR t.status NOT IN ('idle','error','interrupted','host_paused')))) LIMIT 1""")
            clear("""SELECT 1 FROM control_attempts a LEFT JOIN host_requests r ON r.id=a.request_id
                WHERE a.state IN ('dispatching','unknown') OR
                (a.state IN ('sent','acknowledged') AND (r.id IS NULL OR r.phase NOT IN ('completed','blocked','failed','cancelled'))) LIMIT 1""")
            clear("""SELECT 1 FROM host_team_work w LEFT JOIN host_requests r ON r.id=w.request_id
                LEFT JOIN host_runs run ON run.id=w.run_id WHERE r.id IS NULL OR run.id IS NULL
                OR r.phase NOT IN ('completed','blocked','failed','cancelled') OR run.state<>'closed' LIMIT 1""")
            if 'recovery_attempts' in tables:
                clear("SELECT 1 FROM recovery_attempts WHERE state IN ('dispatching','unknown') LIMIT 1")
            if 'host_delegations' in tables:
                clear("""SELECT 1 FROM host_delegations d LEFT JOIN host_requests r ON r.id=d.child_request_id
                    WHERE r.id IS NULL OR r.phase NOT IN ('completed','blocked','failed','cancelled') LIMIT 1""")
            after=database.stat()
            require((before.st_dev,before.st_ino)==(after.st_dev,after.st_ino),'connection_execution_store_changed')
            return {'version':1,'source':'canonical_harness_readonly','idle':True,'code':'connection_execution_idle','database':'matched','storeVerified':True}
    except sqlite3.Error as error:raise ConnectionGuardError('connection_execution_ledger_unavailable') from error

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,required=True);p.add_argument('--expected-store');args=p.parse_args()
    try:
        require(args.root.resolve()==Path(__file__).resolve().parents[1],'connection_execution_root_changed')
        result=execution_idle(args.root,args.expected_store)
        print(json.dumps({'ok':True,'result':result}));return 0
    except (ConnectionGuardError,OSError):
        import sys
        error=sys.exc_info()[1];code=str(error) if isinstance(error,ConnectionGuardError) else 'connection_execution_ledger_unavailable'
        print(json.dumps({'ok':False,'code':code}));return 1
if __name__=='__main__':raise SystemExit(main())
