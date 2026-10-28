"""Explicit operator recovery of a positively unsent original request.

The failed attempt remains immutable. A durable event grants one new epoch;
passive polling, reconnecting and unknown Sends never grant retry authority.
"""
import json

KIND='managed_unsent_retry_authorized'

def epoch(db,request,original):
    value=db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE thread_id=? AND kind=? AND json_extract(data,'$.request_id')=?",
                     (request['thread_id'],KIND,request['id'])).fetchone()[0]
    return max(original,value)

def authorize(managed,db,page,expected_request_id):
    if page['phase']!='bound' or not expected_request_id:return None
    request=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') ORDER BY created_at DESC LIMIT 1",
                       (page['thread_id'],)).fetchone()
    if not request or request['id']!=expected_request_id or request['phase']!='queued' or request['cancel_requested'] or request['claim_id']:
        return None
    attempt=db.execute('SELECT * FROM control_attempts WHERE request_id=? AND thread_id=? ORDER BY rowid DESC LIMIT 1',
                       (request['id'],page['thread_id'])).fetchone()
    if not attempt or attempt['state']!='not_sent' or attempt['generation']!=1 or attempt['acknowledged'] is not None:
        return None
    if db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown','acknowledged') LIMIT 1",(request['id'],)).fetchone():
        return None
    if db.execute('SELECT 1 FROM control_browser_receipts WHERE request_id=? LIMIT 1',(request['id'],)).fetchone():
        return None
    previous=db.execute("SELECT data FROM events WHERE thread_id=? AND kind=? AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",
                        (page['thread_id'],KIND,request['id'])).fetchone()
    if previous and json.loads(previous[0]).get('original_attempt_id')==attempt['id']:
        return attempt['id']
    if attempt['epoch']<0 or attempt['epoch']!=managed.control.epoch(db,request):
        return None
    managed.host.emit(db,page['thread_id'],KIND,{'request_id':request['id'],'page_id':page['page_id'],
        'original_attempt_id':attempt['id'],'source':'explicit_operator_resume','previous_state':'not_sent',
        'model_received':False,'original_request_preserved':True})
    return attempt['id']
