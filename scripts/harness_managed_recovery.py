"""Original ledger facts for recovery; never retry, acknowledge or extend a run."""
import json,hashlib
from harness_state import canonical, stamp


def reconcile_failed_identity(managed,db,page_id,observed,public):
    """Remounted public IDs may change only an original, never-sent recovery."""
    from harness_team_common import object_fields
    object_fields(public,{'url','marker','marker_count','history_at_latest','terminal_failure'})
    if public['terminal_failure'] not in ('Thinking failed','思考失败','无法思考',
            'Something went wrong while generating the response.','生成回复时出错'):
        return False
    failure_hash=hashlib.sha256(public['terminal_failure'].encode()).hexdigest()
    if (observed.get('failure_kind')!='generation_failed' or observed.get('failure_hash')!=failure_hash
            or not observed.get('controls_known') or any(observed.get(k) for k in ('generating','draft','composing','blocked'))
            or public['history_at_latest'] is not True or type(public['marker_count']) is not int or public['marker_count']!=1):
        return False
    page=db.execute("SELECT * FROM managed_pages WHERE page_id=? AND phase='bound'",(page_id,)).fetchone()
    if not page or page['url']!=public['url'] or managed.paused(db,page):return False
    request=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(page['thread_id'],)).fetchone()
    if not request or not request['claim_id'] or managed.host.collaboration.outstanding(db,request['id']):return False
    accepted=db.execute("SELECT * FROM control_attempts WHERE request_id=? AND generation=1 AND state='acknowledged' ORDER BY acknowledged DESC LIMIT 1",(request['id'],)).fetchone()
    if not accepted or public['marker']!=f'[CLW:{accepted["id"]}]':return False
    if not db.execute('SELECT 1 FROM managed_dispatches WHERE attempt_id=?',(accepted['id'],)).fetchone():return False
    if db.execute('SELECT 1 FROM control_browser_receipts WHERE attempt_id=?',(accepted['id'],)).fetchone():return False
    failure=db.execute("SELECT data FROM events WHERE kind='control_browser_result_failed' AND json_extract(data,'$.attempt_id')=? AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(accepted['id'],request['id'])).fetchone()
    if not failure or json.loads(failure['data']).get('failure_hash')!=failure_hash:return False
    if db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown')",(request['id'],)).fetchone():return False
    if db.execute('SELECT 1 FROM managed_partial_public_sends p JOIN control_attempts a ON a.id=p.attempt_id WHERE a.request_id=?',(request['id'],)).fetchone():return False
    key=hashlib.sha256((accepted['id']+':'+failure_hash).encode()).hexdigest()
    record=db.execute('SELECT * FROM control_recoveries WHERE request_id=? AND failure_hash=?',(request['id'],key)).fetchone()
    if not record:
        record=db.execute('SELECT * FROM control_recoveries WHERE request_id=? AND failure_hash=?',(request['id'],failure_hash)).fetchone()
        if record and accepted['acknowledged']>=record['due']:return False
    if not record or record['generation']!=1 or record['base_epoch']!=managed.control.epoch(db,request):return False
    current_hash=observed.get('user_hash')
    if not isinstance(current_hash,str) or len(current_hash)!=64 or any(c not in '0123456789abcdef' for c in current_hash) or current_hash==record['user_hash']:return False
    offered=db.execute("SELECT * FROM control_attempts WHERE request_id=? AND epoch=? AND generation=1 AND state='offered' AND dispatched IS NULL AND acknowledged IS NULL",(request['id'],-record['ordinal'])).fetchone()
    if not offered or offered['user_hash']!=record['user_hash']:return False
    db.execute('UPDATE control_recoveries SET user_hash=? WHERE request_id=? AND failure_hash=? AND user_hash=?',
               (current_hash,request['id'],record['failure_hash'],record['user_hash']))
    db.execute("UPDATE control_attempts SET user_hash=? WHERE id=? AND state='offered' AND dispatched IS NULL AND user_hash=?",
               (current_hash,offered['id'],record['user_hash']))
    managed.host.emit(db,page['thread_id'],'managed_failed_turn_identity_reconciled',{
        'request_id':request['id'],'attempt_id':accepted['id'],'offered_attempt_id':offered['id'],
        'previous_user_hash':record['user_hash'],'user_hash':current_hash,
        'proof':'unique_public_marker_and_saved_generation_failure','model_sends':0,
        'request_replayed':False,'claim_preserved':True})
    return True

def settle_saved_final(managed,db,binding):
    """A failed public ending cannot strand an authenticated, closed summary."""
    r=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1",(binding['thread_id'],)).fetchone()
    if not r:return False
    run=managed.host.team.run_for_request(db,r['id'])
    if not run or run['state']!='closed' or run['reason']!='controller_summary' or run['controller_request']!=r['id']:return False
    if managed.host.collaboration.outstanding(db,r['id']):return False
    if db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone():return False
    if db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown')",(r['id'],)).fetchone():return False
    summary=db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='team_final_summary' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(binding['thread_id'],r['id'])).fetchone()
    failure=db.execute("SELECT seq FROM events WHERE thread_id=? AND kind='control_browser_result_failed' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",(binding['thread_id'],r['id'])).fetchone()
    if not summary or not failure or failure['seq']<=summary['seq']:return False
    saved=json.loads(summary['data'])
    body='本轮已保存的工具总结（网页最终回答失败，由程序回收；不代表项目全部验收）：\n\n'+saved['text']
    if saved.get('references'):body+='\n\n交接引用：\n'+'\n'.join('- '+x for x in saved['references'])
    raw=body.encode();sha=hashlib.sha256(raw).hexdigest()
    dest=managed.state.path.parent/'managed-results'/(sha+'.md');dest.parent.mkdir(exist_ok=True)
    if not dest.exists():dest.write_bytes(raw)
    managed.host.project_reply(db,binding,dict(r),{'request_id':r['id'],'claim_id':r['claim_id'],'reply_id':'closed-summary-'+r['id'],'status':'completed','text':body[:46000]})
    db.execute('INSERT INTO managed_artifacts VALUES(?,?,?,?,?,?,?,?)',('closed-summary-'+r['id'],r['id'],binding['thread_id'],str(dest),sha,len(raw),'authenticated_team_final_summary',managed.host.clock()))
    db.execute("UPDATE control_attempts SET state='not_sent' WHERE request_id=? AND state='offered' AND dispatched IS NULL",(r['id'],))
    managed.host.emit(db,binding['thread_id'],'managed_saved_final_reconciled',{'request_id':r['id'],'source_event_seq':summary['seq'],'path':str(dest),'model_sends':0,'project_acceptance':False})
    return True


def schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS managed_recovery_contexts(
      request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(request_id,attempt_id))''')


def original_wait_receipt(db, request, attempt):
    """A committed wait in this exact tool turn, never a public claim of waiting."""
    if request['phase'] != 'suspended' or request['cancel_requested']:
        return None
    return db.execute('''SELECT e.seq FROM events e
      JOIN events sent ON sent.kind='control_dispatch'
        AND json_extract(sent.data,'$.attempt_id')=?
      WHERE e.thread_id=? AND e.kind='host_waiting_children'
        AND json_extract(e.data,'$.request_id')=? AND e.seq>sent.seq
        AND NOT EXISTS(SELECT 1 FROM control_attempts newer
          WHERE newer.request_id=? AND newer.acknowledged>?)
      ORDER BY e.seq DESC LIMIT 1''',
      (attempt['id'],request['thread_id'],request['id'],request['id'],attempt['acknowledged'])).fetchone()


def reconcile_wait_attention(managed, db):
    # Older code treated a remounted user id as attention-only even when the
    # same authenticated turn had already committed wait(). Correct just that
    # classification. Keep the original event, identity record, claim and pause.
    for entry in db.execute('''SELECT m.request_id,m.attempt_id FROM managed_attention m
      JOIN managed_unverified_identities u ON u.attempt_id=m.attempt_id
      JOIN control_browser_receipts br ON br.attempt_id=m.attempt_id
      WHERE br.result_hash IS NOT NULL''').fetchall():
        request=db.execute('SELECT * FROM host_requests WHERE id=?',(entry['request_id'],)).fetchone()
        attempt=db.execute('SELECT * FROM control_attempts WHERE id=?',(entry['attempt_id'],)).fetchone()
        wait=original_wait_receipt(db,request,attempt)
        if not wait:continue
        event=db.execute('''SELECT seq,data FROM events WHERE kind='host_turn_attention'
          AND json_extract(data,'$.attempt_id')=? ORDER BY seq DESC LIMIT 1''',(attempt['id'],)).fetchone()
        if not event or not json.loads(event['data']).get('missing_tool_outcome') or wait['seq']>=event['seq']:continue
        reply_id='clw-browser-reply-'+attempt['id'].removeprefix('control_')
        reply=db.execute('SELECT response FROM host_replies WHERE id=?',(reply_id,)).fetchone()
        if not reply or json.loads(reply['response']).get('phase')!='needs_attention':continue
        previous=json.loads(reply['response'])
        response={**previous,'phase':'yielded','source':'original_authenticated_wait_receipt'}
        db.execute('UPDATE host_replies SET response=? WHERE id=?',(canonical(response),reply_id))
        db.execute('DELETE FROM managed_attention WHERE request_id=? AND attempt_id=?',
                   (request['id'],attempt['id']))
        managed.host.emit(db,request['thread_id'],'managed_wait_receipt_reconciled',{
            'request_id':request['id'],'attempt_id':attempt['id'],'wait_event_seq':wait['seq'],
            'previous_attention_event_seq':event['seq'],'previous_response':previous,
            'claim_preserved':True,'pause_preserved':True,'model_sends':0,'task_completed':False})


def reconcile_closed_attention(managed, db):
    """A closed run with an authenticated failure is terminal, not still running."""
    for entry in db.execute('''SELECT m.request_id,m.attempt_id FROM managed_attention m
      JOIN host_requests r ON r.id=m.request_id
      JOIN managed_turn_outcomes o ON o.attempt_id=m.attempt_id AND o.kind='needs_attention'
      JOIN control_browser_receipts br ON br.attempt_id=m.attempt_id
      WHERE r.phase='processing' AND r.cancel_requested=0
        AND br.result_hash IS NOT NULL AND br.completed IS NOT NULL''').fetchall():
        r=db.execute('SELECT * FROM host_requests WHERE id=?',(entry['request_id'],)).fetchone()
        run=managed.host.team.run_for_request(db,r['id'])
        if not run or run['state']!='closed' or run['reason']!='controller_summary' or run['controller_request']!=r['id']:continue
        if managed.host.collaboration.outstanding(db,r['id']):continue
        if db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',(r['id'],)).fetchone():continue
        if db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown')",(r['id'],)).fetchone():continue
        artifact=db.execute("SELECT * FROM managed_artifacts WHERE id=? AND request_id=? AND source='local_mcp_public_result'",
                            (entry['attempt_id']+'-tool',r['id'])).fetchone()
        if not artifact:continue
        from pathlib import Path
        try:raw=Path(artifact['path']).read_bytes()
        except OSError:continue
        if hashlib.sha256(raw).hexdigest()!=artifact['sha256']:continue
        body=raw.decode('utf-8-sig')
        if len(body)>46000:body=body[:1000]+'\n完整结果：'+artifact['path']+'\nSHA256: '+artifact['sha256']
        binding=managed.host.binding(db,thread=r['thread_id'])
        managed.host.project_reply(db,binding,dict(r),{'request_id':r['id'],'claim_id':r['claim_id'],
            'reply_id':'closed-attention-'+r['id'],'status':'blocked','text':body})
        db.execute('DELETE FROM managed_attention WHERE request_id=?',(r['id'],))
        managed.host.emit(db,r['thread_id'],'managed_closed_attention_reconciled',{
            'request_id':r['id'],'attempt_id':entry['attempt_id'],'run_id':run['id'],
            'status':'blocked','original_claim_preserved':True,'pause_preserved':True,
            'model_sends':0,'task_completed':False})


def snapshot(db, team, request_id, attempt_id):
    request = db.execute('SELECT id,thread_id,claim_id,phase,cancel_requested FROM host_requests WHERE id=?', (request_id,)).fetchone()
    if not request:
        return None
    attempt = db.execute('SELECT id,request_id,dispatched,acknowledged FROM control_attempts WHERE id=? AND request_id=?', (attempt_id, request_id)).fetchone()
    if not attempt:
        return None
    event = db.execute("""SELECT seq,data,at FROM events WHERE kind='host_turn_attention'
        AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.attempt_id')=? ORDER BY seq DESC LIMIT 1""", (request_id, attempt_id)).fetchone()
    start = db.execute("""SELECT seq FROM events WHERE kind='control_dispatch'
        AND json_extract(data,'$.attempt_id')=? ORDER BY seq LIMIT 1""", (attempt_id,)).fetchone()
    # A legacy attempt without an event boundary cannot own all historic work.
    assigned = []
    if start:
        assigned = [dict(r) for r in db.execute('''SELECT d.child_request_id AS request_id,
            d.child_target_id AS target,h.phase,p.title,
            EXISTS(SELECT 1 FROM control_attempts a WHERE a.request_id=h.id AND a.dispatched IS NOT NULL) AS send_attempted
            FROM host_delegations d JOIN host_requests h ON h.id=d.child_request_id
            LEFT JOIN managed_pages p ON p.thread_id=h.thread_id
            WHERE d.parent_request_id=? AND d.child_request_id IN
              (SELECT json_extract(data,'$.child_request_id') FROM events WHERE kind='host_delegated'
               AND thread_id=? AND seq>? AND seq<=?) ORDER BY d.created_at LIMIT 65''',
            (request_id, request['thread_id'], start['seq'], event['seq'] if event else 2**63-1))]
    run = team.run_for_request(db, request_id)
    checkpoint = None
    counts = {}
    unread_results = 0
    if run:
        row = db.execute('''SELECT version,hash,basis_seq,summary,refs FROM host_team_snapshots
            WHERE run_id=? AND thread_id=? ORDER BY version DESC LIMIT 1''', (run['id'], request['thread_id'])).fetchone()
        if row:
            checkpoint = dict(row)
            checkpoint['summary'] = checkpoint['summary'][:1600]
            refs = json.loads(checkpoint.pop('refs'))
            checkpoint['references'] = refs[:16]
            checkpoint['references_truncated'] = len(refs) > 16
        counts = {r['phase']: r['n'] for r in db.execute('''SELECT h.phase,COUNT(*) AS n FROM host_team_work w
            JOIN host_requests h ON h.id=w.request_id WHERE w.run_id=? GROUP BY h.phase''', (run['id'],))}
        unread_results = db.execute('''SELECT COUNT(*) FROM host_team_work w JOIN host_requests h ON h.id=w.request_id
            WHERE w.run_id=? AND h.phase='completed' AND NOT EXISTS(SELECT 1 FROM host_team_reads r
            WHERE r.run_id=w.run_id AND r.controller_thread=? AND r.request_id=w.request_id)''', (run['id'], request['thread_id'])).fetchone()[0]
    receipt = db.execute('SELECT result_hash,completed FROM control_browser_receipts WHERE attempt_id=?', (attempt_id,)).fetchone()
    outcome = db.execute('SELECT kind FROM managed_turn_outcomes WHERE attempt_id=?', (attempt_id,)).fetchone()
    artifacts=[dict(r) for r in db.execute('SELECT path,sha256,bytes,source FROM managed_artifacts WHERE request_id=? ORDER BY created',(request_id,))]
    return {'source': 'original_local_ledger', 'request': dict(request), 'attempt': dict(attempt),
            'attention_at': event['at'] if event else None,
            'missing_tool_outcome': bool(event and json.loads(event['data']).get('missing_tool_outcome')),
            'browser_reply_saved': bool(receipt and receipt['result_hash']), 'tool_outcome': outcome['kind'] if outcome else None,
            'assignments_in_ended_turn': assigned[:64], 'assignments_truncated': len(assigned)>64,
            'run': team.public_run(run) if run else None, 'latest_checkpoint': checkpoint,
            'children_by_phase': counts, 'unread_completed_results': unread_results,
            'saved_turn_artifacts':artifacts,
            'external_jobs': 'not_verified_by_this_ledger', 'automatic_retry_authorized': False,
            'next_action': 'reconcile_then_close_original_run' if run and run['state']=='draining' else 'reconcile_original_execution_before_continuing'}


def current(db, team, thread):
    row = db.execute('''SELECT a.request_id,a.attempt_id FROM managed_attention a JOIN host_requests r ON r.id=a.request_id
        WHERE r.thread_id=? AND (r.phase IN ('processing','suspended') OR
          (r.phase='queued' AND EXISTS(SELECT 1 FROM managed_partial_public_sends p
            WHERE p.attempt_id=a.attempt_id))) ORDER BY r.created_at DESC LIMIT 1''', (thread,)).fetchone()
    return snapshot(db, team, row['request_id'], row['attempt_id']) if row else None


def saved(db, request_id):
    row = db.execute('SELECT snapshot FROM managed_recovery_contexts WHERE request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', (request_id,)).fetchone()
    return json.loads(row['snapshot']) if row else None


def preserve(db, team, request_id):
    attention = db.execute('SELECT attempt_id FROM managed_attention WHERE request_id=?', (request_id,)).fetchone()
    facts = snapshot(db, team, request_id, attention['attempt_id']) if attention else None
    if facts:
        db.execute('INSERT OR IGNORE INTO managed_recovery_contexts VALUES(?,?,?,?)', (request_id, attention['attempt_id'], canonical(facts), stamp()))
    return facts


def continuation_note(facts):
    if not facts:
        return ''
    checkpoint = facts['latest_checkpoint']
    run = facts['run']
    brief = {'原请求': facts['request']['id'], '原回合': facts['attempt']['id'],
             '最新检查点': {k:checkpoint[k] for k in ('version','hash','basis_seq')} if checkpoint else None,
             '上一回合已派发': facts['assignments_in_ended_turn'][:16],
             '列表有省略': facts['assignments_truncated'] or len(facts['assignments_in_ended_turn'])>16,
             '子任务当前状态': facts['children_by_phase'], '运行': run}
    brief['原成果文件']=facts.get('saved_turn_artifacts',[])
    return ('\n程序核对的原执行事实（不是网页自述，也不是新任务）：\n'+canonical(brief)+
            '\n已派发、已读成果和检查点不能因网页声称“未执行”而重做。context 的 recovery_context 含完整核对记录；当前运行状态以 context.run 为准。'
            '核对原 Job 与磁盘；已受理或未知执行不得盲重放，用户停止保留。单次工具拒绝按当前用户恢复授权处理，保留原错误和已完成工作。'+
            (' 本运行已经进入收尾，只读取并核销现有结果、保存交接、close；不得重建取消任务、开启新一批或延长预算。' if run and run['state']=='draining' else ''))
