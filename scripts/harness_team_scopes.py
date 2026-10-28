"""Conservative execution-scope admission on the existing Host request journal.

This is a managed scheduling fence, not a replacement for native Runtime ACLs or
an OS sandbox. Unknown/legacy execution remains globally conflicting. Leases are
not released on timers or a lost browser; only original terminal/yield evidence.
"""
from __future__ import annotations
import json,os,re,sqlite3
from contextlib import closing
from pathlib import Path
from harness_state import require,canonical,HarnessError
from harness_team_common import object_fields,text,names,hash_value
from harness_workspace_paths import relative_write_path,write_paths as normalized_write_paths
from harness_workspace_probe import inspect_git
from native_work_admission import AdmissionError,_git_common_dir,pure_scope_blocker,implicit_unity_writer,resource_keys,stable_git_marker

ACTIVE={'working','stopping','unknown','processing','web_waiting','web_processing'}

def plain_root(raw):
    text(raw,'root',2048);p=Path(raw)
    require(p.is_absolute() and p.exists() and p.is_dir(),'team_workspace_root_missing')
    for x in (p,*p.parents):
        require(not x.is_symlink() and not (getattr(x.lstat(),'st_file_attributes',0)&0x400),'team_workspace_link_forbidden',403)
    return os.path.normcase(str(p.resolve()))

def relative(raw):
    return relative_write_path(raw)

def validate_access(access,write_paths,resources):
    """Same scope contract at intake and grant; never infer missing authority."""
    # An explicit root selection grants the whole project; blank remains invalid.
    # Do not normalize traversal or mixed scopes into this sentinel.
    paths=normalized_write_paths(access,write_paths)
    return paths,sorted(names(resources))

def worker_access(parent,root,payload):
    """Default a complete child task to the intersecting authorized write area.

    Explicit settings and legacy setup-only pages keep their existing meaning.
    This is scope reuse, not another grant or a change to executor permissions.
    Both roots have already passed plain_root at their existing intake boundary.
    """
    if 'access' in payload or 'write_paths' in payload:
        return payload.get('access','read'),payload.get('write_paths',[])
    if not parent or parent['access']!='write':return 'read',[]
    parent_root=Path(parent['root']);child_root=Path(root)
    try:child_root.relative_to(parent_root)
    except ValueError:return 'read',[]
    paths=[]
    for item in json.loads(parent['write_paths']):
        allowed=parent_root/item
        try:
            child_root.relative_to(allowed)
            return 'write',['.']
        except ValueError:pass
        try:paths.append(allowed.relative_to(child_root).as_posix())
        except ValueError:pass
    return ('write',paths) if paths else ('read',[])

