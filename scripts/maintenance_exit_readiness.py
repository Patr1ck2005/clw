"""Read-only exit proof from the original Host and its loaded transport.

Maintenance reconciles original carrier receipts and execution reservations.
Ordinary exit separately proves paused current carriers and idle Session/Jobs,
retaining unfinished business requests, claims, leases and goals. Neither mode
changes routes or releases work; no model or control is sent.
"""
from contextlib import closing
from pathlib import Path
import hashlib,json,os,re,sqlite3,time,uuid
from harness_state import require,HarnessError
from harness_team_common import hash_value
from harness_web import BUSY as NATIVE_WEB_BUSY
from live_transport import ObservationError

SOURCE='original_host_maintenance_readonly'
EXECUTION_KINDS={'web_turn','unknown_local_operation','execution_lease'}
REQUIRED={'metadata','threads','operations','host_requests','host_runs','host_bindings',
          'managed_pages','control_attempts','host_team_leases','host_team_work',
          'host_team_maintenance','host_maintenance_execution_checks'}
EMPTY_LEDGER_REQUIRED=REQUIRED|{'events','host_replies','web_bindings','web_outbox','web_seen'}

def empty_owned_ledger(db,tables,store_id):
    """Prove no local execution identity, including orphaned historical receipts.

    No Session is inferred from an empty bindings list. All original journal
    tables must be empty, including future tables and positive AUTOINCREMENT
    history; only the original store id is allowed in metadata. Native claims are lazily
    initialized, and their table, when present, is checked like every other one.
    This says nothing about external Jobs owned by other applications.
    """
    if not EMPTY_LEDGER_REQUIRED<=tables or len(tables)>512:return False
    if db.execute("SELECT 1 FROM metadata WHERE key IS NULL OR key<>'id' LIMIT 1").fetchone():return False
    identities=db.execute("SELECT value FROM metadata WHERE key='id' LIMIT 2").fetchall()
    if len(identities)!=1 or identities[0][0]!=store_id:return False
    if 'sqlite_sequence' in tables:
        # The schema seeds host_team_signals=0 even before the first event.
        # A positive/invalid counter or an orphan counter is retained history.
        for name,sequence in db.execute('SELECT name,seq FROM sqlite_sequence'):
            if name not in tables or type(sequence) is not int or sequence!=0:return False
    for name in sorted(tables-{'metadata','sqlite_sequence'}):
        quoted='"'+name.replace('"','""')+'"'
        if db.execute('SELECT 1 FROM '+quoted+' LIMIT 1').fetchone():return False
    return True

def empty_owned_jobs(store_id):
    return {'clientId':'no_execution_owner:'+store_id,'scopeCount':0,'currentSessionCount':0,
            'ownedActiveJobs':0,'inventoryComplete':True,'scopedFallback':False,
            'verification_scope':'empty_original_local_ledger_no_external_scope',
            'externalInventoryVerified':False}
def ledger_revision(path):
    result=[]
    for name in (path.name,path.name+'-wal'):
        file=path.with_name(name)
        try:
            s=file.stat();require(file.is_file(),'maintenance_ledger_unavailable',409)
            result.append([name,str(s.st_dev),str(s.st_ino),str(s.st_size),str(s.st_mtime_ns)])
        except FileNotFoundError:result.append([name,'absent'])
    return result
def revision_hash(revision):
    return hashlib.sha256(json.dumps(revision,separators=(',',':')).encode()).hexdigest()
