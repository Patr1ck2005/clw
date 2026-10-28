"""Three separate local usage journals. User observations are never provider authentication."""
from __future__ import annotations
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
import json
import re
import sqlite3
import uuid
from task_domain import bounded, encoded, fail, fingerprint, now, obj, txt
from task_store import REQUEST
BUCKETS=('chat','work_codex','api')
SOURCES=('operator_observation','self_count','estimate')

def amount(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{1,12}(?:\.\d{1,8})?',value):fail('amount','数值需为非负十进制文本，最多8位小数')
    n=Decimal(value)
    return format(n,'f')

def stamp(value,label):
    value=txt(value,label,60)
    try:
        d=datetime.fromisoformat(value.replace('Z','+00:00'))
        if d.tzinfo is None:raise ValueError()
        return d.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
    except ValueError:fail('time',label+'需要带时区的日期时间')

def entry(raw):
    keys={'bucket','account_alias','kind','unit','amount','source','reference','window','observed_at','resets_at','task_id','note','status'}
    obj(raw,keys,keys-{'task_id','resets_at'})
    r={k:txt(raw[k],k,2000 if k=='note' else 200,False) for k in ('bucket','account_alias','kind','unit','source','reference','window','note','status')}
    if r['bucket'] not in BUCKETS or r['source'] not in SOURCES or r['kind'] not in {'snapshot','delta'}:fail('classification','账本分类无效')
    if not all(r[k] for k in ('account_alias','reference','window','note')):fail('evidence','账号标签、来源引用、窗口和说明不能为空')
    if r['status'] not in {'known','unknown'}:fail('state','用量状态无效')
    if r['status']=='unknown':
        if raw['amount'] is not None:fail('amount','未知数值必须留空，不能填写0')
        r['amount']=None
    else:r['amount']=amount(raw['amount'])
    if r['bucket']=='api':
        if r['kind']!='delta' or not re.fullmatch(r'[A-Z]{3}',r['unit']):fail('unit','API账单需逐笔金额及独立币种')
    elif r['kind']=='snapshot':
        if r['unit'] not in {'used_percent','remaining_messages'}:fail('unit','窗口快照单位无效')
        if r['unit']=='used_percent' and r['amount'] is not None and Decimal(r['amount'])>100:fail('amount','百分比必须不大于100')
    elif r['unit'] not in {'messages','accepted_tasks'}:fail('unit','自行计数只记录明确消息或验收任务，不换算官方额度')
    if r['unit'] in {'remaining_messages','messages','accepted_tasks'} and r['amount'] is not None and Decimal(r['amount'])!=int(Decimal(r['amount'])):fail('amount','计数必须为整数')
    r['observed_at']=stamp(raw['observed_at'],'采集时间')
    r['resets_at']=stamp(raw['resets_at'],'重置时间') if raw.get('resets_at') else None
    r['task_id']=txt(raw.get('task_id',''),'任务引用',100,False)
    if r['kind']=='snapshot' and r['task_id']:fail('attribution','账户窗口快照不能归因给单一任务')
    if r['kind']=='snapshot' and r['source']=='self_count':fail('classification','自行计数不是账户窗口来源')
    if r['resets_at'] and r['kind']!='snapshot':fail('time','逐笔计数没有官方重置时间')
    r['source_verified']=False
    return r

class UsageStore:
    APP=0x434C5755
    def __init__(self,path):
        self.path=Path(path).resolve();self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE')
                app=db.execute('PRAGMA application_id').fetchone()[0]
                names={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
                if app not in (0,self.APP) or (app==0 and names):fail('foreign_store','不是CLW独立用量库，未采用',409)
                if app==self.APP and (names!={'entries','history','receipts','metadata'} or db.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()[0]!='1'):
                    fail('incompatible','用量库结构或版本未支持',409)
                for sql in (
                    'CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, sequence INTEGER UNIQUE, version INTEGER, bucket TEXT, account TEXT, reference TEXT, data TEXT, UNIQUE(bucket,account,reference))',
                    'CREATE TABLE IF NOT EXISTS history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, version INTEGER, data TEXT)',
                    'CREATE TABLE IF NOT EXISTS receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT, response TEXT)',
                    'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT)'):db.execute(sql)
                db.execute("INSERT OR IGNORE INTO metadata VALUES ('schema','1')")
                db.execute("INSERT OR IGNORE INTO metadata VALUES ('store_id',?)",(uuid.uuid4().hex,))
                db.execute('PRAGMA application_id='+str(self.APP))
                self.store_id=db.execute("SELECT value FROM metadata WHERE key='store_id'").fetchone()[0];db.commit()
            except BaseException:db.rollback();raise
            db.execute('PRAGMA journal_mode=WAL')
    def connect(self):
        db=sqlite3.connect(self.path,isolation_level=None,timeout=5);db.row_factory=sqlite3.Row;db.execute('PRAGMA synchronous=FULL');return db
    def receipt(self,request_id):
        if not isinstance(request_id,str) or not REQUEST.fullmatch(request_id):fail('request','请求ID无效')
        with closing(self.connect()) as db:r=db.execute('SELECT response FROM receipts WHERE request_id=?',(request_id,)).fetchone()
        return {'found':r is not None,'receipt':json.loads(r[0]) if r else None,'store_id':self.store_id}
    def command(self,raw):
        bounded(raw);obj(raw,{'request_id','action','actor','data','entry_id','expected_version'}, {'request_id','action','actor','data'})
        self.receipt(raw['request_id']);actor=txt(raw['actor'],'操作者',100)
        if raw['action'] not in {'record','correct'}:fail('action','仅支持记账和同记录修正')
        data=entry(raw['data']);digest=fingerprint(raw)
        with closing(self.connect()) as db:
            try:
                db.execute('BEGIN IMMEDIATE');old=db.execute('SELECT * FROM receipts WHERE request_id=?',(raw['request_id'],)).fetchone()
                if old:
                    if old['fingerprint']!=digest:fail('request_conflict','原请求参数不同',409)
                    db.rollback();return json.loads(old['response'])|{'replayed':True}
                if raw['action']=='correct':
                    row=db.execute('SELECT * FROM entries WHERE id=?',(txt(raw.get('entry_id'),'记录ID',100),)).fetchone()
                    if not row or type(raw.get('expected_version')) is not int or row['version']!=raw['expected_version']:fail('version_conflict','记录已变化，请保留输入并核对',409)
                    previous=json.loads(row['data'])
                    if any(previous[k]!=data[k] for k in ('bucket','account_alias','reference','kind','unit','window','task_id')):fail('identity','修正不更换原池/账号/引用/单位/窗口/任务',409)
                    eid=row['id'];version=row['version']+1;sequence=row['sequence']
                else:
                    if 'entry_id' in raw or 'expected_version' in raw:fail('identity','新增不能提供旧记录身份')
                    if db.execute('SELECT count(*) FROM entries').fetchone()[0]>=10000:fail('capacity','用量库记录达到本版上限',409)
                    eid='usage_'+uuid.uuid4().hex;version=1;sequence=db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM entries').fetchone()[0]
                record=data|{'id':eid,'version':version,'sequence':sequence,'actor':actor,'recorded_at':now()}
                if version==1:
                    db.execute('INSERT INTO entries VALUES (?,?,?,?,?,?,?)',(eid,sequence,version,data['bucket'],data['account_alias'],data['reference'],encoded(record)))
                else:db.execute('UPDATE entries SET version=?,data=? WHERE id=?',(version,encoded(record),eid))
                db.execute('INSERT INTO history(entry_id,version,data) VALUES (?,?,?)',(eid,version,encoded(record)))
                response={'request_id':raw['request_id'],'entry':record,'store_id':self.store_id,'replayed':False,'effect':'usage_metadata_only'}
                db.execute('INSERT INTO receipts VALUES (?,?,?)',(raw['request_id'],digest,encoded(response)));db.commit();return response
            except sqlite3.IntegrityError:db.rollback();fail('duplicate','此池/账号下原引用已记账，请修正原记录，不重复登记',409)
            except BaseException:db.rollback();raise
    def listing(self,after=0,limit=50):
        if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=100:fail('page','分页无效')
        with closing(self.connect()) as db:rows=db.execute('SELECT data FROM entries WHERE sequence>? ORDER BY sequence LIMIT ?',(after,limit+1)).fetchall()
        entries=[json.loads(r[0]) for r in rows[:limit]]
        return {'entries':entries,'next_after':entries[-1]['sequence'] if len(rows)>limit else None,'store_id':self.store_id}
    def history(self,eid):
        with closing(self.connect()) as db:rows=db.execute('SELECT data FROM history WHERE entry_id=? ORDER BY sequence DESC LIMIT 101',(eid,)).fetchall()
        return {'records':[json.loads(r[0]) for r in rows[:100]],'truncated':len(rows)>100}
    def summary(self):
        groups={};snapshots={}
        with closing(self.connect()) as db:
            for row in db.execute('SELECT data FROM entries ORDER BY sequence'):
                r=json.loads(row[0]);key=tuple(r[k] for k in ('bucket','account_alias','source','unit','window'))
                if r['kind']=='snapshot':
                    if key not in snapshots or (r['observed_at'],r['sequence'])>(snapshots[key]['observed_at'],snapshots[key]['sequence']):snapshots[key]=r
                else:
                    g=groups.setdefault(key,dict(zip(('bucket','account_alias','source','unit','window'),key))|{'known_subtotal':Decimal(0),'unknown_count':0,'record_count':0})
                    g['record_count']+=1
                    if r['amount'] is None:g['unknown_count']+=1
                    else:g['known_subtotal']+=Decimal(r['amount'])
        for g in groups.values():
            g['known_subtotal']=str(g['known_subtotal']);g['total']=None if g['unknown_count'] else g['known_subtotal']
        for r in snapshots.values():
            r['expired']=bool(r['resets_at'] and datetime.fromisoformat(r['resets_at'].replace('Z','+00:00'))<=datetime.now(timezone.utc))
        fields={'bucket','account_alias','source','unit','window','amount','observed_at','resets_at','expired'}
        selected=[{k:v for k,v in r.items() if k in fields} for r in list(snapshots.values())[:128]]
        return {'buckets':list(BUCKETS),'official_remaining':dict.fromkeys(BUCKETS,None),'totals':list(groups.values())[:128],'snapshots':selected,
            'total_group_count':len(groups),'snapshot_group_count':len(snapshots),'truncated':len(groups)>128 or len(snapshots)>128,
            'account_identity':'local_alias_unverified','snapshot_semantics':'latest_per_source_unit_window_not_additive','observed_at':now()}
