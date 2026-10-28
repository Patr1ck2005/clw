"""Controller-owned retirement of a parked read-only branch, never worker success."""
import json
from harness_state import require,stamp
from harness_team_common import object_fields,text

def schema(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS host_team_attention_reads(
        run_id TEXT NOT NULL,controller_thread TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
        PRIMARY KEY(run_id,controller_thread,request_id));
      CREATE TABLE IF NOT EXISTS host_team_attention_resolutions(
        request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,controller_thread TEXT NOT NULL,attempt_id TEXT NOT NULL,
        reason TEXT NOT NULL,created TEXT NOT NULL);
    ''')

def settle(team,db,actor,p):
    object_fields(p,{'run_id','claim_id','request_id','attempt_id','reason'})
    run=team.owned(db,actor,p['run_id']);parent=team.controller_request(db,actor,run,p['claim_id'])
    require(run['state'] in ('running','draining'),'team_run_not_running',409)
    reason=text(p['reason'],'reason',2000)
    require(db.execute('SELECT 1 FROM host_team_work WHERE run_id=? AND request_id=?',(run['id'],p['request_id'])).fetchone(),'team_foreign_result',403)
    child=db.execute('SELECT * FROM host_requests WHERE id=?',(p['request_id'],)).fetchone()
    attention=db.execute('SELECT * FROM managed_attention WHERE request_id=? AND attempt_id=?',(child['id'],p['attempt_id'])).fetchone()
    require(attention and child['phase'] in ('processing','suspended') and not child['cancel_requested'],'team_attention_not_current',409)
    require(db.execute('SELECT 1 FROM host_team_attention_reads WHERE run_id=? AND controller_thread=? AND request_id=? AND attempt_id=?',
      (run['id'],actor['thread_id'],child['id'],p['attempt_id'])).fetchone(),'team_read_attention_result_first',409)
    page=db.execute('SELECT paused FROM managed_pages WHERE thread_id=?',(child['thread_id'],)).fetchone()
    receipt=db.execute('SELECT result_hash FROM control_browser_receipts WHERE attempt_id=?',(p['attempt_id'],)).fetchone()
    require(page and page['paused'] and receipt and receipt['result_hash'],'team_attention_turn_not_ended',409)
    scope=team.scopes.scope(db,child['thread_id']);thread=db.execute('SELECT status,active_turn FROM threads WHERE id=?',(child['thread_id'],)).fetchone()
    require(scope and scope['access']=='read' and not json.loads(scope['resources']) and thread['status']=='needs_attention' and not thread['active_turn']
      and not db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(child['id'],)).fetchone(),'team_attention_execution_requires_reconciliation',409)
    require(not team.host.collaboration.outstanding(db,child['id']),'team_children_still_pending',409)
    require(not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(child['id'],)).fetchone(),'team_attention_has_unread_instructions',409)
    # Retiring a failed branch does not replay its refused upload. Preserve the
    # actual artifact source; DOM fallback is never promoted to author Markdown.
    artifacts=[dict(x) for x in db.execute('SELECT id,source,sha256,bytes FROM managed_artifacts WHERE request_id=? AND id IN (?,?)',
      (child['id'],p['attempt_id'],p['attempt_id']+'-tool'))]
    require(artifacts,'team_attention_saved_result_required',409)
    db.execute('INSERT INTO host_team_attention_resolutions VALUES(?,?,?,?,?,?)',(child['id'],run['id'],actor['thread_id'],p['attempt_id'],reason,stamp()))
    db.execute("UPDATE host_requests SET phase='blocked',finished_at=? WHERE id=?",(stamp(),child['id']))
    db.execute("UPDATE threads SET status='error',active_turn=NULL,updated_at=? WHERE id=?",(stamp(),child['thread_id']))
    db.execute('DELETE FROM managed_attention WHERE request_id=?',(child['id'],))
    # The old request stays blocked. Clearing its automatic page pause sends
    # nothing; M may include recovery context with useful new work in one turn.
    # Legacy pauses with unknown provenance and operator stops remain paused.
    page=db.execute('SELECT page_id FROM managed_pages WHERE thread_id=?',(child['thread_id'],)).fetchone()
    owner=db.execute('SELECT source,attempt_id FROM managed_pause_owners WHERE page_id=?',(page['page_id'],)).fetchone()
    reusable=bool(owner and owner['source']=='attention' and owner['attempt_id']==p['attempt_id']
      and not db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',(page['page_id'],)).fetchone()
      and not db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone())
    if reusable:
        db.execute('UPDATE managed_pages SET paused=0 WHERE page_id=?',(page['page_id'],))
        db.execute('DELETE FROM managed_pause_owners WHERE page_id=?',(page['page_id'],))
    result={'request_id':child['id'],'status':'blocked','source':'controller_settled_parked_branch','reason':reason,
            'controller_thread':actor['thread_id'],'original_attempt_id':p['attempt_id'],'worker_claim_preserved':True,
            'worker_reported_success':False,'model_called':False,'independent_acceptance':False,'preserved_artifacts':artifacts,
            'worker_available_for_new_work':reusable,'old_request_retried':False,
            'author_markdown_saved':any(a['source']=='local_mcp_public_result' for a in artifacts)}
    team.host.emit(db,child['thread_id'],'host_result',result)
    team.host.emit(db,parent['thread_id'],'host_child_result',{'request_id':parent['id'],'child_request_id':child['id'],
      'child_thread_id':child['thread_id'],'status':'blocked','source':result['source'],'parent_completed':False})
    return result
