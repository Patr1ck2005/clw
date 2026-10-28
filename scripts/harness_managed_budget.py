"""Operator-only budget refills. Preserve conversations and execution history."""
import json
from harness_state import require,canonical,stamp
from harness_team_common import object_fields,integer,hash_value
from harness_run_limits import deadline_live,sends_available,remaining


def schema(db):
    db.executescript('''CREATE TABLE IF NOT EXISTS managed_budget_receipts(
      id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_budget_links(
      run_id TEXT PRIMARY KEY,source_run TEXT NOT NULL,context TEXT NOT NULL);''')


def latest(db,page):
    row=db.execute('SELECT * FROM host_runs WHERE controller_thread=? ORDER BY created DESC,rowid DESC LIMIT 1',(page['thread_id'],)).fetchone()
    return dict(row) if row else None


def direct_values(db,page,now):
    settings=json.loads(page['settings'])
    if settings.get('conversation_mode')!='direct':return None
    actual=db.execute("SELECT COUNT(*) AS used,MIN(dispatched) AS started FROM control_attempts WHERE thread_id=? AND dispatched IS NOT NULL AND state<>'not_sent'",(page['thread_id'],)).fetchone()
    deadline=settings.get('direct_budget_deadline')
    duration=settings.get('duration_seconds');limit=settings.get('max_dispatches')
    if deadline is None and duration is not None and actual['started'] is not None:deadline=actual['started']+duration
    return {'used':actual['used'],'limit':limit,'deadline':deadline,
            'available_sends':remaining(limit,actual['used']),
            'available_seconds':remaining(deadline,now) if deadline is not None else duration}


def effective_now(db,team,run):
    held=db.execute("SELECT settled FROM host_team_maintenance WHERE run_id=? AND state='settled'",(run['id'],)).fetchone() if run else None
    return held[0] if held else team.host.clock()


def ended_final_attention(db,page,run):
    """A saved ending of this final turn, not merely an old final-send latch."""
    if not run or not run['final_granted'] or run['state'] not in ('running','draining','paused'):
        return None
    request=db.execute('''SELECT r.*,m.attempt_id FROM host_requests r
      JOIN managed_attention m ON m.request_id=r.id
      WHERE r.id=? AND r.thread_id=? AND r.phase IN ('processing','suspended')
        AND r.cancel_requested=0''',(run['controller_request'],page['thread_id'])).fetchone()
    if not request or not request['claim_id']:return None
    attempt=db.execute('''SELECT * FROM control_attempts WHERE request_id=?
      ORDER BY offered DESC,rowid DESC LIMIT 1''',(request['id'],)).fetchone()
    receipt=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',
                       (request['attempt_id'],)).fetchone()
    dispatched=db.execute('''SELECT 1 FROM host_team_dispatches
      WHERE attempt_id=? AND run_id=? AND request_id=? AND is_final=1''',
      (request['attempt_id'],run['id'],request['id'])).fetchone()
    if (not attempt or attempt['id']!=request['attempt_id'] or attempt['state']!='acknowledged'
            or attempt['dispatched'] is None or attempt['acknowledged'] is None or not dispatched
            or not receipt or receipt['request_id']!=request['id'] or receipt['thread_id']!=page['thread_id']
            or receipt['claim_id']!=request['claim_id'] or not receipt['result_hash']
            or receipt['completed'] is None):return None
    outcome=db.execute('SELECT kind FROM managed_turn_outcomes WHERE attempt_id=?',
                       (request['attempt_id'],)).fetchone()
    event=db.execute('''SELECT data FROM events WHERE thread_id=? AND kind='host_turn_attention'
      AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.attempt_id')=?
      ORDER BY seq DESC LIMIT 1''',(page['thread_id'],request['id'],request['attempt_id'])).fetchone()
    if not event or not ((outcome and outcome['kind']=='needs_attention') or
                         (not outcome and json.loads(event['data']).get('missing_tool_outcome') is True)):
        return None
    if (db.execute("SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown')",
                   (page['thread_id'],)).fetchone()
            or db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown')",
                          (page['thread_id'],)).fetchone()
            or db.execute('''SELECT 1 FROM managed_partial_public_sends p JOIN control_attempts a
              ON a.id=p.attempt_id WHERE a.request_id=? AND a.state<>'partial_retired' ''',
                          (request['id'],)).fetchone()):return None
    return {'request_id':request['id'],'attempt_id':request['attempt_id']}


