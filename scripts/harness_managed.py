"""Dedicated browser transport v1, sharing the Host ledger with Companion v4.

Only the supervised child process pipe can drive pages. Project tools enroll
their own real Workflow Session through the existing authenticated Host API.
No provider credentials, remote debugger or alternate executor are introduced.
"""
from contextlib import closing
from pathlib import Path
import hashlib,json,re,secrets,uuid,sqlite3
from harness_state import require,canonical,stamp,HarnessError
from harness_control_plane import ControlPlane,label,digest
from harness_team_carriers import SESSION
from harness_team_common import object_fields,text
from harness_team_scopes import plain_root,validate_access,worker_access
from task_worker import file_bytes
from harness_managed_handoff import ManagedHandoffs
from harness_managed_view import project_view,latest_request
from harness_renderer_lifecycle import project_lifecycle,read_context as renderer_lifecycle_context
from harness_managed_stop_scope import stop_scope
from harness_managed_activity import session_activity
from harness_record_history import browser_record
from harness_managed_models import worker_settings,worker_enrollment_selection,accept_observed,accept_bootstrap_observed,effort_key,model_key
from harness_managed_intake import IntakeDiagnostics
import harness_managed_actions as operator_actions
import harness_managed_preparation as preparation
import harness_managed_first_task as first_task
import harness_managed_recovery as recovery
import harness_managed_attention_recovery as ended_recovery
import harness_managed_budget as budget
import harness_goal_control as goal_control
import harness_next_round as next_round
import harness_managed_scope as managed_scope
import harness_managed_unsent_retry as unsent_retry
import harness_managed_carrier_recovery as carrier_recovery
import harness_managed_send_preparation as send_preparation
from harness_managed_protocol import TextCollaboration, mode as collaboration_mode, TEXT_V1, LEGACY
from harness_accounts import connector_name
from harness_managed_prompt import enrollment_blocks
from harness_recovery import CONTINUATION_SENTENCE
from harness_work_package import work_message,goal_result_guidance
from harness_run_limits import deadline_live,sends_available

PROTOCOL='clw.managed-browser.v1'

class ManagedControl(ControlPlane):
    # Initial managed goals open their run only AFTER the first Send receipt.
    # A safe pulse may renew the same unsent offer even before that run exists.
    # The shared carrier still enforces generation, baseline and offered state.
    renew_initial_offer=True
    # A program may be suspended/offline beyond a short browser-offer lease.
    # Recovery still checks the original failure/user/generation/claim and budget.
    renew_expired_recovery=True
    def __init__(self,managed):
        self.managed=managed;self.host=managed.host;self.state=self.host.state;self.protocol_version=1
    def epoch(self,db,request):
        return unsent_retry.epoch(db,request,super().epoch(db,request))
    def tentative_thread_for_git_probe(self,origin,token,data):
        if origin!=PROTOCOL or token is not None:return None
        with closing(self.state.connect()) as db:
            row=db.execute("SELECT thread_id FROM managed_pages WHERE page_id=? AND phase='bound'",
                           (data['tab_nonce'],)).fetchone()
        return row['thread_id'] if row else None
    def authorize(self,db,origin,token,data):
        require(origin==PROTOCOL and token is None,'managed_process_only',403)
        p=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(data['tab_nonce'],)).fetchone()
        require(p and p['phase']=='bound','managed_page_not_ready',409)
        # A pause fences new work, not receipts from an already dispatched turn.
        # Pulse/dispatch still cannot make an offer under a parent or local pause.
        require(not self.managed.paused(db,p) or data['action'] in ('sent','result','finish'),
                'managed_page_not_ready',409)
        require(not json.loads(p['settings']).get('work_model_pending'),'managed_work_model_pending',409)
        require(data['generation']==1 and data['chat_url']==p['url'],'managed_page_identity_changed',409)
        if data['action'] in ('sent','result','finish') and data.get('attempt_id'):
            require(not db.execute('SELECT 1 FROM managed_partial_public_sends WHERE attempt_id=?',
                                   (data['attempt_id'],)).fetchone(),
                     'managed_partial_public_attempt_unresolved',409)
        if data['action'] in ('sent','result','finish'):
            require(self.managed.receipt_collection_allowed(db,p),'managed_page_not_ready',409)
        b=self.host.binding(db,thread=p['thread_id'])
        require(b['enabled'] or data['action'] in ('sent','result','finish'),'host_paused',409)
        if data['action']=='dispatch' and not p['parent_target']:
            attempt=db.execute('SELECT request_id FROM control_attempts WHERE id=?',(data.get('attempt_id'),)).fetchone()
            if not attempt or not self.host.team.run_for_request(db,attempt[0]):budget.ready_to_start(db,p,self.host.clock())
        if data['action']=='dispatch':carrier_recovery.dispatch(self.managed,db,p,data['attempt_id'])
        db.execute('UPDATE managed_pages SET seen=? WHERE page_id=?',(self.host.clock(),p['page_id']))
        stopped=db.execute('SELECT user_hash FROM managed_stops WHERE page_id=? AND resumed=1',(p['page_id'],)).fetchone()
        return {**dict(p),'generation':1,'origin':PROTOCOL,'chat_url':p['url'],'resumed_stop_user_hash':stopped[0] if stopped else None},b
    def labels_compatible(self,p,page):
        return bool(page['model_label'] and page['effort_label'] and
                    model_key(page['model_label'])==model_key(p['model']) and effort_key(page['effort_label'])==effort_key(p['effort']))
    def recovery_candidate(self,db,peer,binding,page):
        if recovery.settle_saved_final(self.managed,db,binding):return None
        return first_task.recovery_candidate(self,db,peer,binding,page) or super().recovery_candidate(db,peer,binding,page)
    def page_safe(self,p,page):
        # This private transport targets only its owned Chromium renderer and
        # never the OS keyboard/mouse. Unlike legacy Companion, foreground is
        # allowed; drafts/composition and exact page/model guards still apply.
        return (page['visible'] and page['controls_known'] and
                not any(page[k] for k in ('generating','draft','composing','blocked')) and
                (not page['stopped'] or page['user_hash']==p.get('resumed_stop_user_hash')) and
                self.labels_compatible(p,page))
    def sent_page_safe(self,page):
        return (page['visible'] and page['controls_known'] and not any(
            page[k] for k in ('blocked','stopped','draft','composing')))
    def result_page_safe(self,p,page):
        # A result belongs to the original acknowledged Send. A later picker
        # change (including Pro becoming unavailable) cannot change that model
        # or prevent saving its reply. URL, attempt, exact user and new assistant
        # identities are still independently checked by the receipt path.
        return (page['visible'] and page['controls_known'] and
                not any(page[k] for k in ('generating','draft','composing','blocked')) and
                (not page['stopped'] or page['user_hash']==p.get('resumed_stop_user_hash')))
    def page_requests_disable(self,peer,page):
        return page['blocked'] or (page['stopped'] and page['user_hash']!=peer.get('resumed_stop_user_hash'))
    def confirm_delayed_browser_receipt(self,db,p,b,a,receipt,data):
        require(db.execute('SELECT 1 FROM managed_tool_received WHERE attempt_id=?',(a['id'],)).fetchone(),'managed_tool_receipt_missing',409)
        require(self.sent_page_safe(data['page']) and self.labels_compatible(p,data['page']),'control_sent_page_not_safe',409)
        require(data['page']['user_hash']!=a['user_hash'],'control_send_not_observed',409)
        require(data['assistant_before_hash']==receipt['assistant_before_hash'],'managed_original_assistant_changed',409)
        db.execute('UPDATE control_browser_receipts SET sent_user_hash=? WHERE attempt_id=?',(data['page']['user_hash'],a['id']))
        self.host.emit(db,b['thread_id'],'managed_browser_receipt_confirmed',{'request_id':a['request_id'],'attempt_id':a['id'],'claim_changed':False})
        return db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(a['id'],)).fetchone()
    def complete_browser_reply(self,db,b,r,receipt,a,data):
        page_row=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(b['thread_id'],)).fetchone()
        if page_row and json.loads(page_row['settings']).get('conversation_mode')=='direct':
            raw=data['text'].encode('utf-8');sha=hashlib.sha256(raw).hexdigest()
            dest=self.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
            if not dest.exists():dest.write_bytes(raw)
            db.execute('INSERT OR IGNORE INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',
                       (a['id'],r['id'],b['thread_id'],str(dest),sha,len(raw),'public_dom_markdown',self.host.clock()))
            result=super().complete_browser_reply(db,b,r,receipt,a,data)
            goal_control.apply_result(db,page_row,r['id'],data['text'])
            return result
        outcome=db.execute('SELECT * FROM managed_turn_outcomes WHERE attempt_id=?',(a['id'],)).fetchone()
        observation_only=db.execute('SELECT 1 FROM managed_unverified_identities WHERE attempt_id=?',(a['id'],)).fetchone()
        if recovery.original_wait_receipt(db,r,a):
            return super().complete_browser_reply(db,b,r,receipt,a,data)
        if observation_only:
            # A unique public marker can identify a report that needs review,
            # but cannot replace a tool receipt or authorize task completion.
            return self.attention_reply(db,b,r,receipt,a,data,True)
        if r['phase']=='suspended':return super().complete_browser_reply(db,b,r,receipt,a,data)
        page=db.execute('SELECT settings FROM managed_pages WHERE thread_id=?',(b['thread_id'],)).fetchone()
        if not outcome and page and collaboration_mode(json.loads(page['settings']))==TEXT_V1:
            result=self.managed.text.complete(db,b,r,receipt,a,data)
            closed=db.execute('SELECT phase FROM host_requests WHERE id=?',(r['id'],)).fetchone()
            if closed and closed['phase']=='completed' and goal_control.goal_row(db,page_row):
                artifact=db.execute("SELECT path FROM managed_artifacts WHERE id=? AND source='public_dom_markdown'",(a['id'],)).fetchone()
                if artifact:goal_control.apply_result(db,page_row,r['id'],Path(artifact['path']).read_text(encoding='utf-8-sig'))
            return result
        # A finished public turn without its tool receipt is a recoverable
        # protocol problem, never proof that the business goal completed.
        missing_outcome=not outcome
        if missing_outcome:outcome={'kind':'needs_attention'}
        if outcome['kind']=='completed':
            saved=db.execute("SELECT * FROM managed_artifacts WHERE id=? AND source='local_mcp_public_result'",(a['id']+'-tool',)).fetchone()
            require(saved,'managed_tool_result_required',409)
            content=Path(saved['path']).read_text(encoding='utf-8-sig')
            require(hashlib.sha256(Path(saved['path']).read_bytes()).hexdigest()==saved['sha256'],'managed_result_file_changed',409)
            if db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone():
                # New instructions can arrive after a worker saved its result.
                # Preserve that artifact and end only this browser turn. The
                # original request resumes once with all accumulated notes.
                db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(r['id'],))
                db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",(stamp(),r['thread_id']))
                self.host.team.scopes.release(db,r['id'])
                self.host.emit(db,r['thread_id'],'host_waiting_children',{'request_id':r['id'],'reason':'additional_instructions','no_new_request':True})
                return self.host.browser_reply(db,b,{**dict(r),'phase':'suspended'},receipt['claim_id'],a['id'],data['text'],data['assistant_turn_hash'])
            # The unabridged file is authoritative; long values are referenced,
            # never silently squeezed through the legacy event-size boundary.
            body=content if len(content)<=46000 else content[:1000]+'\n\n完整工具原文（必须读取）：'+saved['path']+'\nSHA256: '+saved['sha256']
            result=self.host.browser_reply(db,b,r,receipt['claim_id'],a['id'],body,data['assistant_turn_hash'])
            metadata=db.execute('SELECT status,wait_context FROM managed_goal_turn_metadata WHERE attempt_id=?',(a['id'],)).fetchone()
            goal_control.apply_result(db,page_row,r['id'],content,metadata['status'] if metadata else None,
                                      json.loads(metadata['wait_context']) if metadata and metadata['wait_context'] else None)
            return result
        require(outcome['kind']=='needs_attention' and r['claim_id']==receipt['claim_id'],'managed_turn_outcome_mismatch',409)
        return self.attention_reply(db,b,r,receipt,a,data,missing_outcome)
    def attention_reply(self,db,b,r,receipt,a,data,missing_outcome=False):
        reply='clw-browser-reply-'+a['id'].removeprefix('control_')
        result={'request_id':r['id'],'reply_id':reply,'phase':'needs_attention','thread_id':b['thread_id'],'task_completed':False}
        fingerprint=digest(canonical({'text':data['text'],'turn_hash':data['assistant_turn_hash'],'request_id':r['id']}))
        db.execute('INSERT INTO host_replies VALUES(?,?,?,?)',(reply,r['id'],fingerprint,canonical(result)))
        # Preserve explicit operator pauses separately from this ended turn.
        page=db.execute('SELECT page_id,paused FROM managed_pages WHERE thread_id=?',(b['thread_id'],)).fetchone()
        if page and not page['paused']:
            db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'attention',?)",(page['page_id'],a['id']))
        db.execute('UPDATE managed_pages SET paused=1 WHERE thread_id=?',(b['thread_id'],))
        reason=('网页回合已结束，但缺少工具完成或等待回执。原任务与 Job 保留，请核对后恢复。\n\n' if missing_outcome else '')+data['text']
        db.execute('INSERT OR REPLACE INTO managed_attention VALUES(?,?,?)',(r['id'],a['id'],reason))
        self.host.team.journal.park_read_only_attention(db,r)
        self.host.emit(db,b['thread_id'],'host_turn_attention',{'request_id':r['id'],'attempt_id':a['id'],'text':reason,'original_claim_preserved':True,'missing_tool_outcome':missing_outcome})
        return result
    def prompt(self,db,b,a):
        r=self.original(db,b,a['request_id'])
        page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(b['thread_id'],)).fetchone()
        settings=json.loads(page['settings']);account=settings.get('account','B')
        first=db.execute('SELECT COUNT(*) FROM host_requests WHERE thread_id=?',(b['thread_id'],)).fetchone()[0]==1
        goal_hint=goal_result_guidance(db,b['thread_id'],r['id'])
        if settings.get('conversation_mode')=='direct':
            message=CONTINUATION_SENTENCE if a['epoch']<0 else r['text']
            return work_message('\n\n'.join(x for x in (message,goal_hint) if x),
                                project=page['root'] or None,first=first and a['epoch']>=0)
        if collaboration_mode(settings)==TEXT_V1:
            return self.managed.text.prompt(db,b,a,page,r)
        cli=str(self.host.root/'scripts/harness_managed_client.py')
        args=f'--store-id {self.state.id} --target {b["target_id"]} --session-id {b["spec"]["session_id"]}'
        contract=(f'@{connector_name(account)}\n'
                  f'本次执行：python -X utf8 -B "{cli}" context {args} --attempt-id {a["id"]}\n'
                  '沿本对话原 Session 执行并按 context.result_delivery 保存完整结果。已受理或未知操作核对原 Job。')
        if a['epoch']<0:
            return work_message('\n\n'.join(x for x in (CONTINUATION_SENTENCE,contract,goal_hint) if x))
        role='完成下方独立分工。' if page['parent_target'] else '自主完成当前任务与必要整合。'
        notes='\n\n'.join(x['text'] for x in next_round.current_notes(db,r['id']))
        message='\n\n'.join(x for x in (contract,role,r['text'],notes,goal_hint) if x)
        if carrier_recovery.projection(page):
            message+='\n原网页地址已恢复，继续同一请求和 Session。'
        return work_message(message,project=page['root'] if first else None,first=first)