def retained_request_evidence(db,service,request,terminal_replies=None):
    """Separate a finished carrier turn from an unfinished business request.

    A missing upstream Session is deliberately not evidence: the fixed server
    evicts records without closing their lifecycle. Only the original local
    receipt, absence of execution leases and the retained pause can move a
    request out of the current-call set. Its Session still owns original Jobs.
    """
    if db.execute('SELECT 1 FROM host_team_leases WHERE thread_id=? LIMIT 1',(request['thread_id'],)).fetchone():return None
    thread=db.execute('SELECT provider,status,active_turn FROM threads WHERE id=?',(request['thread_id'],)).fetchone()
    page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(request['thread_id'],)).fetchone()
    attempts=db.execute('''SELECT a.id,a.state,a.acknowledged,b.result_hash,b.completed,b.reply_id
        FROM control_attempts a LEFT JOIN control_browser_receipts b ON b.attempt_id=a.id
        AND b.request_id=a.request_id AND b.thread_id=a.thread_id
        WHERE a.request_id=? ORDER BY a.offered DESC,a.id DESC''',(request['id'],)).fetchall()
    # Manual receivers never belonged to this owner's browser executor. A
    # disabled queued/yielded receiver cannot execute another Host operation;
    # its active_turn is the durable waiting request, not an in-flight call.
    bindings=db.execute('SELECT enabled FROM host_bindings WHERE thread_id=?',(request['thread_id'],)).fetchall()
    if (not page and thread and thread['provider']=='chatgpt_web_host' and bindings and
        all(b['enabled']==0 for b in bindings) and thread['active_turn'] in (None,request['id']) and not attempts):
        if request['phase']=='queued' and not request['claim_id'] and thread['status']=='waiting':
            return {'code':'historical_disabled_manual_receiver','waitingState':'unclaimed_queue'}
        if request['phase']=='suspended' and thread['status']=='waiting_children':
            wait=db.execute("SELECT seq FROM events WHERE thread_id=? AND kind='host_waiting_children' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1",
                            (request['thread_id'],request['id'])).fetchone()
            if wait:return {'code':'historical_disabled_manual_receiver','waitingState':'yielded','eventSequence':wait['seq']}
    saved=[]
    retired=[]
    for attempt in attempts:
        if attempt['state']=='not_sent' and attempt['acknowledged'] is None:continue
        if attempt['state']=='partial_retired' and request['phase']=='blocked' and request['finished_at'] and thread and thread['active_turn'] is None:
            has_table=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_partial_retirements'").fetchone()
            row=db.execute('SELECT result FROM managed_partial_retirements WHERE request_id=? AND attempt_id=?',
                           (request['id'],attempt['id'])).fetchone() if has_table else None
            result=json.loads(row[0]) if row else None
            if (isinstance(result,dict) and result.get('request_id')==request['id'] and
                result.get('original_attempt_id')==attempt['id'] and result.get('status')=='blocked' and
                result.get('source')=='operator_retired_partial_public_send' and
                result.get('external_jobs_verified_zero') is True):
                retired.append(attempt['id']);continue
            return None
        if attempt['state']!='acknowledged':return None
        reply=db.execute('SELECT response FROM host_replies WHERE id=? AND request_id=?',
                         (attempt['reply_id'],request['id'])).fetchone()
        response=json.loads(reply[0]) if reply else None
        if (attempt['result_hash'] and re.fullmatch(r'[a-f0-9]{64}',attempt['result_hash']) and
            type(attempt['completed']) in (int,float) and isinstance(response,dict) and
            response.get('request_id')==request['id'] and response.get('thread_id')==request['thread_id'] and
            response.get('reply_id')==attempt['reply_id'] and
            response.get('phase') in ('completed','blocked','cancelled','needs_attention','yielded')):
            saved.append(attempt['id']);continue
        # An original public generation failure also settles this carrier turn;
        # it cannot erase a later pending acknowledged attempt.
        failure=db.execute("SELECT 1 FROM events WHERE thread_id=? AND kind='control_browser_result_failed' AND json_extract(data,'$.attempt_id')=? AND json_extract(data,'$.request_id')=? LIMIT 1",
                           (request['thread_id'],attempt['id'],request['id'])).fetchone()
        if not failure:return None
    phase=request['phase']
    paused=bool(page and service.host_bridge.managed.paused(db,page))
    if phase=='queued':
        if paused and request['claim_id'] is None and attempts and not saved and all(
                a['state']=='not_sent' and a['acknowledged'] is None for a in attempts):
            return {'code':'retained_not_sent_request','attemptId':attempts[0]['id']}
        return None
    if phase in ('processing','suspended'):
        if thread and thread['active_turn'] is None and paused and saved:
            return {'code':'retained_finished_browser_turn','attemptId':saved[0]}
        if phase=='suspended' and paused and not attempts:
            settings=json.loads(page['settings'])
            receipt=db.execute("SELECT e.seq FROM events e JOIN events w ON w.seq=json_extract(e.data,'$.source_event_seq') AND w.thread_id=e.thread_id AND w.kind='host_waiting_children' AND json_extract(w.data,'$.request_id')=? WHERE e.thread_id=? AND e.kind='managed_first_turn_reconciled' AND json_extract(e.data,'$.request_id')=? AND json_extract(e.data,'$.outcome')='yielded' AND json_extract(e.data,'$.proof')='own_session_receipt_and_unique_sent_bootstrap' AND e.seq>w.seq ORDER BY e.seq DESC LIMIT 1",
                               (request['id'],request['thread_id'],request['id'])).fetchone()
            if (receipt and settings.get('first_task_request_id')==request['id'] and
                settings.get('first_task_outcome')=='yielded'):
                return {'code':'retained_finished_first_turn','eventSequence':receipt['seq']}
        return None
    if phase not in ('blocked','handed_off') or not request['finished_at']:return None
    if saved:return {'code':'historical_finished_browser_turn','attemptId':saved[0]}
    if retired:return {'code':'historical_retired_partial_turn','attemptId':retired[0]}
    # A direct Host final reply can finish a request without a browser attempt.
    if terminal_replies is not None:return terminal_replies.get(request['id'])
    for row in db.execute('SELECT id,response FROM host_replies WHERE request_id=?',(request['id'],)):
        response=json.loads(row['response'])
        if (isinstance(response,dict) and response.get('request_id')==request['id'] and
            response.get('thread_id')==request['thread_id'] and response.get('reply_id')==row['id'] and
            response.get('phase') in ('completed','blocked','cancelled')):
            return {'code':'historical_terminal_host_receipt','replyId':row['id']}
    return None
