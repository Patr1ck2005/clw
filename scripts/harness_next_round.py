"""Next-turn supplements in the original Host ledger and send receipt path."""
import hashlib,json
from harness_state import require,canonical,stamp


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_next_round_notes(
      note_id TEXT PRIMARY KEY,page_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      source_request_id TEXT NOT NULL,batch_id TEXT)''')
    db.execute('''CREATE TABLE IF NOT EXISTS managed_next_round_batches(
      id TEXT PRIMARY KEY,page_id TEXT NOT NULL,thread_id TEXT NOT NULL,
      source_request_id TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,
      created TEXT NOT NULL,accepted_request_id TEXT)''')


def current_notes(db,request):
    return db.execute('''SELECT n.id,n.text,n.created_at FROM host_notes n
      WHERE n.request_id=? AND NOT EXISTS (
        SELECT 1 FROM managed_next_round_notes q WHERE q.note_id=n.id)
      ORDER BY n.created_at,n.rowid''',(request,)).fetchall()


def pending(db,page):
    notes=[dict(row) for row in db.execute('''SELECT n.id,n.text,n.created_at,q.batch_id,q.source_request_id AS request_id
      FROM managed_next_round_notes q JOIN host_notes n ON n.id=q.note_id
      LEFT JOIN managed_next_round_batches b ON b.id=q.batch_id
      WHERE q.page_id=? AND (b.id IS NULL OR b.state='prepared') ORDER BY n.created_at,n.rowid''',(page['page_id'],))]
    state='pending'
    batch=db.execute("SELECT * FROM managed_next_round_batches WHERE page_id=? AND state='prepared' ORDER BY created LIMIT 1",(page['page_id'],)).fetchone()
    if batch:
        op=db.execute('SELECT state FROM operations WHERE id=?',(batch['id'],)).fetchone()
        state='delivery_unknown' if op and op['state'] in ('unknown','dispatching') else 'sending' if op and op['state'] in ('completed','reserved') else 'pending'
    from harness_managed_actions import can_withdraw
    for note in notes:note['withdrawable']=can_withdraw(db,page['thread_id'],note['request_id'],note['id'])
    return {'count':len(notes),'messages':notes,'state':state,
            'batch_id':batch['id'] if batch else None,'current_turn_unchanged':True}


def enqueue(host,db,page,request,text,note_id):
    old=db.execute('SELECT request_id,text FROM host_notes WHERE id=?',(note_id,)).fetchone()
    if old:
        require(old['request_id']==request and old['text']==text,'host_note_operation_conflict',409)
    else:
        db.execute('INSERT INTO host_notes VALUES(?,?,?,?)',(note_id,request,text,stamp()))
        db.execute('INSERT INTO managed_next_round_notes VALUES(?,?,?,?,NULL)',(note_id,page['page_id'],page['thread_id'],request))
        host.emit(db,page['thread_id'],'host_user_note',{'text':text,'request_id':request,'note_id':note_id,'native_steer':False,'delivery_scope':'next_round'})
    result={'operation_id':note_id,'request_id':request,'thread_id':page['thread_id'],
            'state':'note_saved_not_native_interrupt','delivery_scope':'next_round',
            'delivery_state':'pending','next_round':pending(db,page)}
    db.execute("UPDATE operations SET state='completed',response=? WHERE id=?",(canonical(result),note_id))
    return result


def ready(db,page,exclude_operation=None):
    if page['phase']!='bound' or page['paused']:return False
    binding=db.execute('SELECT enabled FROM host_bindings WHERE thread_id=?',(page['thread_id'],)).fetchone()
    if not binding or not binding['enabled']:return False
    if db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(page['thread_id'],)).fetchone():return False
    if db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",(page['thread_id'],)).fetchone():return False
    if db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown') AND (? IS NULL OR id<>?)",(page['thread_id'],exclude_operation,exclude_operation)).fetchone():return False
    if db.execute('SELECT 1 FROM managed_page_issues WHERE page_id=?',(page['page_id'],)).fetchone():return False
    if db.execute('SELECT 1 FROM managed_stops WHERE page_id=? AND resumed=0',(page['page_id'],)).fetchone():return False
    import time
    from harness_managed_budget import direct_values
    budget=direct_values(db,page,time.time())
    if budget and ((budget['available_sends'] is not None and budget['available_sends']<1) or
                   (budget['available_seconds'] is not None and budget['available_seconds']<=0)):return False
    return True


def prepare(host,db,page,goal_followup=''):
    existing=db.execute("SELECT * FROM managed_next_round_batches WHERE page_id=? AND state='prepared' ORDER BY created LIMIT 1",(page['page_id'],)).fetchone()
    if existing:return dict(existing)
    if not ready(db,page):return None
    rows=db.execute('''SELECT n.id,n.text FROM managed_next_round_notes q JOIN host_notes n ON n.id=q.note_id
      WHERE q.page_id=? AND q.batch_id IS NULL ORDER BY n.created_at,n.rowid''',(page['page_id'],)).fetchall()
    if not rows:return None
    # Exact text and order are immutable once prepared; later input forms another batch.
    message='\n\n'.join(row['text'] for row in rows)
    if goal_followup:message+='\n\n'+goal_followup
    require(len(message)<=131072,'managed_next_round_message_too_large',409)
    key='next-'+hashlib.sha256(canonical([page['page_id'],*[row['id'] for row in rows]]).encode()).hexdigest()[:48]
    request=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(page['thread_id'],)).fetchone()
    db.execute('INSERT INTO managed_next_round_batches VALUES(?,?,?,?,?,?,?,NULL)',(key,page['page_id'],page['thread_id'],request['id'],message,'prepared',stamp()))
    db.executemany('UPDATE managed_next_round_notes SET batch_id=? WHERE note_id=?',[(key,row['id']) for row in rows])
    return dict(db.execute('SELECT * FROM managed_next_round_batches WHERE id=?',(key,)).fetchone())


def validate_send(db,page,text,key):
    batch=db.execute('SELECT * FROM managed_next_round_batches WHERE id=?',(key,)).fetchone()
    if not batch:return False
    require(page and page['page_id']==batch['page_id'] and text==batch['text'],'managed_next_round_identity_or_text_changed',409)
    require(batch['state']=='prepared' and ready(db,page,key),'managed_next_round_original_not_ready',409)
    latest=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(page['thread_id'],)).fetchone()
    require(latest and latest['id']==batch['source_request_id'],'managed_next_round_original_changed',409)
    return True


def accepted(db,key):
    db.execute("UPDATE managed_next_round_batches SET state='accepted',accepted_request_id=? WHERE id=? AND state='prepared'",(key,key))


def fold_user_send(db,page,text,key):
    """Admit queued original input and a new human send in one transaction."""
    if not page:return text,False
    rows=db.execute('''SELECT n.id,n.text,q.batch_id FROM managed_next_round_notes q
      JOIN host_notes n ON n.id=q.note_id LEFT JOIN managed_next_round_batches b ON b.id=q.batch_id
      WHERE q.page_id=? AND (q.batch_id IS NULL OR b.state='prepared') ORDER BY n.created_at,n.rowid''',(page['page_id'],)).fetchall()
    if not rows:return text,False
    for batch in {row['batch_id'] for row in rows if row['batch_id']}:
        op=db.execute('SELECT state,response FROM operations WHERE id=?',(batch,)).fetchone()
        if op:
            receipt=json.loads(op['response']) if op['response'] else {}
            require(op['state']=='rejected' and receipt.get('state')=='rejected' and receipt.get('unknown') is False,
                    'managed_next_round_original_send_unresolved',409)
        db.execute("UPDATE managed_next_round_batches SET state='superseded' WHERE id=? AND state='prepared'",(batch,))
    message='\n\n'.join([*(row['text'] for row in rows),text])
    goal=db.execute("SELECT * FROM managed_goals WHERE page_id=? AND state IN ('active','waiting') AND control_mode='automatic' AND result_contract=2",(page['page_id'],)).fetchone()
    if goal:
        message+='\n\n继续未完成的完整目标：'+goal['objective']
        if goal['wait_context']:message+='\n原等待与接续点：'+goal['wait_context']
    require(len(message)<=131072,'managed_next_round_message_too_large',409)
    source=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(page['thread_id'],)).fetchone()
    db.execute('INSERT INTO managed_next_round_batches VALUES(?,?,?,?,?,?,?,NULL)',
               (key,page['page_id'],page['thread_id'],source['id'],message,'prepared',stamp()))
    db.executemany('UPDATE managed_next_round_notes SET batch_id=? WHERE note_id=?',[(key,row['id']) for row in rows])
    return message,True


def delivery(db,request):
    attempt=db.execute('''SELECT a.state,r.sent_user_hash FROM control_attempts a
      LEFT JOIN control_browser_receipts r ON r.attempt_id=a.id WHERE a.request_id=? ORDER BY a.offered DESC LIMIT 1''',(request,)).fetchone()
    if attempt:
        if attempt['state']=='unknown':return 'delivery_unknown'
        if attempt['sent_user_hash']:return 'sent'
        if attempt['state'] in ('dispatching','sent','acknowledged'):return 'sending'
    return 'pending'
