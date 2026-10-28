"""Product-owned durable task journal. Never touches WebCodex's database."""
from __future__ import annotations
from contextlib import closing
from pathlib import Path
import json
import re
import sqlite3
import uuid
import task_goals
import task_routing
from task_domain import MAX_JSON, TaskError, bounded, obj, txt, fail, now, encoded, fingerprint, contract, initial, view, role_of, absolute, within, transition, export_packet
from task_collaboration import ACTIONS as COLLABORATION_ACTIONS, assignment as role_assignment, transition as collaboration_transition
import task_resources

REQUEST = re.compile(r'[A-Za-z0-9_-]{16,100}\Z')
TASK = re.compile(r'clw_task_[a-f0-9]{32}\Z')
from native_identity import SESSION_RE as SESSION

class TaskStore:
    def __init__(self, path: Path, observer=None, communication=None):
        self.path=Path(path).resolve();self.observer=observer;self.communication=communication
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(self.connect()) as db:
            # Identify before ANY persistent pragma/schema write. A supplied path is
            # not permission to convert an unrelated or WebCodex database.
            def identity():
                app_id=db.execute('PRAGMA application_id').fetchone()[0]
                tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                if app_id not in (0,0x434C5754) or (app_id==0 and tables):
                    fail('foreign_store','该文件不是CLW任务库，未采用或修改',409)
                if app_id==0x434C5754:
                    if tables!={'tasks','events','receipts','metadata'}: fail('incompatible','任务库结构异常，未自动修复',409)
                    row=db.execute('SELECT value FROM metadata WHERE key=?',('schema_version',)).fetchone()
                    if row is None or row[0] not in ('1','2','3','4'): fail('incompatible','任务库版本未支持',409)
                return app_id
            identity()
            try:
                db.execute('BEGIN IMMEDIATE');identity()
                for statement in (
                    'CREATE TABLE IF NOT EXISTS tasks (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, version INTEGER NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)'):
                    db.execute(statement)
                db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)',('store_id',uuid.uuid4().hex))
                db.execute('INSERT OR IGNORE INTO metadata VALUES (?,?)',('schema_version','1'))
                db.execute('PRAGMA application_id=1129076564')
                self.store_id=db.execute('SELECT value FROM metadata WHERE key=?',('store_id',)).fetchone()[0]
                db.commit()
            except BaseException:
                db.rollback();raise
            db.execute('PRAGMA journal_mode=WAL')
    def connect(self):
        db=sqlite3.connect(self.path,timeout=5,isolation_level=None)
        db.row_factory=sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        return db
    def _id(self, value):
        if not isinstance(value,str) or not TASK.fullmatch(value): fail('invalid','任务ID无效')
        return value
    def get(self, task_id):
        self._id(task_id)
        with closing(self.connect()) as db:
            row=db.execute('SELECT data FROM tasks WHERE id=?',(task_id,)).fetchone()
        if not row: fail('not_found','任务不存在',404)
        return view(json.loads(row['data']))
    def listing(self, query='', project='', status='', after=0, limit=30):
        txt(query,'搜索',200,False);txt(project,'Project',512,False)
        if status not in {'','draft','open','paused','accepted','cancelled'}: fail('invalid','筛选状态无效')
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=50: fail('invalid','分页参数无效')
        result=[]
        with closing(self.connect()) as db:
            for row in db.execute('SELECT sequence,data FROM tasks WHERE sequence>? ORDER BY sequence',(after,)):
                task=json.loads(row['data']);c=task['contract']
                if status and task['status']!=status: continue
                if query and query.casefold() not in (c['title']+' '+c['goal']+' '+task['id']).casefold(): continue
                if project and not any(r['project_id']==project for r in c['roles']): continue
                result.append({'id':task['id'],'version':task['version'],'sequence':row['sequence'],'title':c['title'],'mode':c['mode'],'phase':view(task)['phase'],'status':task['status'],'contract_version':task['contract_version'],'updated_at':task['updated_at'],'progress':view(task)['progress']})
                if len(result)>limit: break
        more=len(result)>limit;result=result[:limit]
        return {'tasks':result,'next_after':result[-1]['sequence'] if more else None,'store_id':self.store_id,'retention':'local persistent journal, not full chat history'}
    def events(self, task_id, after=0, limit=50):
        self._id(task_id)
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100: fail('invalid','事件分页无效')
        result=[];size=0;more=False
        with closing(self.connect()) as db:
            for row in db.execute('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT ?',(task_id,after,limit+1)):
                entry={k:row[k] for k in ('sequence','version','action','actor','at')}|{'payload':json.loads(row['payload'])}
                amount=len(encoded(entry).encode('utf-8'))
                if len(result)>=limit or (result and size+amount>MAX_JSON):
                    more=True;break
                result.append(entry);size+=amount
        return {'events':result,'next_after':result[-1]['sequence'] if more else None}
    def receipt(self, request_id):
        if not isinstance(request_id,str) or not REQUEST.fullmatch(request_id): fail('invalid','请求ID无效')
        with closing(self.connect()) as db:
            row=db.execute('SELECT response FROM receipts WHERE request_id=?',(request_id,)).fetchone()
        return {'found':row is not None,'receipt':json.loads(row['response']) if row else None,'store_id':self.store_id}
    def sessions(self, task_id, role_id):
        task=self.get(task_id);role,_=role_of(task,role_id)
        if not self.observer: fail('offline','未配置实时会话观察',409)
        state=self.observer.state(role['project_id'])
        if state.get('state')!='connected' or not state.get('projection'): fail('offline','未获得当前项目的有效实时观测',409)
        project=next((p for p in state['projection']['projects'] if p['id']==role['project_id']),None)
        if not project or absolute(project['path'])!=role['project_root']: fail('identity','声明的Project根与实际观测不一致',409)
        return {'connection_id':state['connection_id'],'observed_at':state['observed_at'],'coverage':state.get('coverage',{}).get('sessions'),
            'sessions':[{'id':s['id'],'title':s['title'],'lifecycle':s['lifecycle']} for s in state['projection']['sessions']]}
    def binding(self, task, data):
        obj(data,{'role_id','session_id','connection_id'},{'role_id','session_id','connection_id'})
        role,_=role_of(task,data['role_id'])
        sid=data['session_id']
        if not isinstance(sid,str) or not SESSION.fullmatch(sid): fail('invalid','Session ID无效')
        if not self.observer: fail('offline','未配置实时连接',409)
        state=self.observer.state(role['project_id'],sid)
        if state.get('state')!='connected' or not state.get('projection'): fail('identity','没有当前授权范围内的Session观测',409)
        if state.get('connection_id')!=data['connection_id']: fail('identity','连接身份已变化，请重新核对',409)
        projection=state['projection']
        p=next((p for p in projection['projects'] if p['id']==role['project_id']),None)
        s=next((s for s in projection['sessions'] if s['id']==sid and s['project_id']==role['project_id']),None)
        if not p or absolute(p['path'])!=role['project_root'] or not s or not within(role['worktree'],absolute(p['path'])):
            fail('identity','Project / Session / 工作目录不匹配',409)
        if s['lifecycle']!='active': fail('identity','不能绑定已关闭会话',409)
        return {'session_id':sid,'project_id':role['project_id'],'connection_id':state['connection_id'],
            'observed_at':state['observed_at'],'source':'webcodex_read_observation','not_account_authentication':True}
    def assignment(self, task_id, role_id):
        return role_assignment(self.get(task_id),role_id,self.store_id)

    def inbox(self, after=0, limit=30):
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=50:
            fail('invalid','收件分页参数无效')
        rows=[]
        with closing(self.connect()) as db:
            for row in db.execute('SELECT sequence,data FROM tasks WHERE sequence>? ORDER BY sequence',(after,)):
                task=json.loads(row['data'])
                if task['status'] not in {'open','paused'} or not task.get('collaboration',{}).get('enabled'):continue
                items=[]
                for rid,s in task['roles'].items():
                    if s['status']=='submitted' and s.get('delivery'):
                        d=s['delivery'];items.append({'kind':'delivery','role_id':rid,'delivery_id':d['id'],'summary':d['summary'][:500],'attempt':d['attempt'],'feedback_revision':d['feedback_revision']})
                    elif s['status']=='blocked':items.append({'kind':'blocked','role_id':rid,'summary':'保留责任；核对原恢复点和Job'})
                if task['collaboration'].get('shared_change_pending'):items.append({'kind':'shared_change','summary':'需主控修订共同合同；暂停不等于停止原执行'})
                if view(task)['phase']=='awaiting_acceptance':items.append({'kind':'parent_acceptance','summary':'角色已审阅，父任务仍需逐条验收'})
                if task_goals.enabled(task):
                    if task_goals.limit_reason(task):items.append({'kind':'goal_budget','summary':'达到明确循环/无进展上限；保留证据，不自动换模型或重做'})
                    elif all(s.get('review') for s in task['roles'].values()) and not any(s['status'] in {'running','blocked'} for s in task['roles'].values()):items.append({'kind':'goal_decision','summary':'当前轮交付已审阅；主控决定最终验收或下一轮计划'})
                routing=task.get('routing',{})
                if routing and (routing.get('failures',0)>=routing.get('failure_limit',3) or any(n['phase']=='delivery_unknown' for n in routing.get('outbox',[]))):
                    items.append({'kind':'routing_unknown','summary':'原消息结果未知或停发；保留原键，不自动换账号、收件人或重发'})
                if not items:continue
                rows.append({'sequence':row['sequence'],'task_id':task['id'],'task_version':task['version'],'title':task['contract']['title'],'status':task['status'],'items':items})
                if len(rows)>limit:break
        more=len(rows)>limit;rows=rows[:limit]
        return {'items':rows,'next_after':rows[-1]['sequence'] if more else None,'store_id':self.store_id,'source':'current_task_projection_not_separate_completion_ledger','host_wake_performed':False}

    def resources(self):
        with closing(self.connect()) as db:
            return task_resources.listing(db)|{'store_id':self.store_id}

    def coordinate_resources(self):
        """Bounded metadata work; not a model heartbeat or an executor."""
        with closing(self.connect()) as db:
            if not task_resources.catalog(db)['resources']:return 0
            try:
                db.execute('BEGIN IMMEDIATE')
                changed=task_resources.advance(db)
                db.commit();return changed
            except BaseException:db.rollback();raise

    def command(self, raw):
        bounded(raw)
        obj(raw,{'request_id','action','task_id','expected_version','actor','data'}, {'request_id','action','actor','data'})
        request_id=raw['request_id'];self.receipt(request_id)
        action=txt(raw['action'],'动作',40);actor=txt(raw['actor'],'操作者别名',100);data=raw['data']
        if not isinstance(data,dict): fail('invalid','data必须为对象')
        digest=fingerprint(raw)
        # Resolve an already committed request before any network preflight.
        with closing(self.connect()) as db:
            old=db.execute('SELECT * FROM receipts WHERE request_id=?',(request_id,)).fetchone()
        if old:
            if old['fingerprint']!=digest: fail('request_conflict','原请求ID被不同参数复用',409)
            return json.loads(old['response'])|{'replayed':True}
        creating=action in {'create','import'}
        if not creating:
            tid=self._id(raw.get('task_id'));expected=raw.get('expected_version')
            if type(expected) is not int or expected<1: fail('invalid','缺少准确任务版本')
        elif raw.get('task_id') is not None or raw.get('expected_version') not in (None,0):
            fail('invalid','创建不能指定旧任务身份')
        verified=self.binding(self.get(tid),data) if action=='bind' else None
        communication_verified=task_routing.binding_preflight(self.get(tid),data,self.communication) if action=='routing.bind' else None
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                previous=db.execute('SELECT * FROM receipts WHERE request_id=?',(request_id,)).fetchone()
                if previous:
                    if previous['fingerprint']!=digest: fail('request_conflict','原请求ID被不同参数复用',409)
                    db.rollback();return json.loads(previous['response'])|{'replayed':True}
                if creating:
                    if db.execute('SELECT count(*) FROM tasks').fetchone()[0]>=2000: fail('capacity','本机任务数量达到当前上限，请先导出归档',409)
                    if action=='create': obj(data,{'contract'},{'contract'});c=contract(data['contract']);origin=None
                    else:
                        obj(data,{'bundle'},{'bundle'});bundle=data['bundle']
                        obj(bundle,{'format','task','exported_at'}, {'format','task'})
                        if bundle['format']!='clw.task.v1' or not isinstance(bundle['task'],dict): fail('invalid','不支持该任务包')
                        c=contract(bundle['task'].get('contract'));origin={'kind':'imported_as_new_draft','source_id':txt(bundle['task'].get('id',''),'来源任务ID',100,False),'source_hash':fingerprint(bundle)}
                    tid='clw_task_'+uuid.uuid4().hex;t=now()
                    task={'id':tid,'version':1,'contract_version':1,'contract_hash':fingerprint(c),'contract':c,'roles':initial(c),'status':'draft','created_at':t,'updated_at':t,'created_by':actor,'origin':origin,'acceptance_review':None}
                    db.execute('INSERT INTO tasks(id,version,data) VALUES (?,?,?)',(tid,1,encoded(task)))
                else:
                    row=db.execute('SELECT data,version FROM tasks WHERE id=?',(tid,)).fetchone()
                    if not row: fail('not_found','任务不存在',404)
                    # Deliveries are fenced to one role attempt, not a sibling's mutable task version.
                    # All other edits retain strict whole-task compare-and-swap semantics.
                    if row['version']!=expected and not (action=='deliver' and expected<=row['version']):
                        fail('version_conflict','任务已被其他窗口更新，草稿保留；请核对最新版本',409)
                    task=json.loads(row['data'])
                    all_tasks=(json.loads(r[0]) for r in db.execute('SELECT data FROM tasks')) if action=='claim' else ()
                    task_goals.preflight(task,action,data)
                    task_resources.preflight(db,task,action,data)
                    if action in task_routing.ACTIONS:
                        task=task_routing.transition(task,action,data,actor,self.communication,communication_verified)
                        if action=='routing.enable':db.execute("UPDATE metadata SET value='4' WHERE key='schema_version' AND value IN ('1','2','3')")
                    elif action in task_goals.ACTIONS:
                        task=task_goals.transition(task,action,data,actor)
                        if action=='goal.enable':db.execute("UPDATE metadata SET value='4' WHERE key='schema_version' AND value IN ('1','2','3')")
                    elif action in task_resources.ACTIONS:
                        task=task_resources.transition(db,task,action,data,actor,self.store_id)
                    elif action in COLLABORATION_ACTIONS:
                        task=collaboration_transition(task,action,data,actor,self.store_id)
                        if action=='collaborate':
                            db.execute("UPDATE metadata SET value='2' WHERE key='schema_version' AND value='1'")
                    else:
                        task=transition(task,action,data,actor,all_tasks,verified)
                    task['version']=row['version']+1
                    db.execute('UPDATE tasks SET version=?,data=? WHERE id=?',(task['version'],encoded(task),tid))
                if len(encoded(task).encode('utf-8'))>MAX_JSON-32768:
                    fail('too_large','任务记录已达容量上限，请以产物路径引用代替大段嵌入日志',413)
                payload={'data':data,'contract_version':task['contract_version'],'contract_hash':task['contract_hash'],'result_status':task['status']}
                if action=='import': payload['data']={'import_origin':task['origin'],'contract':task['contract']}
                db.execute('INSERT INTO events(task_id,version,action,actor,at,payload) VALUES (?,?,?,?,?,?)',(tid,task['version'],action,actor,now(),encoded(payload)))
                task_resources.advance(db,request_id)
                task=json.loads(db.execute('SELECT data FROM tasks WHERE id=?',(tid,)).fetchone()[0])
                response={'request_id':request_id,'request_fingerprint':digest,'task_id':tid,'version':task['version'],'store_id':self.store_id,'replayed':False,'task':view(task),'effect':'product_metadata_only'}
                db.execute('INSERT INTO receipts VALUES (?,?,?)',(request_id,digest,encoded(response)))
                db.commit()
                return response
            except BaseException:
                db.rollback()
                raise
    def specialist_receipt(self, raw):
        bounded(raw)
        self._id(raw.get('task_id'));self.receipt(raw.get('request_id'))
        if type(raw.get('expected_version')) is not int or raw['expected_version']<1: fail('version','缺少准确任务版本')
        txt(raw.get('actor'),'操作者',100)
        if raw.get('action') not in {'specialist.prepare','specialist.start','specialist.retry_start','specialist.observe','specialist.cancel','specialist.abandon'}:
            fail('action','未知专项动作')
        with closing(self.connect()) as db:
            row=db.execute('SELECT * FROM receipts WHERE request_id=?',(raw['request_id'],)).fetchone()
        if not row: return None
        if row['fingerprint']!=fingerprint(raw): fail('request_conflict','原请求ID参数不一致',409)
        return json.loads(row['response'])|{'replayed':True}

    def specialist_edit(self, raw, mutate):
        """Trusted in-process path only; ordinary HTTP task commands cannot choose mutate."""
        old=self.specialist_receipt(raw)
        if old is not None:return old
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                old=db.execute('SELECT * FROM receipts WHERE request_id=?',(raw['request_id'],)).fetchone()
                if old:
                    if old['fingerprint']!=fingerprint(raw):fail('request_conflict','原请求ID参数不一致',409)
                    db.rollback();return json.loads(old['response'])|{'replayed':True}
                row=db.execute('SELECT version,data FROM tasks WHERE id=?',(raw['task_id'],)).fetchone()
                if not row:fail('not_found','任务不存在',404)
                if row['version']!=raw['expected_version']:fail('version_conflict','任务已变化，请保留输入并核对',409)
                task=json.loads(row['data']);_,state=role_of(task,raw['data']['role_id'])
                task_goals.preflight(task,raw['action'],raw['data'])
                task_resources.preflight(db,task,raw['action'],raw['data'])
                mutate(task,state)
                task['version']+=1;task['updated_at']=now();bounded(task)
                if len(encoded(task).encode())>MAX_JSON-32768:fail('too_large','任务记录已达上限',413)
                db.execute('UPDATE tasks SET version=?,data=? WHERE id=?',(task['version'],encoded(task),task['id']))
                # The instruction remains in the task itself; journal only the immutable identity/hash.
                public={k:v for k,v in state.get('delegation',{}).items() if k not in {'instruction','observation_token'}}
                db.execute('INSERT INTO events(task_id,version,action,actor,at,payload) VALUES (?,?,?,?,?,?)',
                    (task['id'],task['version'],raw['action'],raw['actor'],now(),encoded({'role_id':raw['data']['role_id'],'delegation':public})))
                response={'request_id':raw['request_id'],'task_id':task['id'],'version':task['version'],'store_id':self.store_id,'replayed':False,'effect':'delegation_intent_recorded_read_current_task_for_remote_outcome'}
                db.execute('INSERT INTO receipts VALUES (?,?,?)',(raw['request_id'],fingerprint(raw),encoded(response)))
                db.commit();return response
            except BaseException:db.rollback();raise

    def specialist_result(self, task_id, role_id, delegation_id, operation, update):
        """Merge only the exact reserved operation; late responses cannot clear newer work."""
        bounded(update)
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                row=db.execute('SELECT data FROM tasks WHERE id=?',(task_id,)).fetchone()
                if not row:fail('not_found','任务不存在',404)
                task=json.loads(row['data']);_,state=role_of(task,role_id);d=state.get('delegation')
                if not d or d['id']!=delegation_id or d.get('operation')!=operation:db.rollback();return False
                d.update(update);task['version']+=1;task['updated_at']=now();bounded(task)
                db.execute('UPDATE tasks SET version=?,data=? WHERE id=?',(task['version'],encoded(task),task_id))
                public={k:v for k,v in update.items() if k!='observation_token'}
                db.execute('INSERT INTO events(task_id,version,action,actor,at,payload) VALUES (?,?,?,?,?,?)',
                    (task_id,task['version'],'specialist.result','native-observation',now(),encoded({'role_id':role_id,'delegation_id':delegation_id,'result':public})))
                db.commit();return True
            except BaseException:db.rollback();raise

    def export(self, task_id, role_id='', fmt='json'):
        return self.render_export(self.get(task_id),role_id,fmt)

    @staticmethod
    def render_export(task, role_id='', fmt='json'):
        """Render one observed snapshot; HTTP adds instructions from this same value."""
        task_id=task['id']
        if role_id: role_of(task,role_id)
        if fmt=='markdown': content=export_packet(task,role_id);ext='md'
        elif fmt=='json': content=encoded({'format':'clw.task.v1','exported_at':now(),'task':task});ext='json'
        else: fail('invalid','导出格式无效')
        return {'filename':task_id+('-'+role_id if role_id else '')+'.'+ext,'content':content,'media_type':'application/json' if ext=='json' else 'text/markdown'}