def verify_page_bindings(db,page_bindings):
    """Match original descriptor identities in the same read-only snapshot.

    Closed descriptors are retained history, not a lifetime capacity limit.
    Read just the identity fields in batches; the public view also projects
    withdrawals, attention and artifacts, which would rescan history per page.
    Request/attempt precedence remains the public view's exact ordering.
    """
    if not page_bindings:return
    wanted_pages={binding['page_id'] for binding in page_bindings}
    pages={row['page_id']:row for row in db.execute('SELECT page_id,thread_id,url FROM managed_pages') if row['page_id'] in wanted_pages}
    threads=set()
    for expected in page_bindings:
        page=pages.get(expected['page_id'])
        require(page and page['thread_id']==expected['thread_id'] and page['url']==expected['url'],'maintenance_original_binding_unavailable',409)
        threads.add(page['thread_id'])
    requests={}
    for row in db.execute("SELECT id,thread_id,phase FROM host_requests ORDER BY thread_id,phase IN ('queued','processing','suspended') DESC,created_at DESC,rowid DESC"):
        if row['thread_id'] in threads:requests.setdefault(row['thread_id'],row)
    wanted_requests={row['id'] for row in requests.values()};attempts={}
    for row in db.execute('SELECT id,request_id FROM control_attempts ORDER BY request_id,offered DESC'):
        if row['request_id'] in wanted_requests:attempts.setdefault(row['request_id'],row['id'])
    for expected in page_bindings:
        request=requests.get(expected['thread_id'])
        require((request['id'] if request else None)==expected['request_id'] and
                (request['phase'] if request else None)==expected['request_phase'] and
                (attempts.get(request['id']) if request else None)==expected['attempt_id'],
                'maintenance_original_binding_unavailable',409)

