"""Checkpoint-based successor conversations, retaining each real Session.

Only a quiescent controller can hand over. The existing run, deadline and send
budget continue; old request/claim/turns are immutable historical ownership.
There is no hidden-context export and no replay of an accepted local Job.
"""
import json,re,uuid
from harness_run_limits import deadline_live,sends_available
from harness_state import require,canonical,stamp
from harness_team_common import object_fields
from harness_managed_models import worker_enrollment_selection


class ManagedHandoffs:
    def __init__(self,managed,db):
        self.managed,self.host=managed,managed.host
        db.executescript('''CREATE TABLE IF NOT EXISTS managed_handoffs(
            id TEXT PRIMARY KEY,source_page TEXT NOT NULL UNIQUE,source_request TEXT NOT NULL UNIQUE,
            source_thread TEXT NOT NULL,source_attempt TEXT NOT NULL,source_claim TEXT NOT NULL,
            successor_page TEXT NOT NULL UNIQUE,successor_request TEXT NOT NULL UNIQUE,
            run_id TEXT NOT NULL,checkpoint TEXT NOT NULL,state TEXT NOT NULL,created REAL NOT NULL);
        ''')

    def fail(self,db,row,reason):
        db.execute("UPDATE managed_handoffs SET state='needs_attention' WHERE id=?",(row['id'],))
        db.execute("UPDATE host_runs SET state='paused',reason='context_handoff_needs_attention',revision=revision+1 WHERE id=?",(row['run_id'],))
        for page in (row['source_page'],row['successor_page']):
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(page,))
            db.execute('INSERT OR REPLACE INTO managed_page_issues VALUES(?,?,?)',(page,'handoff_needs_attention',reason))
        self.host.emit(db,row['source_thread'],'managed_handoff_attention',{'request_id':row['source_request'],'reason':reason,'original_requests_retained':True,'budget_reset':False})

    def prepare(self,db,page,b,p,key):
        object_fields(p,{'request_id','claim_id','checkpoint_version','no_pending_jobs'})
        require(p['no_pending_jobs'] is True,'managed_handoff_reconcile_original_jobs_first',409)
        require(type(p['checkpoint_version']) is int and p['checkpoint_version']>0,'managed_handoff_checkpoint_required')
        r=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(p['request_id'],b['thread_id'])).fetchone()
        require(r and r['claim_id']==p['claim_id'] and r['phase']=='processing' and not r['cancel_requested'],'host_claim_not_current',409)
        run=self.host.team.run_for_request(db,r['id'])
        require(run and run['controller_request']==r['id'] and run['controller_thread']==b['thread_id'],'managed_handoff_controller_only',403)
        require(run['state']=='running' and deadline_live(run,self.host.clock()) and sends_available(run,3),'managed_handoff_original_budget_insufficient',409)
        require(not self.managed.paused(db,page),'managed_parent_paused',409)
        require(not db.execute('SELECT 1 FROM managed_handoffs WHERE source_page=?',(page['page_id'],)).fetchone(),'managed_handoff_already_prepared',409)
        require(not self.host.collaboration.outstanding(db,r['id']),'managed_handoff_wait_for_children',409)
        require(not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone(),'host_new_instructions_read_before_final',409)
        require(not db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown')",(r['id'],)).fetchone(),'managed_handoff_send_unresolved',409)
        maximum=db.execute('SELECT COALESCE(MAX(seq),0) FROM host_team_signals WHERE run_id=?',(run['id'],)).fetchone()[0]
        self.host.team.require_results_read(db,b,run,maximum)
        snapshot=db.execute('SELECT * FROM host_team_snapshots WHERE run_id=? AND thread_id=? ORDER BY version DESC LIMIT 1',(run['id'],b['thread_id'])).fetchone()
        require(snapshot and snapshot['version']==p['checkpoint_version'] and snapshot['basis_seq']==maximum,'managed_handoff_checkpoint_stale',409)
        attempt=db.execute('SELECT br.attempt_id FROM control_browser_receipts br JOIN control_attempts a ON a.id=br.attempt_id WHERE br.request_id=? AND br.result_hash IS NULL ORDER BY a.acknowledged DESC LIMIT 1',(r['id'],)).fetchone()
        require(attempt,'managed_current_turn_missing',409)
        require(not db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id=?',(attempt[0],)).fetchone(),'managed_handoff_turn_already_ended',409)
        successor='web-'+str(uuid.uuid5(uuid.NAMESPACE_URL,'clw-handoff:'+page['page_id']+':'+key))
        settings={k:v for k,v in json.loads(page['settings']).items() if k in ('access','write_paths','resources','duration_seconds','max_dispatches','model_selection','bootstrap_model_selection','account','collaboration_protocol')}
        # A successor enrolls before receiving the existing full goal. Keep its
        # formal work selection, but use the same-family setup selection here.
        if settings.get('bootstrap_model_selection') or settings.get('model_selection'):
            settings['bootstrap_model_selection']=worker_enrollment_selection(settings,settings.get('model_selection'))
        generation=2;prior_page=page['page_id'];visited=set()
        while prior_page not in visited:
            visited.add(prior_page)
            prior=db.execute("SELECT source_page FROM managed_handoffs WHERE successor_page=? AND state='active'",(prior_page,)).fetchone()
            if not prior:break
            generation+=1;prior_page=prior[0]
        title=re.sub(r' · 接续 \d+$','',page['title'])[:100]+f' · 接续 {generation}'
        self.managed.reserve(db,{'page_id':successor,'title':title,'root':page['root'],'model':page['model'],'effort':page['effort'],**settings})
        # A waiting successor cannot enroll or send until the old public turn
        # is actually observed finished. Its explicit pause bit stays independent.
        db.execute("UPDATE managed_pages SET phase='handoff_waiting' WHERE page_id=?",(successor,))
        checkpoint={**dict(snapshot),'references':json.loads(snapshot['refs']),'source_target':page['target_id'],'source_session':b['spec']['session_id'],'source_url':page['url'],
                    'pending_requests':[],'pending_jobs_attested_by_source':[],
                    'result_cursor_source_thread':b['thread_id'],'claims_verified':False}
        checkpoint.pop('refs')
        next_request='clw-handoff-'+uuid.uuid5(uuid.NAMESPACE_URL,successor).hex
        db.execute('INSERT INTO managed_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                   (key,page['page_id'],r['id'],b['thread_id'],attempt[0],r['claim_id'],successor,next_request,run['id'],canonical(checkpoint),'prepared',self.host.clock()))
        db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?",(r['id'],))
        db.execute("UPDATE host_runs SET state='paused',reason='context_handoff',revision=revision+1 WHERE id=?",(run['id'],))
        db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",(stamp(),b['thread_id']))
        self.host.emit(db,b['thread_id'],'managed_handoff_prepared',{'request_id':r['id'],'successor_page':successor,'checkpoint_hash':snapshot['hash'],'business_goal_completed':False})
        return {'state':'handoff_prepared_end_current_turn','successor_page':successor,'run_id':run['id'],'checkpoint_hash':snapshot['hash'],'old_session_preserved':True,'budget_reset':False}

    def enrolling_successor(self,db,page):
        """An original, still-unsent handoff eligible for setup inheritance repair."""
        row=db.execute("SELECT * FROM managed_handoffs WHERE successor_page=? AND state='enrolling'",(page['page_id'],)).fetchone()
        if not row:return False
        original=db.execute('SELECT * FROM host_requests WHERE id=?',(row['source_request'],)).fetchone()
        run=self.host.team.run_for_request(db,row['source_request'])
        source=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(row['source_page'],)).fetchone()
        receipt=db.execute('SELECT result_hash FROM control_browser_receipts WHERE attempt_id=?',(row['source_attempt'],)).fetchone()
        return bool(original and original['phase']=='suspended' and not original['cancel_requested']
                    and original['thread_id']==row['source_thread'] and original['claim_id']==row['source_claim']
                    and run and run['id']==row['run_id'] and run['state']=='paused' and run['reason']=='context_handoff'
                    and deadline_live(run,self.host.clock()) and sends_available(run,1,1)
                    and source and source['thread_id']==row['source_thread'] and self.managed.paused(db,source)
                    and receipt and receipt[0])

    def reconcile(self,db):
        for row in db.execute("SELECT * FROM managed_handoffs WHERE state IN ('prepared','enrolling')").fetchall():
            source=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(row['source_page'],)).fetchone()
            successor=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(row['successor_page'],)).fetchone()
            run=self.host.team.run_for_request(db,row['source_request'])
            if not run or run['state']!='paused' or run['reason']!='context_handoff':continue
            if not deadline_live(run,self.host.clock()) or not sends_available(run,1,1):
                self.fail(db,row,'交接期间原运行窗口或发送预算已到限。检查点与原任务保留，未重置预算或再发送。');continue
            original=db.execute('SELECT * FROM host_requests WHERE id=?',(row['source_request'],)).fetchone()
            if not original or original['phase']!='suspended' or original['claim_id']!=row['source_claim'] or original['cancel_requested']:
                self.fail(db,row,'原请求已停止或身份发生变化。交接已暂停，未创建后继业务请求；请核对原执行。');continue
            if row['state']=='prepared':
                receipt=db.execute('SELECT result_hash FROM control_browser_receipts WHERE attempt_id=?',(row['source_attempt'],)).fetchone()
                if not receipt or not receipt[0] or self.managed.paused(db,source):continue
                db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(source['page_id'],))
                db.execute("UPDATE managed_pages SET phase='reserved' WHERE page_id=?",(successor['page_id'],))
                db.execute("UPDATE managed_handoffs SET state='enrolling' WHERE id=?",(row['id'],))
                self.host.team.scopes.release(db,row['source_request'])
            if successor['phase']!='bound' or self.managed.paused(db,successor):continue
            # The enrollment Send is charged to this same original run. Never
            # create a replacement 6-hour window or replenish the 40 sends.
            if not deadline_live(run,self.host.clock()) or not sends_available(run,1,1):continue
            checkpoint=json.loads(row['checkpoint']);now=stamp()
            text=('继续同一业务目标。你是经过公开检查点接入的后继对话，使用自己的真实 Session；不得使用前任 Session/claim。'
                  '先读 managed context 的 handoff 完整检查点及所引文件，再核对已有成果和原 Job；不要重做已接受工作。\n'
                  '--- 原始目标 ---\n'+run['constraints_text'])
            db.execute("INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,'queued',?)",(row['successor_request'],successor['thread_id'],text,now))
            db.execute("UPDATE host_requests SET phase='handed_off',finished_at=? WHERE id=? AND claim_id=?",(now,row['source_request'],row['source_claim']))
            db.execute("UPDATE threads SET status='idle',active_turn=NULL,updated_at=? WHERE id=?",(now,row['source_thread']))
            db.execute('UPDATE host_bindings SET enabled=0 WHERE thread_id=?',(row['source_thread'],))
            db.execute("UPDATE host_runs SET controller_thread=?,controller_request=?,state='running',reason='',revision=revision+1 WHERE id=?",(successor['thread_id'],row['successor_request'],run['id']))
            db.execute("UPDATE threads SET status='waiting',active_turn=?,updated_at=? WHERE id=?",(row['successor_request'],now,successor['thread_id']))
            db.execute("UPDATE managed_handoffs SET state='active' WHERE id=?",(row['id'],))
            self.host.emit(db,row['source_thread'],'managed_handoff_activated',{'request_id':row['source_request'],'successor_page':successor['page_id'],'successor_request':row['successor_request'],'business_goal_completed':False})
            self.host.emit(db,successor['thread_id'],'host_queued',{'request_id':row['successor_request'],'source':'public_checkpoint_successor','source_request':row['source_request'],'checkpoint_hash':checkpoint['hash']})

    def parent_target(self,db,target):
        seen=set()
        while target:
            require(target not in seen,'managed_handoff_cycle',409);seen.add(target)
            row=db.execute("SELECT successor_page FROM managed_handoffs WHERE source_page=? AND state='active'",(target,)).fetchone()
            if not row:break
            target=row[0]
        return target

    def may_manage(self,db,actor,target):
        row=db.execute('SELECT parent_target_id FROM host_branches WHERE target_id=?',(target,)).fetchone()
        return bool(row and self.parent_target(db,row[0])==actor['target_id'])

    def inherited_read(self,db,run,thread,request,table):
        require(table in ('host_team_reads','host_team_result_cursors'),'managed_handoff_read_table')
        seen=set()
        while thread not in seen:
            seen.add(thread)
            handoff=db.execute("SELECT h.source_thread FROM managed_handoffs h JOIN managed_pages p ON p.page_id=h.successor_page WHERE h.run_id=? AND p.thread_id=? AND h.state='active'",(run,thread)).fetchone()
            if not handoff:return None
            thread=handoff[0]
            row=db.execute('SELECT * FROM '+table+' WHERE run_id=? AND controller_thread=? AND request_id=?',(run,thread,request)).fetchone()
            if row:return row
        return None

    def context(self,db,page,request):
        row=db.execute("SELECT * FROM managed_handoffs WHERE successor_page=? AND successor_request=? AND state='active'",(page['page_id'],request)).fetchone()
        return {'source_request':row['source_request'],'checkpoint':json.loads(row['checkpoint']),'same_run_and_budget':True} if row else None
