"""Read-only ordinary exit: retain business work after current execution is idle.

The desktop owner supplies its fresh public DOM observation over the original
private pipe. That observation identifies a paused carrier, not a business
completion receipt. Independent Session Jobs remain with the shared Runner.
"""
import math,re,time
from harness_state import HarnessError

FIELDS={'page_id','thread_id','request_id','attempt_id','observed_at','paused',
        'generating','draft','composing','raw_stop_present','confirmation',
        'identity_verified','marker','expected_user_hash','observed_user_hash'}
QUIET=('generating','composing','raw_stop_present','confirmation')

def refuse(code,kind,**identity):
    error=HarnessError(code,409)
    error.blockers=[{'kind':kind,**identity}]
    raise error

def checked(condition,code,kind,**identity):
    if not condition:refuse(code,kind,**identity)

def validate_payload(carriers,page_bindings):
    checked(isinstance(carriers,list),'ordinary_exit_observation_required','browser_observation')
    pages={b['page_id']:b for b in page_bindings};seen=set()
    for carrier in carriers:
        checked(isinstance(carrier,dict) and set(carrier)==FIELDS,
                'ordinary_exit_observation_required','browser_observation')
        identity={k:carrier.get(k) for k in ('page_id','thread_id','request_id','attempt_id')}
        checked(carrier['page_id'] in pages and carrier['page_id'] not in seen,
                'ordinary_exit_original_identity_changed','browser_observation',**identity)
        seen.add(carrier['page_id']);binding=pages[carrier['page_id']]
        checked(all(carrier[k]==binding[k] for k in identity),
                'ordinary_exit_original_identity_changed','browser_observation',**identity)
        checked(type(carrier['observed_at']) in (int,float) and math.isfinite(carrier['observed_at']) and
                0<=time.time()-carrier['observed_at']<=30,
                'ordinary_exit_observation_stale','browser_observation',**identity)
        checked(carrier['paused'] is True,'ordinary_exit_future_not_paused','browser_carrier',**identity)
        checked(all(carrier[k] is False for k in QUIET),
                'ordinary_exit_browser_not_quiet','browser_carrier',**identity)
        checked(type(carrier['draft']) is bool,'ordinary_exit_observation_required','browser_observation',**identity)
        checked(carrier['identity_verified'] is True and
                (carrier['marker'] is None or isinstance(carrier['marker'],str) and len(carrier['marker'])<=160) and
                all(carrier[k] is None or isinstance(carrier[k],str) and re.fullmatch(r'[a-f0-9]{64}',carrier[k])
                    for k in ('expected_user_hash','observed_user_hash')),
                'ordinary_exit_original_identity_changed','browser_observation',**identity)
    checked(seen==set(pages),'ordinary_exit_observation_required','browser_observation',
            page_ids=sorted(set(pages)-seen)[:16])

def carrier_identity(carrier):
    """Refresh the observation time within one exit intent, never its identity."""
    return {k:v for k,v in carrier.items() if k!='observed_at'}

def verified_carriers(db,service,carriers):
    result={}
    for carrier in carriers:
        identity={k:carrier[k] for k in ('page_id','thread_id','request_id','attempt_id')}
        page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(carrier['page_id'],)).fetchone()
        checked(page and page['thread_id']==carrier['thread_id'],
                'ordinary_exit_original_identity_changed','browser_carrier',**identity)
        checked(service.host_bridge.managed.paused(db,page),
                'ordinary_exit_future_not_paused','browser_carrier',**identity)
        request=db.execute('SELECT * FROM host_requests WHERE id=?',(carrier['request_id'],)).fetchone() if carrier['request_id'] else None
        if request and request['phase'] in ('queued','processing','suspended'):
            attempt=db.execute('''SELECT a.*,b.sent_user_hash FROM control_attempts a
                LEFT JOIN control_browser_receipts b ON b.attempt_id=a.id
                AND b.request_id=a.request_id AND b.thread_id=a.thread_id WHERE a.id=?''',
                (carrier['attempt_id'],)).fetchone() if carrier['attempt_id'] else None
            checked(not carrier['attempt_id'] or attempt and attempt['request_id']==request['id'] and attempt['thread_id']==request['thread_id'],
                    'ordinary_exit_original_identity_changed','browser_carrier',**identity)
            if any(carrier[k] is not None for k in ('marker','expected_user_hash','observed_user_hash')):
                checked(attempt and attempt['sent_user_hash'] and
                        carrier['marker']=='[CLW:'+attempt['id']+']' and
                        carrier['expected_user_hash']==carrier['observed_user_hash']==attempt['sent_user_hash'],
                        'ordinary_exit_original_identity_changed','browser_carrier',**identity)
            # No supplied delivery proof is needed to close a quiet owned page.
            # Original request/attempt/ACK/unknown states are read-only history;
            # this observation never acknowledges or settles business execution.
        result[carrier['thread_id']]=carrier
    return result

def retained_request(db,service,request,carriers,*,bound_page_ids):
    """A durable claim/lease is scheduling state, not evidence of a live call."""
    page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(request['thread_id'],)).fetchone()
    if page:
        if page['page_id'] not in bound_page_ids:
            # The original private-pipe descriptor set identifies the pages
            # this desktop still owns. A paused historical page outside that
            # set has no GUI carrier from which to obtain a DOM observation.
            # Keep its request/ACK/claim intact. Independent Session calls and
            # Jobs remain owned by the shared Runner after desktop shutdown.
            checked(page['paused']==1,'ordinary_exit_future_not_paused','historical_browser_page',
                    page_id=page['page_id'],thread_id=request['thread_id'],request_id=request['id'])
            return {'code':'ordinary_paused_historical_page','pageId':page['page_id'],
                    'browserDescriptorAbsent':True,'currentExecutionChecked':True}
        carrier=carriers.get(request['thread_id'])
        checked(carrier and carrier['page_id']==page['page_id'] and service.host_bridge.managed.paused(db,page),
                'ordinary_exit_observation_required','browser_carrier',
                page_id=page['page_id'],thread_id=request['thread_id'],request_id=request['id'])
        return {'code':'ordinary_paused_browser_carrier','attemptId':carrier['attempt_id'],
                'carrierRequestId':carrier['request_id'],'currentExecutionChecked':True}
    thread=db.execute('SELECT provider FROM threads WHERE id=?',(request['thread_id'],)).fetchone()
    binding=db.execute('SELECT * FROM host_bindings WHERE thread_id=?',(request['thread_id'],)).fetchone()
    checked(thread and thread['provider']=='chatgpt_web_host' and binding and
            service.host_bridge.future_paused(db,binding,request),
            'ordinary_exit_future_not_paused','manual_receiver',
            thread_id=request['thread_id'],request_id=request['id'])
    return {'code':'ordinary_paused_manual_receiver','currentExecutionChecked':True}
