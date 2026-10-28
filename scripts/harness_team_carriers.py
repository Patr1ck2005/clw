"""Two-sided enrollment of REAL conversations; registration never creates a model.

A project-authorized receiver accepts an explicit invitation in its own Session;
its bounded public receipt is then observed in the exact browser page by the
Companion. This is operator/project provenance, NOT OpenAI account attestation.
"""
from __future__ import annotations
import hashlib,hmac,json,re,secrets,uuid
from pathlib import Path
from harness_state import require,canonical,stamp
from harness_team_common import object_fields,text,identifier,integer
from harness_team_scopes import plain_root

SESSION=re.compile(r'wc_sess_(?:[A-Za-z0-9_-]{16}|[0-9a-f]{32})\Z')
MARKER=re.compile(r'CLW-ENROLL:([0-9a-f]{32}):([A-Za-z0-9_-]{32})\Z')
TICKET=re.compile(r'clwi_[A-Za-z0-9_-]{43}\Z')
RUNTIME_EVENT=re.compile(r'evt_[0-9a-f]{32}\Z')
FRESH_SECONDS=300  # Liveness lease; Send still requires a fresh safe visible page.

def digest(s):return hashlib.sha256(s.encode()).hexdigest()

class Carriers:
    def __init__(self,team):self.team,self.host=team,team.host
    @staticmethod
    def schema(db):
        db.executescript('''
        CREATE TABLE IF NOT EXISTS host_carrier_invites(
          id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, target_id TEXT NOT NULL,
          inviter_thread TEXT NOT NULL, old_session TEXT, allow_rebind INTEGER NOT NULL,
          project TEXT NOT NULL, root TEXT NOT NULL, title TEXT NOT NULL,
          expires REAL NOT NULL, state TEXT NOT NULL, receiver_session TEXT, marker_hash TEXT);
        CREATE TABLE IF NOT EXISTS host_carrier_links(
          thread_id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL, receiver_session TEXT NOT NULL,
          generation INTEGER, origin TEXT, chat_url TEXT, observed REAL NOT NULL DEFAULT 0,
          state TEXT NOT NULL, receipt_source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS host_carrier_discoveries(discovery_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS host_carrier_history(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
          previous_session TEXT, session_id TEXT NOT NULL, invitation_id TEXT NOT NULL, at TEXT NOT NULL);
        ''')
    def may_manage(self,db,actor,target):
        b=db.execute('SELECT * FROM host_bindings WHERE target_id=?',(target,)).fetchone()
        if b:
            inherited=hasattr(self.host,'managed') and self.host.managed.handoffs.may_manage(db,actor,target)
            require(b['thread_id']==actor['thread_id'] or db.execute('SELECT 1 FROM host_branches WHERE target_id=? AND parent_target_id=?',(target,actor['target_id'])).fetchone() or inherited,'team_not_owned_conversation',403)
            return self.host.binding(db,target=target)
        return None
    def invite(self,db,actor,p):
        object_fields(p,{'target','allow_rebind','ttl_seconds','reason'},{'title','project','root'})
        target=identifier(p['target']);require(re.fullmatch(r'[a-z0-9_-]{1,64}',target),'host_branch_id_invalid')
        require(type(p['allow_rebind']) is bool,'team_confirmation_required')
        integer(p['ttl_seconds'],30,86400);text(p['reason'],'reason',2000)
        b=self.may_manage(db,actor,target)
        project=p.get('project',b['spec']['project'] if b else actor['spec']['project'])
        root=plain_root(p.get('root',str(self.host.root)))
        text(project,'project',512)
        if b:require(project==b['spec']['project'],'team_project_changed',409)
        title=text(p.get('title',b['spec']['title'] if b else target),'title',130)
        ident=uuid.uuid4().hex;ticket='clwi_'+secrets.token_urlsafe(32)
        db.execute('INSERT INTO host_carrier_invites VALUES(?,?,?,?,?,?,?,?,?,?,\'pending\',NULL,NULL)',
            (ident,digest(ticket),target,actor['thread_id'],b['spec']['session_id'] if b else None,int(p['allow_rebind']),project,root,title,self.host.clock()+p['ttl_seconds']))
        # Invitation is a setup capability only. It cannot claim/reply or run tools.
        bootstrap=('CLW 对话接入；不是研究任务。请先读取项目 AGENTS.md。\n'
            f'管理工程：{self.host.root}\n本接入的工作工程：{root}\n'
            '先在本真实对话调用 work_on_project 获得自己的 Session；只有工具证实是本对话自己的 Session 才可恢复。'
            '不要复制主控或其他对话的 Session。通过自己的工作工程运行以下已安装的管理CLI；若Runtime拒绝则停止，不换工具绕过。\n'
            f'目标：{target}\n接入票据：{ticket}\n项目：{project}\n'
            '命令：python -X utf8 -B "'+str(self.host.root/'scripts/harness_team_client.py')+'" enroll --store-id '+self.host.state.id+
            ' --target '+target+' --session-id <本对话实际Session> --operation-id <固定接入操作键> --payload-json <以下JSON作为一个argv参数>\n'+
            canonical({'ticket':ticket,'project':project,'root':root})+'\n'
            'JSON字段仅 ticket、project、root，取以上原值。完成后将返回的 browser_marker 单独原样公开一行。'
            '不要领取、重发旧工作；原分支身份恢复若未获授权必须停下。')
        return {'invitation_id':ident,'ticket':ticket,'target':target,'title':title,'bootstrap_text':bootstrap,
                'expires':self.host.clock()+p['ttl_seconds'],'model_created':False,'browser_created':False,'state':'enrollment_pending'}
    def enroll(self,db,target,session,p):
        object_fields(p,{'ticket','project','root'});require(SESSION.fullmatch(session or ''),'team_receiver_session_invalid')
        require(isinstance(p['ticket'],str) and re.fullmatch(r'clwi_[A-Za-z0-9_-]{43}',p['ticket']),'team_invitation_invalid',403)
        i=db.execute('SELECT * FROM host_carrier_invites WHERE ticket_hash=?',(digest(p['ticket']),)).fetchone()
        require(i and i['state']=='pending' and i['expires']>self.host.clock(),'team_invitation_expired_or_used',403)
        require(i['target_id']==target and i['project']==p['project'] and plain_root(p['root'])==i['root'],'team_enrollment_scope_mismatch',403)
        raw=db.execute('SELECT * FROM host_bindings WHERE target_id=?',(target,)).fetchone()
        old=None
        if raw:
            b=self.host.binding(db,target=target);old=b['spec']['session_id']
            require(old==i['old_session'],'team_invitation_identity_stale',409)
            require(not db.execute('SELECT 1 FROM host_team_leases WHERE thread_id=?',(b['thread_id'],)).fetchone(),'team_carrier_has_original_lease',409)
            require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",(b['thread_id'],)).fetchone(),'team_carrier_unresolved_dispatch',409)
            if old!=session:
                require(i['allow_rebind'] and target not in self.host.targets,'team_session_recovery_not_authorized',403)
                physical=db.execute('SELECT 1 FROM host_carrier_links WHERE thread_id=? AND chat_url IS NOT NULL UNION ALL SELECT 1 FROM control_peers WHERE thread_id=? UNION ALL SELECT 1 FROM recovery_peers WHERE thread_id=? LIMIT 1',(b['thread_id'],b['thread_id'],b['thread_id'])).fetchone()
                require(not physical,'team_known_physical_conversation_not_orphan',409)
                require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND (claim_id IS NOT NULL AND phase IN ('queued','processing','suspended'))",(b['thread_id'],)).fetchone(),'team_original_claim_must_be_preserved',409)
                require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown','acknowledged')",(b['thread_id'],)).fetchone(),'team_original_dispatch_must_be_reconciled',409)
                require(not db.execute('SELECT 1 FROM threads WHERE native_id=?',('mcp-host/'+session,)).fetchone(),'team_session_already_owned',409)
                spec={**b['spec'],'session_id':session}
                db.execute('UPDATE host_bindings SET spec=?,wait_key=NULL,wait_until=0 WHERE thread_id=?',(canonical(spec),b['thread_id']))
                db.execute('UPDATE threads SET native_id=? WHERE id=?',('mcp-host/'+session,b['thread_id']))
                db.execute('UPDATE control_peers SET enabled=0 WHERE thread_id=?',(b['thread_id'],))
                self.host.emit(db,b['thread_id'],'carrier_session_recovered',{'previous_session':old,'session_id':session,'original_requests_preserved':True,'invitation_id':i['id']})
            thread=b['thread_id']
        else:
            parent=self.host.binding(db,thread=i['inviter_thread'])
            require(session!=parent['spec']['session_id'],'host_child_requires_independent_session',409)
            require(not db.execute('SELECT 1 FROM threads WHERE native_id=?',('mcp-host/'+session,)).fetchone(),'team_session_already_owned',409)
            thread='hthr_'+uuid.uuid4().hex;at=stamp()
            spec={'id':target,'title':i['title'],'session_id':session,'project':i['project'],'parent_target_id':parent['target_id']}
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(thread,'chatgpt_web_host','mcp-host/'+session,parent['thread_id'],'ChatGPT Web · '+i['title'],i['root'],None,None,'idle',None,at,at))
            db.execute('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,1)',(target,thread,canonical(spec)))
            db.execute('INSERT INTO host_branches VALUES(?,?,?)',(target,parent['target_id'],at))
            self.host.emit(db,thread,'host_bound',{'session_id':session,'model_created':False,'source':'own_receiver_enrollment_not_browser_creation'})
        proof=secrets.token_urlsafe(24);marker='CLW-ENROLL:'+i['id']+':'+proof
        prior=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(thread,)).fetchone()
        require(not prior or prior['state']!='browser_bound' or prior['receiver_session']==session,'team_carrier_recovery_required',409)
        db.execute("UPDATE host_carrier_invites SET state='accepted',receiver_session=?,marker_hash=? WHERE id=?",(session,digest(marker),i['id']))
        db.execute("INSERT OR REPLACE INTO host_carrier_links VALUES(?,?,?,NULL,?,?,0,'receiver_enrolled','project_receiver_then_browser_receipt')",
                   (thread,i['id'],session,prior['origin'] if prior else None,prior['chat_url'] if prior else None))
        db.execute('INSERT INTO host_carrier_history(thread_id,previous_session,session_id,invitation_id,at) VALUES(?,?,?,?,?)',(thread,old,session,i['id'],stamp()))
        self.host.emit(db,thread,'carrier_receiver_enrolled',{'session_id':session,'browser_bound':False,'invitation_id':i['id']})
        return {'state':'receiver_enrolled','browser_marker':marker,'target_id':target,'session_id':session,
                'original_requests_preserved':True,'next':'Print browser_marker exactly once in this chat, then enable Companion on this same page.','not_account_attestation':True}
    def recover(self,db,actor,p):
        object_fields(p,{'invitation_id','receiver_session','runtime_project','runtime_event_id','confirm','reason'})
        require(p['confirm'] is True,'team_recovery_confirmation_required',403)
        require(SESSION.fullmatch(p['receiver_session'] or ''),'team_receiver_session_invalid')
        require(RUNTIME_EVENT.fullmatch(p['runtime_event_id'] or ''),'team_runtime_evidence_invalid',403)
        text(p['reason'],'reason',2000)
        i=db.execute('SELECT * FROM host_carrier_invites WHERE id=?',(p['invitation_id'],)).fetchone()
        require(i and i['inviter_thread']==actor['thread_id'],'team_invitation_not_owned',403)
        require(i['state']=='pending','team_invitation_expired_or_used',403)
        # Controller recovery is a new explicit verification event. Permit one
        # stale pending orphan ticket for at most one day, then re-arm it for one
        # hour; normal receiver-side enrollment remains strictly TTL-bound.
        require(i['expires']>self.host.clock() or self.host.clock()-i['expires']<=86400,'team_invitation_too_stale_to_recover',403)
        require(i['allow_rebind'] and i['project']==p['runtime_project'],'team_session_recovery_not_authorized',403)
        raw=db.execute('SELECT * FROM host_bindings WHERE target_id=?',(i['target_id'],)).fetchone()
        require(raw,'team_recovery_requires_existing_logical_branch',409)
        b=self.host.binding(db,target=i['target_id']);old=b['spec']['session_id']
        require(old==i['old_session'] and old!=p['receiver_session'],'team_invitation_identity_stale',409)
        require(i['target_id'] not in self.host.targets,'team_session_recovery_not_authorized',403)
        require(not db.execute('SELECT 1 FROM host_team_leases WHERE thread_id=?',(b['thread_id'],)).fetchone(),'team_carrier_has_original_lease',409)
        physical=db.execute('SELECT 1 FROM host_carrier_links WHERE thread_id=? AND chat_url IS NOT NULL UNION ALL SELECT 1 FROM control_peers WHERE thread_id=? UNION ALL SELECT 1 FROM recovery_peers WHERE thread_id=? LIMIT 1',(b['thread_id'],b['thread_id'],b['thread_id'])).fetchone()
        require(not physical,'team_known_physical_conversation_not_orphan',409)
        require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND claim_id IS NOT NULL AND phase IN ('queued','processing','suspended')",(b['thread_id'],)).fetchone(),'team_original_claim_must_be_preserved',409)
        require(not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown','acknowledged')",(b['thread_id'],)).fetchone(),'team_original_dispatch_must_be_reconciled',409)
        require(not db.execute('SELECT 1 FROM threads WHERE native_id=?',('mcp-host/'+p['receiver_session'],)).fetchone(),'team_session_already_owned',409)
        spec={**b['spec'],'session_id':p['receiver_session']}
        db.execute('UPDATE host_bindings SET spec=?,wait_key=NULL,wait_until=0 WHERE thread_id=?',(canonical(spec),b['thread_id']))
        db.execute('UPDATE threads SET native_id=? WHERE id=?',('mcp-host/'+p['receiver_session'],b['thread_id']))
        db.execute('UPDATE control_peers SET enabled=0 WHERE thread_id=?',(b['thread_id'],))
        db.execute("UPDATE host_carrier_invites SET state='accepted',receiver_session=?,marker_hash=NULL,expires=MAX(expires,?) WHERE id=?",(p['receiver_session'],self.host.clock()+3600,i['id']))
        db.execute("INSERT OR REPLACE INTO host_carrier_links VALUES(?,?,?,NULL,NULL,NULL,0,'receiver_enrolled',?)",
                   (b['thread_id'],i['id'],p['receiver_session'],'controller_verified_runtime_session:'+p['runtime_event_id']))
        db.execute('INSERT INTO host_carrier_history(thread_id,previous_session,session_id,invitation_id,at) VALUES(?,?,?,?,?)',
                   (b['thread_id'],old,p['receiver_session'],i['id'],stamp()))
        self.host.emit(db,b['thread_id'],'carrier_session_recovered',{'previous_session':old,'session_id':p['receiver_session'],
            'original_requests_preserved':True,'invitation_id':i['id'],'proof_source':'runtime_session_ledger',
            'runtime_event_id':p['runtime_event_id'],'controller_attested':True})
        self.host.emit(db,b['thread_id'],'carrier_receiver_enrolled',{'session_id':p['receiver_session'],'browser_bound':False,
            'invitation_id':i['id'],'browser_proof':'original_invitation_ticket_on_same_page'})
        return {'state':'receiver_enrolled','target_id':b['target_id'],'session_id':p['receiver_session'],
                'original_requests_preserved':True,'browser_ticket_required':True,'browser_marker_required':False,
                'proof_source':'controller_verified_runtime_session_ledger','not_account_attestation':True}

    def ticket_target(self,db,ticket,origin,url):
        require(isinstance(ticket,str) and TICKET.fullmatch(ticket),'team_browser_ticket_invalid',403)
        i=db.execute('SELECT * FROM host_carrier_invites WHERE ticket_hash=?',(digest(ticket),)).fetchone()
        require(i and i['state']=='accepted' and i['receiver_session'],'team_browser_ticket_unconfirmed',403)
        b=self.host.binding(db,target=i['target_id'])
        link=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
        require(link and link['invitation_id']==i['id'] and link['receiver_session']==b['spec']['session_id'],
                'team_receiver_identity_changed',409)
        require(link['state'] in ('receiver_enrolled','browser_bound'),'team_receiver_enrollment_unconfirmed',403)
        require(link['chat_url'] or i['expires']>self.host.clock(),'team_browser_enrollment_expired',403)
        if link['chat_url']:require(link['chat_url']==url and link['origin']==origin,'team_browser_receipt_wrong_page',403)
        foreign=db.execute('SELECT 1 FROM control_peers WHERE origin=? AND chat_url=? AND thread_id<>? UNION ALL SELECT 1 FROM recovery_peers WHERE origin=? AND chat_url=? AND thread_id<>? LIMIT 1',
                           (origin,url,b['thread_id'],origin,url,b['thread_id'])).fetchone()
        require(not foreign,'team_page_has_other_identity',409)
        return b['thread_id']

    def marker_target(self,db,marker,origin,url):
        require(isinstance(marker,str) and MARKER.fullmatch(marker),'team_browser_receipt_invalid',403)
        ident=MARKER.fullmatch(marker)[1];i=db.execute('SELECT * FROM host_carrier_invites WHERE id=?',(ident,)).fetchone()
        require(i and i['state']=='accepted' and i['marker_hash'] and hmac.compare_digest(i['marker_hash'],digest(marker)),'team_browser_receipt_unconfirmed',403)
        b=self.host.binding(db,target=i['target_id']);link=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
        require(link and link['invitation_id']==ident and link['receiver_session']==b['spec']['session_id'],'team_receiver_identity_changed',409)
        require(link['chat_url'] or i['expires']>self.host.clock(),'team_browser_enrollment_expired',403)
        if link['chat_url']:require(link['chat_url']==url and link['origin']==origin,'team_browser_receipt_wrong_page',403)
        # No second bound identity on the same browser conversation, including history.
        foreign=db.execute('SELECT 1 FROM control_peers WHERE origin=? AND chat_url=? AND thread_id<>? UNION ALL SELECT 1 FROM recovery_peers WHERE origin=? AND chat_url=? AND thread_id<>? LIMIT 1',(origin,url,b['thread_id'],origin,url,b['thread_id'])).fetchone()
        require(not foreign,'team_page_has_other_identity',409)
        return b['thread_id']
    def revoke(self,db,actor,p):
        object_fields(p,{'invitation_id','reason'});text(p['reason'],'reason',2000)
        i=db.execute('SELECT * FROM host_carrier_invites WHERE id=?',(p['invitation_id'],)).fetchone()
        require(i and i['inviter_thread']==actor['thread_id'],'team_invitation_not_owned',403)
        db.execute("UPDATE host_carrier_invites SET state='revoked' WHERE id=?",(i['id'],))
        link=db.execute('SELECT thread_id FROM host_carrier_links WHERE invitation_id=?',(i['id'],)).fetchone()
        if link:
            db.execute('UPDATE control_peers SET enabled=0 WHERE thread_id=?',(link['thread_id'],))
            db.execute("UPDATE host_carrier_links SET state='revoked' WHERE thread_id=?",(link['thread_id'],))
        return {'state':'revoked','invitation_id':i['id'],'original_work_not_cancelled':True}
    def bound(self,db,b,origin,url,generation):
        link=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
        if not link:return  # Preserve the old explicit-pair protocol, but not readiness.
        require(link['state']!='revoked','team_receiver_enrollment_revoked',403)
        invitation=db.execute('SELECT state FROM host_carrier_invites WHERE id=?',(link['invitation_id'],)).fetchone()
        require(invitation and invitation['state']=='accepted','team_receiver_enrollment_unconfirmed',403)
        other=db.execute('SELECT 1 FROM control_peers WHERE origin=? AND chat_url=? AND thread_id<>? UNION ALL SELECT 1 FROM recovery_peers WHERE origin=? AND chat_url=? AND thread_id<>? LIMIT 1',(origin,url,b['thread_id'],origin,url,b['thread_id'])).fetchone()
        require(not other,'team_page_has_other_identity',409)
        require(link['receiver_session']==b['spec']['session_id'],'team_receiver_identity_changed',409)
        require(not link['chat_url'] or (link['chat_url']==url and link['origin']==origin),'team_physical_page_changed',409)
        db.execute("UPDATE host_carrier_links SET generation=?,origin=?,chat_url=?,state='browser_bound',observed=0 WHERE thread_id=?",(generation,origin,url,b['thread_id']))
    def observe(self,db,b,peer,page):
        # A heartbeat is liveness, never proof of inference/turn completion.
        db.execute('UPDATE host_carrier_links SET observed=? WHERE thread_id=? AND generation=? AND receiver_session=? AND origin=? AND chat_url=?',
                   (self.host.clock(),b['thread_id'],peer['generation'],b['spec']['session_id'],peer['origin'],peer['chat_url']))
    def projection(self,db,b):
        if hasattr(self.host,'managed'):
            managed=self.host.managed.projection(db,b)
            if managed is not None:return managed
        row=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
        base={'state':'logical_only','runnable':False,'physical_conversation_bound':False,'receiver_confirmed':False,'account_attested':False}
        if not row:return base
        if row['state']=='revoked':return {**base,'state':'revoked'}
        base['receiver_confirmed']=row['receiver_session']==b['spec']['session_id']
        base['state']='receiver_enrolled'
        if not row['chat_url']:return base
        base['physical_conversation_bound']=True
        peer=db.execute('SELECT * FROM control_peers WHERE thread_id=?',(b['thread_id'],)).fetchone()
        live=bool(peer and peer['enabled'] and b['enabled'] and peer['generation']==row['generation'] and peer['expires']>self.host.clock() and row['observed']>0 and 0<=self.host.clock()-row['observed']<=FRESH_SECONDS)
        base.update(state='receiver_confirmed' if live and base['receiver_confirmed'] else 'unavailable',runnable=live and base['receiver_confirmed'])
        return base