def status(db,page,team):
    if page['parent_target']:return {'scope':'controller','controller_target':team.host.managed.handoffs.parent_target(db,page['parent_target'])}
    direct=direct_values(db,page,team.host.clock())
    if direct is not None:
        active=db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(page['thread_id'],)).fetchone()
        settings=json.loads(page['settings']);sends=direct['available_sends'];seconds=direct['available_seconds']
        return {**direct,'scope':'current','run_id':None,'run_state':None,
                'etag':hash_value({'page':page['page_id'],'settings':{k:settings.get(k) for k in ('max_dispatches','duration_seconds','direct_budget_deadline')}}),
                'saved':False,'ended_final_turn':False,'unlimited_sends':sends is None,'unlimited_time':seconds is None,
                'can_continue':not active and (sends is None or sends>=1) and (seconds is None or seconds>0)}
    run=latest(db,page);settings=json.loads(page['settings']);pending=settings.get('budget_refill')
    ended=ended_final_attention(db,page,run)
    current=bool(run and run['state']!='closed' and (not run['final_granted'] or ended))
    if current:
        if ended and pending and pending['source_run']==run['id']:
            available=pending['max_dispatches'];seconds=pending['duration_seconds']
        else:
            available=remaining(run['max_dispatches'],run['dispatches']);seconds=remaining(run['deadline'],effective_now(db,team,run))
    elif pending and pending['source_run']==(run['id'] if run else None):
        available=pending['max_dispatches'];seconds=pending['duration_seconds']
    elif run:
        available=remaining(run['max_dispatches'],run['dispatches']);seconds=remaining(run['deadline'],team.host.clock())
    else:available=settings.get('max_dispatches');seconds=settings.get('duration_seconds')
    # Dispatch counters/revision may change while the operator fills the form;
    # concurrent budget changes and run transitions, however, must be reviewed.
    etag=hash_value({'page':page['page_id'],'run':{k:run[k] for k in ('id','state','reason','max_dispatches','deadline','final_granted')} if run else None,
                     'ended_final_attention':ended,
                     'settings':{k:settings.get(k) for k in ('budget_refill','max_dispatches','duration_seconds')}})
    active=db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",(page['thread_id'],)).fetchone()
    return {'scope':'current' if current else 'next','etag':etag,'run_id':run['id'] if run else None,
            'run_state':run['state'] if run else None,'used':run['dispatches'] if run else 0,'limit':run['max_dispatches'] if run else settings.get('max_dispatches'),
            'available_sends':available,'available_seconds':seconds,'deadline':run['deadline'] if current else None,
            'saved':bool(pending),'ended_final_turn':bool(ended),
            'unlimited_sends':available is None,'unlimited_time':seconds is None,
            'can_continue':bool(run and run['state']=='closed' and not active and (pending or (available is None and seconds is None)) and
                                (available is None or available>=2) and (seconds is None or seconds>=1))}


