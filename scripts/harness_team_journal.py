"""Bounded public-result pages and explicit controller wait selection.

Uses original events and requests; does not copy transcript bodies into a second
journal, synthesize agent replies, or decide the controller's research strategy.
"""
import json
from harness_state import require,canonical,stamp
from harness_team_common import object_fields,integer,names,hash_value
import harness_team_attention as attention_ops
from harness_team_timing import result_timing

class RunJournal:
    def __init__(self,team):self.team=team
    @staticmethod
    def attention(db,request,thread):
        row=db.execute("SELECT e.seq,e.data,e.at,m.attempt_id FROM events e JOIN managed_attention m ON m.request_id=? WHERE e.thread_id=? AND e.kind='host_turn_attention' AND json_extract(e.data,'$.request_id')=m.request_id ORDER BY e.seq DESC LIMIT 1",(request,thread)).fetchone()
        if not row:return None
        data=json.loads(row['data'])
        return {'event_seq':row['seq'],'at':row['at'],'outcome':'needs_attention','reason':data.get('text','')[:1500],
                'attempt_id':row['attempt_id'],'classification':data.get('classification'),
                'task_completed':False,'automatic_retry_authorized':False}
    @staticmethod
    def reconcile_attention(db):
        # Re-index genuine unresolved events from earlier versions. No invented
        # result, acknowledgement, claim, permission, or replay of the worker.
        db.execute('''INSERT OR IGNORE INTO host_team_signals(run_id,source_event,request_id,kind)
          SELECT w.run_id,e.seq,r.id,e.kind FROM managed_attention m
          JOIN host_requests r ON r.id=m.request_id
          JOIN host_team_work w ON w.request_id=r.id
          JOIN host_runs run ON run.id=w.run_id
          JOIN events e ON e.thread_id=r.thread_id AND e.kind='host_turn_attention'
            AND json_extract(e.data,'$.request_id')=r.id
            AND (json_extract(e.data,'$.attempt_id')=m.attempt_id OR
              (json_extract(e.data,'$.attempt_id') IS NULL AND json_extract(e.data,'$.text')=m.reason))
            AND e.seq=(SELECT MAX(previous.seq) FROM events previous WHERE previous.thread_id=r.thread_id
              AND previous.kind='host_turn_attention' AND json_extract(previous.data,'$.request_id')=r.id)
          WHERE run.state<>'closed' AND (r.phase IN ('processing','suspended') OR
            (r.phase='queued' AND EXISTS(SELECT 1 FROM managed_partial_public_sends partial
              WHERE partial.attempt_id=m.attempt_id))) AND r.cancel_requested=0''')
        for row in db.execute('''SELECT r.* FROM managed_attention m JOIN host_requests r ON r.id=m.request_id
          JOIN control_browser_receipts br ON br.attempt_id=m.attempt_id
          WHERE r.phase IN ('processing','suspended') AND r.cancel_requested=0 AND br.result_hash IS NOT NULL''').fetchall():
            RunJournal.park_read_only_attention(db,row)
    @staticmethod
    def park_read_only_attention(db,request):
        # The public browser turn ended and the page is parked. Its read-only
        # reservation has no writer or exclusive resource to keep running.
        # Retain write/explicit resource leases and unknown/native execution.
        scope=db.execute('SELECT access,resources FROM host_team_scopes WHERE thread_id=?',(request['thread_id'],)).fetchone()
        lease=db.execute('SELECT access,resources FROM host_team_leases WHERE request_id=?',(request['id'],)).fetchone()
        thread=db.execute('SELECT status,active_turn FROM threads WHERE id=?',(request['thread_id'],)).fetchone()
        if not scope or scope['access']!='read' or json.loads(scope['resources']):return
        if lease and (lease['access']!='read' or json.loads(lease['resources'])):return
        if not thread or thread['active_turn'] not in (None,request['id']) or thread['status'] not in ('processing','waiting_children','needs_attention'):return
        db.execute('DELETE FROM host_team_leases WHERE request_id=?',(request['id'],))
        db.execute("UPDATE threads SET status='needs_attention',active_turn=NULL,updated_at=? WHERE id=?",(stamp(),request['thread_id']))
    @staticmethod
    def schema(db):
        db.executescript('''
          CREATE TABLE IF NOT EXISTS host_team_result_cursors(
            run_id TEXT NOT NULL,controller_thread TEXT NOT NULL,request_id TEXT NOT NULL,
            through_seq INTEGER NOT NULL,PRIMARY KEY(run_id,controller_thread,request_id));
          CREATE TABLE IF NOT EXISTS host_team_wait_specs(
            run_id TEXT PRIMARY KEY,selected_requests TEXT NOT NULL);
        ''')
        attention_ops.schema(db)
    def result(self,db,actor,p):
        object_fields(p,{'run_id','request_id'},{'after_seq'})
        after=p.get('after_seq',0);integer(after,0,2**53-1)
        run=self.team.owned(db,actor,p['run_id'])
        require(db.execute('SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',(run['id'],p['request_id'])).fetchone(),'team_foreign_result',403)
        q=db.execute('SELECT * FROM host_requests WHERE id=?',(p['request_id'],)).fetchone()
        cursor=db.execute('SELECT through_seq FROM host_team_result_cursors WHERE run_id=? AND controller_thread=? AND request_id=?',
                          (run['id'],actor['thread_id'],q['id'])).fetchone()
        if not cursor and hasattr(self.team.host,'managed'):cursor=self.team.host.managed.handoffs.inherited_read(db,run['id'],actor['thread_id'],q['id'],'host_team_result_cursors')
        through=cursor['through_seq'] if cursor else 0
        require(after<=through,'team_result_cursor_not_read',409)
        rows=db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='assistant_message' AND json_extract(data,'$.request_id')=? AND seq>? ORDER BY seq LIMIT 2",
                        (q['thread_id'],q['id'],after)).fetchall()
        event=rows[0] if rows else None;reply=json.loads(event['data']) if event else None
        next_after=event['seq'] if event else after
        if event:
            through=max(through,next_after)
            db.execute('INSERT OR REPLACE INTO host_team_result_cursors VALUES(?,?,?,?)',(run['id'],actor['thread_id'],q['id'],through))
            if len(rows)==1:
                db.execute('INSERT OR REPLACE INTO host_team_reads VALUES(?,?,?,?)',(run['id'],actor['thread_id'],q['id'],hash_value(reply)))
        artifacts=[]
        if hasattr(self.team.host,'managed'):
            artifacts=[dict(x) for x in db.execute('SELECT path,sha256,bytes,source FROM managed_artifacts WHERE request_id=? ORDER BY created',(q['id'],))]
        attention=self.attention(db,q['id'],q['thread_id'])
        if attention:
            db.execute('INSERT OR REPLACE INTO host_team_attention_reads VALUES(?,?,?,?)',(run['id'],actor['thread_id'],q['id'],attention['attempt_id']))
            attention['controller_option']=(
                'original attempt and request remain unresolved; inspect the partial public artifact and original external Jobs before any retirement; no automatic resend'
                if attention['classification']=='partial_or_foreign_public_send' else
                'settle-attention: retire an ended read-only branch as blocked after reviewing its saved draft; never reports worker success or retries the refusal')
        resolution=db.execute('SELECT * FROM host_team_attention_resolutions WHERE request_id=?',(q['id'],)).fetchone()
        return {'request_id':q['id'],'phase':q['phase'],'reply':reply,'artifacts':artifacts,'attention':attention,'timing':result_timing(db,q['id']),'resolution':dict(resolution) if resolution else None,'event_seq':next_after if event else None,
                'next_after':next_after,'has_more':len(rows)>1,'full_public_reply':True,
                'all_public_parts_read':len(rows)<=1,'parent_completed':False,
                'scope':'one_complete_public_reply_per_page_in_original_order_not_only_final_brief'}
    def selection(self,db,run,mode,raw=None,store=False):
        require(mode in ('any','all','selected'),'team_wait_mode')
        if raw is None:
            row=db.execute('SELECT selected_requests FROM host_team_wait_specs WHERE run_id=?',(run['id'],)).fetchone()
            selected=json.loads(row['selected_requests']) if row else []
        else:
            selected=names(raw,64)
        if mode=='selected':
            require(selected,'team_wait_selection_required')
            for request in selected:
                require(db.execute('SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',(run['id'],request)).fetchone(),'team_wait_selection_foreign',403)
        else:
            require(not raw,'team_wait_selection_unexpected');selected=[]
        if store:db.execute('INSERT OR REPLACE INTO host_team_wait_specs VALUES(?,?)',(run['id'],canonical(selected)))
        return selected
    def selected_terminal(self,db,selected):
        return bool(selected) and all(db.execute('SELECT phase FROM host_requests WHERE id=?',(key,)).fetchone()['phase'] not in ('queued','processing','suspended') for key in selected)
    def wait_ready(self,db,run,mode,after,selected=None):
        # A text-v1 batch can be awaiting real browser pages before any child
        # Host request exists. Older worker events accumulate until assignment;
        # a batch issue or direct user correction still wakes the controller.
        if db.execute("SELECT 1 FROM host_team_signals WHERE run_id=? AND seq>? AND kind='managed_text_batch_attention' AND request_id=? LIMIT 1",(run['id'],after,run['controller_request'])).fetchone():return True
        if db.execute("SELECT 1 FROM host_team_signals WHERE run_id=? AND seq>? AND kind='host_user_note' AND request_id=? LIMIT 1",(run['id'],after,run['controller_request'])).fetchone():return True
        if hasattr(self.team.host,'managed') and db.execute(
                "SELECT 1 FROM managed_text_batches WHERE run_id=? AND state IN ('waiting_pages','retry_requested') LIMIT 1",
                (run['id'],)).fetchone():return False
        # A completed public turn that needs attention must not wait forever
        # behind wait-all. It wakes M once via the existing consumed cursor;
        # the worker stays paused with its original non-terminal request.
        if db.execute("SELECT 1 FROM host_team_signals WHERE run_id=? AND seq>? AND kind='host_turn_attention' AND request_id<>? LIMIT 1",(run['id'],after,run['controller_request'])).fetchone():return True
        # New operator input to M is never hidden behind a worker barrier. M
        # still decides whether to pause/revise/review; no second work is started.
        signal=db.execute('SELECT 1 FROM host_team_signals WHERE run_id=? AND seq>? LIMIT 1',(run['id'],after)).fetchone()
        if not signal:return False
        if mode=='any':return True
        if mode=='all':return not self.team.host.collaboration.outstanding(db,run['controller_request'])
        selected=self.selection(db,run,mode) if selected is None else selected
        return self.selected_terminal(db,selected)