def ledger_read(service,page_bindings=(),*,exit_mode='maintenance',paused_carriers=()):
    from ordinary_exit_readiness import checked,verified_carriers,retained_request
    ordinary=exit_mode=='ordinary'
    checked(service.host_bridge.active_business_operations==0,'maintenance_original_execution_unresolved',
            'host_operation',active_count=service.host_bridge.active_business_operations)
    path=service.state.path.resolve()
    require(path==(service.root/'.local/harness/harness.sqlite3').resolve(),'maintenance_original_store_changed',409)
    before=ledger_revision(path)
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=.3)) as db:
        db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        deadline=time.monotonic()+3;db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        require(REQUIRED<=tables,'maintenance_ledger_unavailable',409)
        # Ordinary quit checks current ownership; full ledger integrity belongs to maintenance.
        if not ordinary:
            require(db.execute('PRAGMA quick_check(1)').fetchone()[0]=='ok','maintenance_ledger_unavailable',409)
        store=db.execute("SELECT value FROM metadata WHERE key='id'").fetchone()
        require(store and store[0]==service.state.id,'maintenance_original_store_changed',409)
        for kind,query in (() if ordinary else (
            ('unknown_local_operation',"SELECT id AS operation_id,thread_id,action,state FROM operations WHERE state IN ('reserved','dispatching','unknown') LIMIT 1"),
            ('browser_send',"SELECT id AS attempt_id,request_id,thread_id,state FROM control_attempts WHERE state IN ('dispatching','sent','unknown') LIMIT 1"),
            ('native_turn',"SELECT id AS thread_id,active_turn,status FROM threads WHERE provider='codex' AND (active_turn IS NOT NULL OR status IN ('working','stopping','unknown')) LIMIT 1"))):
            row=db.execute(query).fetchone()
            checked(row is None,'maintenance_original_execution_unresolved',kind,**(dict(row) if row else {}))
        if not ordinary and 'native_work_claims' in tables:
            row=db.execute("SELECT * FROM native_work_claims WHERE state IS NULL OR state<>'released' LIMIT 1").fetchone()
            checked(row is None,'maintenance_original_execution_unresolved','native_claim',
                    **({k:row[k] for k in ('claim_id','owner_pid','state') if k in row.keys()} if row else {}))
        if not ordinary:
            row=db.execute("SELECT id AS thread_id,active_turn,status FROM threads WHERE provider='native_web' AND (active_turn IS NOT NULL OR status IN ("+','.join('?' for _ in NATIVE_WEB_BUSY)+")) LIMIT 1",sorted(NATIVE_WEB_BUSY)).fetchone()
            checked(row is None,'maintenance_original_execution_unresolved','native_web_turn',**(dict(row) if row else {}))
        if not ordinary and 'web_outbox' in tables:
            row=db.execute("SELECT request_id,thread_id,phase FROM web_outbox WHERE phase NOT IN ('completed','blocked','rejected') LIMIT 1").fetchone()
            checked(row is None,'maintenance_original_execution_unresolved','native_web_send',**(dict(row) if row else {}))
        if not ordinary:
            row=db.execute('''SELECT l.request_id,l.run_id,l.thread_id FROM host_team_leases l LEFT JOIN host_runs r ON r.id=l.run_id
                LEFT JOIN host_requests q ON q.id=l.request_id WHERE r.id IS NULL OR q.id IS NULL
                OR q.thread_id<>l.thread_id LIMIT 1''').fetchone()
            checked(row is None,'maintenance_original_execution_unresolved','orphan_execution_lease',**(dict(row) if row else {}))
        verify_page_bindings(db,page_bindings)
        carriers=verified_carriers(db,service,paused_carriers) if ordinary else {}
        original_requests={r['id']:r for r in db.execute("SELECT * FROM host_requests WHERE phase IN ('queued','processing','suspended')")}
        if ordinary:
            for thread in db.execute("SELECT id,active_turn FROM threads WHERE provider='chatgpt_web_host' AND active_turn IS NOT NULL"):
                request=db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?',(thread['active_turn'],thread['id'])).fetchone()
                checked(request is not None,'maintenance_original_execution_unresolved','host_carrier_identity',
                        thread_id=thread['id'],request_id=thread['active_turn'])
                original_requests[request['id']]=request
        bound_page_ids={binding['page_id'] for binding in page_bindings}
        ordinary_retained={request_id:retained_request(db,service,request,carriers,bound_page_ids=bound_page_ids)
                           for request_id,request in original_requests.items()} if ordinary else {}
        runs=db.execute("SELECT * FROM host_runs WHERE state<>'closed' OR id IN (SELECT run_id FROM host_team_leases)").fetchall()
        if not ordinary:require(len(runs)<=1024,'maintenance_ledger_unavailable',409)
        # Maintenance must reconcile carrier results and resource reservations.
        # Ordinary exit instead proves current execution directly above and
        # through the original Session/Job inventory below. Historical run
        # completion and maintenance checkpoints do not participate in quit.
        for run in (() if ordinary else runs):
            blockers=service.host_bridge.team.maintenance.blockers(db,run['id'])
            for blocker in blockers:
                kind=blocker.get('kind')
                if kind not in EXECUTION_KINDS:continue
                checked(False,'maintenance_original_execution_unresolved',kind,run_id=run['id'],
                        **{k:v for k,v in blocker.items() if k!='kind'})
            if run['state']!='closed':
                page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(run['controller_thread'],)).fetchone()
                checkpoint=db.execute("SELECT checkpoint,checkpoint_hash FROM host_team_maintenance WHERE run_id=? AND state='settled'",(run['id'],)).fetchone()
                held=bool(checkpoint and run['state']=='paused' and run['reason']=='maintenance' and hash_value(json.loads(checkpoint[0]))==checkpoint[1])
                require(held or page and service.host_bridge.managed.paused(db,page),'maintenance_original_execution_unresolved',409)
        needed={original_requests[key]['thread_id'] for key in ordinary_retained};retained=set();controllers={r['controller_request'] for r in runs};historical_attention=[];history_counts={}
        def history(item):
            # Match the existing public() projection's 256-item window. This
            # bounds diagnostics only, never the ledger or current-call/Job set.
            code=item['code'];history_counts[code]=history_counts.get(code,0)+1
            if len(historical_attention)<256:historical_attention.append(item)
        terminal_replies={}
        # host_replies.request_id has no index in legacy stores. One joined read
        # avoids a full receipt-table scan for each historical blocked request.
        replies=() if ordinary else db.execute("SELECT h.id,h.request_id,h.response,r.thread_id FROM host_replies h JOIN host_requests r ON r.id=h.request_id WHERE r.phase IN ('blocked','handed_off') AND r.finished_at IS NOT NULL ORDER BY h.id")
        for reply in replies:
            response=json.loads(reply['response'])
            if (isinstance(response,dict) and response.get('request_id')==reply['request_id'] and
                response.get('thread_id')==reply['thread_id'] and response.get('reply_id')==reply['id'] and
                response.get('phase') in ('completed','blocked','cancelled')):
                terminal_replies.setdefault(reply['request_id'],{'code':'historical_terminal_host_receipt','replyId':reply['id']})
        for request in db.execute("SELECT * FROM host_requests WHERE phase NOT IN ('completed','failed','cancelled') ORDER BY id"):
            if ordinary:
                evidence=ordinary_retained.get(request['id']) or {'code':'historical_business_request_retained'}
                history({'threadId':request['thread_id'],'requestId':request['id'],
                         'requestPhase':request['phase'],'businessOutcomePreserved':True,**evidence})
                continue
            evidence=retained_request_evidence(db,service,request,terminal_replies)
            page=db.execute('SELECT page_id FROM managed_pages WHERE thread_id=?',(request['thread_id'],)).fetchone()
            hold=service.host_bridge.team.maintenance.for_page(db,page['page_id']) if page and request['phase']=='blocked' else None
            if evidence or hold and hold['state']=='settled':
                if request['id'] in controllers:retained.add(request['id'])
                history({'threadId':request['thread_id'],'requestId':request['id'],
                    'requestPhase':request['phase'],'businessOutcomePreserved':True,**(evidence or {'code':'historical_settled_maintenance'})})
            else:needed.add(request['thread_id'])
        for run in (() if ordinary else runs):
            checkpoint=db.execute("SELECT checkpoint,checkpoint_hash FROM host_team_maintenance WHERE run_id=? AND state='settled'",(run['id'],)).fetchone()
            held=bool(checkpoint and run['state']=='paused' and run['reason']=='maintenance' and hash_value(json.loads(checkpoint[0]))==checkpoint[1])
            if run['state']!='closed' and not held and run['controller_request'] not in retained:needed.add(run['controller_thread'])
        if not ordinary:needed.update(r[0] for r in db.execute('SELECT thread_id FROM host_team_leases'))
        requests=() if ordinary else db.execute("SELECT thread_id FROM host_requests WHERE phase IN ('processing','suspended')")
        for request in requests:
            page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(request['thread_id'],)).fetchone()
            if page:
                hold=service.host_bridge.team.maintenance.for_page(db,page['page_id'])
                quiet=service.host_bridge.managed.paused(db,page) or hold and hold['state']=='settled'
            else:
                # Legacy manual inboxes have no automatic browser dispatch.
                # Their exact Session's current call/Jobs must still be read.
                thread=db.execute('SELECT provider FROM threads WHERE id=?',(request['thread_id'],)).fetchone()
                quiet=thread and thread[0]=='chatgpt_web_host'
            require(quiet,'maintenance_original_execution_unresolved',409)
        scopes=set();current_scopes=set();bound=set()
        # Bindings retain original Job ownership after a carrier turn ends.
        # Stream their history without a lifetime count gate; the current-call
        # set and the bounded diagnostic sample remain separate projections.
        for binding in db.execute('SELECT target_id,thread_id,spec FROM host_bindings'):
            try:spec=json.loads(binding['spec']);project,session=spec.get('project'),spec.get('session_id')
            except (ValueError,TypeError,AttributeError):spec=None;project=session=None
            if ordinary and isinstance(spec,dict) and spec.get('conversation_mode')=='direct':
                bound.add(binding['thread_id'])
                continue
            valid=isinstance(project,str) and 1<=len(project)<=512 and isinstance(session,str) and re.fullmatch(r'wc_sess_[A-Za-z0-9_-]{1,100}',session)
            if not valid:
                require(binding['thread_id'] not in needed,'maintenance_original_binding_unavailable',409)
                history({'targetId':binding['target_id'],'code':'historical_binding_unavailable'});continue
            scopes.add((project,session));bound.add(binding['thread_id'])
            if binding['thread_id'] in needed:current_scopes.add((project,session))
        require(needed<=bound,'maintenance_original_binding_unavailable',409)
        empty=empty_owned_ledger(db,tables,service.state.id)
        require(before==ledger_revision(path),'maintenance_original_store_changed',409)
    history_total=sum(history_counts.values())
    return {'scopes':scopes,'currentScopes':current_scopes,'historyAttention':historical_attention,
            'historyAttentionSummary':{'total':history_total,'byCode':history_counts,'sampleCount':len(historical_attention),'truncated':history_total>len(historical_attention)},
            'ledgerFingerprint':revision_hash(before),'runCount':len(runs),
            'emptyOriginalLocalLedger':empty}

