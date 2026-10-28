"""Durable poll-to-claim evidence, not a browser scheduler or model attestation."""
from __future__ import annotations
import time
from urllib.error import URLError

CLAIM_ATTENTION_SECONDS = 45
TERMINAL = {'completed', 'blocked', 'cancelled'}


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS host_handoffs(
        request_id TEXT PRIMARY KEY, first_offered REAL NOT NULL,
        last_offered REAL NOT NULL, offers INTEGER NOT NULL)''')


def record_offer(db, host, binding, request):
    # A yielded parent keeps its original claim and different resume semantics.
    if request['phase'] != 'queued':
        return
    now = host.clock()
    first = db.execute('INSERT OR IGNORE INTO host_handoffs VALUES(?,?,?,1)',
                       (request['id'], now, now)).rowcount
    if first:
        host.emit(db, binding['thread_id'], 'host_handoff_offered',
                  {'request_id': request['id'], 'claim_performed': False,
                   'host_turn_verified': False})
    else:
        db.execute('UPDATE host_handoffs SET last_offered=?,offers=MIN(offers+1,1000000) WHERE request_id=?',
                   (now, request['id']))
    db.commit()


def control_handoff(db, binding, request, base, now):
    tables={x[0] for x in db.execute("SELECT name FROM sqlite_master WHERE name IN ('control_peers','control_attempts','control_adoptions')")}
    if len(tables)!=3:return None
    peer=db.execute('SELECT * FROM control_peers WHERE thread_id=?',(request['thread_id'],)).fetchone()
    if not peer:return None
    a=db.execute('SELECT id,state,offered,dispatched,generation FROM control_attempts WHERE request_id=? ORDER BY offered DESC,rowid DESC LIMIT 1',(request['id'],)).fetchone()
    if a and a['state'] in ('dispatching','sent','unknown','not_sent'):
        age=max(0,now-(a['dispatched'] or a['offered']))
        return {**base,'state':'control_'+a['state'],'attempt_id':a['id'],
                'attention_required':a['state'] in ('unknown','not_sent') or age>=CLAIM_ATTENTION_SECONDS,
                'next_action':'reconcile_original_control_attempt_no_send_retry'}
    if not peer['enabled'] or peer['expires']<=now:
        return {**base,'state':'control_pair_inactive','attention_required':True,'next_action':'inspect_exact_control_pair_no_redelegate'}
    epoch=db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE thread_id=? AND kind='host_waiting_children' AND json_extract(data,'$.request_id')=?",(request['thread_id'],request['id'])).fetchone()[0]
    latest=db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE thread_id=? AND kind IN ('host_queued','host_delegated_input','host_waiting_children') AND json_extract(data,'$.request_id')=?",(request['thread_id'],request['id'])).fetchone()[0]
    adopt=db.execute('SELECT 1 FROM control_adoptions WHERE request_id=? AND epoch=? AND generation=?',(request['id'],epoch,peer['generation'])).fetchone()
    if latest<=peer['cutoff'] and not adopt:
        return {**base,'state':'control_explicit_adoption_required','attention_required':True,'next_action':'explicitly_adopt_this_original_request'}
    if a and a['state']=='offered':
        return {**base,'state':'control_offered','attempt_id':a['id'],'attention_required':now-a['offered']>120,'next_action':'inspect_exact_page_guards_no_redelegate'}
    recent=peer['last_seen']>now-20
    return {**base,'state':'control_observing' if recent else 'control_observer_missing',
            'attention_required':not recent,'next_action':'inspect_exact_control_page'}


def request_handoff(db, binding, request, now=None, *, dispatch_paused=None):
    """Read-only bounded projection, including on pre-migration databases."""
    now = time.time() if now is None else now
    base = {'state': 'idle', 'attention_required': False,
            'next_action': 'none', 'automatic_resume_verified': False,
            'execution_replay_allowed': False, 'silence_is_failure': False}
    if request is None:
        return base
    phase = request['phase']
    base['request_id'] = request['id']
    base['dispatch_paused'] = not binding['enabled'] if dispatch_paused is None else bool(dispatch_paused)
    if phase in TERMINAL:
        return {**base, 'state': phase}
    if request['cancel_requested']:
        return {**base, 'state': 'cancel_requested', 'next_action': 'reconcile_original_stop'}
    if phase == 'processing':
        return {**base, 'state': 'claim_confirmed', 'next_action': 'observe_original_work'}
    if phase == 'suspended':
        return {**base, 'state': 'waiting_children', 'next_action': 'inspect_original_child_results'}
    control=control_handoff(db,binding,request,base,now)
    # A pause prevents the next dispatch, while an already admitted or unknown
    # attempt still needs its original receipt. Neither state requests Stop.
    if control and control['state'] in ('control_dispatching','control_sent','control_unknown','control_not_sent'):
        return control
    if base['dispatch_paused']:
        return {**base, 'state': 'dispatch_paused', 'next_action': 'wait_for_explicit_resume'}
    if control is not None:return control
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_handoffs'").fetchone()
    offer = db.execute('SELECT first_offered,last_offered FROM host_handoffs WHERE request_id=?',
                       (request['id'],)).fetchone() if exists else None
    if offer:
        age = max(0, now - offer['first_offered'])
        return {**base, 'state': 'handoff_offered_unclaimed',
                'offered_at': offer['first_offered'], 'unclaimed_seconds': round(age, 3),
                'attention_required': age >= CLAIM_ATTENTION_SECONDS,
                'next_action': 'recover_original_receiving_conversation',
                'not_a_model_failure': True}
    recent = binding['wait_until'] > now
    return {**base, 'state': 'receiver_polling' if recent else 'receiver_unavailable',
            'attention_required': not recent,
            'next_action': 'inspect_receiver_carrier_then_original_request',
            'legacy_poll_history_unknown': True,
            'handoff_observation_available': False}


def wait_for_results(client, request_id, claim_id, timeout_secs, *, clock=time.monotonic, sleep=time.sleep):
    """Only observe original results. Never claim, re-delegate or launch a model.

    Only read transport failures retry. Authorization/identity rejections propagate.
    Attention and timeout records are not child or parent completion.
    """
    if type(timeout_secs) is not int or not 1 <= timeout_secs <= 3600:
        raise ValueError('bounded_results_wait_required')
    deadline, failures = clock() + timeout_secs, 0
    while True:
        try:
            result = client.call('results', request_id=request_id, claim_id=claim_id)
            failures = 0
        except (OSError, URLError):
            failures += 1
            if failures >= 3 or clock() >= deadline:
                return {'state': 'transport_unavailable', 'request_id': request_id,
                        'parent_completed': False, 'execution_replayed': False,
                        'next_action': 'diagnose_original_app_and_request'}
            sleep(min(2 ** failures, max(0, deadline - clock())))
            continue
        if result.get('pending_children') == 0:
            return {**result, 'state': 'children_returned', 'parent_completed': False}
        attention = [x for x in result.get('children', []) if x.get('handoff', {}).get('attention_required')]
        if attention:
            return {**result, 'state': 'attention_required', 'parent_completed': False,
                    'next_action': 'recover_original_receiver_not_redelegate'}
        remaining = deadline - clock()
        if remaining <= 0:
            return {**result, 'state': 'bounded_wait_expired', 'parent_completed': False}
        sleep(min(2, remaining))
