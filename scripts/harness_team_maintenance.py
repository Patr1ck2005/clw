"""Drain accepted Web turns without creating a model turn or discarding queues."""
import json
import hashlib
from harness_run_limits import deadline_live,sends_available
from pathlib import Path
from harness_state import require,canonical,stamp
from harness_team_common import object_fields,text,hash_value

class Maintenance:
    def __init__(self,team):self.team=team
    @staticmethod
    def schema(db):
        db.executescript('''CREATE TABLE IF NOT EXISTS host_team_maintenance(
          run_id TEXT PRIMARY KEY,state TEXT NOT NULL,reason TEXT NOT NULL,
          requested REAL NOT NULL,settled REAL,previous_state TEXT NOT NULL,
          checkpoint TEXT,checkpoint_hash TEXT,revision INTEGER NOT NULL DEFAULT 1);''')
        db.executescript('''CREATE TABLE IF NOT EXISTS host_maintenance_execution_checks(
          run_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,
          evidence_path TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,checked REAL NOT NULL,
          PRIMARY KEY(run_id,request_id));''')
    @staticmethod
    def held(db,run_id):
        return bool(db.execute("SELECT 1 FROM host_team_maintenance WHERE run_id=? AND state IN ('holding','settled')",(run_id,)).fetchone())
    @staticmethod
    def pages(db,run_id):
        return [dict(r) for r in db.execute('''WITH RECURSIVE members AS (
          SELECT p.* FROM managed_pages p JOIN host_runs r ON r.controller_thread=p.thread_id WHERE r.id=?
          UNION ALL SELECT c.* FROM managed_pages c JOIN members p ON c.parent_target=p.target_id)
          SELECT page_id,target_id,thread_id,parent_target,phase,paused,bootstrap_state,url,model,effort FROM members''',(run_id,))]
    def for_page(self,db,page_id):
        row=db.execute('SELECT page_id,parent_target,thread_id FROM managed_pages WHERE page_id=?',(page_id,)).fetchone();seen=set()
        while row and row['page_id'] not in seen:
            seen.add(row['page_id'])
            run=db.execute("SELECT m.run_id FROM host_team_maintenance m JOIN host_runs r ON r.id=m.run_id WHERE r.controller_thread=? AND m.state IN ('holding','settled')",(row['thread_id'],)).fetchone()
            if run:return self.status(db,run['run_id'])
            row=db.execute('SELECT page_id,parent_target,thread_id FROM managed_pages WHERE target_id=?',(row['parent_target'],)).fetchone() if row['parent_target'] else None
        return None
    def blockers(self,db,run_id):
        run=db.execute('SELECT controller_request FROM host_runs WHERE id=?',(run_id,)).fetchone()
        requests=[run[0]]+[r[0] for r in db.execute('SELECT request_id FROM host_team_work WHERE run_id=?',(run_id,))]
        keys=','.join('?' for _ in requests)
        waiting=[{'kind':'web_turn','attempt_id':r['id'],'request_id':r['request_id'],'delivery':r['state']} for r in db.execute(f'''
          SELECT a.id,a.request_id,a.state FROM control_attempts a LEFT JOIN control_browser_receipts br ON br.attempt_id=a.id
          WHERE a.request_id IN ({keys}) AND (a.state IN ('dispatching','sent','unknown') OR
          (a.state='acknowledged' AND br.result_hash IS NULL AND NOT EXISTS(
          SELECT 1 FROM events e WHERE e.kind='control_browser_result_failed' AND json_extract(e.data,'$.attempt_id')=a.id)))''',requests)]
        for p in self.pages(db,run_id):
            if p['phase']!='bound' and p['bootstrap_state']!='pending':waiting.append({'kind':'enrollment','page_id':p['page_id']})
            if p['thread_id'] and db.execute("SELECT 1 FROM operations WHERE thread_id=? AND state IN ('reserved','dispatching','unknown') LIMIT 1",(p['thread_id'],)).fetchone():waiting.append({'kind':'unknown_local_operation','page_id':p['page_id']})
        # A writer/resource lease retained after an exceptional end requires its
        # original execution to be reconciled; never certify it from DOM silence.
        for r in db.execute("SELECT request_id FROM host_team_leases WHERE run_id=? AND (access='write' OR resources<>'[]')",(run_id,)):
            verified=db.execute('''SELECT 1 FROM host_maintenance_execution_checks v
              JOIN managed_attention m ON m.request_id=v.request_id AND m.attempt_id=v.attempt_id
              JOIN control_browser_receipts b ON b.attempt_id=v.attempt_id AND b.result_hash=v.receipt_hash
              JOIN managed_pages p ON p.thread_id=b.thread_id AND p.paused=1
              WHERE v.run_id=? AND v.request_id=? AND v.attempt_id=(
                SELECT id FROM control_attempts WHERE request_id=v.request_id ORDER BY offered DESC LIMIT 1)''',(run_id,r[0])).fetchone()
            if not verified and not any(x.get('request_id')==r[0] for x in waiting):waiting.append({'kind':'execution_lease','request_id':r[0]})
        return waiting
    def confirm_execution_idle(self,db,actor,p):
        """Operator audit permits maintenance only; never releases a lease or resumes a refused call."""
        object_fields(p,{'run_id','request_id','attempt_id','evidence_path','evidence_sha256'})
        run=self.team.owned(db,actor,p['run_id'])
        require(db.execute("SELECT 1 FROM host_team_maintenance WHERE run_id=? AND state='holding'",(run['id'],)).fetchone(),'team_maintenance_not_holding',409)
        require(db.execute('SELECT 1 FROM host_team_leases WHERE run_id=? AND request_id=?',(run['id'],p['request_id'])).fetchone(),'team_maintenance_lease_missing',409)
        receipt=db.execute('''SELECT b.result_hash FROM control_browser_receipts b
          JOIN managed_attention m ON m.attempt_id=b.attempt_id AND m.request_id=b.request_id
          JOIN managed_pages g ON g.thread_id=b.thread_id AND g.paused=1
          WHERE b.attempt_id=? AND b.request_id=?''',(p['attempt_id'],p['request_id'])).fetchone()
        require(receipt and receipt[0],'team_maintenance_turn_not_saved',409)
        evidence=Path(p['evidence_path']).resolve()
        require(evidence.is_relative_to((self.team.host.root/'evidence').resolve()) and evidence.is_file(),'team_maintenance_evidence_path',409)
        raw=evidence.read_bytes()
        require(len(raw)<1048576 and hashlib.sha256(raw).hexdigest()==p['evidence_sha256'],'team_maintenance_evidence_changed',409)
        proof=json.loads(raw);result=proof.get('result',{}).get('structuredContent',{});output=result.get('output',{});focus=output.get('focus',{});jobs=output.get('jobs',{})
        require(proof.get('source')=='Local-MCP-B.runtime_status' and 0<=self.team.host.clock()-proof.get('observed_at',0)<=300
          and result.get('success') is True and not result.get('error') and focus.get('connected') is True
          and isinstance(focus.get('client_id'),str) and focus['client_id']
          and all(jobs.get(k)==0 for k in ('active_count','running_count','queued_count')),
          'team_maintenance_external_execution_not_idle',409)
        db.execute('INSERT OR REPLACE INTO host_maintenance_execution_checks VALUES(?,?,?,?,?,?,?)',
          (run['id'],p['request_id'],p['attempt_id'],receipt[0],str(evidence),p['evidence_sha256'],self.team.host.clock()))
        self.team.host.emit(db,actor['thread_id'],'team_maintenance_execution_verified',{'run_id':run['id'],'request_id':p['request_id'],
          'attempt_id':p['attempt_id'],'evidence_sha256':p['evidence_sha256'],'lease_retained':True,'attention_retained':True,'model_called':False})
        self.reconcile(db,run['id']);return self.status(db,run['id'])
    def status(self,db,run_id):
        row=db.execute('SELECT * FROM host_team_maintenance WHERE run_id=?',(run_id,)).fetchone()
        if not row:return None
        return {k:row[k] for k in ('run_id','state','reason','requested','settled','checkpoint_hash','revision')}|{
          'pending':self.blockers(db,run_id) if row['state']=='holding' else [],'model_called':False,
          'execution_checks':[dict(r) for r in db.execute('SELECT request_id,attempt_id,evidence_path,evidence_sha256,checked FROM host_maintenance_execution_checks WHERE run_id=?',(run_id,))],
          'external_jobs_verified':False,'scope':'managed_turns_and_local_ledger; verify Local-MCP Jobs before process restart'}
    def request(self,db,actor,p):
        object_fields(p,{'run_id','reason'});run=self.team.owned(db,actor,p['run_id'])
        require(run['state']!='closed','team_run_closed',409);reason=text(p['reason'],'reason',2000)
        if not self.held(db,run['id']):
            db.execute('''INSERT INTO host_team_maintenance VALUES(?,'holding',?,?,NULL,?,NULL,NULL,1)
              ON CONFLICT(run_id) DO UPDATE SET state='holding',reason=excluded.reason,requested=excluded.requested,
              settled=NULL,previous_state=excluded.previous_state,checkpoint=NULL,checkpoint_hash=NULL,revision=revision+1''',
              (run['id'],reason,self.team.host.clock(),run['state']))
            self.team.host.emit(db,actor['thread_id'],'team_quiesce_requested',{'run_id':run['id'],'request_id':run['controller_request'],'model_called':False})
        self.reconcile(db,run['id']);return self.status(db,run['id'])
    def reconcile(self,db,run_id):
        row=db.execute("SELECT * FROM host_team_maintenance WHERE run_id=? AND state='holding'",(run_id,)).fetchone()
        if not row or self.blockers(db,run_id):return
        run=dict(db.execute('SELECT * FROM host_runs WHERE id=?',(run_id,)).fetchone())
        snapshot={'run':run,'pages':self.pages(db,run_id),
          'execution_checks':[dict(r) for r in db.execute('SELECT * FROM host_maintenance_execution_checks WHERE run_id=?',(run_id,))],
          'requests':[dict(r) for r in db.execute('''SELECT id,thread_id,phase,claim_id,cancel_requested FROM host_requests WHERE id=? OR id IN
            (SELECT request_id FROM host_team_work WHERE run_id=?) ORDER BY id''',(run['controller_request'],run_id))],
          'result_cursors':[dict(r) for r in db.execute('SELECT * FROM host_team_result_cursors WHERE run_id=?',(run_id,))],
          'result_reads':[dict(r) for r in db.execute('SELECT * FROM host_team_reads WHERE run_id=?',(run_id,))],
          'artifacts':[dict(r) for r in db.execute('''SELECT id,request_id,path,sha256,bytes,source FROM managed_artifacts WHERE request_id=? OR request_id IN
            (SELECT request_id FROM host_team_work WHERE run_id=?) ORDER BY id''',(run['controller_request'],run_id))]}
        db.execute("UPDATE host_team_maintenance SET state='settled',settled=?,checkpoint=?,checkpoint_hash=?,revision=revision+1 WHERE run_id=?",
          (self.team.host.clock(),canonical(snapshot),hash_value(snapshot),run_id))
        if run['state']!='closed':db.execute("UPDATE host_runs SET state='paused',reason='maintenance',revision=revision+1 WHERE id=?",(run_id,))
        self.team.host.emit(db,run['controller_thread'],'team_quiesced',{'run_id':run_id,'request_id':run['controller_request'],'model_called':False,'checkpoint_hash':hash_value(snapshot)})
    def resume(self,db,actor,p):
        object_fields(p,{'run_id'},{'checkpoint_hash','expected_revision'});run=self.team.owned(db,actor,p['run_id'])
        row=db.execute("SELECT * FROM host_team_maintenance WHERE run_id=? AND state IN ('holding','settled')",(run['id'],)).fetchone()
        require(row,'team_maintenance_checkpoint_changed',409)
        if row['state']=='holding':
            # Withdraw only this unfinished operator hold. This is not an idle
            # certificate: sends, leases, enrollment errors and user pauses stay.
            require(p.get('checkpoint_hash') is None and type(p.get('expected_revision')) is int
              and p['expected_revision']==row['revision'],'team_maintenance_intent_changed',409)
            db.execute("UPDATE host_team_maintenance SET state='resumed',revision=revision+1 WHERE run_id=?",(run['id'],))
            self.team.host.emit(db,actor['thread_id'],'team_maintenance_resumed',{'run_id':run['id'],
              'model_called':False,'original_claims_preserved':True,'pending_maintenance_withdrawn':True})
            return self.status(db,run['id'])|{'pending_maintenance_withdrawn':True}
        require(row['checkpoint_hash']==p.get('checkpoint_hash'),'team_maintenance_checkpoint_changed',409)
        if 'expected_revision' in p:
            require(type(p['expected_revision']) is int and p['expected_revision']==row['revision'],
              'team_maintenance_intent_changed',409)
        require(not self.blockers(db,run['id']),'team_maintenance_execution_changed',409)
        saved=json.loads(row['checkpoint'])
        require(hash_value(saved)==row['checkpoint_hash'],'team_maintenance_checkpoint_corrupt',409)
        for artifact in saved['artifacts']:
            file=Path(artifact['path'])
            require(file.is_file() and hashlib.sha256(file.read_bytes()).hexdigest()==artifact['sha256'],'team_maintenance_artifact_changed',409)
        for request in saved['requests']:
            current=db.execute('SELECT claim_id FROM host_requests WHERE id=?',(request['id'],)).fetchone()
            require(current and current['claim_id']==request['claim_id'],'team_maintenance_original_claim_changed',409)
        # Maintenance time is excluded, without replenishing sends or dropping
        # old results/claims/user pauses. An exhausted window resumes draining.
        if run['state']!='closed':
            state=row['previous_state']
            if state=='running' and (not deadline_live(run,row['settled']) or not sends_available(run,1,1)):state='draining'
            require(run['state']=='paused' and run['reason']=='maintenance','team_maintenance_pause_changed',409)
            db.execute('UPDATE host_runs SET state=?,reason=?,deadline=deadline+?,revision=revision+1 WHERE id=?',
              (state,saved['run']['reason'],max(0,self.team.host.clock()-row['settled']),run['id']))
        db.execute("UPDATE host_team_maintenance SET state='resumed',revision=revision+1 WHERE run_id=?",(run['id'],))
        self.team.host.emit(db,actor['thread_id'],'team_maintenance_resumed',{'run_id':run['id'],'request_id':run['controller_request'],'model_called':False,'original_claims_preserved':True})
        return self.status(db,run['id'])