def job_read(transport,scopes,deadline,current_scopes=(),*,exit_mode='maintenance'):
    from ordinary_exit_readiness import checked
    from harness_job_inventory import ACTIVE,UNCERTAIN,job_terminal
    require(exit_mode in ('maintenance','ordinary'),'maintenance_exit_mode_required',409)
    require(transport and isinstance(transport.client_id,str) and transport.client_id,'maintenance_jobs_unverified',409)
    client=transport.client_id
    require(all(not project.startswith('agent:') or project.split(':',2)[1]==client for project,_ in current_scopes),'maintenance_original_binding_unavailable',409)
    status=transport.post('status',{'compact':True,'client_id':client},deadline)
    focus=status.get('focus',{});counts=status.get('jobs',{})
    require(status.get('service')=='webcodex' and status.get('version')=='0.4.1' and focus.get('client_id')==client and focus.get('connected') is True,'maintenance_jobs_unverified',409)
    require(all(type(counts.get(k)) is int and counts[k]>=0 for k in ('active_count','running_count','queued_count')),'maintenance_jobs_unverified',409)
    # Current/retained original Sessions supply positive call/Job identity.
    # Historical grants alone are neither activity nor current ownership.
    missing_scopes=set();missing_sessions=[]
    for project,session in sorted(current_scopes):
        try:detail=transport.post('detail',{'project':project,'session_id':session,'limit':1},deadline)
        except ObservationError as error:
            if exit_mode!='ordinary' or error.code!='not_found':raise
            # SessionStore can evict metadata independently of retained Job
            # ownership. This remains a diagnostic, never a terminal Session
            # receipt; exact original-scope Job reads below are mandatory.
            missing_scopes.add((project,session))
            missing_sessions.append({'project':project,'session_id':session,'code':error.code,
                                     'businessStateRetained':True})
            continue
        checked(detail.get('session_id')==session and detail.get('running_call') is False,
                'maintenance_jobs_unverified','session_call',project=project,session_id=session,
                running_call=detail.get('running_call'),running_jobs=detail.get('running_jobs'))
        # Console detail samples Project-wide exact `running` Jobs before
        # selecting this Session. Its count/completeness cannot prove the
        # Session idle; the exact status inventories below do that.
    seen=set();scoped_fallback=bool(missing_scopes);owned_projects={project for project,_ in scopes};matched={}
    def rows_for(listing,state):
        jobs=listing.get('jobs') if isinstance(listing,dict) else None
        require(isinstance(jobs,list) and len(jobs)<=100 and
                type(listing.get('count')) is int and listing['count']==len(jobs) and
                type(listing.get('matched_count')) is int and listing['matched_count']>=len(jobs) and
                type(listing.get('truncated')) is bool and
                listing['truncated']==(listing['matched_count']>len(jobs)) and
                (not listing['truncated'] or len(jobs)==100) and
                all(isinstance(j,dict) and j.get('status')==state and
                    isinstance(j.get('job_id'),str) and j['job_id'] and
                    isinstance(j.get('project'),str) for j in jobs) and
                len({j['job_id'] for j in jobs})==len(jobs),'maintenance_jobs_unverified',409)
        return jobs
    def check_owned(job,project,session):
        checked(job.get('client_id')==client and (not project.startswith('agent:') or project.split(':',2)[1]==client),
                'maintenance_original_binding_unavailable','owned_job_identity',project=project,
                session_id=session,job_id=job['job_id'])
        checked(job['status'] not in ACTIVE,'maintenance_jobs_active','owned_jobs',project=project,
                session_id=session,job_ids=[job['job_id']],status=job['status'])
        checked(job_terminal(job),'maintenance_jobs_unverified','owned_job_outcome_unknown',project=project,
                session_id=session,job_id=job['job_id'],status=job['status'],
                command_execution_state=job.get('command_execution_state'))
    def scoped(state,selected_scopes=None):
        for project,session in sorted(scopes if selected_scopes is None else selected_scopes):
            selected=transport.post('jobs',{'project':project,'session_id':session,'status':state,'limit':100},deadline)
            jobs=rows_for(selected,state)
            require(all(j.get('project')==project and j.get('session_id')==session for j in jobs),'maintenance_jobs_unverified',409)
            for job in jobs:check_owned(job,project,session)
            checked(not selected['truncated'],'maintenance_jobs_unverified','owned_jobs_inventory_incomplete',
                    project=project,session_id=session,status=state,matched_count=selected['matched_count'])
    for state in ACTIVE+UNCERTAIN:
        listing=transport.post('jobs',{'status':state,'limit':100},deadline)
        jobs=rows_for(listing,state)
        # runtime_status is focused on this Runner; list_jobs may expose Jobs
        # from other visible Runners. Compare complete inventories at the same
        # focus instead of expanding unrelated activity into per-Session reads.
        matched[state]=sum(j.get('client_id')==client for j in jobs) if not listing['truncated'] else None
        if listing['truncated']:
            # The official list_jobs contract has exact Project/Session filters,
            # not a pagination cursor. Prove the owned scopes directly instead
            # of turning >100 unrelated Jobs into a permanent global blocker.
            scoped_fallback=True
            scoped(state,set(scopes)|missing_scopes)
            continue
        for job in jobs:
            key=job.get('job_id');require(isinstance(key,str) and key and key not in seen and job.get('status')==state,'maintenance_jobs_unverified',409);seen.add(key)
            require(isinstance(job.get('project'),str),'maintenance_jobs_unverified',409)
            if job['project'] in owned_projects:require(isinstance(job.get('session_id'),str),'maintenance_jobs_unverified',409)
            if (job['project'],job.get('session_id')) in scopes:
                check_owned(job,job['project'],job['session_id'])
        # A missing Session never borrows global zero as a call receipt.
        # Filter-before-limit proves all eight original status branches even
        # when every global list is empty and complete.
        if missing_scopes:scoped(state,missing_scopes)
    # runtime_status aggregates running+started and queued+agent_queued;
    # stop_requested/recovering count only toward active_count. A different
    # visibility or moving snapshot is resolved against original Sessions.
    groups=(('running_count',('running','started')),('queued_count',('queued','agent_queued')),('active_count',ACTIVE))
    if any(all(matched[s] is not None for s in states) and
           counts[key]!=sum(matched[s] for s in states) for key,states in groups):
        scoped_fallback=True
        for state in ACTIVE:scoped(state)
    return {'clientId':client,'scopeCount':len(scopes),'currentSessionCount':len(current_scopes),'ownedActiveJobs':0,'inventoryComplete':True,'scopedFallback':scoped_fallback,
            'missingSessions':missing_sessions}