def refill(managed,db,p):
    object_fields(p,{'page_id','operation_id','expected_etag','add_dispatches','add_seconds'})
    managed.host.identifier(p['operation_id']);fingerprint=hash_value(p)
    old=db.execute('SELECT * FROM managed_budget_receipts WHERE id=?',(p['operation_id'],)).fetchone()
    if old:
        require(old['fingerprint']==fingerprint,'managed_budget_operation_conflict',409)
        return {**json.loads(old['response']),'replayed':True}
    integer(p['add_dispatches'],0,10000);integer(p['add_seconds'],0,604800)
    require(p['add_dispatches'] or p['add_seconds'],'managed_budget_empty')
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
    require(page and page['phase']=='bound' and not page['parent_target'],'managed_budget_controller_required',409)
    require(not db.execute("SELECT 1 FROM managed_handoffs WHERE source_page=? AND state IN ('prepared','enrolling','active')",(page['page_id'],)).fetchone(),'managed_resume_successor_instead',409)
    before=status(db,page,managed.host.team)
    require(before['etag']==p['expected_etag'],'managed_budget_changed',409)
    run=latest(db,page);settings=json.loads(page['settings'])
    if settings.get('conversation_mode')=='direct':
        if p['add_dispatches']:settings['max_dispatches']=(settings['max_dispatches'] if settings['max_dispatches'] is not None else before['used'])+p['add_dispatches']
        if p['add_seconds']:
            if before['deadline'] is None:
                settings['duration_seconds']=(settings['duration_seconds'] or 0)+p['add_seconds']
            else:settings['direct_budget_deadline']=max(before['deadline'],managed.host.clock())+p['add_seconds']
        db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
        fresh=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page['page_id'],)).fetchone()
        if status(db,fresh,managed.host.team)['can_continue']:
            db.execute("UPDATE managed_goals SET state='active',reason='budget_refilled',updated=? WHERE page_id=? AND state='needs_attention' AND reason='user_budget_exhausted'",(managed.host.clock(),page['page_id']))
    elif before['scope']=='current':
        ended=ended_final_attention(db,page,run);pending=settings.get('budget_refill')
        if ended and pending and pending['source_run']==run['id']:
            # Credit saved while the final turn was running belongs to this
            # original goal when that turn ends needing recovery. It already
            # includes unused sends; do not count them a second time.
            ceiling=run['dispatches']+pending['max_dispatches']+p['add_dispatches'] if pending['max_dispatches'] is not None else None
            deadline=effective_now(db,managed.host.team,run)+pending['duration_seconds']+p['add_seconds'] if pending['duration_seconds'] is not None else None
            settings.pop('budget_refill',None)
            db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
        else:
            ceiling=(run['max_dispatches']+p['add_dispatches'] if run['max_dispatches'] is not None else
                     run['dispatches']+p['add_dispatches'] if p['add_dispatches'] else None)
            deadline=(max(run['deadline'] or effective_now(db,managed.host.team,run),effective_now(db,managed.host.team,run))+p['add_seconds']
                      if p['add_seconds'] else run['deadline'])
        require((ceiling is None or ceiling<=2**53-1) and (deadline is None or deadline<253402300799),'managed_budget_too_large')
        db.execute('UPDATE host_runs SET max_dispatches=?,deadline=?,revision=revision+1 WHERE id=?',(ceiling,deadline,run['id']))
        # Saving credit is not permission to resume a drained/paused branch.
        # A still-running team continues its existing authorized work normally.
        held=db.execute("SELECT * FROM host_team_maintenance WHERE run_id=? AND state='settled'",(run['id'],)).fetchone()
        if not held and (ended or (run['state']=='draining' and run['reason'] in ('deadline','turn_budget'))):
            db.execute("UPDATE host_runs SET state='paused',reason='budget_refill' WHERE id=?",(run['id'],))
            if not page['paused']:db.execute("INSERT OR REPLACE INTO managed_pause_owners VALUES(?,'budget_refill',NULL)",(page['page_id'],))
            db.execute('UPDATE managed_pages SET paused=1 WHERE page_id=?',(page['page_id'],))
        # Maintenance retains its checkpoint and pause, while an exhausted
        # previous state becomes eligible to run only on explicit maintenance resume.
        if held and (ceiling is None or ceiling>run['dispatches']+1) and (deadline is None or deadline>held['settled']):
            prior=json.loads(held['checkpoint'])['run']
            if held['previous_state']=='draining' and prior['reason'] in ('deadline','turn_budget'):
                db.execute("UPDATE host_team_maintenance SET previous_state='running' WHERE run_id=?",(run['id'],))
    else:
        sends=(before['available_sends']+p['add_dispatches'] if before['available_sends'] is not None else p['add_dispatches'] or None)
        seconds=(int(before['available_seconds'])+p['add_seconds'] if before['available_seconds'] is not None else p['add_seconds'] or None)
        require((sends is None or sends<=10000) and (seconds is None or seconds<=604800),'managed_budget_next_window_too_large')
        # Retain unused credit; the next window starts at its actual Send, not
        # when the user saves. The closed run and its replies stay immutable.
        settings['budget_refill']={'source_run':run['id'] if run else None,'max_dispatches':sends,'duration_seconds':seconds}
        db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
    fresh=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page['page_id'],)).fetchone()
    result={'state':'budget_refilled','budget':status(db,fresh,managed.host.team),'model_sends':0,'paused_preserved':True,'replayed':False}
    managed.host.emit(db,page['thread_id'],'managed_budget_refilled',{'run_id':run['id'] if run else None,'scope':before['scope'],
      'add_dispatches':p['add_dispatches'],'add_seconds':p['add_seconds'],'operation_id':p['operation_id'],'model_sends':0})
    db.execute('INSERT INTO managed_budget_receipts VALUES(?,?,?,?)',(p['operation_id'],fingerprint,canonical(result),stamp()))
    return result


