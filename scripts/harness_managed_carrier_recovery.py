"""Recover only an unadmitted first business request on an empty homepage.

The earlier enrollment Send, Session, attempts and old conversation URL remain
facts. This descriptor changes neither business ownership nor retry authority.
"""
import hashlib,json,re
from harness_state import require,canonical
from harness_team_common import object_fields
from harness_managed_unsent_retry import KIND

HOME='https://chatgpt.com/'
EMPTY=hashlib.sha256(b'').hexdigest()
KEY='empty_carrier_recovery'
CHAT=re.compile(r'https://chatgpt\.com/c/[A-Za-z0-9-]{16,128}\Z')

def projection(page):
    value=json.loads(page['settings']).get(KEY)
    return value if isinstance(value,dict) else None

def original_scope(db,page):
    all_settings=json.loads(page['settings'])
    settings={k:all_settings.get(k) for k in ('account','access','write_paths','resources','collaboration_protocol',
        'first_turn_mode','first_turn_instructions','first_task_request_id','model_selection','bootstrap_model_selection',
        'bootstrap_model_verified','work_model_pending','duration_seconds','max_dispatches')}
    binding=db.execute('SELECT thread_id,target_id,spec FROM host_bindings WHERE thread_id=?',(page['thread_id'],)).fetchone()
    scope=db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?',(page['thread_id'],)).fetchone()
    return hashlib.sha256(canonical({'page':{k:page[k] for k in ('page_id','thread_id','target_id','parent_target','root','model','effort')},
        'settings':settings,'binding':dict(binding) if binding else None,'scope':dict(scope) if scope else None}).encode()).hexdigest()

def candidate(managed,db,page_id):
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page_id,)).fetchone()
    def no(reason):return {'eligible':False,'reason':reason}
    if not page or page['phase']!='bound' or not CHAT.fullmatch(page['url']):return no('original_bound_page_required')
    settings=json.loads(page['settings']);request_id=settings.get('first_task_request_id')
    if (page['bootstrap_state']!='sent' or settings.get('first_turn_mode')!='task_v1' or
            settings.get('first_task_outcome')!='not_started' or settings.get('work_model_pending') or
            settings.get('first_task_recovery',{}).get('reason')!='public_turn_ended_before_admission'):
        return no('first_business_request_not_unadmitted')
    if managed.paused(db,page):return no('future_dispatch_paused')
    request=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(request_id,page['thread_id'])).fetchone()
    if not request or request['phase']!='queued' or request['claim_id'] or request['cancel_requested']:return no('original_request_not_queued_unclaimed')
    if db.execute('SELECT 1 FROM host_requests WHERE thread_id=? AND id<>?',(page['thread_id'],request_id)).fetchone():return no('business_history_present')
    binding=db.execute('SELECT * FROM host_bindings WHERE thread_id=? AND target_id=?',(page['thread_id'],page['target_id'])).fetchone()
    if not binding or not binding['enabled']:return no('original_receiver_disabled')
    if not db.execute("SELECT 1 FROM managed_receipts WHERE actor=? AND json_extract(response,'$.state')='receiver_enrolled' AND json_extract(response,'$.first_task.request_id')=?",(page_id,request_id)).fetchone():return no('original_enrollment_receipt_missing')
    attempts=[dict(x) for x in db.execute('SELECT * FROM control_attempts WHERE request_id=? ORDER BY rowid',(request_id,))]
    if not attempts or any(x['state']!='not_sent' or x['acknowledged'] is not None or x['generation']!=1 for x in attempts):return no('original_send_not_definitively_absent')
    for table,column,value in [('control_browser_receipts','request_id',request_id),('host_replies','request_id',request_id),('host_team_leases','request_id',request_id),('managed_artifacts','request_id',request_id),('managed_attention','request_id',request_id)]:
        if db.execute(f'SELECT 1 FROM {table} WHERE {column}=?',(value,)).fetchone():return no('original_execution_evidence_present')
    if db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','sent','unknown')",(page['thread_id'],)).fetchone():return no('original_operation_unresolved')
    if db.execute('SELECT 1 FROM managed_tool_received WHERE attempt_id IN (SELECT id FROM control_attempts WHERE request_id=?)',(request_id,)).fetchone():return no('model_tool_received')
    if db.execute('SELECT 1 FROM managed_turn_outcomes WHERE attempt_id IN (SELECT id FROM control_attempts WHERE request_id=?)',(request_id,)).fetchone():return no('original_turn_outcome_present')
    if db.execute('SELECT 1 FROM managed_partial_public_sends WHERE attempt_id IN (SELECT id FROM control_attempts WHERE request_id=?)',(request_id,)).fetchone():return no('partial_public_send_unresolved')
    event=db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind=? AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(page['thread_id'],KIND,request_id)).fetchone()
    if not event or json.loads(event['data']).get('original_attempt_id')!=attempts[-1]['id'] or managed.control.epoch(db,request)!=event['seq']:return no('explicit_original_resume_required')
    scope={'page_id':page_id,'thread_id':page['thread_id'],'request_id':request_id,'account':settings.get('account','B'),
           'original_url':page['url'],'original_attempt_id':attempts[-1]['id'],'retry_epoch':event['seq'],
           'original_scope_hash':original_scope(db,page)}
    scope['scope_hash']=hashlib.sha256(canonical({'scope':scope,'settings':settings,'request':dict(request),'attempts':attempts,'binding':dict(binding)}).encode()).hexdigest()
    return {'eligible':True,**scope}

