"""Small durable provider bindings and operation receipts, not a business workflow.
Native runtimes own threads/turns. This journal never marks a project goal accepted.
"""
from __future__ import annotations
from contextlib import closing
from datetime import datetime, timezone
import hashlib, json, re, sqlite3, threading, uuid
from pathlib import Path

class HarnessError(ValueError):
    def __init__(self, code: str, status: int = 400):
        self.code, self.status = code, status
        super().__init__(code)

def stamp():return datetime.now(timezone.utc).isoformat()
def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
def require(condition,code,status=400):
    if not condition:raise HarnessError(code,status)

def public(value):
    """Drop credential-looking fields and redact common bearer values recursively."""
    if isinstance(value,dict):
        return {k:public(v) for k,v in value.items() if k.lower().replace('_','') not in {'accesstoken','refreshtoken','consumetoken','authorization','cookie','apikey','token','email','accountid','intent','hostkey','hostaccesskey','recoverytoken','x-clw-host'}}
    if isinstance(value,list):return [public(v) for v in value[:256]]
    if isinstance(value,str):
        return re.sub(r'(?i)(?:wc_(?:pat|oat|wake_consume)_|wck_|sk-)[A-Za-z0-9_-]{12,}|clw[hr]_[A-Za-z0-9_-]{43}|Bearer\s+[A-Za-z0-9_.-]{12,}','[redacted]',value)[:131072]
    return value

class HarnessState:
    def __init__(self,path:Path):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        self.lock=threading.RLock()
        with closing(self.connect()) as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,provider TEXT NOT NULL,native_id TEXT NOT NULL UNIQUE,parent_id TEXT,title TEXT NOT NULL,cwd TEXT NOT NULL,model TEXT,effort TEXT,status TEXT NOT NULL,active_turn TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,action TEXT NOT NULL,thread_id TEXT,state TEXT NOT NULL,response TEXT,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,thread_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS thread_events ON events(thread_id,seq);
            ''')
            db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)',('id',uuid.uuid4().hex));db.commit()
            self.id=db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()[0]
            # An interrupted send is not safe to replay, even after reconnect.
            db.execute("UPDATE operations SET state='unknown' WHERE state IN ('reserved','dispatching')")
            db.execute("UPDATE threads SET status='unknown' WHERE status IN ('working','stopping')")
            db.commit()
    def connect(self):
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row;return db
    def begin(self,key,command):
        require(isinstance(key,str) and re.fullmatch(r'[A-Za-z0-9_-]{16,100}',key),'request_id_required')
        fp=hashlib.sha256(canonical(command).encode()).hexdigest()
        with self.lock,closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE');row=db.execute('SELECT * FROM operations WHERE id=?',(key,)).fetchone()
            if row:
                require(row['fingerprint']==fp,'request_id_conflict',409)
                if row['response']:return False,json.loads(row['response'])
                return False,{'operation_id':key,'state':row['state'],'unknown':True,'replayed':True}
            db.execute('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',(key,fp,command['action'],command.get('thread_id'),'reserved',None,stamp()));db.commit()
            return True,None
    def operation(self,key,state,response=None):
        with self.lock,closing(self.connect()) as db:
            db.execute('UPDATE operations SET state=?,response=? WHERE id=?',(state,canonical(public(response)) if response is not None else None,key));db.commit()
    def receipt(self,key):
        with closing(self.connect()) as db:row=db.execute('SELECT * FROM operations WHERE id=?',(key,)).fetchone()
        require(row is not None,'operation_not_found',404)
        return {'operation_id':key,'state':row['state'],'result':json.loads(row['response']) if row['response'] else None}
    def bind(self,native_id,title,cwd,model=None,effort=None,parent_id=None,provider='codex'):
        require(isinstance(native_id,str) and 1<=len(native_id)<=160,'invalid_native_thread')
        require(isinstance(title,str) and 0<len(title)<=160,'invalid_title')
        now=stamp();key='hthr_'+uuid.uuid4().hex
        with self.lock,closing(self.connect()) as db:
            if parent_id:require(db.execute('SELECT 1 FROM threads WHERE id=?',(parent_id,)).fetchone() is not None,'unknown_parent',404)
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(key,provider,native_id,parent_id,title,str(cwd),model,effort,'idle',None,now,now));db.commit()
        return self.thread(key)
    def thread(self,key):
        with closing(self.connect()) as db:row=db.execute('SELECT * FROM threads WHERE id=?',(key,)).fetchone()
        require(row is not None,'unknown_thread',404)
        return dict(row)
    def by_native(self,key):
        with closing(self.connect()) as db:row=db.execute('SELECT * FROM threads WHERE native_id=?',(key,)).fetchone()
        return dict(row) if row else None
    def listing(self):
        with closing(self.connect()) as db:return [dict(row) for row in db.execute('SELECT * FROM threads ORDER BY updated_at DESC LIMIT 200')]
    def update(self,key,**values):
        require(bool(values) and set(values)<={'status','active_turn','title','model','effort'},'invalid_thread_update')
        values['updated_at']=stamp()
        with self.lock,closing(self.connect()) as db:
            db.execute('UPDATE threads SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),key));db.commit()
    def event(self,key,kind,data):
        data=public(data);text=canonical(data)
        if len(text.encode())>262144:data={'truncated':True,'summary':str(data)[:120000]};text=canonical(data)
        with self.lock,closing(self.connect()) as db:
            db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',(key,kind,text,stamp()));db.commit()
    def events(self,key,after=0,limit=100):
        self.thread(key);require(type(after) is int and after>=0,'invalid_cursor')
        with closing(self.connect()) as db:rows=db.execute('SELECT * FROM events WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?',(key,after,min(limit,100)+1)).fetchall()
        items=[{'seq':r['seq'],'kind':r['kind'],'data':json.loads(r['data']),'at':r['at']} for r in rows[:limit]]
        return {'items':items,'next_after':items[-1]['seq'] if items else after,'has_more':len(rows)>limit}