def ready_to_start(db,page,now=None):
    import time
    direct=direct_values(db,page,time.time() if now is None else now)
    if direct is not None:
        require((direct['available_sends'] is None or direct['available_sends']>=1) and
                (direct['available_seconds'] is None or direct['available_seconds']>0),'managed_budget_needs_time_and_sends',409)
        return
    pending=json.loads(page['settings']).get('budget_refill')
    if pending:
        require((pending['max_dispatches'] is None or pending['max_dispatches']>=2) and (pending['duration_seconds'] is None or pending['duration_seconds']>=1),'managed_budget_needs_time_and_sends',409)
        run=latest(db,page)
        require(not run or run['state']=='closed','managed_budget_wait_for_close',409)
        require(pending['source_run']==(run['id'] if run else None),'managed_budget_source_changed',409)


def continuation(managed,db,page_id,expected_run_id):
    page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(page_id,)).fetchone()
    require(page and not page['parent_target'],'managed_budget_controller_required',409)
    view=status(db,page,managed.host.team)
    require(view.get('run_id')==expected_run_id,'managed_budget_source_changed',409)
    require(view.get('can_continue'),'managed_budget_continuation_not_ready',409)
    ready_to_start(db,page)
    return {'objective':'继续本数学或开发任务的原目标。用户已经续杯，仍使用本对话及自己的 Session。先读取 managed context 的 budget_continuation：核对原目标、最新检查点、旧成果及取消/受阻工作，再安排未完成的实质工作。已完成工作不重做；已受理或未知执行先核对原操作，单次工具拒绝按当前用户恢复约定处理，旧取消项不自动重建。保留原定义、证据边界及用户约束。'}


