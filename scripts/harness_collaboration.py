"""Small tools for already-connected Web branches; no model/browser scheduler.

A parent may delegate, release this checkout while awaiting children, and recover
its ORIGINAL request when their results arrive. Same-checkout writers stay serial.
Session binding is trusted-project-process provenance, not OpenAI attestation.
"""
from __future__ import annotations
from contextlib import closing
import hashlib
import json
import re
import uuid
from harness_state import canonical, public, require, stamp
from harness_handoff import ensure_schema, request_handoff

SESSION = re.compile(r'wc_sess_(?:[A-Za-z0-9_-]{16}|[0-9a-f]{32})\Z')
EXECUTING = ('working', 'stopping', 'unknown', 'processing', 'web_waiting', 'web_processing')
OPEN_PHASES = ('queued', 'processing', 'suspended')
FIELDS = {
    'join': {'parent_target_id', 'title', 'confirm'},
    'branches': set(),
    'delegate': {'request_id', 'claim_id', 'child_target_id', 'delegation_id', 'text'},
    'yield': {'request_id', 'claim_id'},
    'results': {'request_id', 'claim_id'},
    'result': {'request_id', 'claim_id', 'delegation_id', 'after_seq'},
}


def title(value):
    value = str(value).strip()
    while value.startswith('ChatGPT Web · '):
        value = value.removeprefix('ChatGPT Web · ').strip()
    return 'ChatGPT Web · ' + value[:130]