def empty_browser(p):
    object_fields(p,{'url','at','document_generation','editor','control_known','history_at_latest','user_hash','assistant_hash',
                     'generating','draft','composing','approval','login','blocked','access_limited','complete','marker_count'})
    return (p['url']==HOME and type(p['at']) is int and type(p['document_generation']) is int and p['document_generation']>0 and
            all(p[k] is True for k in ('editor','control_known')) and
            (p['history_at_latest'] is True or p['history_at_latest'] is None) and
            all(p[k] is False for k in ('generating','draft','composing','approval','login','blocked','access_limited','complete')) and
            p['user_hash']==EMPTY and p['assistant_hash']==EMPTY and p['marker_count']==0)

def prepare(managed,db,p):
    object_fields(p,{'page_id','expected','browser'})
    scope=candidate(managed,db,p['page_id'])
    require(scope.get('eligible') and p['expected']==scope,'managed_empty_carrier_scope_changed',409)
    require(empty_browser(p['browser']) and abs(managed.host.clock()*1000-p['browser']['at'])<=15000,'managed_empty_carrier_not_verified',409)
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone();settings=json.loads(page['settings'])
    previous=settings.get(KEY);identity=hashlib.sha256(canonical(scope).encode()).hexdigest()
    descriptor={**{k:v for k,v in scope.items() if k not in ('eligible','scope_hash')},'id':identity,'state':'prepared','attempt_id':None}
    settings[KEY]=descriptor
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
    managed.host.emit(db,page['thread_id'],'managed_empty_carrier_prepared',{'request_id':scope['request_id'],'recovery':descriptor,
        'previous':previous,'browser':p['browser'],'original_bootstrap_preserved':True,'model_sends':0})
    return descriptor

def dispatch(managed,db,page,attempt_id):
    recovery=projection(page)
    if not recovery or recovery['state']!='prepared':return
    request=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(recovery['request_id'],page['thread_id'])).fetchone()
    attempt=db.execute('SELECT * FROM control_attempts WHERE id=?',(attempt_id,)).fetchone()
    require(recovery['original_scope_hash']==original_scope(db,page) and request and
            managed.control.epoch(db,request)==recovery['retry_epoch'] and
            request['phase']=='queued' and not request['claim_id'] and not request['cancel_requested'] and
            attempt and attempt['request_id']==request['id'] and attempt['state']=='offered' and attempt['dispatched'] is None and
            attempt['acknowledged'] is None and attempt['epoch']==recovery['retry_epoch'] and attempt['user_hash']==EMPTY and
            recovery['attempt_id'] in (None,attempt_id),'managed_empty_carrier_dispatch_changed',409)
    settings=json.loads(page['settings']);settings[KEY]['attempt_id']=attempt_id
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))

def bind(managed,db,p):
    object_fields(p,{'page_id','recovery_id','request_id','attempt_id','original_url','account','url','browser'})
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound','managed_empty_carrier_page_changed',409)
    descriptor=projection(page);browser=p['browser'];settings=json.loads(page['settings'])
    require(descriptor and descriptor['id']==p['recovery_id'] and descriptor['request_id']==p['request_id'] and
            descriptor['original_url']==p['original_url'] and descriptor['account']==p['account']==settings.get('account','B') and
            descriptor['attempt_id']==p['attempt_id'] and descriptor['original_scope_hash']==original_scope(db,page),
            'managed_empty_carrier_identity_changed',409)
    object_fields(browser,{'at','user_hash','marker','marker_count','history_at_latest','draft','composing','login','blocked','access_limited'})
    require(CHAT.fullmatch(p['url']) and p['url']!=p['original_url'] and browser['marker']=='[CLW:'+p['attempt_id']+']' and
            browser['marker_count']==1 and (browser['history_at_latest'] is True or browser['history_at_latest'] is None) and
            all(browser[k] is False for k in ('draft','composing','login','blocked','access_limited')) and
            re.fullmatch('[0-9a-f]{64}',browser['user_hash']) and browser['user_hash']!=EMPTY and
            type(browser['at']) is int and abs(managed.host.clock()*1000-browser['at'])<=15000,'managed_empty_carrier_send_not_observed',409)
    if descriptor['state']=='bound':
        require(page['url']==p['url'] and descriptor['user_hash']==browser['user_hash'],'managed_empty_carrier_binding_conflict',409)
        return descriptor
    require(descriptor['state']=='prepared' and page['url']==p['original_url'],'managed_empty_carrier_binding_changed',409)
    attempt=db.execute('SELECT * FROM control_attempts WHERE id=? AND request_id=? AND thread_id=?',(p['attempt_id'],p['request_id'],page['thread_id'])).fetchone()
    require(attempt and attempt['state'] in ('dispatching','acknowledged') and attempt['epoch']==descriptor['retry_epoch'] and
            attempt['user_hash']==EMPTY,'managed_empty_carrier_original_send_required',409)
    prepared=db.execute('SELECT assistant_before_hash FROM managed_dispatches WHERE attempt_id=?',(p['attempt_id'],)).fetchone()
    require(prepared and prepared[0]==EMPTY,'managed_empty_carrier_preparation_missing',409)
    descriptor={**descriptor,'state':'bound','url':p['url'],'user_hash':browser['user_hash']};settings[KEY]=descriptor
    db.execute('UPDATE managed_pages SET url=?,settings=?,seen=? WHERE page_id=? AND url=?',(p['url'],canonical(settings),managed.host.clock(),page['page_id'],p['original_url']))
    managed.host.emit(db,page['thread_id'],'managed_empty_carrier_bound',{'request_id':p['request_id'],'recovery':descriptor,
        'original_attempt_preserved':True,'new_request_created':False,'model_sends':0})
    return descriptor
