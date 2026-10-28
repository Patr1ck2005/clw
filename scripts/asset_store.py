"""Product-owned asset journal and transactional raster blobs. No external execution."""
from __future__ import annotations
from contextlib import closing
from copy import deepcopy
from decimal import Decimal
from io import BytesIO
from pathlib import Path
import hashlib, json, ntpath, sqlite3, uuid, zipfile
from task_domain import bounded, encoded, fingerprint, obj, txt, now, fail, absolute, within
from task_store import REQUEST
from asset_domain import BATCH, CANDIDATE, ACTIVE, MAX_EXPORT, contract, spec_item, requirement_hash, charge, accounting, projection, handoff, handoff_markdown
from asset_images import decode, validate

MAX_BLOBS=256*1024*1024

class AssetStore:
    APP=0x434C574D
    def __init__(self,path,tasks=None,observer=None):
        self.path=Path(path).resolve();self.tasks=tasks;self.observer=observer
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(self.connect()) as db:
            def identity():
                app=db.execute('PRAGMA application_id').fetchone()[0]
                names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                if app not in (0,self.APP) or (app==0 and names):fail('foreign_store','不是CLW素材库，未采用',409)
                if app==self.APP:
                    if names!={'batches','blobs','events','receipts','metadata'}:fail('incompatible','素材库结构不兼容',409)
                    row=db.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()
                    if not row or row[0]!='1':fail('incompatible','素材库版本不兼容',409)
            identity()
            try:
                db.execute('BEGIN IMMEDIATE');identity()
                for sql in (
                    'CREATE TABLE IF NOT EXISTS batches(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS blobs(sha256 TEXT PRIMARY KEY,bytes INTEGER NOT NULL,data BLOB NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL,data TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS receipts(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL)',
                    'CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)'):db.execute(sql)
                db.execute("INSERT OR IGNORE INTO metadata VALUES('schema','1')");db.execute("INSERT OR IGNORE INTO metadata VALUES('store_id',?)",(uuid.uuid4().hex,))
                db.execute('PRAGMA application_id='+str(self.APP));self.store_id=db.execute("SELECT value FROM metadata WHERE key='store_id'").fetchone()[0];db.commit()
            except BaseException:db.rollback();raise
            db.execute('PRAGMA journal_mode=WAL')
    def connect(self):
        db=sqlite3.connect(self.path,timeout=5,isolation_level=None);db.row_factory=sqlite3.Row;db.execute('PRAGMA synchronous=FULL');return db
    def _id(self,value):
        if not isinstance(value,str) or not BATCH.fullmatch(value):fail('batch','批次ID无效')
        return value
    def _load(self,db,bid):
        row=db.execute('SELECT data FROM batches WHERE id=?',(self._id(bid),)).fetchone()
        if not row:fail('not_found','批次不存在',404)
        b=json.loads(row[0])
        if b['status']=='published' and fingerprint(b['contract'])!=b['spec_hash']:fail('integrity','冻结合同指纹不一致，未采用',409)
        return b
    def get(self,bid):
        with closing(self.connect()) as db:b=self._load(db,bid)
        p=projection(b);p['parent_state']=self.parent_state(b);p['delivery_ready']=p['delivery_ready'] and p['parent_state'] in {'unlinked','current'};return p
    def _parent(self,c):
        if not c['task_id']:return None
        if not self.tasks:fail('parent','父任务库未配置',409)
        t=self.tasks.get(c['task_id'])
        if t['status']=='cancelled' or not any(r['project_id']==c['project_id'] and within(absolute(c['project_root']),absolute(r['worktree'])) for r in t['contract']['roles']):fail('parent','父任务已取消或不包含所选Project及工作目录',409)
        return {'task_id':t['id'],'task_version':t['version'],'task_store_id':self.tasks.store_id}
    def parent_state(self,b):
        p=b['parent_binding']
        if not p:return 'unlinked'
        try:return 'current' if p==self._parent(b['contract']) else 'changed'
        except ValueError:return 'unavailable'
    def _require_parent(self,b):
        if self.parent_state(b) not in {'unlinked','current'}:fail('parent_changed','父任务版本已变；核对后明确确认新版本，不使用旧交付依据',409)
    def projects(self):
        if not self.observer:fail('offline','未配置只读观察；仍可填写明确的项目声明',409)
        state=self.observer.state()
        if state.get('state')!='connected' or not state.get('projection'):fail('offline','没有有效项目观测，未使用旧清单',409)
        return {'projects':state['projection']['projects'],'coverage':state['coverage'].get('projects'),'observed_at':state['observed_at'],'scope':'navigation_only_not_authority'}
    def receipt(self,rid):
        if not isinstance(rid,str) or not REQUEST.fullmatch(rid):fail('request','原请求ID无效')
        with closing(self.connect()) as db:row=db.execute('SELECT response FROM receipts WHERE request_id=?',(rid,)).fetchone()
        return {'found':row is not None,'receipt':json.loads(row[0]) if row else None,'store_id':self.store_id}
    def _replay(self,db,rid,digest):
        row=db.execute('SELECT * FROM receipts WHERE request_id=?',(rid,)).fetchone()
        if not row:return None
        if row['fingerprint']!=digest:fail('request_conflict','原请求不能换参数或图片',409)
        return json.loads(row['response'])|{'replayed':True}
    def _commit(self,raw,digest,fn):
        self.receipt(raw['request_id'])
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');old=self._replay(db,raw['request_id'],digest)
                if old:db.rollback();return old
                b=None
                if raw['action']!='create':
                    b=self._load(db,raw.get('batch_id'))
                    if type(raw.get('expected_version')) is not int or b['version']!=raw['expected_version']:fail('version_conflict','批次已变化，保留输入并刷新核对',409)
                elif 'batch_id' in raw or 'expected_version' in raw:fail('identity','新建不接收旧批次身份')
                b,detail,created=fn(db,b)
                b['version']=1 if created else b['version']+1;b['updated_at']=now();bounded(b)
                if created:
                    if db.execute('SELECT count(*) FROM batches').fetchone()[0]>=128:fail('capacity','素材库达到128批上限',409)
                    db.execute('INSERT INTO batches(id,version,data) VALUES(?,?,?)',(b['id'],b['version'],encoded(b)))
                else:db.execute('UPDATE batches SET version=?,data=? WHERE id=?',(b['version'],encoded(b),b['id']))
                event={'action':raw['action'],'at':now(),'actor':raw['actor'],'version':b['version'],'detail':detail}
                db.execute('INSERT INTO events(batch_id,data) VALUES(?,?)',(b['id'],encoded(event)))
                result={'request_id':raw['request_id'],'store_id':self.store_id,'batch':projection(b),'replayed':False,'effect':'local_asset_journal_only',**({'candidate_id':detail['candidate']['id']} if 'candidate' in detail else {})}
                db.execute('INSERT INTO receipts VALUES(?,?,?)',(raw['request_id'],digest,encoded(result)));db.commit();return result
            except BaseException:db.rollback();raise
    def _new(self,c,supersedes=None):
        return {'id':'asset_batch_'+uuid.uuid4().hex,'version':0,'status':'draft','contract':c,'spec_hash':None,'parent_binding':self._parent(c),'supersedes':supersedes,'created_at':now(),'attempts':[],'candidates':[],'selected':{}}
    def command(self,raw):
        bounded(raw);obj(raw,{'request_id','action','actor','data','batch_id','expected_version'},{'request_id','action','actor','data'})
        txt(raw['actor'],'操作者',100);action=raw['action'];d=raw['data']
        if action not in {'create','update','publish','clone','reserve','outcome','review','confirm_parent'}:fail('action','没有模型/API/生产目录执行动作')
        def mutate(db,b):
            if action in {'create','update'}:
                obj(d,{'contract'},{'contract'});c=contract(d['contract'])
                if action=='create':return self._new(c),{'contract':c},True
                if b['status']!='draft':fail('frozen','已发布需求不可修改，请明确复制为新草稿',409)
                b['contract']=c;b['parent_binding']=self._parent(c);return b,{'contract':c},False
            if action=='clone':
                obj(d,{'title'},{'title'})
                if any(a['state'] in ACTIVE for a in b['attempts']) or accounting(b)['unknown_count']:fail('unresolved','存在未决执行或费用，先核对原批次',409)
                c=deepcopy(b['contract']);c['title']=txt(d['title'],'新标题',160)
                return self._new(c,b['id']),{'supersedes':b['id'],'contract':c},True
            if action=='confirm_parent':
                obj(d,{'note','confirmed'},{'note','confirmed'});txt(d['note'],'父任务核对依据',2000)
                if d['confirmed'] is not True:fail('confirmation','需明确核对父任务变化')
                old=b['parent_binding'];b['parent_binding']=self._parent(b['contract'])
                return b,{'previous':old,'current':b['parent_binding'],'note':d['note']},False
            if action=='publish':
                obj(d,{'confirmed'},{'confirmed'})
                if b['status']!='draft' or d['confirmed'] is not True:fail('state','仅明确确认后的草稿可发布')
                self._require_parent(b);b['status']='published';b['spec_hash']=fingerprint(b['contract']);return b,{'spec_hash':b['spec_hash']},False
            if b['status']!='published':fail('draft','先发布冻结需求',409)
            if fingerprint(b['contract'])!=b['spec_hash']:fail('integrity','合同指纹不匹配',409)
            if action=='reserve':
                obj(d,{'asset_keys'},{'asset_keys'});keys=d['asset_keys']
                if not isinstance(keys,list) or not keys or len(keys)>32 or any(not isinstance(k,str) for k in keys) or len(set(keys))!=len(keys):fail('items','领取清单必须为1至32个不重复素材ID')
                self._require_parent(b);ledger=accounting(b)
                if ledger['needs_reconciliation']:fail('unresolved','先核对原执行或未知费用，禁止重复生成',409)
                if len(b['attempts'])+len(keys)>96:fail('capacity','单批最多96次明确领取',409)
                for key in keys:
                    spec_item(b,key)
                    if key in b['selected'] or any(a['asset_key']==key and a['state'] in ACTIVE for a in b['attempts']):fail('active','已批准或仍有未决执行，不能重领',409)
                budget=b['contract']['budget']
                if budget and Decimal(ledger['available'])<Decimal(budget['per_attempt'])*len(keys):fail('budget','本地预算不足，不领取；不得以换批次绕过未决费用',409)
                added=[]
                for key in keys:
                    a={'id':'asset_attempt_'+uuid.uuid4().hex,'asset_key':key,'external_key':'clw_asset_'+uuid.uuid4().hex,'state':'reserved','external_ref':'','evidence':'尚未发送，只预留并导出','created_at':now(),'reserved_amount':budget['per_attempt'] if budget else None,'charge':{'status':'reserved' if budget else 'not_applicable','amount':None,'source':'local_reservation_not_bill'}}
                    b['attempts'].append(a);added.append(deepcopy(a))
                return b,{'attempts':added},False
            if action=='outcome':
                obj(d,{'attempt_id','state','external_ref','evidence','charge','confirmed'},{'attempt_id','state','external_ref','evidence','charge','confirmed'})
                a=next((a for a in b['attempts'] if a['id']==d['attempt_id']),None)
                if not a:fail('attempt','不是本批次原Attempt',404)
                state=d['state'];allowed={'reserved':{'in_progress','outcome_unknown','completed','failed','not_sent'},'in_progress':{'in_progress','outcome_unknown','completed','failed'},'outcome_unknown':{'outcome_unknown','in_progress','completed','failed','not_sent'},'completed':{'completed'},'failed':{'failed'},'not_sent':{'not_sent'}}
                if state not in allowed[a['state']]:fail('state','不能回退或重开原执行',409)
                if d['confirmed'] is not True:fail('confirmation','外部结果必须明确确认')
                ref=txt(d['external_ref'],'外部回执或会话引用',300,state in {'completed','failed','in_progress'})
                if a['external_ref'] and ref!=a['external_ref']:fail('identity','已知外部引用不能更换，请核对原执行',409)
                evidence=txt(d['evidence'],'核对依据',3000);bill=charge(d['charge'],b,state)
                if bill['status']=='known' and ref and any(x['id']!=a['id'] and x['external_ref']==ref and x['charge']['status']=='known' for x in b['attempts']):fail('duplicate_reference','同一费用引用已用于其他Attempt；需要真实分项引用，不重复记总单',409)
                before=deepcopy(a);a.update(state=state,external_ref=ref,evidence=evidence,charge=bill,updated_at=now())
                return b,{'before':before,'after':deepcopy(a),'assertion_source':'operator_report'},False
            obj(d,{'candidate_id','outcome','note','confirmed'},{'candidate_id','outcome','note','confirmed'})
            c=next((c for c in b['candidates'] if c['id']==d['candidate_id']),None)
            if not c:fail('candidate','候选不存在于本批',404)
            if d['outcome'] not in {'approved','rejected','changes_requested'} or d['confirmed'] is not True:fail('review','必须明确审阅结果')
            note=txt(d['note'],'视觉和许可审阅依据',3000)
            if d['outcome']=='approved':
                if c['validation']['status']!='passed':fail('validation','技术校验未通过，不能批准',409)
                self._blob(db,c);self._require_parent(b)
                old=b['selected'].get(c['asset_key'])
                if old and old!=c['id']:
                    prev=next(x for x in b['candidates'] if x['id']==old);prev['review']={'outcome':'superseded','note':'已明确选择另一候选','actor':raw['actor'],'at':now()}
                b['selected'][c['asset_key']]=c['id']
            elif b['selected'].get(c['asset_key'])==c['id']:del b['selected'][c['asset_key']]
            c['review']={'outcome':d['outcome'],'note':note,'actor':raw['actor'],'at':now(),'source':'operator_visual_and_license_review'}
            return b,{'candidate_id':c['id'],'review':c['review']},False
        return self._commit(raw,fingerprint(raw),mutate)
    def upload(self,raw,data):
        bounded(raw);obj(raw,{'request_id','actor','batch_id','expected_version','attempt_id','spec_hash','source_sha256','name'}, {'request_id','actor','batch_id','expected_version','attempt_id','spec_hash','source_sha256','name'})
        txt(raw['actor'],'操作者',100);name=ntpath.basename(txt(raw['name'],'文件名',200));source=hashlib.sha256(data).hexdigest()
        if raw['source_sha256']!=source:fail('upload_hash','原文件哈希不匹配')
        digest=fingerprint({'upload':raw,'sha256':source});self.receipt(raw['request_id'])
        with closing(self.connect()) as db:
            old=self._replay(db,raw['request_id'],digest)
            if old:return old
        meta,normalized=decode(data)
        def mutate(db,b):
            if b['status']!='published' or b['spec_hash']!=raw['spec_hash'] or fingerprint(b['contract'])!=b['spec_hash']:fail('frozen','不是当前冻结合同',409)
            a=next((a for a in b['attempts'] if a['id']==raw['attempt_id']),None)
            if not a or a['state']!='completed':fail('attempt','先核对原Attempt确已完成，再导入候选',409)
            if any(c['attempt_id']==a['id'] and c['source_sha256']==source for c in b['candidates']):fail('duplicate','该原文件已导入此Attempt，不重复保存',409)
            if len(b['candidates'])>=192:fail('capacity','每批最多192张候选',409)
            spec=spec_item(b,a['asset_key']);c=meta|{'id':'asset_candidate_'+uuid.uuid4().hex,'asset_key':a['asset_key'],'attempt_id':a['id'],'original_name':name,'input_hash':requirement_hash(b,spec),'spec_hash':b['spec_hash'],'validation':validate(meta,spec),'review':None,'imported_at':now(),'actor':raw['actor']}
            existing=db.execute('SELECT bytes FROM blobs WHERE sha256=?',(c['sha256'],)).fetchone()
            if not existing:
                used=db.execute('SELECT COALESCE(SUM(bytes),0) FROM blobs').fetchone()[0]
                if used+len(normalized)>MAX_BLOBS:fail('capacity','本版候选库达到256 MiB上限，请另建独立素材库',409)
                db.execute('INSERT INTO blobs VALUES(?,?,?)',(c['sha256'],len(normalized),normalized))
            b['candidates'].append(c);return b,{'candidate':c},False
        return self._commit(raw|{'action':'upload'},digest,mutate)
    def _blob(self,db,c):
        r=db.execute('SELECT data FROM blobs WHERE sha256=?',(c['sha256'],)).fetchone()
        if not r or hashlib.sha256(r[0]).hexdigest()!=c['sha256'] or len(r[0])!=c['bytes']:fail('integrity','候选图片完整性核对失败',409)
        return r[0]
    def image(self,bid,cid):
        if not isinstance(cid,str) or not CANDIDATE.fullmatch(cid):fail('candidate','候选ID无效')
        with closing(self.connect()) as db:
            b=self._load(db,bid);c=next((c for c in b['candidates'] if c['id']==cid),None)
            if not c:fail('not_found','图片不在本批次',404)
            return self._blob(db,c),c['mime']
    def export_handoff(self,bid,fmt='json'):
        b=self.get(bid);self._require_parent(b);p=handoff(b)
        if fmt not in {'json','markdown'}:fail('format','只支持JSON/Markdown')
        return {'content':p if fmt=='json' else handoff_markdown(p),'format':fmt,'store_id':self.store_id}
    def delivery(self,bid):
        with closing(self.connect()) as db:
            db.execute('BEGIN');b=self._load(db,bid);self._require_parent(b)
            if not projection(b)['delivery_ready']:fail('not_ready','需要全部项当前批准，且没有未决执行或未知费用',409)
            selected=[next(c for c in b['candidates'] if c['id']==b['selected'][i['key']]) for i in b['contract']['items']]
            if any(c['review']['outcome']!='approved' or c['validation']['status']!='passed' for c in selected):fail('integrity','批准记录不一致',409)
            if sum(c['bytes'] for c in selected)>MAX_EXPORT:fail('export_size','本版单次交付包上限64 MiB',413)
            manifest={'format':'clw.assets.delivery.v1','batch_id':b['id'],'batch_version':b['version'],'spec_hash':b['spec_hash'],'contract':b['contract'],'parent_binding':b['parent_binding'],'selected_candidates':selected,'attempts':b['attempts'],'accounting':accounting(b),'integration':'not_performed; explicit consumer review required','exported_at':now()}
            out=BytesIO()
            with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED) as z:
                z.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
                z.writestr('README.txt','Approved normalized candidates only. No production integration was performed. Check manifest hashes, license review and original target before manual integration.\n')
                for c in selected:z.writestr('candidates/'+c['asset_key']+'.'+c['format'],self._blob(db,c))
            return out.getvalue()
    def listing(self,query='',after=0,limit=30):
        txt(query,'搜索',200,False)
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=50:fail('page','分页无效')
        rows=[]
        with closing(self.connect()) as db:
            for r in db.execute('SELECT sequence,data FROM batches WHERE sequence>? ORDER BY sequence',(after,)):
                b=json.loads(r['data']);c=b['contract']
                if query.casefold() not in (c['title']+' '+c['project_id']+' '+b['id']).casefold():continue
                p=projection(b);rows.append({k:p[k] for k in ('id','version','status','phase','progress','updated_at')}|{'sequence':r['sequence'],'title':c['title'],'project_id':c['project_id']})
                if len(rows)>limit:break
        return {'batches':rows[:limit],'next_after':rows[limit-1]['sequence'] if len(rows)>limit else None,'store_id':self.store_id}
    def events(self,bid,after=0):
        self._id(bid)
        if type(after) is not int or after<0:fail('page','事件游标无效')
        with closing(self.connect()) as db:rs=db.execute('SELECT * FROM events WHERE batch_id=? AND sequence>? ORDER BY sequence LIMIT 21',(bid,after)).fetchall()
        return {'events':[{'sequence':r['sequence'],**json.loads(r['data'])} for r in rs[:20]],'next_after':rs[19]['sequence'] if len(rs)>20 else None}
