"""Bounded recovery of an ORIGINAL Web request, not retrying its execution.

An explicitly paired browser observer can report visible terminal generation
errors and send a fixed continuation. It cannot read work, claim, reply, execute
commands, grant native scopes, or certify model progress. Silence is not failure.
"""
from __future__ import annotations
from contextlib import closing
import hashlib, json, re, secrets, uuid
from harness_state import require, stamp
from harness_accounts import connector_name

EXTENSION = re.compile(r'chrome-extension://[a-p]{32}\Z')
CHAT = re.compile(r'https://chatgpt\.com/(?:g/[A-Za-z0-9_-]+/)?c/[A-Za-z0-9-]{16,128}\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
DELAYS = (15, 45, 120)
ERRORS = {'cannot_think', 'generation_failed'}
BLOCKS = {'user_stopped', 'new_user_input', 'login_required', 'rate_limited', 'safety_denied'}
KINDS = ERRORS | BLOCKS | {'idle', 'generating', 'draft', 'unsupported', 'hidden'}
PAGE_FLAGS = {'visible','controls_known','assistant_identity_known','user_identity_known','terminal_marker','draft','composing','generating'}
CONTINUATION_SENTENCE = '继续。刚刚发生中断，检查已完成内容，从未完成部分继续，直到本次全部任务完成。'


def original_account(db, binding):
    account = binding['spec'].get('account')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_pages'").fetchone():
        page = db.execute('SELECT settings FROM managed_pages WHERE thread_id=?', (binding['thread_id'],)).fetchone()
        if page:
            account = json.loads(page['settings']).get('account')
    return account if account in ('A', 'B') else None


def connector_reference(account=None):
    return '@' + connector_name(account) if account in ('A', 'B') else '沿用本对话原连接器。'


def continuation_prompt(account=None):
    return CONTINUATION_SENTENCE + '\n' + connector_reference(account)

def validate_page(value):
    require(isinstance(value,dict) and set(value)==PAGE_FLAGS|{'adapter_version','kind'},'recovery_page_fields')
    require(value['kind'] in KINDS and isinstance(value['adapter_version'],str) and re.fullmatch(r'[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}',value['adapter_version']),'recovery_page_invalid')
    require(all(type(value[k]) is bool for k in PAGE_FLAGS),'recovery_page_invalid')
    return dict(value)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

class Recovery:
    def __init__(self, host):
        self.host, self.state, self.clock = host, host.state, host.clock
        with closing(self.state.connect()) as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS recovery_codes(hash TEXT PRIMARY KEY,thread_id TEXT NOT NULL,expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS recovery_observations(peer_id TEXT PRIMARY KEY,observed_at REAL NOT NULL,data TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS recovery_peers(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,origin TEXT NOT NULL,chat_url TEXT NOT NULL,thread_id TEXT NOT NULL,enabled INTEGER NOT NULL,expires REAL NOT NULL,last_seen REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS recovery_attempts(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,peer_id TEXT NOT NULL,failure_key TEXT NOT NULL,user_key TEXT NOT NULL,kind TEXT NOT NULL,ordinal INTEGER NOT NULL,state TEXT NOT NULL,created REAL NOT NULL,due REAL NOT NULL,dispatch_at REAL,ack_at REAL,UNIQUE(request_id,peer_id,failure_key));
            ''');db.commit()

    def pairing_code(self, thread):
        with self.host.lock, closing(self.state.connect()) as db:
            b = self.host.binding(db, thread=thread)
            require(b['enabled'], 'host_paused', 409)
            code = secrets.token_hex(8).upper()
            db.execute('DELETE FROM recovery_codes WHERE expires<? OR thread_id=?', (self.clock(), thread))
            db.execute('INSERT INTO recovery_codes VALUES(?,?,?)', (digest(code), thread, self.clock()+120))
            db.commit()
        return {'pair_code': code, 'expires_in': 120, 'scope': 'visible_failure_observer_and_fixed_prompt_only'}

    def disable(self, thread):
        with self.host.lock, closing(self.state.connect()) as db:
            self.host.binding(db, thread=thread)
            db.execute('UPDATE recovery_peers SET enabled=0 WHERE thread_id=?', (thread,))
            db.execute("UPDATE recovery_attempts SET state='cancelled' WHERE state='planned' AND peer_id IN (SELECT id FROM recovery_peers WHERE thread_id=?)", (thread,))
            self.host.emit(db, thread, 'recovery_disabled', {'native_execution_stopped': False})
            db.commit()
        return {'disabled': True, 'native_execution_stopped': False}

    def snapshot(self, thread):
        with closing(self.state.connect()) as db:
            self.host.binding(db, thread=thread)
            peers = db.execute('SELECT id,enabled,expires,last_seen FROM recovery_peers WHERE thread_id=?', (thread,)).fetchall()
            attempts = db.execute('SELECT a.id,a.request_id,a.kind,a.ordinal,a.state,a.due,a.ack_at FROM recovery_attempts a JOIN recovery_peers p ON p.id=a.peer_id WHERE p.thread_id=? ORDER BY a.created DESC LIMIT 16', (thread,)).fetchall()
            observed = db.execute('SELECT o.observed_at,o.data FROM recovery_observations o JOIN recovery_peers p ON p.id=o.peer_id WHERE p.thread_id=? AND p.enabled=1 AND p.expires>? ORDER BY o.observed_at DESC LIMIT 1',(thread,self.clock())).fetchone()
        page = {**json.loads(observed['data']),'observed_at':observed['observed_at'],'recent':observed['observed_at']>self.clock()-20} if observed else None
        return {'paired': any(p['enabled'] and p['expires']>self.clock() for p in peers),
                'observer_recent': any(p['enabled'] and p['expires']>self.clock() and p['last_seen']>self.clock()-20 for p in peers),
                'page_observation':page, 'page_observation_is_not_recovery_acceptance':True,
                'attempts': [dict(a) for a in attempts], 'max_prompts_per_request': len(DELAYS),
                'backoff_seconds': list(DELAYS), 'silence_is_not_failure': True,
                'scope': 'explicit_terminal_error_only', 'actual_page_adapter_verified': False}

    def current(self, db, peer, request_id=None):
        b = self.host.binding(db, thread=peer['thread_id'])
        require(b['enabled'] and peer['enabled'] and peer['expires']>self.clock(), 'recovery_disabled', 409)
        spec = self.host.targets.get(b['target_id']) or self.host.collaboration.definition(b['target_id'])
        require(b['spec']==spec, 'host_binding_configuration_changed', 409)
        r = db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing') ORDER BY created_at DESC LIMIT 1", (peer['thread_id'],)).fetchone()
        if request_id is not None:
            require(r and r['id']==request_id and not r['cancel_requested'], 'recovery_request_changed_or_stopped', 409)
        if r and r['cancel_requested']: r = None
        return b, dict(r) if r else None

    def pair(self, origin, raw):
        require(set(raw)=={'action','code','chat_url'}, 'recovery_fields')
        require(isinstance(raw['code'], str) and re.fullmatch(r'[0-9A-F]{16}', raw['code']), 'recovery_pair_invalid', 403)
        require(isinstance(raw['chat_url'], str) and CHAT.fullmatch(raw['chat_url']), 'recovery_exact_chat_required', 403)
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            code = db.execute('SELECT * FROM recovery_codes WHERE hash=?', (digest(raw['code']),)).fetchone()
            require(code and code['expires']>self.clock(), 'recovery_pair_expired_or_used', 403)
            b = self.host.binding(db, thread=code['thread_id']);require(b['enabled'], 'host_paused', 409)
            require(not hasattr(self.host,'control') or not self.host.control.owns(db,b['thread_id']), 'control_carrier_already_enabled', 409)
            db.execute('DELETE FROM recovery_codes WHERE hash=?', (digest(raw['code']),))
            db.execute('UPDATE recovery_peers SET enabled=0 WHERE thread_id=?', (b['thread_id'],))
            token = 'clwr_'+secrets.token_urlsafe(32); peer = 'recpeer_'+uuid.uuid4().hex
            db.execute('INSERT INTO recovery_peers VALUES(?,?,?,?,?,1,?,?)', (peer,digest(token),origin,raw['chat_url'],b['thread_id'],self.clock()+86400,self.clock()))
            self.host.emit(db,b['thread_id'],'recovery_paired',{'scope':'one_exact_ChatGPT_tab','max_attempts':3,'model_identity_attested':False})
            db.commit()
        return {'peer_id':peer,'recovery_token':token,'store_id':self.state.id,'thread_id':b['thread_id'],'chat_url':raw['chat_url']}

    def wire(self, origin, token, raw):
        read_only=self.host.maintenance_exit_fence is not None and isinstance(raw,dict) and raw.get('action')=='status'
        with self.host.business_admission(read_only=read_only):return self._wire(origin,token,raw)
    def _wire(self,origin,token,raw):
        require(isinstance(origin,str) and EXTENSION.fullmatch(origin), 'recovery_extension_origin_required', 403)
        require(isinstance(raw,dict) and len(json.dumps(raw).encode())<=8192, 'recovery_body_invalid')
        if raw.get('action')=='pair': return self.pair(origin,raw)
        require(isinstance(token,str) and re.fullmatch(r'clwr_[A-Za-z0-9_-]{43}', token), 'recovery_pair_required', 403)
        action=raw.get('action')
        fields={'status':set(),'observe':{'request_id','kind','failure_key','user_key','safe'},'dispatch':{'request_id','attempt_id'},'finish':{'attempt_id','result'}}
        expected_fields={'action','chat_url'}|fields.get(action,set())
        require(action in fields and (set(raw)==expected_fields or (action=='status' and set(raw)==expected_fields|{'page'})), 'recovery_fields')
        page=validate_page(raw['page']) if 'page' in raw else None
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            p=db.execute('SELECT * FROM recovery_peers WHERE hash=? AND origin=?',(digest(token),origin)).fetchone()
            require(p and p['chat_url']==raw['chat_url'], 'recovery_pair_mismatch', 403); p=dict(p)
            b,r=self.current(db,p,raw.get('request_id') if action in ('observe','dispatch') else None)
            if self.host.maintenance_exit_fence is None:db.execute('UPDATE recovery_peers SET last_seen=? WHERE id=?',(self.clock(),p['id']))
            if action=='status':
                if page is not None and self.host.maintenance_exit_fence is None:
                    db.execute('INSERT INTO recovery_observations VALUES(?,?,?) ON CONFLICT(peer_id) DO UPDATE SET observed_at=excluded.observed_at,data=excluded.data',(p['id'],self.clock(),json.dumps(page,sort_keys=True)))
                result={'request_id':r['id'] if r else None,'phase':r['phase'] if r else None,'enabled':True,'store_id':self.state.id,'page_diagnostics_supported':True}
            elif action=='observe': result=self.observe(db,p,b,r,raw)
            else:
                a=db.execute('SELECT * FROM recovery_attempts WHERE id=? AND peer_id=?',(raw.get('attempt_id'),p['id'])).fetchone()
                require(a is not None,'recovery_attempt_unknown',404);a=dict(a)
                if action=='dispatch':
                    require(a['request_id']==r['id'], 'recovery_wrong_request', 409)
                    require(a['state']=='planned' and a['due']<=self.clock(), 'recovery_not_dispatchable_no_replay', 409)
                    require(self.clock()-a['due']<90,'recovery_offer_expired',409)
                    db.execute("UPDATE recovery_attempts SET state='dispatching',dispatch_at=? WHERE id=?",(self.clock(),a['id']))
                    self.host.emit(db,b['thread_id'],'recovery_dispatch',{'request_id':r['id'],'attempt_id':a['id'],'ordinal':a['ordinal'],'model_resumed':False})
                    result={'dispatch':True,'attempt_id':a['id']}
                else:
                    require(raw['result'] in ('sent','not_sent','unknown'), 'recovery_result_invalid')
                    require(a['state'] in ('dispatching','acknowledged') or a['state']==raw['result'], 'recovery_finish_conflict',409)
                    final_state='acknowledged' if a['state']=='acknowledged' else raw['result']
                    db.execute('UPDATE recovery_attempts SET state=? WHERE id=?',(final_state,a['id']))
                    result={'recorded':True,'model_resumed':final_state=='acknowledged','state':final_state}
            db.commit();return result

    def observe(self,db,p,b,r,raw):
        kind=raw['kind'];require(kind in KINDS, 'recovery_observation_invalid')
        if kind in BLOCKS:
            db.execute('UPDATE recovery_peers SET enabled=0 WHERE id=?',(p['id'],))
            self.host.emit(db,b['thread_id'],'recovery_blocked',{'reason':kind,'automatic_retry':False})
            return {'decision':'disabled','reason':kind}
        if kind not in ERRORS: return {'decision':'wait','reason':kind}
        require(type(raw['safe']) is bool,'recovery_observation_invalid')
        if not raw['safe']:return {'decision':'wait','reason':'page_not_safe'}
        require(isinstance(raw['failure_key'],str) and DIGEST.fullmatch(raw['failure_key']) and isinstance(raw['user_key'],str) and DIGEST.fullmatch(raw['user_key']), 'recovery_event_identity_invalid')
        a=db.execute('SELECT * FROM recovery_attempts WHERE request_id=? AND peer_id=? AND failure_key=?',(r['id'],p['id'],raw['failure_key'])).fetchone()
        if a and a['user_key']!=raw['user_key']:
            db.execute('UPDATE recovery_peers SET enabled=0 WHERE id=?',(p['id'],));return {'decision':'disabled','reason':'new_user_input'}
        if a and a['state']!='planned':return {'decision':'wait','reason':'same_failure_already_handled','state':a['state']}
        if not a:
            uncertain=db.execute("SELECT 1 FROM recovery_attempts WHERE request_id=? AND state IN ('dispatching','unknown')",(r['id'],)).fetchone()
            if uncertain:return {'decision':'attention','reason':'previous_dispatch_unknown_no_replay'}
            count=db.execute('SELECT COUNT(*) FROM recovery_attempts WHERE request_id=?',(r['id'],)).fetchone()[0]
            if count>=len(DELAYS):return {'decision':'attention','reason':'recovery_budget_exhausted'}
            aid='recovery_'+uuid.uuid4().hex
            db.execute("INSERT INTO recovery_attempts VALUES(?,?,?,?,?,?,?,'planned',?,?,NULL,NULL)",(aid,r['id'],p['id'],raw['failure_key'],raw['user_key'],kind,count+1,self.clock(),self.clock()+DELAYS[count]))
            self.host.emit(db,b['thread_id'],'recovery_scheduled',{'request_id':r['id'],'attempt_id':aid,'reason':kind,'ordinal':count+1,'delay_seconds':DELAYS[count]})
            a=db.execute('SELECT * FROM recovery_attempts WHERE id=?',(aid,)).fetchone()
        if a['due']>self.clock():return {'decision':'wait','reason':'backoff','after_seconds':a['due']-self.clock()}
        if self.clock()-a['due']>=90:return {'decision':'attention','reason':'recovery_offer_expired'}
        return {'decision':'offer','attempt_id':a['id'],'request_id':r['id'],'failure_key':a['failure_key'],'user_key':a['user_key'],'prompt':self.prompt(b,r,a['id'],original_account(db,b))}

    def prompt(self,b,r,aid,account=None):
        return (continuation_prompt(account)+'\n'
                'python -X utf8 -B scripts/harness_host_client.py recover '
                f'--store-id {self.state.id} --target {b["target_id"]} --session-id {b["spec"]["session_id"]} '
                f'--request-id {r["id"]} --recovery-id {aid}')

    def acknowledge(self,db,b,r,recovery_id):
        a=db.execute('SELECT a.* FROM recovery_attempts a JOIN recovery_peers p ON p.id=a.peer_id WHERE a.id=? AND a.request_id=? AND p.thread_id=?',(recovery_id,r['id'],b['thread_id'])).fetchone()
        require(a and a['state'] in ('dispatching','sent','unknown','acknowledged'),'recovery_dispatch_not_observed',409)
        require(b['enabled'] and not r['cancel_requested'] and r['phase'] in ('queued','processing'), 'recovery_request_changed_or_stopped',409)
        db.execute("UPDATE recovery_attempts SET state='acknowledged',ack_at=COALESCE(ack_at,?) WHERE id=?",(self.clock(),a['id']))
        if a['state']!='acknowledged': self.host.emit(db,b['thread_id'],'recovery_acknowledged',{'request_id':r['id'],'attempt_id':a['id'],'execution_replayed':False,'source':'authorized_project_process'})
        db.commit()
        return {**self.host.project_request(b,r),'recovery_id':a['id'],'original_claim_id':r['claim_id'],'already_claimed':r['claim_id'] is not None,'instruction':'Recover original Jobs and edits; this acknowledgement is not task completion.'}