def resume_operator(managed,db,page):
    # The desktop Resume is an explicit operator action on this controller.
    # Page and run pauses must change in the same transaction, regardless of
    # the human-readable reason originally supplied by the controller.
    if page['parent_target']:return
    request=db.execute("SELECT id FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(page['thread_id'],)).fetchone()
    run=managed.host.team.run_for_request(db,request['id']) if request else None
    ended=ended_final_attention(db,page,run)
    if not run or (run['state']!='paused' and not ended):return
    require(not managed.host.team.maintenance.held(db,run['id']),'team_use_resume_maintenance',409)
    require(not run['final_granted'] or ended or not db.execute(
      'SELECT 1 FROM managed_attention WHERE request_id=?',(request['id'],)).fetchone(),
      'managed_resume_finalizing',409)
    pending=json.loads(page['settings']).get('budget_refill')
    if ended and pending and pending['source_run']==run['id']:
        require((pending['max_dispatches'] is None or pending['max_dispatches']>=2) and (pending['duration_seconds'] is None or pending['duration_seconds']>=1),'managed_budget_needs_time_and_sends',409)
        settings=json.loads(page['settings']);settings.pop('budget_refill',None)
        db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
        db.execute('UPDATE host_runs SET max_dispatches=?,deadline=? WHERE id=?',
                   (run['dispatches']+pending['max_dispatches'] if pending['max_dispatches'] is not None else None,managed.host.clock()+pending['duration_seconds'] if pending['duration_seconds'] is not None else None,run['id']))
        run=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run['id'],)).fetchone())
    require(deadline_live(run,managed.host.clock()),'managed_resume_window_expired',409)
    require(sends_available(run,1,1),'managed_resume_sends_exhausted',409)
    # final_granted describes the exhausted window. Only the explicit operator
    # Resume, after this exact final turn ended, starts another window of the
    # same request. Its original final dispatch and send counters stay intact.
    if ended:
        db.execute("UPDATE host_runs SET state='running',reason='',final_granted=0,revision=revision+1 WHERE id=?",(run['id'],))
    else:
        db.execute("UPDATE host_runs SET state='running',reason='',revision=revision+1 WHERE id=?",(run['id'],))
    managed.host.emit(db,page['thread_id'],'managed_operator_resumed_run',{
      'run_id':run['id'],'request_id':request['id'],'previous_reason':run['reason'],
      'original_claims_preserved':True,'model_sends':0,
      **({'ended_final_attempt':ended['attempt_id'],'budget_window_reopened':True} if ended else {})})


def context(db,run_id):
    row=db.execute('SELECT context FROM managed_budget_links WHERE run_id=?',(run_id,)).fetchone()
    return json.loads(row[0]) if row else None


def link_run(managed,db,page,new_run,pending):
    source=pending.get('source_run')
    if source:
        run=db.execute('SELECT * FROM host_runs WHERE id=?',(source,)).fetchone()
        request=db.execute('SELECT text FROM host_requests WHERE id=?',(run['controller_request'],)).fetchone()
        checkpoints=[dict(r) for r in db.execute('''SELECT s.thread_id,s.version,s.summary,s.refs,s.hash,s.basis_seq
          FROM host_team_snapshots s WHERE s.run_id=? AND s.version=(SELECT MAX(t.version) FROM host_team_snapshots t WHERE t.run_id=s.run_id AND t.thread_id=s.thread_id)''',(source,))]
        for c in checkpoints:c['references']=json.loads(c.pop('refs'))
        artifacts=[dict(r) for r in db.execute('SELECT path,sha256,bytes,source FROM managed_artifacts WHERE request_id=?',(run['controller_request'],))]
        children=[dict(r) for r in db.execute('''SELECT w.request_id,q.phase,q.cancel_requested,q.claim_id,p.target_id,p.title
          FROM host_team_work w JOIN host_requests q ON q.id=w.request_id LEFT JOIN managed_pages p ON p.thread_id=q.thread_id WHERE w.run_id=?''',(source,))]
        prior=context(db,source)
        facts={'source_run':managed.host.team.public_run(run),'original_goal':prior['original_goal'] if prior else request['text'],
          'previous_context_run':source,'checkpoints':checkpoints,'controller_artifacts':artifacts,'previous_work':children,
          'prior_sends':run['dispatches']+(prior.get('prior_sends',0) if prior else 0),
          'instructions':'Keep the original conversation, project constraints and evidence. Reuse prior results; cancelled work is not automatically revived. Read original run results when needed; this is not proof of external Job completion.'}
        db.execute('INSERT INTO managed_budget_links VALUES(?,?,?)',(new_run,source,canonical(facts)))
    settings=json.loads(page['settings']);settings.pop('budget_refill',None)
    settings.update(max_dispatches=pending['max_dispatches'],duration_seconds=pending['duration_seconds'])
    db.execute('UPDATE managed_pages SET settings=? WHERE page_id=?',(canonical(settings),page['page_id']))
