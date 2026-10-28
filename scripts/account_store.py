"""Persistent local account labels and explicitly confirmed Session attribution. No auth grants."""
from __future__ import annotations
from contextlib import closing
from pathlib import Path
import json, re, sqlite3, uuid
from task_domain import bounded, encoded, fail, fingerprint, now, obj, txt
from task_store import REQUEST, SESSION
from live_transport import ObservationError

ACCOUNT=re.compile(r'acct_[a-f0-9]{32}\Z')
BINDING=re.compile(r'bind_[a-f0-9]{32}\Z')

class AccountStore:
    APP=0x434C5741
    def __init__(self,path,sources,observer=None,health=None,tasks=None):
        self.path=Path(path).resolve();self.sources=sources;self.observer=observer;self.health=health;self.tasks=tasks
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(self.connect()) as db:
            def identity():
                app=db.execute('PRAGMA application_id').fetchone()[0]
                names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                if app not in (0,self.APP) or (app==0 and names):fail('foreign_store','不是CLW账户元数据库，未采用',409)
                if app==self.APP:
                    if names!={'accounts','bindings','events','receipts','metadata'}:fail('incompatible','账户库结构不兼容',409)
                    row=db.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()
                    if not row or row[0]!='1':fail('incompatible','账户库版本不兼容',409)
            identity()
            try:
                db.execute('BEGIN IMMEDIATE');identity()
                for sql in (
                    'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, source_id TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, connection_id TEXT NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(connection_id,project_id,session_id))',
                    'CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, data TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL)'):db.execute(sql)
                db.execute("INSERT OR IGNORE INTO metadata VALUES ('schema','1')");db.execute("INSERT OR IGNORE INTO metadata VALUES ('store_id',?)",(uuid.uuid4().hex,))
                db.execute('PRAGMA application_id='+str(self.APP));self.store_id=db.execute("SELECT value FROM metadata WHERE key='store_id'").fetchone()[0];db.commit()
            except BaseException:db.rollback();raise
            db.execute('PRAGMA journal_mode=WAL')
    def connect(self):
        db=sqlite3.connect(self.path,isolation_level=None,timeout=5);db.row_factory=sqlite3.Row;db.execute('PRAGMA synchronous=FULL');return db
    def get(self,aid):
        if not isinstance(aid,str) or not ACCOUNT.fullmatch(aid):fail('account','账号记录ID无效')
        with closing(self.connect()) as db:row=db.execute('SELECT data FROM accounts WHERE id=?',(aid,)).fetchone()
        if not row:fail('not_found','账号记录不存在',404)
        return json.loads(row[0])
    def source(self,a):
        e=self.sources.get(a['source_id'])
        if e['fingerprint']!=a['source_fingerprint'] or e['connection_id']!=a['connection_id']:fail('source_changed','入口引用已变化，需重新核对并确认；不迁移旧归属',409)
        return e
    def receipt(self,rid):
        if not isinstance(rid,str) or not REQUEST.fullmatch(rid):fail('request','原请求ID无效')
        with closing(self.connect()) as db:row=db.execute('SELECT response FROM receipts WHERE request_id=?',(rid,)).fetchone()
        return {'found':row is not None,'receipt':json.loads(row[0]) if row else None,'store_id':self.store_id}
    def bindings(self,aid):
        self.get(aid)
        with closing(self.connect()) as db:rows=db.execute('SELECT data FROM bindings WHERE account_id=? ORDER BY id',(aid,)).fetchall()
        return [json.loads(r[0]) for r in rows]
    def observed(self,a,project='',session=''):
        self.source(a)
        if a['archived']:fail('archived','该记录已归档，恢复后再观察',409)
        if not self.observer:fail('not_configured','尚未关联WebCodex只读接口',409)
        try:state=self.observer.state(project,session)
        except ObservationError:fail('observation','当前后端观察失败，未采用过期数据',409)
        if state.get('state')!='connected' or not state.get('projection'):fail('observation','当前后端未连接，不把缓存当成有效绑定依据',409)
        if state.get('connection_id')!=a['connection_id']:fail('connection','后端身份与此入口声明不一致',409)
        p=state['projection']
        if project and not any(x['id']==project for x in p['projects']):fail('project','该Project不可见',409)
        if session and not any(s['id']==session and s['project_id']==project for s in p['sessions']):fail('session','未观察到指定Project中的确切Session',409)
        return state
    def command(self,raw):
        bounded(raw);obj(raw,{'request_id','action','actor','data','account_id','expected_version'},{'request_id','action','actor','data'})
        rid=raw['request_id'];self.receipt(rid);actor=txt(raw['actor'],'操作者',100);action=raw['action'];data=raw['data'];digest=fingerprint(raw)
        if action not in {'create','update','archive','restore','reconfirm_source','bind','unbind'}:fail('action','未提供执行、重启或授权操作')
        with closing(self.connect()) as db:old=db.execute('SELECT * FROM receipts WHERE request_id=?',(rid,)).fetchone()
        if old:
            if old['fingerprint']!=digest:fail('request_conflict','原请求ID被不同参数复用',409)
            return json.loads(old['response'])|{'replayed':True}
        a=None;observed=None;source=None
        if action=='create':
            if 'account_id' in raw or 'expected_version' in raw:fail('identity','新建不能指定旧身份')
            obj(data,{'source_id','name','browser_hint','notes'},{'source_id','name','browser_hint','notes'});source=self.sources.get(data['source_id'])
        else:
            a=self.get(raw.get('account_id'))
            if type(raw.get('expected_version')) is not int or raw['expected_version']!=a['version']:fail('version_conflict','记录已变化，请保留输入并核对',409)
        if action in {'create','update'}:
            if action=='update':obj(data,{'name','browser_hint','notes'},{'name','browser_hint','notes'})
            fields={k:txt(data[k],k,2000 if k=='notes' else 120,k=='name') for k in ('name','browser_hint','notes')}
        elif action=='bind':
            obj(data,{'project_id','session_id','connection_id','role','notes','confirmed'},{'project_id','session_id','connection_id','role','notes','confirmed'})
            if data['confirmed'] is not True:fail('confirmation','必须明确确认账号归属；观察Session不证明来源账号')
            if not isinstance(data['session_id'],str) or not SESSION.fullmatch(data['session_id']):fail('session','Session ID无效')
            if data['connection_id']!=a['connection_id']:fail('connection','绑定不跨后端',409)
            txt(data['project_id'],'Project',512);txt(data['role'],'角色',80,False);txt(data['notes'],'归属确认说明',2000)
            observed=self.observed(a,data['project_id'],data['session_id'])
        elif action=='unbind':
            obj(data,{'binding_id','reason'},{'binding_id','reason'});txt(data['reason'],'解绑原因',2000)
            if not isinstance(data['binding_id'],str) or not BINDING.fullmatch(data['binding_id']):fail('binding','绑定ID无效')
        elif action in {'archive','restore','reconfirm_source'}:
            keys={'reason','confirmed'} if action=='reconfirm_source' else {'reason'};obj(data,keys,keys);txt(data['reason'],'原因',2000)
            if action=='reconfirm_source':
                if data['confirmed'] is not True:fail('confirmation','需要确认入口变化')
                source=self.sources.get(a['source_id'])
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');old=db.execute('SELECT * FROM receipts WHERE request_id=?',(rid,)).fetchone()
                if old:
                    if old['fingerprint']!=digest:fail('request_conflict','原请求参数已改变',409)
                    db.rollback();return json.loads(old['response'])|{'replayed':True}
                if a:
                    row=db.execute('SELECT data FROM accounts WHERE id=?',(a['id'],)).fetchone()
                    if not row or json.loads(row[0])['version']!=a['version']:fail('version_conflict','并发修改发生；原输入保留',409)
                    a=json.loads(row[0]);a['version']+=1
                else:
                    if db.execute('SELECT count(*) FROM accounts').fetchone()[0]>=64:fail('capacity','本版最多64个历史账户记录')
                    a={'id':'acct_'+uuid.uuid4().hex,'version':1,'source_id':source['id'],'source_fingerprint':source['fingerprint'],'connection_id':source['connection_id'],'tunnel_id':source['tunnel_id'],'created_at':now(),'archived':False,'identity_source':'local_operator_profile_not_openai_auth'}
                if action in {'create','update'}:a.update(fields)
                if action=='archive':a['archived']=True
                if action=='restore':a['archived']=False
                if action=='reconfirm_source':a.update(source_fingerprint=source['fingerprint'],connection_id=source['connection_id'],tunnel_id=source['tunnel_id'])
                detail={}
                if action=='bind':
                    row=db.execute('SELECT * FROM bindings WHERE connection_id=? AND project_id=? AND session_id=?',(a['connection_id'],data['project_id'],data['session_id'])).fetchone()
                    if row and row['account_id']!=a['id']:fail('binding_conflict','这个Session已归于另一个账户；须先明确解绑，不能抢占',409)
                    if not row and db.execute('SELECT count(*) FROM bindings').fetchone()[0]>=512:fail('capacity','绑定记录达到本版512项上限')
                    bid=row['id'] if row else 'bind_'+uuid.uuid4().hex
                    b={'id':bid,'account_id':a['id'],'connection_id':a['connection_id'],'project_id':data['project_id'],'session_id':data['session_id'],'source_fingerprint':a['source_fingerprint'],'role':txt(data['role'],'角色',80,False),'notes':data['notes'],'confirmed_by':actor,'confirmed_at':now(),'session_observed_at':observed['observed_at'],'attribution':'operator_confirmed_not_ingress_proof'}
                    db.execute('INSERT INTO bindings VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',(bid,a['id'],b['connection_id'],b['project_id'],b['session_id'],encoded(b)));detail={'binding':b}
                if action=='unbind':
                    row=db.execute('SELECT data FROM bindings WHERE id=? AND account_id=?',(data['binding_id'],a['id'])).fetchone()
                    if not row:fail('binding','绑定不存在于该账户',404)
                    detail={'removed_binding':json.loads(row[0]),'reason':data['reason']};db.execute('DELETE FROM bindings WHERE id=?',(data['binding_id'],))
                a['updated_at']=now();a['updated_by']=actor
                if action=='create':db.execute('INSERT INTO accounts VALUES (?,?,?,?)',(a['id'],a['source_id'],a['version'],encoded(a)))
                else:db.execute('UPDATE accounts SET version=?,data=? WHERE id=?',(a['version'],encoded(a),a['id']))
                event={'action':action,'actor':actor,'at':now(),'account':a,'detail':detail,'reason':data.get('reason')}
                db.execute('INSERT INTO events(account_id,data) VALUES (?,?)',(a['id'],encoded(event)))
                response={'request_id':rid,'store_id':self.store_id,'account':a,'replayed':False,'effect':'local_attribution_metadata_only'}
                db.execute('INSERT INTO receipts VALUES (?,?,?)',(rid,digest,encoded(response)));db.commit();return response
            except sqlite3.IntegrityError:db.rollback();fail('duplicate','该入口已有账户记录，请修改/恢复原记录',409)
            except BaseException:db.rollback();raise
    def listing(self):
        with closing(self.connect()) as db:
            accounts=[json.loads(r[0]) for r in db.execute('SELECT data FROM accounts ORDER BY rowid')]
            bindings=[json.loads(r[0]) for r in db.execute('SELECT data FROM bindings ORDER BY id')]
        for a in accounts:
            e=self.sources.entries.get(a['source_id']);a['source_current']=bool(e and e['fingerprint']==a['source_fingerprint'])
            a['registered_bindings']=sum(b['account_id']==a['id'] for b in bindings)
        return {'accounts':accounts,'sources':self.sources.public(),'store_id':self.store_id,'scope':'registered local profiles, not all ChatGPT accounts or conversations'}
    def history(self,aid,after=0):
        self.get(aid)
        if type(after) is not int or after<0:fail('cursor','事件游标无效')
        with closing(self.connect()) as db:rows=db.execute('SELECT * FROM events WHERE account_id=? AND sequence>? ORDER BY sequence LIMIT 51',(aid,after)).fetchall()
        events=[{'sequence':r['sequence'],**json.loads(r['data'])} for r in rows[:50]]
        return {'events':events,'next_after':events[-1]['sequence'] if len(rows)>50 else None}
    def dashboard(self,aid):
        a=self.get(aid);bindings=self.bindings(aid);source=self.sources.entries.get(a['source_id']);valid=bool(source and source['fingerprint']==a['source_fingerprint'])
        for b in bindings:b['source_current']=valid and b['source_fingerprint']==a['source_fingerprint'] and b['connection_id']==a['connection_id']
        health=self.health.observe(a['source_id']) if self.health and valid and not a['archived'] else {'state':'archived' if a['archived'] else 'source_changed','account_authentication':False}
        return {'account':a,'bindings':bindings,'health':health,'all_conversation_count':None,'model_state':'unobserved'}
    def inspect(self,aid,project='',session=''):
        a=self.get(aid);state=self.observed(a,project,session)
        return {'observation':state,'attribution':'session_exists_only; account must be confirmed separately'}
    def activity(self,aid,bid):
        a=self.get(aid);b=next((b for b in self.bindings(aid) if b['id']==bid),None)
        if not b:fail('binding','绑定不存在于此账号',404)
        if b['source_fingerprint']!=a['source_fingerprint'] or b['connection_id']!=a['connection_id']:fail('source_changed','旧归属需重新确认',409)
        state=self.observed(a,b['project_id'],b['session_id']);p=state['projection'];s=next(s for s in p['sessions'] if s['id']==b['session_id'])
        jobs=[j for j in p['jobs'] if (j.get('owner_session_id') or j.get('session_id'))==b['session_id']];links=[]
        if self.tasks:
            with closing(self.tasks.connect()) as db:
                for row in db.execute('SELECT data FROM tasks'):
                    t=json.loads(row[0])
                    for rid,rs in t['roles'].items():
                        rb=rs.get('binding')
                        if rb and all(rb.get(k)==b[k] for k in ('connection_id','project_id','session_id')):links.append({'task_id':t['id'],'title':t['contract']['title'],'role':rid,'phase':rs['status'],'worktree':next(r['worktree'] for r in t['contract']['roles'] if r['id']==rid)})
                    if len(links)>50:break
        return {'binding':b,'session':s,'jobs':jobs,'coverage':state['coverage'],'observed_at':state['observed_at'],'tasks':links[:50],'tasks_truncated':len(links)>50,'attribution':b['attribution'],'counts_not_exact_tool_calls':True}
    def export(self):
        with closing(self.connect()) as db:
            accounts=[json.loads(r[0]) for r in db.execute('SELECT data FROM accounts ORDER BY rowid')];bindings=[json.loads(r[0]) for r in db.execute('SELECT data FROM bindings ORDER BY id')]
        return {'format':'clw.accounts.v1','exported_at':now(),'accounts':accounts,'bindings':bindings,'coverage':'all current metadata; event history via paged history API; no credentials, health refs, transcripts or authentication claims'}
