"""Optional user budgets shared by existing run and continuation controls."""


def deadline_live(run, now):
    return run['deadline'] is None or run['deadline'] > now


def sends_available(run, needed=1, reserve_final=0):
    return (run['max_dispatches'] is None or
            run['dispatches'] + needed + reserve_final <= run['max_dispatches'])


def remaining(value, used=0):
    return None if value is None else max(0, value-used)


def migrate_runs(db):
    """Allow NULL budgets without changing old finite limits or run identities."""
    if not db.in_transaction:db.execute('BEGIN IMMEDIATE')
    columns=list(db.execute('PRAGMA table_info(host_runs)'))
    if not any(row['name'] in ('deadline','max_dispatches') and row['notnull'] for row in columns):
        return
    db.execute('''CREATE TABLE host_runs_optional_budget(
      id TEXT PRIMARY KEY,controller_thread TEXT NOT NULL,controller_request TEXT NOT NULL UNIQUE,
      goal_ref TEXT NOT NULL,constraints_text TEXT NOT NULL,state TEXT NOT NULL,
      deadline REAL,max_dispatches INTEGER,max_parallel INTEGER NOT NULL,
      dispatches INTEGER NOT NULL DEFAULT 0,final_granted INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,wait_mode TEXT NOT NULL DEFAULT 'all',
      after_seq INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,reason TEXT NOT NULL DEFAULT '')''')
    names=','.join(row['name'] for row in columns)
    db.execute('INSERT INTO host_runs_optional_budget('+names+') SELECT '+names+' FROM host_runs')
    db.execute('DROP TABLE host_runs')
    db.execute('ALTER TABLE host_runs_optional_budget RENAME TO host_runs')