class ManagedPages:
    def __init__(self,host):
        self.host,self.state=host,host.state;self.control=ManagedControl(self)
        with closing(self.state.connect()) as db:
            db.execute('CREATE TABLE IF NOT EXISTS managed_stops(page_id TEXT PRIMARY KEY,user_hash TEXT NOT NULL,turn_hash TEXT NOT NULL,resumed INTEGER NOT NULL DEFAULT 0)')
            db.executescript('''
            CREATE TABLE IF NOT EXISTS managed_pages(
              page_id TEXT PRIMARY KEY,target_id TEXT UNIQUE NOT NULL,thread_id TEXT UNIQUE,
              parent_target TEXT,root TEXT NOT NULL,title TEXT NOT NULL,model TEXT NOT NULL,
              effort TEXT NOT NULL,url TEXT NOT NULL,phase TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,
              seen REAL NOT NULL DEFAULT 0,cutoff INTEGER NOT NULL,ticket_hash TEXT NOT NULL,
              marker TEXT,bootstrap_text TEXT NOT NULL,bootstrap_state TEXT NOT NULL DEFAULT 'pending',
              settings TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_receipts(
              id TEXT PRIMARY KEY,actor TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_artifacts(
              id TEXT PRIMARY KEY,request_id TEXT NOT NULL,thread_id TEXT NOT NULL,path TEXT NOT NULL,
              sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,source TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_dispatches(
              attempt_id TEXT PRIMARY KEY,assistant_before_hash TEXT NOT NULL,prompt_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_partial_public_sends(
              attempt_id TEXT PRIMARY KEY,observation_hash TEXT NOT NULL,
              artifact_id TEXT NOT NULL,response TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_tool_received(attempt_id TEXT PRIMARY KEY,received REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_bootstrap_budget(page_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_turn_outcomes(attempt_id TEXT PRIMARY KEY,kind TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_unverified_identities(attempt_id TEXT PRIMARY KEY,previous_user_hash TEXT NOT NULL,user_hash TEXT NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_legacy_holds(thread_id TEXT PRIMARY KEY,target_id TEXT UNIQUE NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_attention(request_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,reason TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_pause_owners(page_id TEXT PRIMARY KEY,source TEXT NOT NULL,attempt_id TEXT);
            CREATE TABLE IF NOT EXISTS managed_page_issues(page_id TEXT PRIMARY KEY,kind TEXT NOT NULL,detail TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS managed_page_waits(request_id TEXT PRIMARY KEY,targets TEXT NOT NULL,state TEXT NOT NULL);
            ''')
            self.intake=IntakeDiagnostics(host,db)
            operator_actions.schema(db)
            preparation.schema(db)
            recovery.schema(db)
            ended_recovery.schema(db)
            budget.schema(db)
            goal_control.schema(db)
            next_round.schema(db)
            self.handoffs=ManagedHandoffs(self,db)
            self.text=TextCollaboration(self,db)
            db.commit()
            recovery.reconcile_wait_attention(self,db)
            recovery.reconcile_closed_attention(self,db)
            self.host.team.journal.reconcile_attention(db);db.commit()
    def paused(self,db,page):
        return self.pause_origin(db,page) is not None
    def receipt_collection_allowed(self,db,page):
        """A future operator hold cannot revoke an already committed original turn."""
        original=page['page_id'] if page else None;seen=set()
        if page and page['thread_id'] and db.execute('SELECT 1 FROM managed_attention a JOIN host_requests r ON r.id=a.request_id WHERE r.thread_id=?',(page['thread_id'],)).fetchone():return False
        while page:
            require(page['page_id'] not in seen,'managed_page_cycle',409);seen.add(page['page_id'])
            issue=db.execute('SELECT kind FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
            local_fault=issue and issue['kind'] in ('usage_limit','model_unavailable','model_mismatch','control_failed','login_required')
            if issue and (page['page_id']==original or not local_fault):return False
            if page['paused']:
                owner=db.execute('SELECT source FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
                if not (local_fault and page['page_id']!=original) and (not owner or owner['source']!='operator'):return False
            target=self.handoffs.parent_target(db,page['parent_target']) if page['parent_target'] else None
            page=db.execute('SELECT page_id,thread_id,parent_target,paused FROM managed_pages WHERE target_id=?',(target,)).fetchone() if target else None
            require(not target or page,'managed_parent_identity_changed',409)
        return True
    def pause_origin(self,db,page,include_self=True):
        original=page['page_id'] if page else None
        seen=set()
        while page:
            require(page['page_id'] not in seen,'managed_page_cycle',409);seen.add(page['page_id'])
            if page['paused'] and (include_self or page['page_id']!=original):
                owner=db.execute('SELECT source,attempt_id FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
                issue=db.execute('SELECT kind FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone()
                local_fault=owner and owner['source']=='page_issue' and issue and issue['kind'] in ('usage_limit','model_unavailable','model_mismatch','control_failed','login_required')
                # A newly recorded page/model fault pauses that page, not work
                # already assigned to independent descendants. Explicit stops,
                # maintenance and legacy/unknown pause ownership still cascade.
                if page['page_id']==original or not local_fault:
                    title=db.execute('SELECT title FROM managed_pages WHERE page_id=?',(page['page_id'],)).fetchone()
                    return {'page_id':page['page_id'],'title':title[0] if title else '',
                            'source':owner['source'] if owner else 'page_or_legacy_pause',
                            'attempt_id':owner['attempt_id'] if owner else None,'inherited':page['page_id']!=original}
            target=self.handoffs.parent_target(db,page['parent_target']) if page['parent_target'] else None
            page=db.execute('SELECT page_id,parent_target,paused FROM managed_pages WHERE target_id=?',(target,)).fetchone() if target else None
            require(not target or page,'managed_parent_identity_changed',409)
        return None
    def pages_ready(self,db,targets):
        pages=[]
        for target in targets:
            row=db.execute('SELECT page_id,target_id,parent_target,title,phase,paused,settings FROM managed_pages WHERE target_id=?',(target,)).fetchone()
            require(row,'managed_page_missing',404)
            issue=db.execute('SELECT kind,detail FROM managed_page_issues WHERE page_id=?',(row['page_id'],)).fetchone()
            public=dict(row);settings=json.loads(public.pop('settings'))
            first_pending=bool(settings.get('first_task_outcome')=='not_started' and db.execute(
                "SELECT 1 FROM host_requests WHERE id=? AND phase IN ('queued','processing','suspended')",
                (settings.get('first_task_request_id'),)).fetchone())
            pages.append({**public,'work_model_pending':bool(settings.get('work_model_pending')),'first_task_pending':first_pending,'paused':self.paused(db,row),'issue':dict(issue) if issue else None,'preparation_result':preparation.summary(db,row['page_id'])})
        ready=all(p['phase']=='bound' and not p['paused'] and not p['work_model_pending'] and not p['first_task_pending'] for p in pages)
        attention=any(p['issue'] for p in pages)
        return {'state':'pages_ready' if ready else 'pages_need_attention' if attention else 'waiting_events','pages':pages,'model_called':False}
    def reconcile_page_waits(self,db):
        for wait in db.execute("SELECT * FROM managed_page_waits WHERE state='waiting_events'").fetchall():
            result=self.pages_ready(db,json.loads(wait['targets']))
            if result['state']=='waiting_events':continue
            r=db.execute('SELECT * FROM host_requests WHERE id=?',(wait['request_id'],)).fetchone()
            if not r or r['cancel_requested'] or r['phase'] not in ('processing','suspended'):continue
            db.execute('UPDATE managed_page_waits SET state=? WHERE request_id=?',(result['state'],r['id']))
            self.host.emit(db,r['thread_id'],'managed_pages_settled',{'request_id':r['id'],'state':result['state'],'model_called':False})
    def resume_attention(self,db,page):
        pending=db.execute("SELECT r.* FROM host_requests r JOIN managed_attention a ON a.request_id=r.id WHERE r.thread_id=? AND r.phase IN ('processing','suspended') AND r.cancel_requested=0",(page['thread_id'],)).fetchall()
        resumed=[]
        for r in pending:
            run=self.host.team.run_for_request(db,r['id'])
            if run:
                require(not self.host.team.maintenance.held(db,run['id']),'team_use_resume_maintenance',409)
                # An ended final turn is reopened by the explicit operator
                # budget/resume transaction, never by bypassing the final latch.
                require(not run['final_granted'],'managed_resume_finalizing',409)
                require(run['state']!='paused','managed_resume_controller_paused',409)
                require(run['state']!='closed','managed_resume_run_closed',409)
                if run['state']=='running':
                    require(deadline_live(run,self.host.clock()),'managed_resume_window_expired',409)
                    require(sends_available(run,1,1),'managed_resume_sends_exhausted',409)
                else:
                    require(run['state']=='draining' and r['id']==run['controller_request'] and not run['final_granted'] and sends_available(run),'managed_resume_finalizing',409)
            facts=recovery.preserve(db,self.host.team,r['id'])
            db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(r['id'],))
            db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",(stamp(),r['thread_id']))
            self.host.emit(db,r['thread_id'],'host_waiting_children',{'request_id':r['id'],'reason':'operator_resume_after_attention','no_new_request':True})
            note='clw-operator-resume-'+uuid.uuid4().hex
            message='用户已授权恢复本分支。先核对本次原 Job、已有成果和待处理原因；不得重放已接受的命令，继续使用原 request/claim。'+recovery.continuation_note(facts)
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',(note,r['id'],message,stamp()))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)',(note,r['id']))
            self.host.emit(db,r['thread_id'],'host_user_note',{'request_id':r['id'],'note_id':note,'text':message,'native_steer':False})
            db.execute('DELETE FROM managed_attention WHERE request_id=?',(r['id'],));resumed.append(r['id'])
        return resumed
    def legacy_quiet(self,db,thread):
        row=db.execute('SELECT status FROM threads WHERE id=?',(thread,)).fetchone()
        return bool(row and row[0] in ('idle','host_paused','waiting','waiting_children') and
            not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase='processing'",(thread,)).fetchone() and
            not db.execute('SELECT 1 FROM host_team_leases WHERE thread_id=?',(thread,)).fetchone() and
            not db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",(thread,)).fetchone() and
            not db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",(thread,)).fetchone())
    def held_legacy(self,db,thread):
        held=db.execute('SELECT 1 FROM managed_legacy_holds h JOIN host_bindings b ON b.thread_id=h.thread_id WHERE h.thread_id=? AND b.enabled=0',(thread,)).fetchone()
        return bool(held and self.legacy_quiet(db,thread))
    def definition(self,target):
        with closing(self.state.connect()) as db:
            row=db.execute('SELECT b.spec FROM managed_pages p JOIN host_bindings b ON p.thread_id=b.thread_id WHERE p.target_id=?',(target,)).fetchone()
            return json.loads(row[0]) if row else None
    def projection(self,db,b):
        p=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(b['thread_id'],)).fetchone()
        if not p:return None
        settings=json.loads(p['settings'])
        eligible=(p['phase']=='bound' or first_task.received(p)) and not settings.get('work_model_pending') and not self.paused(db,p) and b['enabled']
        ready=eligible and 0<=self.host.clock()-p['seen']<=300
        # Admission records a logical request, before the driver hydrates its
        # owned renderer. Execution still requires the unchanged fresh carrier.
        # A received first task keeps its separate enrollment/Send ledger gate.
        receiver=db.execute('SELECT native_id FROM threads WHERE id=?',(b['thread_id'],)).fetchone()
        expected_native=('web-conversation/'+p['page_id'] if settings.get('conversation_mode')=='direct'
                         else 'mcp-host/'+b['spec']['session_id'])
        queueable=bool(p['phase']=='bound' and eligible and
            p['target_id']==b['target_id'] and settings.get('account','B') in ('A','B') and
            receiver and receiver['native_id']==expected_native)
        return {'state':'receiver_confirmed' if ready else p['phase'],'runnable':bool(ready),
                **({'queueable':queueable} if p['phase']=='bound' else {}),
                'physical_conversation_bound':p['phase']=='bound','receiver_confirmed':bool(p['thread_id']),
                'account_attested':False,'transport':PROTOCOL}
    def reserve(self,db,p,parent=None):
        object_fields(p,{'page_id','title','root','model','effort'},{'access','write_paths','resources','duration_seconds','max_dispatches','model_selection','bootstrap_model_selection','account','first_turn_instructions','first_turn_mode','collaboration_protocol','collaboration_enabled'})
        require(isinstance(p['page_id'],str) and re.fullmatch(r'web-[0-9a-f-]{36}',p['page_id']),'managed_page_id')
        root=plain_root(p['root']);title=text(p['title'],'title',130)
        model,effort=label(p['model']),label(p['effort'])
        target=p['page_id'];ticket='clwm_'+secrets.token_urlsafe(32)
        first_turn=preparation.instructions(p)
        inherited=self.host.team.scopes.scope(db,parent['thread_id']) if parent and first_turn and p.get('first_turn_mode',first_task.MODE)==first_task.MODE else None
        access,write_paths=worker_access(inherited,root,p)
        settings={'access':access,'write_paths':write_paths,'resources':p.get('resources',[]),
                   'duration_seconds':p.get('duration_seconds'),'max_dispatches':p.get('max_dispatches'),'model_selection':p.get('model_selection'),'account':p.get('account','B')}
        settings['collaboration_protocol']=collaboration_mode({'collaboration_protocol':p.get('collaboration_protocol',LEGACY)})
        if 'collaboration_enabled' in p:
            require(type(p['collaboration_enabled']) is bool,'managed_collaboration_invalid')
            settings['collaboration_enabled']=p['collaboration_enabled']
        if parent:
            owner=db.execute('SELECT settings FROM managed_pages WHERE target_id=?',(parent['target_id'],)).fetchone()
            require(owner and settings['collaboration_protocol']==collaboration_mode(json.loads(owner['settings'])),
                    'managed_worker_protocol_mismatch',409)
        if first_turn:
            settings['first_turn_instructions']=first_turn
            settings['first_turn_mode']=p.get('first_turn_mode',first_task.MODE)
            require(settings['first_turn_mode'] in ('prepare_v1',first_task.MODE),'managed_first_turn_mode')
            if first_task.enabled({'settings':canonical(settings)}) and parent:
                original=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(parent['thread_id'],)).fetchone()
                run=self.host.team.run_for_request(db,original['id']) if original else None
                require(run and run['state']=='running' and run['controller_request']==original['id'],'managed_first_task_requires_active_controller',409)
                settings['first_task_parent']={'run_id':run['id'],'request_id':original['id'],'claim_id':original['claim_id']}
        bootstrap_selection=p.get('bootstrap_model_selection') or p.get('model_selection')
        if bootstrap_selection:
            require(isinstance(bootstrap_selection,dict) and bootstrap_selection.get('model') and bootstrap_selection.get('effort'),'managed_bootstrap_model_required')
            settings['bootstrap_model_selection']=bootstrap_selection
            settings['work_model_pending']=(model_key(bootstrap_selection['model'])!=model_key(model) or effort_key(bootstrap_selection['effort'])!=effort_key(effort))
        require(settings.get('first_turn_mode')!=first_task.MODE or not settings.get('work_model_pending'),'managed_first_task_requires_work_model',409)
        require(settings['account'] in ('A','B'),'managed_account_invalid')
        settings['write_paths'],settings['resources']=validate_access(settings['access'],settings['write_paths'],settings['resources'])
        require(settings['duration_seconds'] is None or type(settings['duration_seconds']) is int and 1<=settings['duration_seconds']<=604800,'managed_duration')
        require(settings['max_dispatches'] is None or type(settings['max_dispatches']) is int and 2<=settings['max_dispatches']<=10000,'managed_budget')
        cutoff=db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0]
        cli=str(self.host.root/'scripts/harness_managed_client.py')
        blocks=enrollment_blocks(root=root,account=settings['account'],instructions=first_turn,first_turn_mode=settings.get('first_turn_mode'),
                                 cli=cli,store_id=self.state.id,target=target,ticket=ticket)
        bootstrap=''.join(block['text'] for block in blocks)
        db.execute('INSERT INTO managed_pages(page_id,target_id,parent_target,root,title,model,effort,url,phase,cutoff,ticket_hash,bootstrap_text,settings,created) VALUES(?,?,?,?,?,?,?,\'https://chatgpt.com/\',\'reserved\',?,?,?,?,?)',
                   (p['page_id'],target,parent['target_id'] if parent else None,root,title,model,effort,cutoff,digest(ticket),bootstrap,canonical(settings),self.host.clock()))
        return {'page_id':p['page_id'],'target':target,'state':'reserved','bootstrap_text':bootstrap,
                'access':settings['access'],'write_paths':settings['write_paths']}
    def register_direct(self,db,p):
        object_fields(p,{'page_id','title','model','effort','account'},
                      {'root','url','model_selection','collaboration_enabled','duration_seconds','max_dispatches'})
        require(isinstance(p['page_id'],str) and re.fullmatch(r'web-[0-9a-f-]{36}',p['page_id']),'managed_page_id')
        require(p['account'] in ('A','B'),'managed_account_invalid')
        title=text(p['title'],'title',130);model=label(p['model']);effort=label(p['effort'])
        root=plain_root(p['root']) if p.get('root') else ''
        url=p.get('url','https://chatgpt.com/')
        require(url=='https://chatgpt.com/' or re.fullmatch(r'https://chatgpt.com/c/[0-9a-f-]+',url),'managed_exact_chat_required')
        require(p.get('collaboration_enabled',False) is False,'managed_direct_collaboration_requires_project_binding')
        settings={'conversation_mode':'direct','collaboration_enabled':False,'account':p['account'],
                  'access':'read','write_paths':[],'resources':[],
                  'duration_seconds':p.get('duration_seconds'),'max_dispatches':p.get('max_dispatches'),
                  'model_selection':p.get('model_selection')}
        for field,lo,hi in [('duration_seconds',1,604800),('max_dispatches',2,10000)]:
            require(settings[field] is None or type(settings[field]) is int and lo<=settings[field]<=hi,'managed_budget')
        old=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
        if old:
            require(old['phase']=='bound' and old['root']==root and json.loads(old['settings'])==settings and
                    old['model']==model and old['effort']==effort and old['title']==title,'managed_direct_registration_conflict',409)
            return {'page_id':old['page_id'],'thread_id':old['thread_id'],'state':'bound','conversation_mode':'direct','replayed':True}
        thread='hthr_'+uuid.uuid4().hex;at=stamp()
        db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                   (thread,'chatgpt_web_host','web-conversation/'+p['page_id'],None,title,root,model,effort,'idle',None,at,at))
        spec={'id':p['page_id'],'title':title,'session_id':None,'project':None,'root':root,'conversation_mode':'direct'}
        db.execute('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,1)',(p['page_id'],thread,canonical(spec)))
        cutoff=db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0]
        db.execute('''INSERT INTO managed_pages(page_id,target_id,thread_id,root,title,model,effort,url,phase,cutoff,ticket_hash,bootstrap_text,settings,created)
                      VALUES(?,?,?,?,?,?,?,?,'bound',?,'','',?,?)''',
                   (p['page_id'],p['page_id'],thread,root,title,model,effort,url,cutoff,canonical(settings),self.host.clock()))
        self.host.emit(db,thread,'managed_direct_registered',{'page_id':p['page_id'],'project_bound':False,'model_sends':0})
        return {'page_id':p['page_id'],'thread_id':thread,'state':'bound','conversation_mode':'direct','model_sends':0}
    def private(self,data):
        with self.host.business_admission():return self._private(data)
    def _private(self,data):
        try:return self.private_operation(data)
        except HarnessError as error:
            if data.get('op')=='enroll':
                # The failed transaction has rolled back. This audit does not
                # retry enrollment or create an execution success receipt.
                try:
                    with self.host.lock,closing(self.state.connect()) as db:
                        self.intake.rejected(db,data,error);db.commit()
                except (sqlite3.Error,OSError,HarnessError):pass
            raise
    def private_operation(self,data):
        op,key,p=data['op'],data['operation_id'],data['payload'];self.host.identifier(key)
        fp=digest(canonical(data));target=data['target_id']
        git_probe=None
        if (op=='context' and 'attempt_id' in p) or op=='first-task':
            with closing(self.state.connect()) as probe_db:
                tentative=probe_db.execute('SELECT thread_id FROM managed_pages WHERE target_id=?',
                                           (target,)).fetchone()
            if tentative and tentative['thread_id']:
                git_probe=self.host.team.scopes.preflight_native_git(tentative['thread_id'])
        with self.host.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            old=db.execute('SELECT * FROM managed_receipts WHERE id=?',(key,)).fetchone()
            if old:
                require(old['fingerprint']==fp,'managed_operation_conflict',409);return json.loads(old['response'])
            page=db.execute('SELECT * FROM managed_pages WHERE target_id=?',(target,)).fetchone()
            require(page,'managed_page_missing',404)
            if op=='enroll':result=self.enroll(db,page,data['session_id'],p)
            else:
                b=self.host.binding(db,target=target)
                require(b['spec']['session_id']==data['session_id'],'host_session_mismatch',403)
                if op=='first-task':result=first_task.begin(self,db,page,b,p,git_probe,key)
                elif op=='context':
                    object_fields(p,set(),{'attempt_id'})
                    if 'attempt_id' in p:self.receive_tool_attempt(db,page,b,p['attempt_id'],git_probe=git_probe)
                    r=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase IN ('processing','suspended') ORDER BY created_at DESC LIMIT 1",(b['thread_id'],)).fetchone()
                    result={'target':target,'session_id':data['session_id'],'store_id':self.state.id,'request':dict(r) if r else None,
                            'role':'worker' if page['parent_target'] else 'controller','assignment_source':'request.text; run goal is team context, not a second assignment',
                            'run':self.host.team.run_for_request(db,r['id']) if r else None,
                            'worker_configuration':{'default':'inherit','optional_fields':['model','effort'],'independent_effort':True,'current_model':page['model'],'current_effort':page['effort'],'bootstrap_model_selection':worker_enrollment_selection(json.loads(page['settings']),{'model':page['model'],'effort':page['effort']}),'enrollment_policy':'with a complete first work package: use the selected work model for enrollment and work in one message; setup-only: use recorded non-Pro enrollment choice or Extra High, then verify work settings without another message','availability':'verified_on_worker_page_before_send'},
                            'guide':str(self.host.root/'docs/harness/MANAGED_WEB.md')}
                    result['budget_continuation']=budget.context(db,result['run']['id']) if result['run'] else None
                    if r:
                        result['result_delivery']=preparation.result_delivery(self,b,r,key)
                        result['additional_instructions']=[dict(x) for x in next_round.current_notes(db,r['id'])]
                        result['artifacts']=[dict(x) for x in db.execute('SELECT path,sha256,bytes,source FROM managed_artifacts WHERE request_id=? ORDER BY created',(r['id'],))]
                        result['recovery_context']=recovery.saved(db,r['id'])
                        # Only a real Session tool read acknowledges the notes.
                        # Browser view/health polling cannot acknowledge them.
                        db.execute('DELETE FROM host_unread_notes WHERE request_id=?',(r['id'],))
                    result['handoff']=self.handoffs.context(db,page,r['id'] if r else None)
                    result['preparation_result']=preparation.summary(db,page['page_id'])
                    result['maintenance']=self.host.team.maintenance.for_page(db,page['page_id'])
                    result['worker_configuration'].update(first_turn_instructions='Preferred: supply the COMPLETE first work package with create. Enrollment and this task run in ONE Web message using the requested work model; read, implement, verify and report in that turn. Omit only for intentional setup-only pages.',preparation_results='pages and wait-ready expose saved first-task results; do not assign the same first task again')
                    result['worker_configuration']['access']='For a complete first task, omit both access and write_paths to reuse the parent grant intersected with the child directory. Explicit read remains read-only; outside that grant, specify the task scope. This reuses authority, not an additional approval.'
                    result['worker_configuration']['pending_worker']='For your own reserved/pending child with no Session or Send, prepare-worker {target, first_turn_instructions, activate:true} attaches a COMPLETE task to that original page and current run. Keeps its account, model and scope. Only a local preparation_required issue can be cleared; independent refusal, unknown Send and explicit stop remain blocked.'
                    wait=db.execute('SELECT targets FROM managed_page_waits WHERE request_id=?',(r['id'],)).fetchone() if r else None
                    result['waiting_pages']=self.pages_ready(db,json.loads(wait[0])) if wait else None
                elif op=='wait-ready':
                    object_fields(p,{'targets'})
                    targets=p['targets'];require(isinstance(targets,list) and targets and all(isinstance(t,str) for t in targets) and len(set(targets))==len(targets),'managed_targets_required')
                    for target_page in targets:
                        owned=self.host.team.carriers.may_manage(db,b,target_page)
                        require(owned or db.execute('SELECT 1 FROM managed_pages WHERE target_id=? AND parent_target=?',(target_page,target)).fetchone(),'managed_wait_pages_not_owned',403)
                    r=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(b['thread_id'],)).fetchone()
                    require(r,'managed_wait_requires_processing_controller',409)
                    run=self.host.team.run_for_request(db,r['id'])
                    require(run and run['controller_request']==r['id'] and run['state']=='running','managed_wait_requires_processing_controller',409)
                    result=self.pages_ready(db,targets)
                    db.execute('INSERT OR REPLACE INTO managed_page_waits VALUES(?,?,?)',(r['id'],canonical(targets),result['state']))
                    if result['state']=='waiting_events':
                        maximum=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
                        db.execute("UPDATE host_runs SET after_seq=?,wait_mode='any',revision=revision+1 WHERE id=?",(maximum,run['id']))
                        db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(r['id'],))
                        db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",(stamp(),b['thread_id']))
                        self.host.team.scopes.release(db,r['id'])
                        self.host.emit(db,b['thread_id'],'host_waiting_children',{'request_id':r['id'],'run_id':run['id'],'reason':'managed_pages','no_new_request':True})
                elif op=='handoff':result=self.handoffs.prepare(db,page,b,p,key)
                elif op=='prepare-worker':result=first_task.prepare_worker(self,db,page,b,p)
                elif op=='create':
                    require(json.loads(page['settings']).get('collaboration_enabled',True),'managed_collaboration_not_enabled',409)
                    require(b['enabled'] and not self.paused(db,page),'managed_parent_paused',409)
                    object_fields(p,{'page_id','title','root'},{'model','effort','access','write_paths','resources','duration_seconds','max_dispatches','first_turn_instructions','first_turn_mode'})
                    settings=json.loads(page['settings'])
                    selected=worker_settings(page,settings,p)
                    result=self.reserve(db,{**p,**selected,'collaboration_protocol':collaboration_mode(settings)},b)
                    result.update(model=selected['model'],effort=selected['effort'],model_policy='explicit' if 'model' in p or 'effort' in p else 'inherit')
                elif op=='turn-end':
                    object_fields(p,{'request_id','claim_id','outcome'},{'markdown_path','markdown','goal_status','wait_context'})
                    require(p['outcome'] in ('completed','yielded','needs_attention'),'managed_turn_outcome')
                    r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(p['request_id'],b['thread_id'])).fetchone()
                    require(r and r['claim_id']==p['claim_id'] and r['phase'] in ('processing','suspended'),'host_claim_not_current',409)
                    require((p['outcome']=='yielded')==(r['phase']=='suspended'),'managed_turn_outcome_mismatch',409)
                    if first_task.enabled(page) and page['phase']=='receiver_enrolled':
                        result=first_task.finish(self,db,page,b,r,p,key)
                        db.execute('INSERT INTO managed_receipts VALUES(?,?,?,?)',(key,target,fp,canonical(result)));db.commit();return result
                    a=db.execute('SELECT br.attempt_id FROM control_browser_receipts br JOIN control_attempts a ON a.id=br.attempt_id WHERE br.request_id=? AND br.result_hash IS NULL ORDER BY a.acknowledged DESC LIMIT 1',(r['id'],)).fetchone()
                    require(a,'managed_current_turn_missing',409)
                    require(not ('markdown' in p and 'markdown_path' in p),'managed_single_result_source')
                    notes=db.execute('''SELECT n.id,n.text,n.created_at FROM host_notes n
                      JOIN host_unread_notes u ON u.note_id=n.id AND u.request_id=n.request_id
                      WHERE n.request_id=? ORDER BY n.created_at,n.rowid LIMIT 33''',(r['id'],)).fetchall() if p['outcome']=='completed' else []
                    if notes:
                        # Return new input in this very tool round. The durable
                        # operation receipt makes a lost response replayable;
                        # only delivered notes are acknowledged, never unseen input.
                        result={'state':'additional_instructions_pending','additional_instructions':[dict(n) for n in notes[:32]],
                                'has_more':len(notes)>32,'task_completed':False,'result_saved':False,
                                'next_action':'Process these notes in the current Web turn, then submit the revised result with a new operation_id.'}
                        db.executemany('DELETE FROM host_unread_notes WHERE request_id=? AND note_id=?',[(r['id'],n['id']) for n in notes[:32]])
                    else:
                        if 'markdown_path' in p:raw=file_bytes(Path(page['root']),p['markdown_path'],8*1024*1024)
                        else:raw=text(p.get('markdown','让出等待' if p['outcome']=='yielded' else ''),'markdown',48000).encode()
                        sha=hashlib.sha256(raw).hexdigest();dest=self.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
                        if not dest.exists():dest.write_bytes(raw)
                        db.execute('INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',(a[0]+'-tool',r['id'],b['thread_id'],str(dest),sha,len(raw),'local_mcp_public_result',self.host.clock()))
                        db.execute('INSERT INTO managed_turn_outcomes VALUES(?,?)',(a[0],p['outcome']))
                        warning=None
                        if 'goal_status' in p or 'wait_context' in p:
                            try:status,waiting=goal_control.result_metadata(raw.decode('utf-8-sig'),p.get('goal_status'),p.get('wait_context'))
                            except (ValueError,TypeError,HarnessError) as error:
                                warning=getattr(error,'code',str(error));status='metadata_invalid';waiting=None
                            db.execute('INSERT INTO managed_goal_turn_metadata VALUES(?,?,?)',(a[0],status,canonical(waiting) if waiting else None))
                        self.host.emit(db,b['thread_id'],'managed_raw_result',{'request_id':r['id'],'path':str(dest),'sha256':sha,'outcome':p['outcome']})
                        result={'state':'turn_outcome_saved','outcome':p['outcome'],'path':str(dest),'sha256':sha,'task_completed':False}
                        if warning:result['goal_metadata_warning']=warning
                elif op=='pages':
                    object_fields(p,set(),{'after'});after=p.get('after',0);require(type(after) is int and after>=0,'managed_page_cursor')
                    rows=db.execute('''WITH RECURSIVE owners(target) AS (
                        SELECT ? UNION SELECT h.source_page FROM managed_handoffs h JOIN owners o ON h.successor_page=o.target WHERE h.state='active')
                        SELECT rowid AS cursor,page_id,target_id,parent_target,title,phase,paused,bootstrap_state,model,effort,settings FROM managed_pages
                        WHERE (parent_target IN (SELECT target FROM owners) OR target_id=?) AND rowid>? ORDER BY rowid LIMIT 129''',(target,target,after)).fetchall()
                    listed=[]
                    for row in rows[:128]:
                        item=dict(row);settings=json.loads(item.pop('settings'))
                        listed.append({**item,'paused':self.paused(db,row),'work_model_pending':bool(settings.get('work_model_pending')),'bootstrap_model_selection':settings.get('bootstrap_model_selection'),'preparation_result':preparation.summary(db,row['page_id'])})
                    result={'pages':listed,'has_more':len(rows)>128,'next_after':rows[min(127,len(rows)-1)]['cursor'] if rows else after}
                else:raise ValueError('managed_operation_unknown')
            if op not in ('context','pages','first-task'):
                db.execute('INSERT INTO managed_receipts VALUES(?,?,?,?)',(key,target,fp,canonical(result)))
            db.commit();return result
    def receive_tool_attempt(self,db,page,b,attempt_id,git_probe=None):
        # The exact real Workflow Session echoes the unique marker supplied in
        # its dispatched prompt. This is a tool receipt, not a fabricated DOM
        # hash. Public browser confirmation is still required for result capture.
        require(page['phase']=='bound','managed_page_not_ready',409)
        a=self.control.attempt(db,{**dict(page),'generation':1},attempt_id)
        require(not db.execute('SELECT 1 FROM managed_partial_public_sends WHERE attempt_id=?',
                               (attempt_id,)).fetchone(),
                'managed_partial_public_attempt_unresolved',409)
        prepared=db.execute('SELECT * FROM managed_dispatches WHERE attempt_id=?',(attempt_id,)).fetchone()
        require(prepared and a['state'] in ('dispatching','sent','unknown','acknowledged'),'managed_no_prepared_send',409)
        require(self.receipt_collection_allowed(db,page),'managed_page_not_ready',409)
        r=self.control.original(db,b,a['request_id'])
        require(not r['cancel_requested'] and r['phase'] in ('queued','processing','suspended'),'host_claim_not_current',409)
        receipt=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(attempt_id,)).fetchone()
        if receipt:
            require(receipt['result_hash'] is None,'managed_received_attempt_stale',409);return
        require(a['state']!='acknowledged','managed_original_receipt_missing',409)
        require(self.control.epoch(db,r)==a['epoch'] if a['epoch']>=0 else r['phase']=='processing','control_request_epoch_changed',409)
        claim=self.host.browser_claim(db,b,r,attempt_id,git_probe=git_probe)
        db.execute("UPDATE control_attempts SET state='acknowledged',acknowledged=? WHERE id=?",(self.host.clock(),attempt_id))
        db.execute('INSERT INTO managed_tool_received VALUES(?,?)',(attempt_id,self.host.clock()))
        db.execute('INSERT INTO control_browser_receipts VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL)',(attempt_id,r['id'],b['thread_id'],claim,'',prepared['assistant_before_hash']))
        db.execute('DELETE FROM host_unread_notes WHERE request_id=? AND note_id IN (SELECT note_id FROM control_browser_note_receipts WHERE attempt_id=?)',(r['id'],attempt_id))
        self.host.emit(db,b['thread_id'],'control_received',{'request_id':r['id'],'attempt_id':attempt_id,'source':'own_session_exact_attempt','browser_confirmation_pending':True,'task_completed':False})
        self.open_run_in_transaction(db,page,git_probe=git_probe,accepted_attempt=attempt_id)
    def enroll(self,db,page,session,p):
        object_fields(p,{'ticket','project','root'})
        require(SESSION.fullmatch(session or ''),'team_receiver_session_invalid')
        require(isinstance(p['ticket'],str) and digest(p['ticket'])==page['ticket_hash'],'managed_ticket_invalid',403)
        require(page['phase']=='reserved' and not page['thread_id'],'managed_already_enrolled',409)
        require(plain_root(p['root'])==page['root'],'managed_root_changed',403)
        text(p['project'],'project',512)
        source=db.execute('SELECT b.spec FROM managed_handoffs h JOIN host_bindings b ON b.thread_id=h.source_thread WHERE h.successor_page=?',(page['page_id'],)).fetchone()
        require(not source or json.loads(source[0])['project']==p['project'],'managed_handoff_project_changed',409)
        require(not db.execute('SELECT 1 FROM threads WHERE native_id=?',('mcp-host/'+session,)).fetchone(),'host_session_already_bound_no_reparent',409)
        parent=self.host.binding(db,target=page['parent_target']) if page['parent_target'] else None
        thread='hthr_'+uuid.uuid4().hex;at=stamp();spec={'id':page['target_id'],'title':page['title'],'session_id':session,'project':p['project']}
        if parent:spec['parent_target_id']=parent['target_id']
        db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(thread,'chatgpt_web_host','mcp-host/'+session,parent['thread_id'] if parent else None,'ChatGPT Web · '+page['title'],page['root'],page['model'],page['effort'],'idle',None,at,at))
        db.execute('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,1)',(page['target_id'],thread,canonical(spec)))
        if parent:db.execute('INSERT INTO host_branches VALUES(?,?,?)',(page['target_id'],parent['target_id'],at))
        marker='CLW-MANAGED:'+page['page_id']+':'+secrets.token_hex(16)
        db.execute("UPDATE managed_pages SET thread_id=?,marker=?,phase='receiver_enrolled',seen=? WHERE page_id=?",(thread,marker,self.host.clock(),page['page_id']))
        settings=json.loads(page['settings']);b=self.host.binding(db,thread=thread)
        self.host.team.scopes.grant(db,parent or b,{'target':page['target_id'],'project':p['project'],'root':page['root'],'access':settings['access'],'write_paths':settings['write_paths'],'resources':settings['resources'],'confirm':True})
        self.host.emit(db,thread,'managed_enrolled',{'page_id':page['page_id'],'session_id':session,'account_attested':False})
        if settings.get('first_turn_instructions'):
            self.host.emit(db,thread,'managed_first_task_requested' if settings.get('first_turn_mode')==first_task.MODE else 'managed_preparation_requested',{'text':settings['first_turn_instructions'],'model_selection':settings.get('bootstrap_model_selection'),'source':'enrollment_turn'})
        current=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page['page_id'],)).fetchone()
        initial=first_task.register(self,db,current,b)
        return {'browser_marker':marker,'target':page['target_id'],'thread_id':thread,'state':'receiver_enrolled','first_task':initial}
    def browser(self,op,p):
        reads={'record-history','record-index','record-body','prompt-preview','session-activity','list','pending-receipt','prepared','view','goal-read','next-round-read','budget-continuation','model-change-check','carrier-recovery-check','bootstrap-query-reset-check'}
        read_only=op in ('record-history','record-index','record-body') or (self.host.maintenance_exit_fence is not None and op in reads)
        with self.host.business_admission(read_only=read_only):return self._browser(op,p)
    def _browser(self,op,p):
        """Called by the supervised stdin pipe, never an HTTP browser endpoint."""
        if op in ('record-history','record-index','record-body'):
            return browser_record(self.state,op,p)
        if op=='bootstrap-query-reset-check':
            object_fields(p,{'page_id'})
            from harness_bootstrap_query_reset import candidate
            with closing(self.state.connect()) as db:
                db.execute('BEGIN')
                return candidate(self,db,p['page_id'])
        if op=='carrier-recovery-check':
            object_fields(p,{'page_id'})
            with closing(self.state.connect()) as db:
                return carrier_recovery.candidate(self,db,p['page_id'])
        if op=='recover-ended-turn':
            object_fields(p,{'page_id','attempt_id','browser'})
            return ended_recovery.recover(self,p)
        if op=='reconcile-attention':
            object_fields(p,{'page_id','operation_id','payload'})
            with self.host.lock:
                with closing(self.state.connect()) as db:
                    page=db.execute('SELECT thread_id,parent_target FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                    require(page and page['thread_id'],'managed_maintenance_controller_required',409)
                    actor=page['thread_id']
                    if page['parent_target']:
                        require(isinstance(p['payload'],dict),'managed_reconcile_request_changed',409)
                        latest=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
                                          (page['thread_id'],)).fetchone()
                        require(latest and latest['id']==p['payload'].get('request_id'),'managed_reconcile_request_changed',409)
                        run=self.host.team.run_for_request(db,latest['id'])
                        require(run and run['id']==p['payload'].get('run_id') and run['controller_thread']!=page['thread_id'],
                                'managed_reconcile_run_changed',409)
                        actor=run['controller_thread']
                return self.host.team.public_command(actor,p['operation_id'],'reconcile-attention',p['payload'])
        if op=='prompt-preview':
            object_fields(p,{'page_id'},{'root','account','instructions','draft','first_turn_instructions','conversation_mode'})
            require(p.get('conversation_mode','managed') in ('direct','managed'),'managed_preview_mode')
            with closing(self.state.connect()) as db:
                page=db.execute('SELECT root,thread_id,effort,bootstrap_text,settings FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                settings=json.loads(page['settings']) if page else {}
                mode=settings.get('conversation_mode','managed') if page else p.get('conversation_mode','managed')
                if mode=='direct':
                    first=db.execute('SELECT id,text FROM host_requests WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1',
                                     (page['thread_id'],)).fetchone() if page else None
                    if first:
                        message=first['text'];goal_hint=goal_result_guidance(db,page['thread_id'],first['id'])
                    else:
                        message=settings.get('first_turn_instructions') or p.get('first_turn_instructions') or p.get('instructions',p.get('draft',''))
                        goal_hint=''
                    require(isinstance(message,str),'managed_preview_instructions')
                    if not page:
                        require(p.get('account') in ('A','B') and isinstance(p.get('root',''),str),'managed_preview_scope')
                    project=page['root'] if page else plain_root(p['root']) if p.get('root') else None
                    preview=work_message('\n\n'.join(x for x in (message,goal_hint) if x),project=project or None,first=True)
                    return {'source':'saved_direct_message' if first else 'direct_message_preview','conversation_mode':'direct',
                            'blocks':[{'title':'首次工作消息','text':preview}],
                            'effort':page['effort'] if page else None,'model_sends':0}
            if page:
                saved=re.sub(r'clwm_[A-Za-z0-9_-]{43}', '<接入凭据已隐藏>', page['bootstrap_text'])
                saved=re.sub(r'--(?:store-id|target)\s+\S+', '--identity <本机身份已隐藏>', saved)
                return {'source':'saved_enrollment_message','blocks':[{'title':'首次发送的完整消息（凭据已隐藏）','text':saved}],
                        'effort':json.loads(page['settings']).get('bootstrap_model_selection',{}).get('effort')}
            require(p.get('account') in ('A','B') and isinstance(p.get('root'),str),'managed_preview_scope')
            instructions=preparation.instructions({'first_turn_instructions':p.get('instructions','')})
            blocks=enrollment_blocks(root=plain_root(p['root']) if p['root'] else '<发送时创建的独立工作区>',account=p['account'],instructions=instructions,
                cli=str(self.host.root/'scripts/harness_managed_client.py'),store_id='<发送时填入>',target='<发送时填入>',ticket='<发送时生成>')
            return {'source':'enrollment_message_preview','blocks':blocks,'model_sends':0}
        if op=='session-activity':
            # Read-only and outside the shared write transaction: the rotating
            # connector journal must never delay a claim or browser receipt.
            object_fields(p,{'page_id'})
            with closing(self.state.connect()) as db:
                page=db.execute('SELECT phase,thread_id,target_id,settings,created FROM managed_pages WHERE page_id=?',
                                (p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404)
                available=page['phase'] in ('receiver_enrolled','bound') and json.loads(page['settings']).get('account','B') in ('A','B')
                bound=db.execute('SELECT spec FROM host_bindings WHERE thread_id=? AND target_id=?',
                                 (page['thread_id'],page['target_id'])).fetchone() if available else None
                session=json.loads(bound['spec']).get('session_id') if bound else None
                created=page['created']
            activity=session_activity(self.host.root,session,created)
            if not session:activity['scope']='not_available'
            return activity
        if op=='maintenance':
            object_fields(p,{'page_id','operation_id','action'},{'checkpoint_hash','expected_run_id','expected_revision'})
            require(p['action'] in ('quiesce','resume-maintenance'),'managed_maintenance_action')
            with closing(self.state.connect()) as db:
                page=db.execute('SELECT thread_id,parent_target FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and not page['parent_target'],'managed_maintenance_controller_required',409)
                run=db.execute('SELECT id FROM host_runs WHERE controller_thread=? ORDER BY created DESC LIMIT 1',(page['thread_id'],)).fetchone()
                require(run,'team_run_missing',404)
                if 'expected_run_id' in p:require(run['id']==p['expected_run_id'],'team_maintenance_run_changed',409)
            payload={'run_id':run['id'],'confirm':True}
            if p['action']=='quiesce':payload['reason']='operator_graceful_maintenance'
            else:
                if 'checkpoint_hash' in p:payload['checkpoint_hash']=p['checkpoint_hash']
                if 'expected_revision' in p:payload['expected_revision']=p['expected_revision']
            return self.host.team.public_command(page['thread_id'],p['operation_id'],p['action'],payload)
        if op=='wire':
            pageid=p['page_id'];data=dict(p['data']);public_failure=data.pop('public_failure',None)
            with closing(self.state.connect()) as db:
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(pageid,)).fetchone()
                require(page,'managed_page_missing',404)
            if public_failure is not None:
                require(data['action']=='pulse','managed_failed_turn_observation_action')
                with self.host.lock,closing(self.state.connect()) as db:
                    db.execute('BEGIN IMMEDIATE')
                    recovery.reconcile_failed_identity(self,db,pageid,data['page'],public_failure)
                    db.commit()
            result=self.control.process(PROTOCOL,None,{'generation':1,'chat_url':page['url'],'tab_nonce':pageid,**data})
            if data['action']=='sent':self.open_run(pageid)
            return result
        if op=='retire-partial':
            # A local network probe can take seconds on a slow host. Keep it
            # outside the shared SQLite write transaction; the transaction
            # below still rechecks the exact original request and public turn.
            from native_work_admission import AdmissionError,zero_local_jobs
            try:require(zero_local_jobs(self.host.root) is True,
                        'managed_partial_retirement_external_jobs_not_idle',409)
            except (AdmissionError,OSError,ValueError):
                require(False,'managed_partial_retirement_external_jobs_not_idle',409)
        with self.host.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            if op=='list':
                if self.host.maintenance_exit_fence is None:
                    recovery.reconcile_closed_attention(self,db)
                    for held in db.execute("SELECT run_id FROM host_team_maintenance WHERE state='holding'").fetchall():self.host.team.maintenance.reconcile(db,held['run_id'])
                    self.handoffs.reconcile(db)
                    self.text.reconcile(db)
                    self.reconcile_page_waits(db)
                pages=[];lifecycle_context=renderer_lifecycle_context(db)
                for row in db.execute('SELECT page_id,target_id,thread_id,parent_target,root,title,model,effort,url,phase,paused,bootstrap_state,bootstrap_text,marker,settings FROM managed_pages ORDER BY created'):
                    paused=self.paused(db,row)
                    active=bool(not paused and db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') AND cancel_requested=0 LIMIT 1",(row['thread_id'],)).fetchone())
                    attention=db.execute('SELECT a.reason FROM managed_attention a JOIN host_requests r ON r.id=a.request_id WHERE r.thread_id=? ORDER BY r.created_at DESC LIMIT 1',(row['thread_id'],)).fetchone()
                    issue=db.execute('SELECT detail,kind FROM managed_page_issues WHERE page_id=?',(row['page_id'],)).fetchone()
                    successor=db.execute("SELECT successor_page,state FROM managed_handoffs WHERE source_page=? AND state IN ('enrolling','active')",(row['page_id'],)).fetchone()
                    settings=json.loads(row['settings'])
                    stopped=db.execute('SELECT user_hash,resumed FROM managed_stops WHERE page_id=?',(row['page_id'],)).fetchone()
                    pages.append({**dict(row),'paused':paused,'own_paused':bool(row['paused']),'account':settings.get('account','B'),'collaboration_protocol':collaboration_mode(settings),'observed_stop_user_hash':stopped[0] if stopped else None,'resumed_stop_user_hash':stopped[0] if stopped and stopped[1] else None,'successor':successor[0] if successor else None,'attention':attention[0] if attention else issue[0] if issue else None,'issue_kind':issue['kind'] if issue else None,'active_work':active,'model_selection':settings.get('model_selection'),'bootstrap_model_selection':settings.get('bootstrap_model_selection'),'work_model_pending':bool(settings.get('work_model_pending')),'access':settings.get('access','read'),'write_paths':settings.get('write_paths',[]),'duration_seconds':settings.get('duration_seconds'),'max_dispatches':settings.get('max_dispatches')})
                    pages[-1]['intake']=self.intake.view(db,row)
                    pages[-1]['conversation_mode']=settings.get('conversation_mode','managed')
                    pages[-1]['collaboration_enabled']=settings.get('collaboration_enabled',True)
                    pages[-1]['first_turn_instructions']=settings.get('first_turn_instructions','')
                    pages[-1]['first_turn_mode']=settings.get('first_turn_mode','prepare_v1')
                    pages[-1]['bootstrap_wait']=first_task.bootstrap_wait(self,db,row)
                    pages[-1]['preparation_result']=preparation.summary(db,row['page_id'])
                    pages[-1]['latest_request']=latest_request(db,row['thread_id'])
                    latest=pages[-1]['latest_request']
                    # Use the exact attempt selected with the public request;
                    # an independent ordering could select a tied older offer.
                    attempt=db.execute('SELECT id,state,dispatched,acknowledged FROM control_attempts WHERE id=? AND request_id=?',
                        (latest['attempt_id'],latest['id'])).fetchone() if latest and latest['attempt_id'] else None
                    pages[-1]['attempt']=dict(attempt) if attempt else None
                    pages[-1]['carrier_recovery']=carrier_recovery.projection(row)
                    pages[-1]['renderer_lifecycle']=project_lifecycle(db,row,pages[-1]['latest_request'],lifecycle_context)
                    pages[-1]['successor_state']=successor['state'] if successor else None
                    pages[-1]['stop_scope']=stop_scope(db,row,pages[-1]['latest_request'])
                    pages[-1]['ended_recovery']=ended_recovery.public_state(db,pages[-1]['latest_request']['id'] if pages[-1]['latest_request'] else None)
                    pages[-1]['pause_origin']=self.pause_origin(db,row)
                    pages[-1]['receipt_collection_allowed']=self.receipt_collection_allowed(db,row)
                    pages[-1]['maintenance']=self.host.team.maintenance.for_page(db,row['page_id'])
                    pages[-1]['budget_status']=budget.status(db,row,self.host.team)
                    pages[-1]['goal']=goal_control.view(db,row,self.host.team,summary=True)
                    if pages[-1]['maintenance'] and row['phase']!='bound' and row['bootstrap_state']=='pending':pages[-1]['paused']=True
                result={'protocol':PROTOCOL,'store_id':self.state.id,'pages':pages}
            elif op=='recover-empty-carrier':
                result=carrier_recovery.prepare(self,db,p)
            elif op=='bind-recovered-carrier':
                result=carrier_recovery.bind(self,db,p)
            elif op=='hold-legacy':
                targets=p.get('targets');require(isinstance(targets,list) and targets and len(set(targets))==len(targets),'managed_legacy_targets')
                rows=[]
                for target in targets:
                    b=db.execute('SELECT thread_id FROM host_bindings WHERE target_id=?',(target,)).fetchone()
                    require(b and not db.execute('SELECT 1 FROM managed_pages WHERE thread_id=?',(b[0],)).fetchone(),'managed_legacy_target_required',409)
                    require(self.legacy_quiet(db,b[0]),'managed_legacy_execution_not_quiescent',409);rows.append((b[0],target))
                for thread,target in rows:
                    db.execute('INSERT OR IGNORE INTO managed_legacy_holds VALUES(?,?,?)',(thread,target,self.host.clock()))
                    db.execute('UPDATE host_bindings SET enabled=0 WHERE thread_id=?',(thread,))
                result={'held':targets,'original_requests_and_claims_preserved':True,'executions_cancelled':False}
            elif op=='pending-receipt':
                object_fields(p,{'page_id','url'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['phase']=='bound' and page['url']==p['url'],
                        'managed_page_identity_changed',409)
                # This read never creates an offer, a recovery, or a new claim.
                pending=db.execute("SELECT br.* FROM control_browser_receipts br JOIN control_attempts a ON a.id=br.attempt_id JOIN host_requests r ON r.id=br.request_id WHERE br.thread_id=? AND a.generation=1 AND br.result_hash IS NULL AND r.phase IN ('processing','suspended') ORDER BY a.acknowledged DESC LIMIT 1",(page['thread_id'],)).fetchone()
                if pending:
                    result={'state':'browser_result_pending' if pending['sent_user_hash'] else 'model_received_browser_confirmation_pending',
                            'attempt_id':pending['attempt_id'],'sent_user_hash':pending['sent_user_hash'],
                            'assistant_before_hash':pending['assistant_before_hash'],'dispatch':False}
                else:
                    unknown=db.execute("SELECT a.id,a.state FROM control_attempts a JOIN host_requests r ON r.id=a.request_id WHERE a.thread_id=? AND a.state IN ('dispatching','sent','unknown') AND r.phase IN ('queued','processing','suspended') ORDER BY a.offered DESC LIMIT 1",(page['thread_id'],)).fetchone()
                    result={'state':'original_attempt_requires_reconciliation','attempt_id':unknown['id'],'attempt_state':unknown['state'],'dispatch':False} if unknown else {'state':'paused_no_pending_receipt','dispatch':False}
            elif op=='prepare':
                a=db.execute('SELECT a.id FROM control_attempts a JOIN managed_pages p ON p.thread_id=a.thread_id WHERE a.id=? AND p.page_id=?',(p['attempt_id'],p['page_id'])).fetchone()
                require(a,'managed_attempt_missing')
                require(re.fullmatch('[0-9a-f]{64}',p['assistant_before_hash']) and re.fullmatch('[0-9a-f]{64}',p['prompt_hash']),'managed_prepare_digest')
                old=db.execute('SELECT * FROM managed_dispatches WHERE attempt_id=?',(p['attempt_id'],)).fetchone()
                require(not old or (old['assistant_before_hash']==p['assistant_before_hash'] and old['prompt_hash']==p['prompt_hash']),'managed_prepare_conflict',409)
                db.execute('INSERT OR IGNORE INTO managed_dispatches VALUES(?,?,?)',(p['attempt_id'],p['assistant_before_hash'],p['prompt_hash']));result={'prepared':True}
            elif op=='prepared':
                row=db.execute('SELECT d.*,a.user_hash AS previous_user_hash FROM managed_dispatches d JOIN control_attempts a ON a.id=d.attempt_id JOIN managed_pages p ON p.thread_id=a.thread_id WHERE d.attempt_id=? AND p.page_id=?',(p['attempt_id'],p['page_id'])).fetchone()
                require(row,'managed_original_send_baseline_missing',409);result=dict(row)
            elif op=='reconcile-send-preparation':
                result=send_preparation.authorize(self,db,p)
            elif op=='partial-public-send':
                result=self.partial_public_send(db,p)
            elif op=='first-task-failed':
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404)
                result=first_task.fail(self,db,page,p)
            elif op=='reconcile-user':
                # Process-private DOM observation; never exposed as a model tool.
                # Replace only the browser observation, not the execution identity.
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['phase']=='bound' and page['url']==p['url'],'managed_page_identity_changed',409)
                a=self.control.attempt(db,{**dict(page),'generation':1},p['attempt_id'])
                receipt=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(a['id'],)).fetchone()
                require(receipt and a['state']=='acknowledged' and not receipt['result_hash'],'managed_original_receipt_not_pending',409)
                require(p['marker']==f'[CLW:{a["id"]}]' and type(p['marker_count']) is int and p['marker_count']==1,'managed_original_marker_required',409)
                require(re.fullmatch('[0-9a-f]{64}',p['user_hash']) and p['user_hash']!=p['previous_user_hash'],'managed_changed_user_digest_required',409)
                require(receipt['sent_user_hash']==p['previous_user_hash'],'managed_browser_identity_conflict',409)
                tool_outcome=db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(a['id'],)).fetchone()
                r=db.execute('SELECT * FROM host_requests WHERE id=?',(receipt['request_id'],)).fetchone()
                require(r and r['phase'] in ('processing','suspended') and not r['cancel_requested'] and r['claim_id']==receipt['claim_id'],'host_claim_not_current',409)
                text_protocol=collaboration_mode(json.loads(page['settings']))==TEXT_V1
                wait_receipt=recovery.original_wait_receipt(db,r,a)
                terminal_failure=p.get('terminal_failure','')
                if terminal_failure:
                    require(terminal_failure in ('Thinking failed','思考失败','无法思考','Something went wrong while generating the response.','生成回复时出错')
                            and p.get('history_at_latest') is True and r['phase']=='processing'
                            and db.execute('SELECT 1 FROM managed_dispatches WHERE attempt_id=?',(a['id'],)).fetchone(),
                            'managed_terminal_failure_identity_unverified',409)
                elif text_protocol and not tool_outcome:
                    prepared=db.execute('SELECT 1 FROM managed_dispatches WHERE attempt_id=?',(a['id'],)).fetchone()
                    require(prepared and p.get('complete') is True and p.get('history_at_latest') is True
                            and isinstance(p.get('assistant_turn_hash'),str)
                            and re.fullmatch('[0-9a-f]{64}',p['assistant_turn_hash'])
                            and p['assistant_turn_hash']!=receipt['assistant_before_hash'],
                            'managed_text_public_identity_unverified',409)
                elif not tool_outcome and not wait_receipt:
                    db.execute('INSERT OR IGNORE INTO managed_unverified_identities VALUES(?,?,?,?)',(a['id'],p['previous_user_hash'],p['user_hash'],stamp()))
                proof='unique_public_marker_and_terminal_failure' if terminal_failure else 'unique_public_marker_and_tool_outcome' if tool_outcome else 'original_authenticated_wait_receipt' if wait_receipt else 'verified_text_v1_public_turn' if text_protocol else 'unique_public_marker_attention_only'
                self.host.emit(db,page['thread_id'],'managed_browser_identity_reconciled',{'request_id':r['id'],'attempt_id':a['id'],'previous_user_hash':p['previous_user_hash'],'user_hash':p['user_hash'],'proof':proof,'request_replayed':False})
                db.execute('UPDATE control_browser_receipts SET sent_user_hash=? WHERE attempt_id=?',(p['user_hash'],a['id']))
                result={'state':'original_browser_identity_reconciled','request_replayed':False,'attention_only':not bool(tool_outcome or text_protocol or wait_receipt)}
            elif op=='view':
                object_fields(p,{'page_id'},{'record_summaries'})
                require(type(p.get('record_summaries',False)) is bool,'managed_record_summaries_invalid')
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone();require(page,'managed_page_missing',404)
                result=project_view(db,page,self.host.team,record_summaries=p.get('record_summaries',False))
                result['pause_origin']=self.pause_origin(db,page)
                result['renderer_lifecycle']=project_lifecycle(db,page,result['latest_request'])
                result['reconciliation']=recovery.current(db,self.host.team,page['thread_id'])
            elif op=='refill-budget':result=budget.refill(self,db,p)
            elif op=='goal-read':
                object_fields(p,{'page_id'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and not page['parent_target'],'managed_goal_controller_required',409)
                result={'goal':goal_control.view(db,page,self.host.team),'model_sends':0}
            elif op=='goal-save':result=goal_control.save(self,db,p)
            elif op=='goal-stop':result=goal_control.stop(self,db,p)
            elif op=='goal-review':result=goal_control.review(self,db,p)
            elif op=='goal-next':result=goal_control.prepare_next(self,db,p)
            elif op=='goal-discard':result=goal_control.discard(self,db,p)
            elif op=='budget-continuation':result=budget.continuation(self,db,p['page_id'],p['expected_run_id'])
            elif op=='withdraw':
                result=operator_actions.withdraw(self.host,db,p)
            elif op=='retire-partial':
                result=operator_actions.retire_partial(self,db,p,local_jobs_verified=True)
            elif op=='model-change-check':
                object_fields(p,{'page_id','expected_model','expected_effort'})
                operator_actions.check_model_change(db,p,label)
                result={'ready':True,'model_sends':0}
            elif op=='configure-model':
                object_fields(p,{'page_id','model','effort','model_selection','expected_model','expected_effort'})
                page=operator_actions.check_model_change(db,p,label)
                model,effort=label(p['model']),label(p['effort']);selection=p['model_selection']
                require(isinstance(selection,dict) and label(selection.get('model',''))==model and label(selection.get('effort',''))==effort,'managed_model_observation_mismatch',409)
                settings=json.loads(page['settings']);settings['model_selection']=selection;settings['work_model_pending']=False
                db.execute('UPDATE managed_pages SET model=?,effort=?,settings=? WHERE page_id=?',(model,effort,canonical(settings),p['page_id']))
                db.execute('UPDATE threads SET model=?,effort=?,updated_at=? WHERE id=?',(model,effort,stamp(),page['thread_id']))
                db.execute("DELETE FROM managed_page_issues WHERE page_id=? AND kind='model_mismatch'",(p['page_id'],))
                self.host.emit(db,page['thread_id'],'managed_model_changed',{'model':model,'effort':effort,'previous_model':page['model'],'previous_effort':page['effort'],'scope':'future_turns_and_new_workers','paused_preserved':True})
                result={'model':model,'effort':effort,'paused':self.paused(db,page),'existing_workers_changed':False}
            elif op in ('bootstrap-model-ready','work-model-ready'):
                object_fields(p,{'page_id','model_selection'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404);settings=json.loads(page['settings'])
                if op=='bootstrap-model-ready':
                    require(page['phase']=='reserved' and page['bootstrap_state']=='pending','managed_worker_model_already_sent',409)
                    require(isinstance(p['model_selection'],dict),'managed_model_observation_mismatch',409)
                    require(not re.search(r'\bpro\b',str(p['model_selection'].get('model',''))+' '+str(p['model_selection'].get('effort','')),re.I)
                            or bool(settings.get('first_turn_instructions','').strip()),
                            'managed_pro_enrollment_not_allowed_use_extra_high',409)
                    model,effort=accept_bootstrap_observed(page,settings,p['model_selection'])
                    settings['bootstrap_model_selection']=p['model_selection']
                    settings['bootstrap_model_verified']=True
                    if not settings.get('work_model_pending'):
                        accept_observed(page,p['model_selection'])
                        settings['model_selection']=p['model_selection']
                        db.execute('UPDATE managed_pages SET model=?,effort=? WHERE page_id=?',(model,effort,p['page_id']))
                else:
                    require(page['phase']=='bound' and settings.get('work_model_pending') and not self.paused(db,page),'managed_work_model_not_pending',409)
                    require(not db.execute('SELECT 1 FROM control_attempts WHERE thread_id=? AND dispatched IS NOT NULL',(page['thread_id'],)).fetchone(),'managed_original_send_unconfirmed',409)
                    model,effort=accept_observed(page,p['model_selection'])
                    settings['work_model_pending']=False;settings['model_selection']=p['model_selection']
                    db.execute('UPDATE managed_pages SET model=?,effort=? WHERE page_id=?',(model,effort,p['page_id']))
                    db.execute('UPDATE threads SET model=?,effort=?,updated_at=? WHERE id=?',(model,effort,stamp(),page['thread_id']))
                db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),p['page_id']))
                self.reconcile_page_waits(db)
                result={'model':model,'effort':effort,'verified':True,'phase':'bootstrap' if op=='bootstrap-model-ready' else 'work','model_sends':0}
            elif op=='worker-model-ready':
                object_fields(p,{'page_id','model_selection'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['parent_target'] and page['phase']=='reserved' and page['bootstrap_state']=='pending','managed_worker_model_already_sent',409)
                model,effort=accept_observed(page,p['model_selection'])
                settings=json.loads(page['settings'])
                settings.setdefault('requested_model',page['model']);settings.setdefault('requested_effort',page['effort'])
                settings['model_selection']=p['model_selection']
                db.execute('UPDATE managed_pages SET model=?,effort=?,settings=? WHERE page_id=?',(model,effort,canonical(settings),p['page_id']))
                result={'model':model,'effort':effort,'verified':True}
            elif op=='register-direct':result=self.register_direct(db,p)
            elif op=='bind-direct':
                object_fields(p,{'page_id','url'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['phase']=='bound' and json.loads(page['settings']).get('conversation_mode')=='direct','managed_direct_page_required',409)
                require(re.fullmatch(r'https://chatgpt.com/c/[0-9a-f-]+',p['url']),'managed_exact_chat_required')
                require(page['url'] in ('https://chatgpt.com/',p['url']),'managed_page_identity_changed',409)
                db.execute('UPDATE managed_pages SET url=?,seen=? WHERE page_id=?',(p['url'],self.host.clock(),p['page_id']))
                result={'state':'bound','conversation_mode':'direct','url':p['url'],'model_sends':0}
            elif op=='next-round-read':
                object_fields(p,{'page_id'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404);result=next_round.pending(db,page)
            elif op=='next-round-prepare':
                object_fields(p,{'page_id'},{'goal_followup'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404)
                result={'state':'next_round_prepared','batch':next_round.prepare(self.host,db,page,p.get('goal_followup','')),'model_sends':0}
            elif op=='reserve':result=self.reserve(db,p)
            elif op=='stop-observed':
                object_fields(p,{'page_id','url','user_hash','turn_hash','generating','observed_stopped','stop_clicked'})
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['phase']=='bound' and p['url']==page['url'],'managed_stop_page_changed',409)
                require(p['generating'] is False and (p['observed_stopped'] is True or p['stop_clicked'] is True),'managed_stop_not_observed',409)
                require(all(isinstance(p[k],str) and re.fullmatch('[0-9a-f]{64}',p[k]) for k in ('user_hash','turn_hash')),'managed_stop_identity')
                prior=db.execute('SELECT * FROM managed_stops WHERE page_id=?',(p['page_id'],)).fetchone()
                if prior and prior['user_hash']==p['user_hash']:
                    result={'state':'stop_already_observed','local_execution_stopped':False}
                else:
                    receipt=db.execute('SELECT br.* FROM control_browser_receipts br JOIN control_attempts a ON a.id=br.attempt_id WHERE a.thread_id=? AND br.result_hash IS NULL ORDER BY a.acknowledged DESC LIMIT 1',(page['thread_id'],)).fetchone()
                    if receipt:
                        require(receipt['sent_user_hash']==p['user_hash'],'managed_stop_original_turn_mismatch',409)
                        a=db.execute('SELECT * FROM control_attempts WHERE id=?',(receipt['attempt_id'],)).fetchone()
                        b=self.host.binding(db,thread=page['thread_id']);r=self.control.original(db,b,receipt['request_id'])
                        reason='网页生成已按用户要求停止。业务任务与原 Job 保留，尚未证明本地执行停止。明确恢复后先核对原回执，不重放已接受命令。'
                        data={'text':reason,'assistant_turn_hash':p['turn_hash']}
                        result=self.control.attention_reply(db,b,r,receipt,a,data)
                        db.execute('UPDATE control_browser_receipts SET result_turn_hash=?,result_hash=?,reply_id=?,completed=? WHERE attempt_id=?',(p['turn_hash'],digest(reason),result['reply_id'],self.host.clock(),a['id']))
                    db.execute('INSERT OR REPLACE INTO managed_stops VALUES(?,?,?,0)',(p['page_id'],p['user_hash'],p['turn_hash']))
                    db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(p['page_id'],))
                    result={'state':'browser_stop_observed','original_claim_preserved':True,'local_execution_stopped':False}
            elif op=='intake-observed':
                result=self.intake.observe(db,p)
            elif op=='configure-write-scope':
                result=managed_scope.narrow(self,db,p)
            elif op=='configure-intake':
                result=self.intake.configure(db,p)
            elif op=='page-issue':
                require(p['kind'] in ('bootstrap_failed','bootstrap_receipt_missing','login_required','usage_limit','user_stopped','model_mismatch','model_unavailable','preparation_required','control_failed'),'managed_page_issue_kind')
                detail=text(p['detail'],'detail',4000)
                issue_page=db.execute('SELECT paused FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(issue_page,'managed_page_missing',404)
                db.execute('INSERT OR REPLACE INTO managed_page_issues VALUES(?,?,?)',(p['page_id'],p['kind'],detail))
                if not issue_page['paused']:
                    db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'page_issue',NULL)",(p['page_id'],))
                db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(p['page_id'],))
                self.reconcile_page_waits(db);result={'state':'needs_attention','no_send_replayed':True}
            elif op=='bootstrap':
                require(p['state'] in ('sending','sent','unknown'),'managed_bootstrap_state')
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page,'managed_page_missing',404)
                require(p['state']!='sending' or page['bootstrap_state']=='pending','managed_bootstrap_no_blind_retry',409)
                if p['state']=='sending':
                    require(not self.host.team.maintenance.for_page(db,page['page_id']),'team_maintenance_no_new_dispatch',409)
                    require(page['phase']=='reserved','managed_bootstrap_wait_for_original_turn',409)
                    require(not self.paused(db,page),'managed_parent_paused',409)
                    require(not first_task.bootstrap_wait(self,db,page),'managed_bootstrap_waiting_local_slot',409)
                    parent=db.execute('SELECT b.thread_id FROM managed_pages p JOIN host_bindings b ON b.target_id=p.parent_target WHERE p.page_id=?',(p['page_id'],)).fetchone()
                    handoff=db.execute("SELECT * FROM managed_handoffs WHERE successor_page=? AND state='enrolling'",(p['page_id'],)).fetchone()
                    if handoff:
                        run=db.execute('SELECT * FROM host_runs WHERE id=?',(handoff['run_id'],)).fetchone()
                        require(run and run['state']=='paused' and run['reason']=='context_handoff' and deadline_live(run,self.host.clock()) and sends_available(run,1,2),'managed_handoff_original_budget_insufficient',409)
                        db.execute('INSERT INTO managed_bootstrap_budget VALUES(?,?)',(p['page_id'],run['id']))
                        db.execute('UPDATE host_runs SET dispatches=dispatches+1,revision=revision+1 WHERE id=?',(run['id'],))
                    elif parent:
                        run=db.execute("SELECT * FROM host_runs WHERE controller_thread=? AND state<>'closed' ORDER BY created DESC LIMIT 1",(parent[0],)).fetchone()
                        require(run and run['state']=='running' and deadline_live(run,self.host.clock()) and sends_available(run,1,1),'managed_bootstrap_budget_exhausted',409)
                        db.execute('INSERT INTO managed_bootstrap_budget VALUES(?,?)',(p['page_id'],run['id']))
                        db.execute('UPDATE host_runs SET dispatches=dispatches+1,revision=revision+1 WHERE id=?',(run['id'],))
                settings=json.loads(page['settings'])
                settings.setdefault('bootstrap_'+p['state']+'_at',self.host.clock())
                db.execute('UPDATE managed_pages SET bootstrap_state=?,settings=? WHERE page_id=?',(p['state'],canonical(settings),p['page_id']));result={'state':p['state']}
            elif op in ('bind','bind-first-turn'):
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                require(page and page['marker'],'managed_public_receipt_required',409)
                first_turn=op=='bind-first-turn'
                if first_turn:
                    first_task.reconcile_turn(self,db,page,p)
                    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                else:require(page['marker'] in p['public_text'],'managed_public_receipt_required',409)
                require(re.fullmatch(r'https://chatgpt.com/c/[A-Za-z0-9-]+',p['url']),'managed_conversation_url')
                require(page['phase'] in ('receiver_enrolled','bound') and (page['phase']!='bound' or p['url']==page['url']),'managed_binding_changed',409)
                preparation.save(self,db,page,p,verified_first_turn=first_turn)
                settings=json.loads(page['settings'])
                if settings.get('first_task_outcome')=='not_started':
                    db.execute("DELETE FROM managed_page_issues WHERE page_id=? AND kind='bootstrap_receipt_missing'",(p['page_id'],))
                else:
                    db.execute("DELETE FROM managed_page_issues WHERE page_id=? AND kind IN ('bootstrap_failed','bootstrap_receipt_missing')",(p['page_id'],))
                if first_task.enabled(page) and not settings.get('first_task_outcome'):
                    db.execute("INSERT OR REPLACE INTO managed_page_issues VALUES(?,'bootstrap_receipt_missing',?)",(page['page_id'],'首轮任务已结束网页回答，但缺少任务结果回执；保留原 request/claim 和本地执行，不重发首条消息。'))
                    db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(page['page_id'],))
                    db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'page_issue',NULL)",(page['page_id'],))
                db.execute("UPDATE managed_pages SET phase='bound',url=?,seen=? WHERE page_id=?",(p['url'],self.host.clock(),p['page_id']));result={'state':'bound'}
                # A verified receipt resolves only the earlier intake failure.
                # Keep the task pause and independent usage/model/stop issues.
                self.reconcile_page_waits(db)
            elif op=='pause':
                require(type(p['paused']) is bool,'managed_pause_value')
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone();require(page,'managed_page_missing',404)
                if 'expected_request_id' in p:
                    current=db.execute("SELECT id FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') ORDER BY created_at DESC LIMIT 1",(page['thread_id'],)).fetchone()
                    require((current[0] if current else None)==p['expected_request_id'],'managed_resume_request_changed',409)
                if not p['paused']:
                    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_page=? AND state IN ('enrolling','active')",(p['page_id'],)).fetchone(),'managed_resume_successor_instead',409)
                    budget.resume_operator(self,db,page)
                if not p['paused']:
                    if page['parent_target']:
                        require(self.pause_origin(db,page,include_self=False) is None,'managed_parent_paused_resume_parent_first',409)
                    repair_origin=('controller_pro_preparation_inherited_by_worker' if page['parent_target'] else
                                   'controller_pro_preparation_inherited_by_handoff' if self.handoffs.enrolling_successor(db,page) else None)
                    # Repair only the old, provably unsent setup inheritance
                    # bug on explicit resume. Sent/unknown turns and platform
                    # refusals must retain their original settings and receipt.
                    issue=db.execute('SELECT kind,detail FROM managed_page_issues WHERE page_id=?',(p['page_id'],)).fetchone()
                    settings=json.loads(page['settings'])
                    original=settings.get('bootstrap_model_selection') or {}
                    if (repair_origin and page['phase']=='reserved' and page['bootstrap_state']=='pending' and not page['thread_id']
                            and not first_task.enabled(page) and issue and issue['kind']=='preparation_required' and effort_key(original.get('effort'))=='pro'
                            and not re.search(r'\bpro\b',str(original.get('model','')),re.I)):
                        bootstrap=worker_enrollment_selection(settings,settings.get('model_selection'))
                        settings['bootstrap_model_selection']=bootstrap
                        settings['bootstrap_model_verified']=False
                        settings['work_model_pending']=(model_key(bootstrap['model'])!=model_key(page['model']) or effort_key(bootstrap['effort'])!=effort_key(page['effort']))
                        settings['enrollment_repair']={'previous_selection':original,'previous_issue':dict(issue),'at':self.host.clock(),'reason':repair_origin}
                        db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),p['page_id']))
                db.execute('UPDATE managed_pages SET paused=? WHERE page_id=?',(int(p['paused']),p['page_id']))
                if p['paused']:db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'operator',NULL)",(p['page_id'],))
                else:db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(p['page_id'],))
                if not p['paused']:db.execute('DELETE FROM managed_page_issues WHERE page_id=?',(p['page_id'],))
                if not p['paused']:db.execute('UPDATE managed_stops SET resumed=1 WHERE page_id=?',(p['page_id'],))
                resumed=self.resume_attention(db,page) if not p['paused'] else []
                retried=unsent_retry.authorize(self,db,page,p.get('expected_request_id')) if not p['paused'] else None
                result={'paused':p['paused'],'resumed_original_requests':resumed,'original_claims_preserved':True,
                        'known_unsent_original_attempt':retried}
            elif op=='pause-all':
                db.execute("INSERT OR REPLACE INTO managed_pause_owners SELECT page_id,'operator',NULL FROM managed_pages WHERE parent_target IS NULL")
                db.execute('UPDATE managed_pages SET paused=1 WHERE parent_target IS NULL');result={'paused':True,'original_claims_preserved':True}
            elif op=='artifact':
                require(isinstance(p['text'],str) and len(p['text'].encode())<=8*1024*1024,'managed_result_too_large')
                page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone();require(page and page['thread_id'],'managed_page_missing')
                a=db.execute('SELECT request_id FROM control_attempts WHERE id=? AND thread_id=?',(p['attempt_id'],page['thread_id'])).fetchone();require(a,'managed_attempt_missing')
                require(not db.execute('SELECT 1 FROM managed_partial_public_sends WHERE attempt_id=?',
                                       (p['attempt_id'],)).fetchone(),
                        'managed_partial_public_attempt_unresolved',409)
                if collaboration_mode(json.loads(page['settings']))==TEXT_V1:
                    turn_hash=p.get('assistant_turn_hash')
                    require(isinstance(turn_hash,str) and re.fullmatch('[0-9a-f]{64}',turn_hash),
                            'managed_text_artifact_turn_required',409)
                    previous=db.execute('SELECT assistant_turn_hash FROM managed_text_artifact_turns WHERE attempt_id=?',
                                        (p['attempt_id'],)).fetchone()
                    require(not previous or previous['assistant_turn_hash']==turn_hash,
                            'managed_text_artifact_turn_conflict',409)
                    db.execute('INSERT OR IGNORE INTO managed_text_artifact_turns VALUES(?,?)',
                               (p['attempt_id'],turn_hash))
                raw=p['text'].encode();sha=hashlib.sha256(raw).hexdigest();dest=self.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
                if not dest.exists():dest.write_bytes(raw)
                ident=p['attempt_id'];old=db.execute('SELECT sha256 FROM managed_artifacts WHERE id=?',(ident,)).fetchone();require(not old or old[0]==sha,'managed_result_conflict',409)
                db.execute('INSERT OR IGNORE INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',(ident,a[0],page['thread_id'],str(dest),sha,len(raw),'public_dom_markdown',self.host.clock()))
                result={'path':str(dest),'sha256':sha,'bytes':len(raw)}
            else:raise ValueError('managed_browser_operation')
            db.commit()
            if op=='goal-save' and result.get('goal',{}).get('mode')=='automatic':
                from harness_goal_watch import ensure_watcher
                ensure_watcher(self.host)
            return result
    def partial_public_send(self,db,p):
        # The renderer observed a completed public turn after an attempted Send,
        # but its visible user message is not the complete prepared CLW prompt.
        # This observation is evidence, never a browser receipt or proof that
        # the worker received the assigned task.
        object_fields(p,{'page_id','attempt_id','url','previous_user_hash','user_hash',
                         'assistant_before_hash','assistant_turn_hash','user_text',
                         'assistant_text','user_text_complete','complete',
                         'history_at_latest','generating','draft','composing'})
        require(all(type(p[k]) is bool for k in ('user_text_complete','complete',
                'history_at_latest','generating','draft','composing')),
                'managed_partial_public_flags',409)
        require(p['user_text_complete'] and p['complete'] and p['history_at_latest']
                and not any(p[k] for k in ('generating','draft','composing')),
                'managed_partial_public_turn_not_complete',409)
        require(all(isinstance(p[k],str) and re.fullmatch('[0-9a-f]{64}',p[k])
                    for k in ('previous_user_hash','user_hash','assistant_before_hash',
                              'assistant_turn_hash')),'managed_partial_public_identity',409)
        user_text=text(p['user_text'],'partial_user_text',512000)
        assistant_text=text(p['assistant_text'],'partial_assistant_text',48000)
        page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
        require(page and page['phase']=='bound' and page['url']==p['url']
                and page['parent_target'] and collaboration_mode(json.loads(page['settings']))==TEXT_V1,
                'managed_partial_public_page_mismatch',409)
        attempt=self.control.attempt(db,{**dict(page),'generation':1},p['attempt_id'])
        prepared=db.execute('SELECT * FROM managed_dispatches WHERE attempt_id=?',(attempt['id'],)).fetchone()
        require(prepared and attempt['dispatched'] is not None
                and attempt['state'] in ('dispatching','sent','unknown'),
                'managed_partial_public_dispatch_missing',409)
        require(attempt['user_hash']==p['previous_user_hash']
                and p['user_hash']!=attempt['user_hash']
                and prepared['assistant_before_hash']==p['assistant_before_hash']
                and p['assistant_turn_hash']!=prepared['assistant_before_hash'],
                'managed_partial_public_baseline_changed',409)
        require(digest(user_text)!=prepared['prompt_hash']
                and not re.search(r'\[CLW:control_[0-9a-f]{32}\]',user_text),
                'managed_partial_public_not_mismatched',409)
        observation_hash=digest(canonical(p))
        prior=db.execute('SELECT * FROM managed_partial_public_sends WHERE attempt_id=?',
                         (attempt['id'],)).fetchone()
        if prior:
            require(prior['observation_hash']==observation_hash,
                    'managed_partial_public_conflict',409)
            artifact=db.execute('SELECT path,sha256 FROM managed_artifacts WHERE id=? AND source=?',
                                (prior['artifact_id'],'public_dom_partial_send')).fetchone()
            require(artifact and Path(artifact['path']).is_file()
                    and hashlib.sha256(Path(artifact['path']).read_bytes()).hexdigest()==artifact['sha256'],
                    'managed_partial_public_artifact_changed',409)
            return {**json.loads(prior['response']),'replayed':True}
        request=self.control.original(db,self.host.binding(db,thread=page['thread_id']),
                                      attempt['request_id'])
        require(request['phase']=='queued' and request['claim_id'] is None
                and not request['cancel_requested'] and self.control.epoch(db,request)==attempt['epoch'],
                'managed_partial_public_original_changed',409)
        require(self.host.team.run_for_request(db,request['id'])
                and db.execute('SELECT 1 FROM host_team_work WHERE request_id=?',
                               (request['id'],)).fetchone(),
                'managed_partial_public_worker_assignment_required',409)
        require(not db.execute('SELECT 1 FROM control_browser_receipts WHERE request_id=?',
                               (request['id'],)).fetchone()
                and not db.execute('SELECT 1 FROM managed_tool_received WHERE attempt_id=?',
                                   (attempt['id'],)).fetchone()
                and not db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',
                                   (attempt['id'],)).fetchone()
                and not db.execute('SELECT 1 FROM managed_artifacts WHERE id IN (?,?,?)',
                                   (attempt['id'],attempt['id']+'-tool',attempt['id']+'-partial')).fetchone()
                and not db.execute('SELECT 1 FROM managed_attention WHERE request_id=?',
                                   (request['id'],)).fetchone()
                and not db.execute('SELECT 1 FROM host_team_attention_resolutions WHERE request_id=?',
                                   (request['id'],)).fetchone()
                and not db.execute('SELECT 1 FROM host_replies WHERE request_id=?',
                                   (request['id'],)).fetchone(),
                'managed_partial_public_prior_resolution',409)
        raw=(canonical({'classification':'partial_or_foreign_public_send',
                        'attempt_id':attempt['id'],'request_id':request['id'],
                        'page_id':page['page_id'],'url':p['url'],
                        'prepared_prompt_hash':prepared['prompt_hash'],
                        'observation':p})+'\n').encode('utf-8')
        sha=hashlib.sha256(raw).hexdigest()
        dest=self.state.path.parent/'managed-results'/(sha+'.json')
        dest.parent.mkdir(exist_ok=True)
        if dest.exists():
            require(hashlib.sha256(dest.read_bytes()).hexdigest()==sha,
                    'managed_partial_public_artifact_changed',409)
        else:dest.write_bytes(raw)
        artifact_id=attempt['id']+'-partial'
        db.execute('INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',
                   (artifact_id,request['id'],page['thread_id'],str(dest),sha,len(raw),
                    'public_dom_partial_send',self.host.clock()))
        budget_recorded=bool(db.execute('SELECT 1 FROM host_team_dispatches WHERE attempt_id=?',
                                        (attempt['id'],)).fetchone())
        reason=('partial_or_foreign_public_send：已观察到新的完整公开用户/助手回合，但用户文本与本次完整发送提示不符且缺少原标记。'
                '原 attempt 和 request 保持未决；公开文本只作为部分/外来网页证据，不是协作者成果。'
                '请核对原网页、Local-MCP Job 与磁盘后处理，禁止盲目重发。\n'
                f'证据：{dest}\nSHA256: {sha}')
        if not page['paused']:
            db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'attention',?)",
                       (page['page_id'],attempt['id']))
        db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(page['page_id'],))
        db.execute('INSERT INTO managed_attention VALUES(?,?,?)',
                   (request['id'],attempt['id'],reason))
        self.host.emit(db,page['thread_id'],'host_turn_attention',
                       {'request_id':request['id'],'attempt_id':attempt['id'],
                        'text':reason,'classification':'partial_or_foreign_public_send',
                        'original_attempt_unresolved':True,'original_claim_preserved':True,
                        'public_send_observed':True,'budget_dispatch_recorded':budget_recorded,
                        'task_completed':False,'automatic_retry_authorized':False})
        result={'state':'partial_or_foreign_public_send','attention_only':True,
                'original_attempt_preserved':True,'no_send_replayed':True,
                'request_phase':request['phase'],'budget_dispatch_recorded':budget_recorded,
                'public_send_observed':True,
                'artifact':{'path':str(dest),'sha256':sha,'bytes':len(raw)}}
        db.execute('INSERT INTO managed_partial_public_sends VALUES(?,?,?,?,?)',
                   (attempt['id'],observation_hash,artifact_id,canonical(result),self.host.clock()))
        return result
    def open_run(self,pageid):
        with closing(self.state.connect()) as probe_db:
            tentative=probe_db.execute('SELECT thread_id FROM managed_pages WHERE page_id=?',(pageid,)).fetchone()
        git_probe=self.host.team.scopes.preflight_native_git(tentative['thread_id']) if tentative and tentative['thread_id'] else None
        with self.host.lock,closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE');p=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(pageid,)).fetchone()
            self.open_run_in_transaction(db,p,git_probe=git_probe);db.commit()
    def open_run_in_transaction(self,db,p,git_probe=None,*,accepted_attempt=None):
        if p['parent_target']:return
        if json.loads(p['settings']).get('conversation_mode')=='direct':return
        r=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' ORDER BY created_at DESC LIMIT 1",(p['thread_id'],)).fetchone()
        if not r or self.host.team.run_for_request(db,r['id']):return
        s=json.loads(p['settings']);b=self.host.binding(db,thread=p['thread_id'])
        pending=s.get('budget_refill')
        if pending:budget.ready_to_start(db,p)
        limits=pending or s
        result=self.host.team.open(db,b,{'request_id':r['id'],'claim_id':r['claim_id'],'goal_ref':r['id'],'constraints':r['text'] if len(r['text'])<=12000 else '完整任务与约束见原 request.text；不得丢弃或缩减。',
                'duration_seconds':limits['duration_seconds'],'max_dispatches':limits['max_dispatches']},git_probe=git_probe,accepted_attempt=accepted_attempt)
        db.execute('UPDATE host_runs SET dispatches=1 WHERE id=?',(result['run_id'],))
        if pending:budget.link_run(self,db,p,result['run_id'],pending)