def readiness(service,payload,*,retained_permit=None):
    from ordinary_exit_readiness import validate_payload,carrier_identity
    base={'store_id','ledger_fingerprint','page_bindings'}
    require(isinstance(payload,dict) and base<=set(payload)<=base|{'exit_mode','paused_carriers','permit_id'} and payload['store_id']==service.state.id,'maintenance_original_store_changed',409)
    exit_mode=payload.get('exit_mode','maintenance')
    require(exit_mode in ('maintenance','ordinary') and (exit_mode=='ordinary' or not {'paused_carriers','permit_id'}&set(payload)),
            'maintenance_exit_mode_required',409)
    require(isinstance(payload['ledger_fingerprint'],str) and re.fullmatch(r'[a-f0-9]{64}',payload['ledger_fingerprint']) and
            isinstance(payload['page_bindings'],list) and
            all(isinstance(b,dict) and set(b)=={'page_id','thread_id','url','request_id','request_phase','attempt_id'} and
                isinstance(b['page_id'],str) and 1<=len(b['page_id'])<=128 and isinstance(b['thread_id'],str) and 1<=len(b['thread_id'])<=128 and
                (b['url'] is None or isinstance(b['url'],str) and len(b['url'])<=2048) and all(b[k] is None or isinstance(b[k],str) and len(b[k])<=128 for k in ('request_id','request_phase','attempt_id')) for b in payload['page_bindings']) and
            len({b['page_id'] for b in payload['page_bindings']})==len(payload['page_bindings']),'maintenance_original_binding_unavailable',409)
    if exit_mode=='ordinary':validate_payload(payload.get('paused_carriers'),payload['page_bindings'])
    require(not service.closed,'maintenance_original_host_unavailable',409)
    require(retained_permit is not None or service.host_bridge.maintenance_exit_fence is None,'maintenance_original_host_shutdown_pending',409)
    try:
        with service.lock:
            original_transport=service.transport
            transport_identity=tuple(getattr(original_transport,k,None) for k in ('origin','client_id','namespace'))
            original_instance=service.instance
            refreshed=None
            if 'permit_id' in payload:
                saved=getattr(service,'_maintenance_exit_permit',None)
                refreshed=saved['proof'] if saved else None
                old=saved['payload'] if saved else {}
                require(retained_permit is None and refreshed and payload['permit_id']==refreshed['permitId'] and
                        refreshed['instanceId']==original_instance and refreshed.get('exitMode','maintenance')==exit_mode and
                        original_transport is saved['transport'] and transport_identity==saved['transportIdentity'] and
                        {k:v for k,v in payload.items() if k not in ('permit_id','paused_carriers')}=={k:v for k,v in old.items() if k!='paused_carriers'} and
                        [carrier_identity(c) for c in payload['paused_carriers']]==[carrier_identity(c) for c in old['paused_carriers']],
                        'maintenance_exit_requires_original_receipt',409)
            if retained_permit:require(retained_permit.get('exitMode','maintenance')==exit_mode,'maintenance_exit_requires_original_receipt',409)
            def read_local():
                if exit_mode=='ordinary':return ledger_read(service,payload['page_bindings'],exit_mode=exit_mode,paused_carriers=payload['paused_carriers'])
                return ledger_read(service,payload['page_bindings'])
            initial=read_local()
        require(initial['ledgerFingerprint']==payload['ledger_fingerprint'],'maintenance_original_store_changed',409)
        # The shared Runner and submitted external Jobs do not belong to the
        # desktop Host lifetime. Ordinary quit keeps them and their outcomes;
        # it is fenced by current browser observations and actual Host calls.
        # Maintenance still requires the complete original execution inventory.
        jobs=({'source':'independent_execution_retained','desktopShutdownBlocked':False,
               'remoteInventoryRead':False,'scopeCount':len(initial['scopes']),
               'currentSessionCount':len(initial['currentScopes'])} if exit_mode=='ordinary' else
              empty_owned_jobs(payload['store_id']) if initial['emptyOriginalLocalLedger'] else
              job_read(original_transport,initial['scopes'],time.monotonic()+12,initial['currentScopes'],exit_mode=exit_mode))
        with service.lock:
            require(not service.closed and service.instance==original_instance and service.transport is original_transport and tuple(getattr(original_transport,k,None) for k in ('origin','client_id','namespace'))==transport_identity,'maintenance_original_host_unavailable',409)
            if exit_mode=='ordinary':validate_payload(payload['paused_carriers'],payload['page_bindings'])
            final=read_local()
            require(not service.closed and service.instance==original_instance and service.transport is original_transport and tuple(getattr(original_transport,k,None) for k in ('origin','client_id','namespace'))==transport_identity,'maintenance_original_host_unavailable',409)
            require(initial['ledgerFingerprint']==final['ledgerFingerprint'],'maintenance_original_store_changed',409)
            require(initial['emptyOriginalLocalLedger']==final['emptyOriginalLocalLedger'],'maintenance_original_store_changed',409)
            require(initial['scopes']==final['scopes'] and initial['currentScopes']==final['currentScopes'],'maintenance_original_binding_unavailable',409)
            original_permit=retained_permit or refreshed
            proof={'version':1,'source':SOURCE,'idle':True,'exitMode':exit_mode,'permitId':original_permit['permitId'] if original_permit else uuid.uuid4().hex,'instanceId':service.instance,'hostPid':os.getpid(),'storeId':service.state.id,
                    'root':str(service.root),'observedAt':time.time(),'ledgerFingerprint':final['ledgerFingerprint'],
                    'jobs':jobs,'historyAttention':final['historyAttention'],'historyAttentionSummary':final['historyAttentionSummary'],
                    'modelCalled':False,'leaseReleaseAuthorized':False}
            if retained_permit is None:service._maintenance_exit_permit={'proof':json.loads(json.dumps(proof)),'payload':json.loads(json.dumps({k:v for k,v in payload.items() if k!='permit_id'})),
                'transport':original_transport,'transportIdentity':transport_identity}
            return proof
    except HarnessError:raise
    except ObservationError:require(False,'maintenance_jobs_unverified',409)
    except (OSError,ValueError,TypeError,KeyError,sqlite3.Error):
        require(False,'maintenance_ledger_unavailable',409)

