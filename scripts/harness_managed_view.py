"""Read-only public UI projection. Reading status never acknowledges a note."""
import json
from harness_record_history import KINDS, project_events, record_history
import harness_managed_budget as budget
import harness_goal_control as goal_control
import harness_next_round as next_round
from harness_recovery import DELAYS, digest


def latest_request(db, thread):
    row = db.execute("""SELECT id,phase,cancel_requested,created_at,finished_at FROM host_requests
        WHERE thread_id=? ORDER BY phase IN ('queued','processing','suspended') DESC,created_at DESC,rowid DESC LIMIT 1""", (thread,)).fetchone()
    if not row:
        return None
    result = dict(row)
    attempt = db.execute('''SELECT a.id,br.sent_user_hash FROM control_attempts a
        LEFT JOIN control_browser_receipts br ON br.attempt_id=a.id
        WHERE a.request_id=? ORDER BY a.offered DESC LIMIT 1''', (row['id'],)).fetchone()
    result['attempt_id'] = attempt['id'] if attempt else None
    result['sent_user_hash'] = attempt['sent_user_hash'] if attempt else None
    result['withdrawn'] = bool(db.execute('SELECT 1 FROM managed_withdrawals WHERE message_id=?', (row['id'],)).fetchone())
    result['delivery_state'] = next_round.delivery(db,row['id'])
    resolution = db.execute('SELECT attempt_id,reason,created FROM host_team_attention_resolutions WHERE request_id=?', (row['id'],)).fetchone()
    result['resolution'] = dict(resolution) if resolution else None
    if resolution:
        result['resolution']['author_markdown_saved'] = bool(db.execute(
            "SELECT 1 FROM managed_artifacts WHERE request_id=? AND id=? AND source='local_mcp_public_result'",
            (row['id'], resolution['attempt_id']+'-tool')).fetchone())
        result['resolution']['partial_public_send'] = bool(db.execute(
            'SELECT 1 FROM managed_partial_retirements WHERE request_id=?',(row['id'],)).fetchone())
    return result


def project_view(db, page, team, record_summaries=False):
    thread = page['thread_id']
    history = record_history(db, page) if record_summaries else None
    events = history['events'] if history else project_events(db, thread)
    active = db.execute("SELECT id,phase,cancel_requested,created_at,finished_at FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') ORDER BY created_at DESC LIMIT 1", (thread,)).fetchone()
    latest = latest_request(db, thread)
    partial = db.execute('''SELECT x.observation_hash,a.request_id,a.id AS attempt_id
        FROM managed_partial_public_sends x JOIN control_attempts a ON a.id=x.attempt_id
        JOIN managed_attention m ON m.request_id=a.request_id AND m.attempt_id=a.id
        WHERE a.thread_id=? ORDER BY a.offered DESC LIMIT 1''',(thread,)).fetchone()
    attempt = db.execute('SELECT id,state,offered,dispatched,acknowledged FROM control_attempts WHERE request_id=? ORDER BY offered DESC LIMIT 1', (latest['id'],)).fetchone() if latest else None
    run = db.execute('SELECT * FROM host_runs WHERE controller_thread=? ORDER BY created DESC,rowid DESC LIMIT 1', (thread,)).fetchone()
    if run and latest and run['controller_request']!=latest['id']:
        run = None
    counts = db.execute("SELECT COUNT(*) AS attempted,SUM(acknowledged IS NOT NULL) AS confirmed FROM control_attempts WHERE thread_id=? AND dispatched IS NOT NULL AND state<>'not_sent'", (thread,)).fetchone()
    stats = {'attempted':counts['attempted']+int(page['bootstrap_state']!='pending'),
             'confirmed':(counts['confirmed'] or 0)+int(page['bootstrap_state']=='sent')}
    stats['unconfirmed'] = stats['attempted']-stats['confirmed']
    children = [{**dict(r),'latest_request':latest_request(db,r['thread_id'])} for r in db.execute('SELECT page_id,thread_id,title,phase,paused,model,effort FROM managed_pages WHERE parent_target=? ORDER BY created', (page['target_id'],))]
    settings = json.loads(page['settings'])
    queued = next_round.pending(db,page)
    automatic_recovery = None
    first_failure=settings.get('first_task_failure')
    if active and first_failure and first_failure['request_id']==active['id'] and (not attempt or attempt['acknowledged'] is None):
        automatic_recovery={'state':'backoff','ordinal':1,'due':first_failure['due'],'limit':len(DELAYS)}
    if active and attempt:
        failure = db.execute("SELECT data FROM events WHERE thread_id=? AND kind='control_browser_result_failed' ORDER BY seq DESC LIMIT 1", (thread,)).fetchone()
        if failure:
            failed = json.loads(failure['data'])
            if failed['attempt_id'] == attempt['id'] and failed['request_id'] == active['id']:
                key = digest(attempt['id']+':'+failed['failure_hash'])
                rec = db.execute('SELECT ordinal,due FROM control_recoveries WHERE request_id=? AND failure_hash=?', (active['id'],key)).fetchone()
                count = db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?', (active['id'],)).fetchone()[0]
                automatic_recovery = {'state':'backoff' if rec else 'exhausted' if count>=len(DELAYS) else 'waiting',
                                      'ordinal':rec['ordinal'] if rec else count,'due':rec['due'] if rec else None,'limit':len(DELAYS)}
    result = {'page_id':page['page_id'],'thread_id':thread,'events':events,
            'conversation_mode':settings.get('conversation_mode','managed'),
            'collaboration_enabled':settings.get('collaboration_enabled',True),
            'ended_recovery':__import__('harness_managed_attention_recovery').public_state(db,latest['id'] if latest else None),
            'partial_public_send':dict(partial) if partial else None,'automatic_recovery':automatic_recovery,
            'budget_status':budget.status(db,page,team),
            'goal':goal_control.view(db,page,team),
            'maintenance':team.maintenance.for_page(db,page['page_id']),
            'run':team.public_run(run) if run else None,'sends':stats['attempted'],'send_stats':stats,
            'request':dict(active) if active else None,'latest_request':latest,
            'turns':db.execute('SELECT COUNT(*) FROM control_attempts WHERE request_id=? AND acknowledged IS NOT NULL',(latest['id'],)).fetchone()[0] if latest else 0,
            'attempt':dict(attempt) if attempt else None,'children':children,
            'access':settings.get('access','read'),'write_paths':settings.get('write_paths',[]),
            'duration_seconds':settings.get('duration_seconds'),'max_dispatches':settings.get('max_dispatches'),
            'pending_notes':queued['count'],
            'next_round':queued}
    if history:
        result['record_history'] = {key: history[key] for key in
                                    ('has_before', 'has_after', 'total', 'first_seq', 'last_seq')}
    return result
