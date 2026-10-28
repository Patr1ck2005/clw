"""One original final-result selection for manual and automatic goal controls."""
import json


def original_result(db,page,request_id):
    request=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',
                       (request_id,page['thread_id'])).fetchone()
    run=db.execute('SELECT * FROM host_runs WHERE controller_request=? AND controller_thread=? ORDER BY created DESC,rowid DESC LIMIT 1',
                   (request_id,page['thread_id'])).fetchone()
    direct=json.loads(page['settings']).get('conversation_mode')=='direct'
    if not request or (not run and not direct):return 'final_evidence_missing',None
    key='closed-summary-'+request_id
    summary=db.execute('SELECT 1 FROM managed_artifacts WHERE id=?',(key,)).fetchone()
    reconciled=db.execute("SELECT 1 FROM events WHERE thread_id=? AND kind='managed_saved_final_reconciled' AND json_extract(data,'$.request_id')=?",
                          (page['thread_id'],request_id)).fetchone()
    if summary or reconciled:
        # A final generation failure can follow a completed yielded reply.
        # The authenticated final summary outranks that earlier receipt, and
        # a malformed summary chain must never fall back to the old reply.
        from harness_goal_watch import Goals
        return Goals.saved_summary(db,{'thread_id':page['thread_id']},page,request,run)
    latest=db.execute('SELECT id FROM control_attempts WHERE request_id=? AND thread_id=? AND acknowledged IS NOT NULL ORDER BY acknowledged DESC,rowid DESC LIMIT 1',
                      (request_id,page['thread_id'])).fetchone()
    receipt=db.execute('SELECT * FROM control_browser_receipts WHERE request_id=? AND thread_id=? AND completed IS NOT NULL ORDER BY completed DESC,rowid DESC LIMIT 1',
                       (request_id,page['thread_id'])).fetchone()
    if not receipt:return 'final_evidence_missing',None
    if latest and latest['id']!=receipt['attempt_id']:return 'final_evidence_invalid',None
    if request['claim_id'] and receipt['claim_id']!=request['claim_id']:return 'final_evidence_invalid',None
    if direct:
        artifact_id=receipt['attempt_id'];source='public_dom_markdown'
    elif json.loads(page['settings']).get('collaboration_protocol')=='text_v1':
        observed=db.execute('SELECT assistant_turn_hash FROM managed_text_artifact_turns WHERE attempt_id=?',
                            (receipt['attempt_id'],)).fetchone()
        if not observed or observed[0]!=receipt['result_turn_hash']:return 'final_evidence_invalid',None
        artifact_id=receipt['attempt_id'];source='public_dom_markdown'
    else:artifact_id=receipt['attempt_id']+'-tool';source='local_mcp_public_result'
    result=db.execute('SELECT * FROM managed_artifacts WHERE request_id=? AND thread_id=? AND id=? AND source=?',
                      (request_id,page['thread_id'],artifact_id,source)).fetchone()
    return ('',dict(result)) if result else ('final_evidence_missing',None)