def authorize_shutdown(service,payload):
    """Confirm only the original retained permit; never pause or release work."""
    fields={'instance_id','store_id','permit_id','ledger_fingerprint'}
    require(isinstance(payload,dict) and fields<=set(payload)<=fields|{'exit_mode'},'maintenance_exit_requires_original_receipt',409)
    with service.lock:
        saved=getattr(service,'_maintenance_exit_permit',None);proof=saved['proof'] if saved else None
        require(proof and {k:v for k,v in payload.items() if k!='exit_mode'}=={'instance_id':service.instance,'store_id':service.state.id,'permit_id':proof['permitId'],'ledger_fingerprint':proof['ledgerFingerprint']} and
                payload.get('exit_mode','maintenance')==proof.get('exitMode','maintenance'),'maintenance_exit_requires_original_receipt',409)
        require(service.transport is saved['transport'] and tuple(getattr(service.transport,k,None) for k in ('origin','client_id','namespace'))==saved['transportIdentity'],
                'maintenance_original_host_unavailable',409)
        original_payload=saved['payload']
    # Native may have needed time to exit. Recheck the exact loaded Sessions
    # and Jobs instead of treating a stale preflight as a shutdown receipt.
    fresh=readiness(service,original_payload,retained_permit=proof)
    with service.lock:
        require(fresh['ledgerFingerprint']==payload['ledger_fingerprint']==revision_hash(ledger_revision(service.state.path)),
                'maintenance_original_store_changed',409)
        service.host_bridge.seal_maintenance(payload['permit_id'])
        return {'kind':'original_host_maintenance_shutdown','state':'maintenance_shutdown_accepted',
                'exitMode':proof.get('exitMode','maintenance'),
                'instanceId':service.instance,'storeId':service.state.id,'permitId':payload['permit_id'],'hostPid':os.getpid(),
                'modelCalled':False,'pauseAuthorized':False,'leaseReleaseAuthorized':False}