class Scopes:
    def __init__(self,team):self.team,self.host=team,team.host
    def preflight_native_git(self,thread):
        """Read a legacy pure-Web Git identity before admission takes a write lock.

        The snapshot is only an optimization. Missing or changed evidence keeps
        the existing unknown-Git fence inside the transaction.
        """
        try:
            path=Path(self.team.state.path)
            with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)) as db:
                db.row_factory=sqlite3.Row
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_work_claims'").fetchone():return None
                if not db.execute("SELECT 1 FROM native_work_claims WHERE state<>'released' LIMIT 1").fetchone():return None
                row=db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?',(thread,)).fetchone()
                if row is None or row['access']!='write':return None
                if db.execute('SELECT 1 FROM host_team_git_scopes WHERE thread_id=?',(thread,)).fetchone():return None
                recorded=dict(row)
            root=plain_root(recorded['root']);stat=Path(root).stat()
            if (type(recorded.get('device')) is not int or type(recorded.get('inode')) is not int or
                    (stat.st_dev,stat.st_ino)!=(recorded['device'],recorded['inode'])):return None
            common_dir=_git_common_dir(root,timeout=2)
            marker=stable_git_marker(root,common_dir)
            if marker is None:return None
            return {'scope':recorded,'root':root,'device':stat.st_dev,'inode':stat.st_ino,
                    'common_dir':common_dir,'git_marker':marker}
        except (AdmissionError,HarnessError,ValueError,OSError,sqlite3.Error):return None
    @staticmethod
    def schema(db):
        db.executescript('''
        CREATE TABLE IF NOT EXISTS host_team_scopes(
          thread_id TEXT PRIMARY KEY, project TEXT NOT NULL, root TEXT NOT NULL,
          access TEXT NOT NULL, write_paths TEXT NOT NULL, resources TEXT NOT NULL,
          fingerprint TEXT NOT NULL, granted_by TEXT NOT NULL, device INTEGER, inode INTEGER);
        CREATE TABLE IF NOT EXISTS host_team_git_scopes(thread_id TEXT PRIMARY KEY,head TEXT NOT NULL,common_dir TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS host_team_leases(
          request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL,
          root TEXT NOT NULL, access TEXT NOT NULL, resources TEXT NOT NULL,
          acquired REAL NOT NULL);
        ''')
    def grant(self,db,actor,p):
        object_fields(p,{'target','project','root','access','write_paths','resources','confirm'},{'expected_git_head'})
        require(p['confirm'] is True,'team_scope_confirmation_required',403)
        b=self.team.carriers.may_manage(db,actor,p['target']);require(b,'host_binding_missing',409)
        require(p['project']==b['spec']['project'],'team_workspace_project_mismatch',403)
        root=plain_root(p['root'])
        paths,resources=validate_access(p['access'],p['write_paths'],p['resources'])
        if implicit_unity_writer({'root':root,'access':p['access'],'write_paths':canonical(paths)}):
            resources=sorted(set(resources)|{'unity'})
        git=None
        if 'expected_git_head' in p:
            require(isinstance(p['expected_git_head'],str) and re.fullmatch('[0-9a-f]{40}|[0-9a-f]{64}',p['expected_git_head']),'team_git_head_invalid')
            git=inspect_git(root);require(git['head']==p['expected_git_head'],'team_git_frozen_head_changed',409)
        require(not db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('processing','suspended')",(b['thread_id'],)).fetchone(),'team_active_original_scope_cannot_change',409)
        require(not db.execute('SELECT 1 FROM host_team_leases WHERE thread_id=?',(b['thread_id'],)).fetchone(),'team_scope_in_use',409)
        require(not db.execute("SELECT 1 FROM host_runs WHERE controller_thread=? AND state<>'closed'",(b['thread_id'],)).fetchone(),'team_controller_scope_in_use',409)
        require(not db.execute("SELECT 1 FROM host_team_work w JOIN host_requests r ON r.id=w.request_id WHERE r.thread_id=? AND r.phase IN ('queued','processing','suspended')",(b['thread_id'],)).fetchone(),'team_scope_has_pending_work',409)
        fingerprint=hash_value({'project':p['project'],'root':root,'access':p['access'],'paths':paths,'resources':resources,'git':git})
        s=Path(root).stat()
        db.execute('INSERT OR REPLACE INTO host_team_scopes VALUES(?,?,?,?,?,?,?,?,?,?)',
            (b['thread_id'],p['project'],root,p['access'],canonical(paths),canonical(resources),fingerprint,actor['thread_id'],s.st_dev,s.st_ino))
        db.execute('DELETE FROM host_team_git_scopes WHERE thread_id=?',(b['thread_id'],))
        if git:db.execute('INSERT INTO host_team_git_scopes VALUES(?,?,?)',(b['thread_id'],git['head'],git['common_dir']))
        self.host.emit(db,b['thread_id'],'team_workspace_granted',{'fingerprint':fingerprint,'access':p['access'],'project':p['project'],'not_native_authorization':True})
        return {'target_id':b['target_id'],'fingerprint':fingerprint,'root':root,'project':p['project'],'access':p['access'],
                'native_tools_still_require_authorization':True}
    def scope(self,db,thread):
        row=db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?',(thread,)).fetchone()
        if row is None:return None
        result=dict(row);git=db.execute('SELECT head,common_dir FROM host_team_git_scopes WHERE thread_id=?',(thread,)).fetchone()
        result['git']=dict(git) if git else None;return result
    def verify(self,s):
        require(s,'team_workspace_not_registered',409)
        p=Path(s['root']);require(plain_root(s['root'])==s['root'],'team_workspace_identity_changed',409)
        st=p.stat();require(st.st_dev==s['device'] and st.st_ino==s['inode'],'team_workspace_identity_changed',409)
        if s.get('git'):
            actual=inspect_git(p)
            require(actual['head']==s['git']['head'] and actual['common_dir']==s['git']['common_dir'],'team_git_frozen_head_changed',409)
    @staticmethod
    def conflict(a,b):
        # Nested/aliased workspace roots cannot accidentally bypass a shared writer.
        ar,br=a['root'],b['root'];prefix=lambda x,y:x==y or x.startswith(y+os.sep)
        same=prefix(ar,br) or prefix(br,ar)
        ra=resource_keys(json.loads(a['resources']));rb=resource_keys(json.loads(b['resources']))
        if implicit_unity_writer(a):ra.add('unity')
        if implicit_unity_writer(b):rb.add('unity')
        return (same and ('write' in (a['access'],b['access']))) or bool(ra&rb)
    @staticmethod
    def native_blocker(db,scope,git_probe=None,held_request_id=None):
        if scope is not None and scope.get('git') is None and isinstance(git_probe,dict):
            try:
                stored=db.execute('SELECT * FROM host_team_scopes WHERE thread_id=?',(scope['thread_id'],)).fetchone()
                recorded=dict(stored) if stored else None
                root=plain_root(scope['root']);stat=Path(root).stat()
                if (recorded==git_probe.get('scope') and root==git_probe.get('root') and
                        all(scope.get(key)==recorded[key] for key in
                            ('thread_id','root','access','write_paths','device','inode')) and
                        type(recorded.get('device')) is int and type(recorded.get('inode')) is int and
                        git_probe.get('git_marker') is not None and
                        (stat.st_dev,stat.st_ino)==(recorded['device'],recorded['inode'])==
                        (git_probe.get('device'),git_probe.get('inode')) and
                        stable_git_marker(root,git_probe.get('common_dir'))==git_probe.get('git_marker')):
                    scope={**scope,'git':{'common_dir':git_probe['common_dir']}}
            except (HarnessError,KeyError,OSError,ValueError,sqlite3.Error):pass
        try:return pure_scope_blocker(db,scope,held_request_id=held_request_id)
        except (AdmissionError,ValueError,OSError,sqlite3.Error):return {'kind':'native_work','state':'unknown'}
    @staticmethod
    def native_busy(db,scope,git_probe=None,held_request_id=None):
        return Scopes.native_blocker(db,scope,git_probe,held_request_id) is not None
    def busy(self,db,thread,exclude_operation=None,git_probe=None,held_request_id=None):
        current=self.scope(db,thread)
        if self.native_busy(db,current,git_probe,held_request_id):return True
        active=db.execute("SELECT id FROM threads WHERE id<>? AND status IN ('working','stopping','unknown','processing','web_waiting','web_processing')",(thread,)).fetchall()
        for row in active:
            other=self.scope(db,row['id'])
            if current is None or other is None or self.conflict(current,other):return True
        for row in db.execute('SELECT * FROM host_team_leases WHERE thread_id<>?',(thread,)):
            other=dict(row);registered=self.scope(db,row['thread_id'])
            if registered:other['write_paths']=registered['write_paths']
            if current is None or self.conflict(current,other):return True
        # In-flight legacy control and native sends have no managed lease. Never
        # assume their paths are disjoint based on a requested label alone.
        for row in db.execute("SELECT a.thread_id FROM control_attempts a JOIN host_requests r ON r.id=a.request_id WHERE a.thread_id<>? AND a.state IN ('dispatching','sent','unknown') AND r.phase IN ('queued','processing','suspended')",(thread,)):
            other=self.scope(db,row['thread_id'])
            if current is None or other is None or self.conflict(current,other):return True
        return bool(db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') AND (? IS NULL OR id<>?) LIMIT 1",(exclude_operation,exclude_operation)).fetchone())
    def reserve(self,db,run,r,git_probe=None):
        s=self.scope(db,r['thread_id']);self.verify(s)
        old=db.execute('SELECT * FROM host_team_leases WHERE request_id=?',(r['id'],)).fetchone()
        if old:return
        require(not self.busy(db,r['thread_id'],git_probe=git_probe),'team_workspace_or_resource_busy',409)
        work=db.execute('SELECT resources FROM host_team_work WHERE request_id=?',(r['id'],)).fetchone()
        resources=sorted(set(json.loads(s['resources']))|set(json.loads(work['resources']) if work else []))
        if implicit_unity_writer(s):resources=sorted(set(resources)|{'unity'})
        candidate={**s,'resources':canonical(resources)}
        require(not self.native_busy(db,candidate,git_probe),'team_workspace_or_resource_busy',409)
        for held in db.execute('SELECT * FROM host_team_leases WHERE request_id<>?',(r['id'],)):
            other=dict(held);registered=self.scope(db,held['thread_id'])
            if registered:other['write_paths']=registered['write_paths']
            require(not self.conflict(candidate,other),'team_workspace_or_resource_busy',409)
        # Competing projects share a fair resource queue. Ready controller
        # continuations precede new workers; within that class the project
        # least recently dispatched wins, then original request order. Already
        # accepted sends retain ownership and never queue behind newer work.
        if r['phase'] in ('queued','suspended') and not self.team.committed_receipt(db,r):
            project_turns={}
            def rank(scope,request,envelope):
                if scope['project'] not in project_turns:
                    project_turns[scope['project']]=db.execute('SELECT COALESCE(MAX(d.at),0) FROM host_team_dispatches d JOIN host_requests q ON q.id=d.request_id JOIN host_team_scopes s ON s.thread_id=q.thread_id WHERE s.project=?',(scope['project'],)).fetchone()[0]
                controller=request['id']==envelope['controller_request']
                return (0 if controller and request['phase']=='suspended' else 1,project_turns[scope['project']],request['created_at'],request['id'])
            ours=rank(s,r,run)
            for pending in db.execute("SELECT * FROM host_requests WHERE id<>? AND phase IN ('queued','suspended') AND cancel_requested=0",(r['id'],)).fetchall():
                if db.execute('SELECT 1 FROM host_team_leases WHERE request_id=?',(pending['id'],)).fetchone():continue
                other=self.scope(db,pending['thread_id'])
                if not other:continue
                work=db.execute('SELECT resources FROM host_team_work WHERE request_id=?',(pending['id'],)).fetchone()
                other={**other,'resources':canonical(sorted(set(json.loads(other['resources']))|set(json.loads(work[0]) if work else [])))}
                if not self.conflict(candidate,other):continue
                other_run=self.team.run_for_request(db,pending['id'])
                if not other_run or self.team.ready(db,pending) is not True:continue
                # Only admissible queued work participates in ordering. A
                # removed workspace or changed frozen HEAD cannot monopolize
                # a shared resource while never being able to acquire it.
                try:self.verify(other)
                except (HarnessError,OSError):continue
                require(ours<=rank(other,pending,other_run),'team_workspace_or_resource_busy',409)
        workers=db.execute('SELECT COUNT(*) FROM host_team_leases WHERE run_id=? AND thread_id<>?',(run['id'],run['controller_thread'])).fetchone()[0]
        if run['max_parallel'] and r['thread_id']!=run['controller_thread']:require(workers<run['max_parallel'],'team_parallel_budget',409)
        db.execute('INSERT INTO host_team_leases VALUES(?,?,?,?,?,?,?)',(r['id'],run['id'],r['thread_id'],s['root'],s['access'],canonical(resources),self.host.clock()))
    def release(self,db,request):db.execute('DELETE FROM host_team_leases WHERE request_id=?',(request,))
    def execution_context_from_thread(self,thread):
        from contextlib import closing
        with closing(self.host.state.connect()) as db:return self.execution_context(db,thread)
    def execution_context(self,db,thread):
        s=self.scope(db,thread)
        if not s:return None
        return {'project':s['project'],'root':s['root'],'access':s['access'],'write_paths':json.loads(s['write_paths']),
                'resources':json.loads(s['resources']),'fingerprint':s['fingerprint'],'git_constraint':s.get('git'),'meaning':'managed_scope_not_native_tool_authorization'}