class HostCollaboration:
    def __init__(self, host):
        self.host, self.state = host, host.state
        with closing(self.state.connect()) as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS host_branches(
                    target_id TEXT PRIMARY KEY, parent_target_id TEXT NOT NULL,
                    created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS host_delegations(
                    id TEXT PRIMARY KEY, parent_request_id TEXT NOT NULL,
                    parent_thread_id TEXT NOT NULL, child_target_id TEXT NOT NULL,
                    child_thread_id TEXT NOT NULL, child_request_id TEXT NOT NULL UNIQUE,
                    fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS host_parent_requests ON host_delegations(parent_request_id);
                CREATE TABLE IF NOT EXISTS host_notes(
                    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, text TEXT NOT NULL,
                    created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS host_unread_notes(
                    note_id TEXT PRIMARY KEY, request_id TEXT NOT NULL);
            ''')
            ensure_schema(db)
            db.commit()

    def definition(self, target):
        if hasattr(self.host,'managed'):
            managed=self.host.managed.definition(target)
            if managed:return managed
        with closing(self.state.connect()) as db:
            row = db.execute('SELECT b.spec FROM host_bindings b JOIN host_branches c ON c.target_id=b.target_id WHERE b.target_id=?', (target,)).fetchone()
        require(row is not None, 'host_target_not_configured', 403)
        return json.loads(row['spec'])

    def join(self, data):
        require(data['confirm'] is True, 'host_explicit_pairing_required', 403)
        target, session = data['target_id'], data['session_id']
        require(isinstance(target, str) and re.fullmatch(r'[a-z0-9_-]{1,64}', target), 'host_branch_id_invalid')
        require(isinstance(session, str) and SESSION.fullmatch(session), 'host_branch_session_invalid')
        require(isinstance(data['title'], str) and 0 < len(data['title'].strip()) <= 130, 'host_branch_title_invalid')
        require(target not in self.host.targets, 'host_configured_identity_is_not_a_child', 409)
        parent_id = data['parent_target_id']
        require(isinstance(parent_id, str) and parent_id != target, 'host_parent_invalid')
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            parent = self.host.binding(db, target=parent_id)
            expected = self.host.targets.get(parent_id) or self.definition(parent_id)
            require(parent['spec'] == expected, 'host_binding_configuration_changed', 409)
            require(parent['enabled'], 'host_parent_paused', 409)
            require(session != parent['spec']['session_id'], 'host_child_requires_independent_session', 409)
            spec = {'id': target, 'title': data['title'].strip(), 'session_id': session,
                    'project': parent['spec']['project'], 'parent_target_id': parent_id}
            old = db.execute('SELECT * FROM host_bindings WHERE target_id=?', (target,)).fetchone()
            if old:
                require(json.loads(old['spec']) == spec, 'host_branch_identity_conflict', 409)
                return {'thread': self.state.thread(old['thread_id']), 'target_id': target,
                        'joined': True, 'replayed': True, 'model_created': False,
                        'carrier':self.host.team.carriers.projection(db,self.host.binding(db,target=target))}
            require(db.execute('SELECT 1 FROM threads WHERE native_id=?', ('mcp-host/' + session,)).fetchone() is None,
                    'host_session_already_bound_no_reparent', 409)
            thread, now = 'hthr_' + uuid.uuid4().hex, stamp()
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (thread, 'chatgpt_web_host', 'mcp-host/' + session, parent['thread_id'], title(spec['title']), str(self.host.root), None, None, 'idle', None, now, now))
            db.execute('INSERT INTO host_bindings(target_id,thread_id,spec,enabled) VALUES(?,?,?,1)', (target, thread, canonical(spec)))
            db.execute('INSERT INTO host_branches VALUES(?,?,?)', (target, parent_id, now))
            self.host.emit(db, thread, 'host_bound', {'session_id': session, 'parent_id': parent['thread_id'], 'source': 'independently_registered_project_process', 'model_created': False})
            db.commit()
        return {'thread': self.state.thread(thread), 'target_id': target, 'joined': True,
                'replayed': False, 'model_created': False, 'native_browser_fork': False,
                'carrier':{'state':'logical_only','runnable':False,'physical_conversation_bound':False,'enrollment_required':True}}

    def busy(self, db, thread, git_probe=None, held_request_id=None):
        binding=db.execute('SELECT spec FROM host_bindings WHERE thread_id=?',(thread,)).fetchone()
        if binding and json.loads(binding['spec']).get('conversation_mode')=='direct':
            return bool(db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase='processing' AND (? IS NULL OR id<>?)",(thread,held_request_id,held_request_id)).fetchone() or
                        db.execute("SELECT 1 FROM operations WHERE thread_id=? AND action='message.send' AND state IN ('reserved','dispatching','unknown') AND (? IS NULL OR id<>?)",(thread,held_request_id,held_request_id)).fetchone())
        if hasattr(self.host,'team'):return self.host.team.scopes.busy(db,thread,git_probe=git_probe,
                                                                         held_request_id=held_request_id)
        marks = ','.join('?' for _ in EXECUTING)
        running = db.execute(f'SELECT 1 FROM threads WHERE id<>? AND status IN ({marks}) LIMIT 1', (thread, *EXECUTING)).fetchone()
        unknown = db.execute("SELECT 1 FROM operations WHERE action='message.send' AND state IN ('reserved','dispatching','unknown') LIMIT 1").fetchone()
        return bool(running or unknown)

    def outstanding(self, db, request):
        return db.execute("SELECT COUNT(*) FROM host_delegations d JOIN host_requests r ON r.id=d.child_request_id WHERE d.parent_request_id=? AND r.phase IN ('queued','processing','suspended')", (request,)).fetchone()[0]

    def candidate(self, db, binding, git_probe=None):
        rows = db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase IN ('queued','suspended') ORDER BY created_at", (binding['thread_id'],)).fetchall()
        for row in rows:
            if self.host.future_paused(db,binding,row):continue
            if self.busy(db,binding['thread_id'],git_probe=git_probe,held_request_id=row['id']):continue
            managed=self.host.team.ready(db,row) if hasattr(self.host,'team') else None
            if managed is False:continue
            if row['phase'] == 'queued' and not row['cancel_requested']:
                return row
            if row['phase'] == 'suspended' and (managed is True or not self.outstanding(db,row['id'])):
                return row
        return None

    def context(self, db, binding, data):
        self.host.identifier(data['request_id']); self.host.identifier(data['claim_id'])
        row = db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?', (data['request_id'], binding['thread_id'])).fetchone()
        require(row is not None and row['claim_id'] == data['claim_id'], 'host_parent_claim_mismatch', 409)
        return dict(row)

    def action(self, db, binding, data):
        action = data['action']
        if action == 'branches':
            rows = db.execute('SELECT b.thread_id,b.target_id,b.enabled,b.wait_until,b.spec FROM host_branches c JOIN host_bindings b ON b.target_id=c.target_id WHERE c.parent_target_id=? ORDER BY c.created_at', (binding['target_id'],)).fetchall()
            return {'children': [{'thread_id': x['thread_id'], 'target_id': x['target_id'], 'session_id': json.loads(x['spec'])['session_id'], 'enabled': bool(x['enabled']), 'waiter_recent': x['wait_until'] >= self.host.clock(), 'automatic_resume_verified': False, 'carrier': self.host.team.carriers.projection(db,self.host.binding(db,thread=x['thread_id']))} for x in rows],
                    'same_checkout_writers': 'serialized', 'model_or_browser_creation': False}
        parent = self.context(db, binding, data)
        if action == 'results':
            return self.results(db, parent['id'])
        if action == 'result':
            self.host.identifier(data['delegation_id'])
            require(type(data['after_seq']) is int and data['after_seq'] >= 0, 'invalid_cursor')
            edge = db.execute('SELECT * FROM host_delegations WHERE id=? AND parent_request_id=? AND parent_thread_id=?', (data['delegation_id'], parent['id'], binding['thread_id'])).fetchone()
            require(edge is not None, 'host_result_not_original_child', 403)
            # One full public reply per page; never treat a truncated excerpt as a review.
            rows = db.execute("SELECT seq,data,at FROM events WHERE thread_id=? AND kind='assistant_message' AND seq>? AND json_extract(data,'$.request_id')=? ORDER BY seq LIMIT 2", (edge['child_thread_id'], data['after_seq'], edge['child_request_id'])).fetchall()
            items = [{'seq': e['seq'], 'at': e['at'], 'data': json.loads(e['data'])} for e in rows[:1]]
            phase = db.execute('SELECT phase FROM host_requests WHERE id=?', (edge['child_request_id'],)).fetchone()['phase']
            return {'delegation_id': edge['id'], 'child_request_id': edge['child_request_id'], 'child_thread_id': edge['child_thread_id'], 'phase': phase, 'items': items, 'has_more': len(rows)>1, 'next_after': items[-1]['seq'] if items else data['after_seq'], 'scope': 'full_public_reply_page_not_hidden_reasoning_or_independent_acceptance'}
        if action == 'delegate':
            require(self.host.team.run_for_request(db,parent['id']) is None,'team_use_run_assign_for_managed_parent',409)
            self.host.identifier(data['delegation_id'])
            require(isinstance(data['text'], str) and 0 < len(data['text'].strip()) <= 24000, 'invalid_message')
            fingerprint = hashlib.sha256(canonical(data).encode()).hexdigest()
            prior = db.execute('SELECT * FROM host_delegations WHERE id=?', (data['delegation_id'],)).fetchone()
            if prior:
                require(prior['fingerprint'] == fingerprint, 'host_delegation_conflict', 409)
                return self.delegation_receipt(prior)
            require(not self.host.future_paused(db,binding,parent) and parent['phase'] == 'processing' and not parent['cancel_requested'], 'host_parent_not_delegating', 409)
            edge = db.execute('SELECT * FROM host_branches WHERE target_id=? AND parent_target_id=?', (data['child_target_id'], binding['target_id'])).fetchone()
            require(edge is not None, 'host_not_direct_registered_child', 403)
            child = self.host.binding(db, target=data['child_target_id'])
            require(child['enabled'], 'host_child_paused', 409)
            require(db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')", (child['thread_id'],)).fetchone() is None, 'host_child_has_original_work', 409)
            child_request = 'clw-child-' + hashlib.sha256(data['delegation_id'].encode()).hexdigest()[:40]
            now = stamp()
            db.execute('INSERT INTO host_requests(id,thread_id,text,phase,created_at) VALUES(?,?,?,?,?)', (child_request, child['thread_id'], data['text'], 'queued', now))
            db.execute('INSERT INTO host_delegations VALUES(?,?,?,?,?,?,?,?)', (data['delegation_id'], parent['id'], binding['thread_id'], child['target_id'], child['thread_id'], child_request, fingerprint, now))
            db.execute("UPDATE threads SET status='waiting',active_turn=?,updated_at=? WHERE id=?", (child_request, now, child['thread_id']))
            self.host.emit(db, child['thread_id'], 'host_delegated_input', {'text': data['text'], 'request_id': child_request, 'parent_request_id': parent['id'], 'parent_thread_id': binding['thread_id']})
            self.host.emit(db, binding['thread_id'], 'host_delegated', {'child_thread_id': child['thread_id'], 'child_request_id': child_request, 'model_started': False})
            db.commit()
            return self.delegation_receipt(dict(child_request_id=child_request, child_thread_id=child['thread_id'], id=data['delegation_id']))
        require(action == 'yield', 'host_branch_action_invalid')
        require(self.host.team.run_for_request(db,parent['id']) is None,'team_use_run_wait_for_managed_parent',409)
        require(parent['phase'] in ('processing', 'suspended') and not parent['cancel_requested'], 'host_parent_not_yieldable', 409)
        require(db.execute('SELECT 1 FROM host_delegations WHERE parent_request_id=?', (parent['id'],)).fetchone() is not None, 'host_no_children_to_wait', 409)
        pending = self.outstanding(db, parent['id'])
        if pending and parent['phase'] == 'processing':
            db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?", (parent['id'],))
            db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=? AND active_turn=?", (stamp(), binding['thread_id'], parent['id']))
            self.host.emit(db, binding['thread_id'], 'host_waiting_children', {'request_id': parent['id'], 'pending': pending, 'same_request_resume': True})
            db.commit()
        return {'request_id': parent['id'], 'pending_children': pending, 'state': 'waiting_children' if pending else 'children_returned', 'instruction': 'After yielding, do not write this checkout; arm a wait and resume the original claim when children return.'}

    @staticmethod
    def delegation_receipt(row):
        return {'delegation_id': row['id'], 'child_request_id': row['child_request_id'], 'child_thread_id': row['child_thread_id'], 'state': 'queued_for_registered_receiver_not_browser_proof', 'model_started': False, 'transport_only': True, 'automatic_resume_verified': False, 'next_action': 'yield_then_inspect_exact_child_handoff'}

    def results(self, db, request):
        rows = db.execute('SELECT d.*,r.phase,r.cancel_requested FROM host_delegations d JOIN host_requests r ON r.id=d.child_request_id WHERE d.parent_request_id=? ORDER BY d.created_at', (request,)).fetchall()
        result = []
        for row in rows:
            e = db.execute("SELECT seq,data FROM events WHERE thread_id=? AND kind='assistant_message' AND json_extract(data,'$.request_id')=? ORDER BY seq DESC LIMIT 1", (row['child_thread_id'], row['child_request_id'])).fetchone()
            match = (e['seq'], json.loads(e['data'])) if e else None
            text = match[1].get('text', '') if match else ''
            binding = self.host.binding(db, thread=row['child_thread_id'])
            original = db.execute('SELECT id,thread_id,phase,cancel_requested FROM host_requests WHERE id=?', (row['child_request_id'],)).fetchone()
            handoff = request_handoff(db, binding, original, self.host.clock(),dispatch_paused=self.host.future_paused(db,binding,original))
            result.append({'handoff': handoff, 'delegation_id': row['id'], 'child_request_id': row['child_request_id'], 'child_thread_id': row['child_thread_id'], 'phase': row['phase'], 'cancel_requested': bool(row['cancel_requested']), 'reply_excerpt': text[:2000], 'reply_truncated': len(text) > 2000, 'event_seq': match[0] if match else None})
        return {'request_id': request, 'children': result, 'pending_children': self.outstanding(db, request), 'parent_completed': False, 'independent_acceptance': False}

    def acknowledge_notes(self, db, request):
        """A real receiver read is the acknowledgement; a browser status poll is not."""
        if db.execute('SELECT 1 FROM host_notes WHERE request_id=?', (request,)).fetchone():
            db.execute('DELETE FROM host_unread_notes WHERE request_id=?', (request,))
            db.commit()

    def request_details(self, request):
        with closing(self.state.connect()) as db:
            import harness_next_round as next_round
            notes = next_round.current_notes(db, request)
            source = db.execute('SELECT parent_request_id,parent_thread_id,id FROM host_delegations WHERE child_request_id=?', (request,)).fetchone()
            return {'additional_instructions': [dict(x) for x in notes], 'delegation': dict(source) if source else None, 'pending_children': self.outstanding(db, request)}

    def append(self, thread, request, text, note_id):
        self.host.identifier(request)
        require(isinstance(text, str) and 0 < len(text.strip()) <= 16000, 'host_note_invalid')
        with self.host.lock, closing(self.state.connect()) as db:
            b = self.host.binding(db, thread=thread)
            row = db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?', (request, thread)).fetchone()
            page=db.execute('SELECT * FROM managed_pages WHERE thread_id=?',(thread,)).fetchone()
            if page:
                # Desktop additions belong to the next browser turn. They do
                # not change a running receiver's context or final-result gate.
                latest=db.execute('SELECT id FROM host_requests WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(thread,)).fetchone()
                require(row and latest and latest['id']==request and not row['cancel_requested'],'host_note_request_not_current',409)
                # A legacy checkpoint handoff changes the physical receiver.
                # Do not acknowledge input against the retiring source thread.
                require(not db.execute('SELECT 1 FROM managed_handoffs WHERE source_request=?',(request,)).fetchone(),'host_handoff_in_progress',409)
                import harness_next_round as next_round
                queued=next_round.pending(db,page)
                total=sum(len(n['text'].encode('utf-8')) for n in queued['messages'])
                require(queued['count']<64 and total+len(text.encode('utf-8'))<=65536,'host_note_budget',409)
                result=next_round.enqueue(self.host,db,page,request,text,note_id)
                db.commit()
                from harness_goal_watch import ensure_watcher
                ensure_watcher(self.host)
                return result
            require(row and row['phase'] in OPEN_PHASES and not row['cancel_requested'], 'host_note_request_not_current', 409)
            # The controller seals a run only after reading all prior notes.
            # Do not accept invisible new work into that already-sealed result.
            run=self.host.team.run_for_request(db,request)
            require(not run or run['state']!='closed','host_finalizing_no_append',409)
            require(not db.execute('SELECT 1 FROM managed_handoffs WHERE source_request=?',(request,)).fetchone(),'host_handoff_in_progress',409)
            total, count = db.execute('SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))),0),COUNT(*) FROM host_notes WHERE request_id=?', (request,)).fetchone()
            require(count < 64 and total + len(text.encode('utf-8')) <= 65536, 'host_note_budget', 409)
            db.execute('INSERT INTO host_notes VALUES(?,?,?,?)', (note_id, request, text, stamp()))
            db.execute('INSERT INTO host_unread_notes VALUES(?,?)', (note_id, request))
            self.host.emit(db, thread, 'host_user_note', {'text': text, 'request_id': request, 'note_id': note_id, 'native_steer': False})
            result = {'operation_id': note_id, 'request_id': request, 'thread_id': thread, 'state': 'note_saved_not_native_interrupt'}
            db.execute("UPDATE operations SET state='completed',response=? WHERE id=?", (canonical(result), note_id))
            db.commit()
            return result

    def cancel_descendants(self, db, request):
        pending, visited = [request], set()
        while pending:
            parent = pending.pop()
            require(parent not in visited, 'host_delegation_graph_invalid', 409)
            visited.add(parent)
            for row in db.execute("SELECT r.* FROM host_delegations d JOIN host_requests r ON r.id=d.child_request_id WHERE d.parent_request_id=? AND r.phase IN ('queued','processing','suspended')", (parent,)).fetchall():
                pending.append(row['id'])
                if row['phase'] not in OPEN_PHASES:
                    continue
                db.execute('UPDATE host_requests SET cancel_requested=1 WHERE id=?', (row['id'],))
                if row['phase'] == 'queued' and not self.host.team.has_unsettled_dispatch(db,row['id']):
                    db.execute("UPDATE host_requests SET phase='cancelled',finished_at=? WHERE id=?", (stamp(), row['id']))
                    b = self.host.binding(db, thread=row['thread_id'])
                    db.execute('UPDATE threads SET status=?,active_turn=NULL,updated_at=? WHERE id=? AND active_turn=?', ('idle' if b['enabled'] else 'host_paused', stamp(), row['thread_id'], row['id']))
                self.host.emit(db, row['thread_id'], 'host_cancel_requested', {'request_id': row['id'], 'source_parent_request': request, 'native_execution_stopped': False})
