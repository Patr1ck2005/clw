"""Opt-in exact-tab control carrier over ORIGINAL Host requests.

A browser capability is bound to one exact enrolled ChatGPT page. It receives only
the original request selected by the durable Host journal, obtains one Send grant,
then returns only the new public assistant reply for that exact sent user turn.
It never reads hidden reasoning, chooses a request/claim, or receives Host keys.
A committed Send grant is never issued twice, including after restart.
"""
from __future__ import annotations
from contextlib import closing
import hashlib, json, re, secrets, uuid
from harness_state import HarnessError, require, canonical
from harness_recovery import EXTENSION, DELAYS, continuation_prompt, connector_reference, original_account
from harness_work_package import WORK_PACKAGE_GUIDANCE

PRIVATE_FIELDS = {
    'control-code': {'confirm', 'model_label', 'effort_label'},
    'control-adopt': {'confirm', 'request_id'},
    'control-disable': {'confirm'},
    'control-receive': {'attempt_id'},
    'control-status': set(),
}
CHAT = re.compile(r'https://chatgpt\.com/(?:g/[A-Za-z0-9_-]+/)?c/(?:WEB:)?[A-Za-z0-9-]{16,128}\Z')
TOKEN = re.compile(r'clwc_[A-Za-z0-9_-]{43}\Z')
NONCE = re.compile(r'[0-9a-f]{32}\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')
PAGE_BOOL = {'visible', 'generating', 'draft', 'composing', 'focused', 'blocked', 'stopped', 'controls_known', 'model_pro_visible', 'effort_disallowed_visible'}
PAGE_DIAG_BOOL = {'editor_known', 'user_known', 'mode_control_known'}
PAGE_FIELDS = PAGE_BOOL | PAGE_DIAG_BOOL | {'model_label', 'effort_label', 'user_hash', 'failure_hash', 'failure_kind'}
CONFIRMED_MODEL = '@confirmed-sol-nonpro'
CONFIRMED_EFFORT = '@confirmed-medium-or-extra-high'


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def label(value):
    require(isinstance(value, str) and 0 < len(value) <= 96 and '\n' not in value and '\r' not in value, 'control_label_invalid')
    return ' '.join(value.split()).casefold()


def permitted_model(model):
    model = label(model)
    require(re.search(r'\bsol\b', model) is not None and re.search(r'\bpro\b', model) is None,
            'control_only_explicit_sol_allowed', 403)
    return model


def permitted_effort(effort):
    effort = label(effort)
    require(effort in ('medium', '中等', 'extra high', '极高'), 'control_allowed_effort_required', 403)
    return effort


def permitted_labels(model, effort):
    return permitted_model(model), permitted_effort(effort)


def resolve_visible_guard(page, confirmed):
    require(page['controls_known'] and page['visible'] and not page['blocked'] and not page['stopped'],
            'control_page_not_safe_to_bind', 409)
    require(not page['model_pro_visible'], 'control_pro_visible_not_allowed', 403)
    require(not page['effort_disallowed_visible'], 'control_disallowed_effort_visible', 403)
    model = permitted_model(page['model_label']) if page['model_label'] else None
    effort = permitted_effort(page['effort_label']) if page['effort_label'] else None
    if model is None:
        require(confirmed is True, 'control_explicit_low_cost_confirmation_required', 403)
        model = CONFIRMED_MODEL
    if effort is None:
        require(confirmed is True, 'control_explicit_low_cost_confirmation_required', 403)
        effort = CONFIRMED_EFFORT
    return model, effort


def guard_compatible(model, effort, page):
    if page['model_pro_visible'] or page['effort_disallowed_visible']:
        return False
    page_model = label(page['model_label']) if page['model_label'] else ''
    page_effort = label(page['effort_label']) if page['effort_label'] else ''
    model_ok = ((model == CONFIRMED_MODEL and (not page_model or (
                    re.search(r'\bsol\b', page_model) is not None and re.search(r'\bpro\b', page_model) is None)))
                or (model != CONFIRMED_MODEL and page_model == model))
    effort_ok = ((effort == CONFIRMED_EFFORT and (not page_effort or page_effort in ('medium','中等','extra high','极高')))
                 or (effort != CONFIRMED_EFFORT and page_effort == effort))
    return model_ok and effort_ok


def validate_page(page):
    require(isinstance(page, dict) and set(page) == PAGE_FIELDS, 'control_page_fields')
    require(all(type(page[k]) is bool for k in PAGE_BOOL | PAGE_DIAG_BOOL), 'control_page_flags')
    require(isinstance(page['user_hash'], str) and DIGEST.fullmatch(page['user_hash']), 'control_user_identity_required')
    require(isinstance(page['failure_hash'], str) and DIGEST.fullmatch(page['failure_hash']), 'control_failure_identity')
    require(page['failure_kind'] in ('', 'cannot_think', 'generation_failed'), 'control_failure_kind')
    for k in ('model_label', 'effort_label'):
        require(isinstance(page[k], str) and len(page[k]) <= 96, 'control_page_label')
    return page


class ControlPlane:
    def __init__(self, host):
        self.host, self.state = host, host.state
        self.protocol_version = 4
        with closing(self.state.connect()) as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS control_codes(
                hash TEXT PRIMARY KEY,thread_id TEXT NOT NULL,model TEXT NOT NULL,
                effort TEXT NOT NULL,expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS control_peers(
                thread_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,
                origin TEXT NOT NULL,chat_url TEXT NOT NULL,tab_nonce TEXT NOT NULL,
                model TEXT NOT NULL,effort TEXT NOT NULL,enabled INTEGER NOT NULL,
                expires REAL NOT NULL,last_seen REAL NOT NULL,cutoff INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS control_adoptions(
                request_id TEXT NOT NULL,epoch INTEGER NOT NULL,generation INTEGER NOT NULL,
                PRIMARY KEY(request_id,epoch,generation));
              CREATE TABLE IF NOT EXISTS control_attempts(
                id TEXT PRIMARY KEY,request_id TEXT NOT NULL,thread_id TEXT NOT NULL,
                epoch INTEGER NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,
                user_hash TEXT NOT NULL,offered REAL NOT NULL,dispatched REAL,acknowledged REAL,
                UNIQUE(request_id,epoch));
              CREATE TABLE IF NOT EXISTS control_baselines(request_id TEXT PRIMARY KEY,failure_hash TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS control_browser_receipts(
                attempt_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,thread_id TEXT NOT NULL,
                claim_id TEXT NOT NULL,sent_user_hash TEXT NOT NULL,assistant_before_hash TEXT NOT NULL,
                result_turn_hash TEXT,result_hash TEXT,reply_id TEXT,completed REAL);
              CREATE TABLE IF NOT EXISTS control_browser_note_receipts(
                attempt_id TEXT NOT NULL,note_id TEXT NOT NULL,PRIMARY KEY(attempt_id,note_id));
              CREATE TABLE IF NOT EXISTS control_discoveries(
                id TEXT PRIMARY KEY,origin TEXT NOT NULL,chat_url TEXT NOT NULL,tab_nonce TEXT NOT NULL,
                thread_id TEXT NOT NULL,request_id TEXT,model TEXT NOT NULL,effort TEXT NOT NULL,expires REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS control_page_authorizations(
                discovery_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,source TEXT NOT NULL,created REAL NOT NULL);
              CREATE TABLE IF NOT EXISTS control_recoveries(
                request_id TEXT NOT NULL,failure_hash TEXT NOT NULL,user_hash TEXT NOT NULL,
                ordinal INTEGER NOT NULL,due REAL NOT NULL,base_epoch INTEGER NOT NULL,
                generation INTEGER NOT NULL,PRIMARY KEY(request_id,failure_hash),UNIQUE(request_id,ordinal));
            ''')
            db.commit()

    def tentative_thread_for_git_probe(self,origin,token,data):
        if not isinstance(token,str) or not TOKEN.fullmatch(token):return None
        with closing(self.state.connect()) as db:
            row=db.execute('SELECT thread_id FROM control_peers WHERE token_hash=? AND origin=?',
                           (digest(token),origin)).fetchone()
        return row['thread_id'] if row else None

    def owns(self, db, thread):
        return db.execute('SELECT 1 FROM control_peers WHERE thread_id=? AND enabled=1 AND expires>?',
                          (thread, self.host.clock())).fetchone() is not None

    def epoch(self, db, request):
        return db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE thread_id=? AND kind='host_waiting_children' AND json_extract(data,'$.request_id')=?",
                          (request['thread_id'], request['id'])).fetchone()[0]

    def original(self, db, binding, request_id):
        self.host.identifier(request_id)
        r = db.execute('SELECT * FROM host_requests WHERE id=? AND thread_id=?', (request_id, binding['thread_id'])).fetchone()
        require(r is not None, 'control_original_request_missing', 404)
        return dict(r)

    def snapshot(self, thread):
        with closing(self.state.connect()) as db:
            self.host.binding(db, thread=thread)
            p = db.execute('SELECT generation,enabled,expires,last_seen,model,effort FROM control_peers WHERE thread_id=?', (thread,)).fetchone()
            attempts = db.execute('SELECT id,request_id,epoch,generation,state,offered,dispatched,acknowledged FROM control_attempts WHERE thread_id=? ORDER BY offered DESC LIMIT 16', (thread,)).fetchall()
            recovery = db.execute('SELECT c.request_id,c.ordinal,c.due FROM control_recoveries c JOIN host_requests r ON r.id=c.request_id WHERE r.thread_id=? ORDER BY c.due DESC LIMIT 3', (thread,)).fetchall()
            return {'paired': bool(p and p['enabled'] and p['expires'] > self.host.clock()),
                    'observer_recent': bool(p and p['enabled'] and p['expires'] > self.host.clock() and p['last_seen'] > self.host.clock() - 20),
                    'generation': p['generation'] if p else None,
                    'model_label': p['model'] if p else None, 'effort_label': p['effort'] if p else None,
                    'attempts': [dict(x) for x in attempts], 'recoveries': [dict(x) for x in recovery], 'model_identity_attested': False,
                    'automatic_resume_verified': False, 'legacy_pairing_upgraded': False,
                    'unknown_send_retried': False, 'max_error_recoveries_per_request': len(DELAYS),
                    'error_backoff_seconds': list(DELAYS), 'silence_is_failure': False}

    def private(self, binding, data):
        with self.host.business_admission(read_only=isinstance(data,dict) and data.get('action')=='control-status'):
            return self._private(binding,data)
    def _private(self,binding,data):
        action = data['action']
        if action == 'control-status':
            return self.snapshot(binding['thread_id'])
        if action == 'control-receive':
            return self.receive(binding, data['attempt_id'])
        require(data['confirm'] is True, 'control_explicit_confirmation_required', 403)
        with closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            if action == 'control-disable':
                db.execute('UPDATE control_peers SET enabled=0 WHERE thread_id=?', (binding['thread_id'],))
                self.host.emit(db, binding['thread_id'], 'control_disabled', {'native_execution_stopped': False})
                db.commit()
                return {'disabled': True, 'native_execution_stopped': False}
            require(binding['enabled'], 'host_paused', 409)
            if action == 'control-code':
                model, effort = permitted_labels(data['model_label'], data['effort_label'])
                code = secrets.token_hex(8).upper()
                db.execute('DELETE FROM control_codes WHERE thread_id=? OR expires<?', (binding['thread_id'], self.host.clock()))
                db.execute('INSERT INTO control_codes VALUES(?,?,?,?,?)', (digest(code), binding['thread_id'], model, effort, self.host.clock() + 120))
                db.commit()
                return {'pair_code': code, 'expires_in': 120, 'separate_control_opt_in': True,
                        'model_label': model, 'effort_label': effort, 'scope': 'fixed_original_request_prompt_and_bounded_explicit_failure_recovery'}
            require(action == 'control-adopt', 'control_private_action')
            r = self.original(db, binding, data['request_id'])
            require(r['phase'] in ('queued', 'suspended') and not r['cancel_requested'], 'control_original_not_adoptable', 409)
            p = db.execute('SELECT * FROM control_peers WHERE thread_id=?', (binding['thread_id'],)).fetchone()
            require(p and p['enabled'] and p['expires'] > self.host.clock(), 'control_pair_required', 409)
            epoch = self.epoch(db, r)
            prior = db.execute('SELECT state FROM control_attempts WHERE request_id=? AND epoch=?', (r['id'], epoch)).fetchone()
            require(not prior or prior['state'] == 'offered', 'control_previous_dispatch_no_replay', 409)
            db.execute('INSERT OR IGNORE INTO control_adoptions VALUES(?,?,?)', (r['id'], epoch, p['generation']))
            db.commit()
            return {'request_id': r['id'], 'epoch': epoch, 'adopted': True, 'request_replayed': False}


    def trusted_companion_origin(self, db, origin):
        """A previously paired CLW extension origin is the one-time profile trust anchor."""
        recovery = db.execute('SELECT 1 FROM recovery_peers WHERE origin=? LIMIT 1', (origin,)).fetchone()
        control = db.execute('SELECT 1 FROM control_peers WHERE origin=? LIMIT 1', (origin,)).fetchone()
        return bool(recovery or control)

    def discovery_candidates(self, db, origin, chat_url):
        """Resolve current page vs runnable CLW work without exposing routing ids."""
        mapped = db.execute(
            'SELECT thread_id,MAX(seen) AS seen FROM ('
            'SELECT thread_id,last_seen AS seen FROM recovery_peers WHERE origin=? AND chat_url=? UNION ALL '
            'SELECT thread_id,last_seen AS seen FROM control_peers WHERE origin=? AND chat_url=?'
            ') GROUP BY thread_id ORDER BY seen DESC', (origin, chat_url, origin, chat_url)).fetchall()
        mapped_threads = {x['thread_id'] for x in mapped}
        all_threads = [x['thread_id'] for x in db.execute(
            "SELECT b.thread_id FROM host_bindings b JOIN threads t ON t.id=b.thread_id "
            "WHERE b.enabled=1 AND t.provider='chatgpt_web_host' ORDER BY t.created_at")]

        def resolve(thread_id):
            try:
                b = self.host.binding(db, thread=thread_id)
            except Exception:
                return None
            existing = db.execute(
                'SELECT origin,chat_url,enabled,expires FROM control_peers WHERE thread_id=?', (thread_id,)).fetchone()
            if existing and existing['enabled'] and existing['expires'] > self.host.clock() and (
                    existing['origin'] != origin or existing['chat_url'] != chat_url):
                return None
            request = self.host.collaboration.candidate(db, b)
            return b, dict(request) if request is not None else None, thread_id in mapped_threads

        mapped_rows = [x for x in (resolve(t) for t in mapped_threads) if x is not None]
        mapped_runnable = [x for x in mapped_rows if x[1] is not None]
        if mapped_runnable:
            return {'candidates': mapped_runnable, 'wrong_page': None}

        other_runnable = [x for x in (resolve(t) for t in all_threads if t not in mapped_threads)
                          if x is not None and x[1] is not None]
        if mapped_rows and other_runnable:
            current_titles = [str(x[0]['spec'].get('title') or 'CLW Web 对话')[:130] for x in mapped_rows]
            pending_titles = [str(x[0]['spec'].get('title') or 'CLW Web 对话')[:130] for x in other_runnable[:8]]
            return {'candidates': [], 'wrong_page': {
                'current_titles': current_titles, 'pending_titles': pending_titles,
                'switch_required': True}}

        if mapped_rows:
            return {'candidates': mapped_rows, 'wrong_page': None}
        return {'candidates': other_runnable, 'wrong_page': None}

    def bootstrap(self, origin, data):
        require(set(data) in ({'action','chat_url','tab_nonce','page','confirm_low_cost'}, {'action','chat_url','tab_nonce','page','confirm_low_cost','enrollment'}, {'action','chat_url','tab_nonce','page','confirm_low_cost','enrollment_ticket'}, {'action','chat_url','tab_nonce','page','confirm_low_cost','confirm_page_binding'}), 'control_bootstrap_fields')
        require(isinstance(data['chat_url'], str) and CHAT.fullmatch(data['chat_url']), 'control_exact_chat_required', 403)
        require(isinstance(data['tab_nonce'], str) and NONCE.fullmatch(data['tab_nonce']), 'control_tab_nonce_required')
        page = validate_page(data['page'])
        require(type(data['confirm_low_cost']) is bool, 'control_confirmation_flag')
        explicit_page = data.get('confirm_page_binding',False)
        require(type(explicit_page) is bool,'control_page_binding_confirmation_flag')
        model, effort = resolve_visible_guard(page, data['confirm_low_cost'])
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            marker=data.get('enrollment');ticket=data.get('enrollment_ticket')
            require(not (marker and ticket),'team_multiple_browser_proofs',403)
            proof_thread=(self.host.team.carriers.marker_target(db,marker,origin,data['chat_url']) if marker else
                          self.host.team.carriers.ticket_target(db,ticket,origin,data['chat_url']) if ticket else None)
            require(proof_thread or self.trusted_companion_origin(db, origin), 'control_profile_not_previously_trusted', 403)
            db.execute('DELETE FROM host_carrier_discoveries WHERE discovery_id IN (SELECT id FROM control_discoveries WHERE expires<?)',(self.host.clock(),))
            db.execute('DELETE FROM control_page_authorizations WHERE discovery_id IN (SELECT id FROM control_discoveries WHERE expires<?)',(self.host.clock(),))
            db.execute('DELETE FROM control_discoveries WHERE expires<?', (self.host.clock(),))
            if proof_thread:
                proved=self.host.binding(db,thread=proof_thread)
                candidate=db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase IN ('queued','suspended') AND cancel_requested=0 ORDER BY created_at LIMIT 1",(proved['thread_id'],)).fetchone()
                discovery={'candidates':[(proved,dict(candidate) if candidate else None,False)],'wrong_page':None}
            else:
                discovery = self.discovery_candidates(db, origin, data['chat_url'])
            if discovery['wrong_page']:
                db.commit()
                return {'state': 'wrong_registered_page', **discovery['wrong_page'],
                        'internal_target_required': False, 'pair_code_required': False}
            candidates = discovery['candidates']
            require(candidates, 'control_no_registered_clw_conversation', 409)
            unproved=[b['spec']['title'] for b,_,old_page in candidates if not old_page and not db.execute('SELECT 1 FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()]
            if unproved and not proof_thread:
                db.commit();return {'state':'enrollment_required','titles':unproved[:8],'model_created':False,'browser_created':False}
            result = []
            for b, request, previously_bound in candidates[:8]:
                did = 'clwd_' + uuid.uuid4().hex
                db.execute('INSERT INTO control_discoveries VALUES(?,?,?,?,?,?,?,?,?)',
                           (did, origin, data['chat_url'], data['tab_nonce'], b['thread_id'],
                            request['id'] if request else None, model, effort, self.host.clock()+120))
                if proof_thread:db.execute('INSERT INTO host_carrier_discoveries VALUES(?,?)',(did,proof_thread))
                if explicit_page and not proof_thread:
                    link=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
                    old_page=db.execute('SELECT 1 FROM control_peers WHERE thread_id=? UNION ALL SELECT 1 FROM recovery_peers WHERE thread_id=? LIMIT 1',(b['thread_id'],b['thread_id'])).fetchone()
                    attempts=db.execute('SELECT 1 FROM control_attempts WHERE thread_id=? LIMIT 1',(b['thread_id'],)).fetchone()
                    open_claim=db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended') AND claim_id IS NOT NULL LIMIT 1",(b['thread_id'],)).fetchone()
                    if link and link['state']=='receiver_enrolled' and not link['chat_url'] and not old_page and not attempts and not open_claim:
                        db.execute("INSERT INTO control_page_authorizations VALUES(?,?, 'explicit_popup_first_page',?)",(did,b['thread_id'],self.host.clock()))
                spec = b['spec']
                result.append({'discovery_id': did, 'title': str(spec.get('title') or 'CLW Web 对话')[:130],
                               'has_current_request': request is not None, 'previously_bound': previously_bound})
            db.commit()
        auto_bind_safe = len(result) == 1 and (bool(proof_thread) or result[0]['previously_bound'])
        return {'state': 'one_confirmed_receiver' if proof_thread else 'one_previously_bound' if auto_bind_safe else 'choose_candidate',
                'auto_bind_safe': auto_bind_safe, 'candidates': result,
                'internal_target_required': False, 'pair_code_required': False}

    def bind_discovery(self, origin, data):
        require(set(data) == {'action','discovery_id','confirm','confirm_low_cost','chat_url','tab_nonce','page'}, 'control_bind_fields')
        require(data['confirm'] is True, 'control_explicit_confirmation_required', 403)
        require(isinstance(data['discovery_id'], str) and re.fullmatch(r'clwd_[0-9a-f]{32}', data['discovery_id']), 'control_discovery_id')
        require(isinstance(data['chat_url'], str) and CHAT.fullmatch(data['chat_url']), 'control_exact_chat_required', 403)
        require(isinstance(data['tab_nonce'], str) and NONCE.fullmatch(data['tab_nonce']), 'control_tab_nonce_required')
        page = validate_page(data['page'])
        require(type(data['confirm_low_cost']) is bool, 'control_confirmation_flag')
        resolve_visible_guard(page, data['confirm_low_cost'])
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            d = db.execute('SELECT * FROM control_discoveries WHERE id=? AND origin=? AND chat_url=? AND tab_nonce=?',
                           (data['discovery_id'], origin, data['chat_url'], data['tab_nonce'])).fetchone()
            require(d and d['expires'] > self.host.clock(), 'control_discovery_expired_or_foreign', 403)
            require(guard_compatible(d['model'], d['effort'], page), 'control_visible_labels_changed', 409)
            b = self.host.binding(db, thread=d['thread_id'])
            require(b['enabled'], 'host_paused', 409)
            previously_bound = bool(db.execute(
                'SELECT 1 FROM recovery_peers WHERE origin=? AND chat_url=? AND thread_id=? UNION ALL '
                'SELECT 1 FROM control_peers WHERE origin=? AND chat_url=? AND thread_id=? LIMIT 1',
                (origin, data['chat_url'], b['thread_id'], origin, data['chat_url'], b['thread_id'])).fetchone())
            uncertain = db.execute(
                "SELECT 1 FROM control_attempts WHERE thread_id=? AND state IN ('dispatching','sent','unknown') LIMIT 1",
                (b['thread_id'],)).fetchone()
            require(uncertain is None, 'control_previous_dispatch_no_replay', 409)
            recovery_uncertain = db.execute(
                "SELECT 1 FROM recovery_attempts a JOIN recovery_peers p ON p.id=a.peer_id "
                "WHERE p.thread_id=? AND a.state IN ('dispatching','sent','unknown') LIMIT 1",
                (b['thread_id'],)).fetchone()
            require(recovery_uncertain is None, 'control_legacy_dispatch_requires_reconciliation', 409)
            proof=db.execute('SELECT 1 FROM host_carrier_discoveries WHERE discovery_id=? AND thread_id=?',(d['id'],b['thread_id'])).fetchone()
            page_auth=db.execute('SELECT 1 FROM control_page_authorizations WHERE discovery_id=? AND thread_id=?',(d['id'],b['thread_id'])).fetchone()
            request = None
            if d['request_id']:
                current=(db.execute("SELECT * FROM host_requests WHERE id=? AND thread_id=? AND phase IN ('queued','suspended') AND cancel_requested=0",(d['request_id'],b['thread_id'])).fetchone() if proof else self.host.collaboration.candidate(db,b))
                require(current and current['id'] == d['request_id'], 'control_original_not_runnable', 409)
                request = dict(current)
            link=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
            if link and not link['chat_url']:
                require(proof or page_auth,'team_browser_receipt_required',403)
            old = db.execute('SELECT generation FROM control_peers WHERE thread_id=?', (b['thread_id'],)).fetchone()
            generation = old['generation'] + 1 if old else 1
            token = 'clwc_' + secrets.token_urlsafe(32)
            cutoff = db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0]
            db.execute('UPDATE recovery_peers SET enabled=0 WHERE thread_id=?', (b['thread_id'],))
            db.execute("UPDATE recovery_attempts SET state='cancelled' WHERE state='planned' AND peer_id IN "
                       "(SELECT id FROM recovery_peers WHERE thread_id=?)", (b['thread_id'],))
            db.execute('INSERT OR REPLACE INTO control_peers VALUES(?,?,?,?,?,?,?,?,1,?,?,?)',
                       (b['thread_id'], generation, digest(token), origin, data['chat_url'], data['tab_nonce'],
                        d['model'], d['effort'], self.host.clock()+3600, self.host.clock(), cutoff))
            self.host.team.carriers.bound(db,b,origin,data['chat_url'],generation)
            adopted = None
            if request is not None:
                epoch = self.epoch(db, request)
                prior = db.execute('SELECT state FROM control_attempts WHERE request_id=? AND epoch=?',
                                   (request['id'], epoch)).fetchone()
                require(not prior or prior['state'] == 'offered', 'control_previous_dispatch_no_replay', 409)
                db.execute('INSERT OR IGNORE INTO control_adoptions VALUES(?,?,?)',
                           (request['id'], epoch, generation))
                adopted = request['id']
            db.execute('DELETE FROM control_page_authorizations WHERE discovery_id IN (SELECT id FROM control_discoveries WHERE origin=? AND chat_url=?)',(origin,data['chat_url']))
            db.execute('DELETE FROM control_discoveries WHERE origin=? AND chat_url=?', (origin, data['chat_url']))
            self.host.emit(db, b['thread_id'], 'control_paired',
                           {'generation': generation,
                            'source': 'enrollment_proof' if proof else 'explicit_page_authorization' if page_auth else 'unified_companion_discovery',
                            'old_requests_require_adoption': False, 'model_attested': False})
            if adopted:
                self.host.emit(db, b['thread_id'], 'control_adopted',
                               {'request_id': adopted, 'generation': generation,
                                'previously_bound_exact_page': previously_bound,
                                'human_title_confirmation_required': not previously_bound})
            db.commit()
            spec = b['spec']
        return {'control_token': token, 'generation': generation, 'store_id': self.state.id,
                'model_label': d['model'], 'effort_label': d['effort'],
                'title': str(spec.get('title') or 'CLW Web 对话')[:130],
                'adopted_request_id': adopted, 'internal_target_required': False, 'pair_code_required': False}

    def pair(self, origin, data):
        require(set(data) == {'action', 'code', 'chat_url', 'tab_nonce'}, 'control_pair_fields')
        require(isinstance(data['chat_url'], str) and CHAT.fullmatch(data['chat_url']), 'control_exact_chat_required', 403)
        require(isinstance(data['tab_nonce'], str) and NONCE.fullmatch(data['tab_nonce']), 'control_tab_nonce_required')
        require(isinstance(data['code'], str) and re.fullmatch('[0-9A-F]{16}', data['code']), 'control_code_invalid', 403)
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            c = db.execute('SELECT * FROM control_codes WHERE hash=?', (digest(data['code']),)).fetchone()
            require(c and c['expires'] > self.host.clock(), 'control_code_expired_or_used', 403)
            b = self.host.binding(db, thread=c['thread_id'])
            require(b['enabled'], 'host_paused', 409)
            require(not db.execute('SELECT 1 FROM recovery_peers WHERE thread_id=? AND enabled=1 AND expires>?', (b['thread_id'], self.host.clock())).fetchone(),
                    'control_disable_legacy_recovery_first', 409)
            require(not db.execute('SELECT 1 FROM control_peers WHERE origin=? AND chat_url=? AND thread_id<>? AND enabled=1 AND expires>?',
                                   (origin, data['chat_url'], b['thread_id'], self.host.clock())).fetchone(), 'control_tab_already_bound', 409)
            carrier=db.execute('SELECT * FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
            if carrier:
                require(carrier['state']!='revoked' and carrier['chat_url']==data['chat_url'] and carrier['origin']==origin,'team_legacy_pair_cannot_bypass_enrollment',403)
            old = db.execute('SELECT generation FROM control_peers WHERE thread_id=?', (b['thread_id'],)).fetchone()
            gen = old['generation'] + 1 if old else 1
            cutoff = db.execute('SELECT COALESCE(MAX(seq),0) FROM events').fetchone()[0]
            token = 'clwc_' + secrets.token_urlsafe(32)
            db.execute('INSERT OR REPLACE INTO control_peers VALUES(?,?,?,?,?,?,?,?,1,?,?,?)',
                       (b['thread_id'], gen, digest(token), origin, data['chat_url'], data['tab_nonce'], c['model'], c['effort'], self.host.clock()+3600, self.host.clock(), cutoff))
            self.host.team.carriers.bound(db,b,origin,data['chat_url'],gen)
            db.execute('DELETE FROM control_codes WHERE hash=?', (digest(data['code']),))
            self.host.emit(db, b['thread_id'], 'control_paired', {'generation': gen, 'old_requests_require_adoption': True, 'model_attested': False})
            db.commit()
            return {'control_token': token, 'generation': gen, 'store_id': self.state.id,
                    'model_label': c['model'], 'effort_label': c['effort'], 'thread_id': b['thread_id']}

    def authorize(self, db, origin, token, data):
        require(isinstance(token, str) and TOKEN.fullmatch(token), 'control_token_required', 403)
        p = db.execute('SELECT * FROM control_peers WHERE token_hash=? AND origin=?', (digest(token), origin)).fetchone()
        require(p and p['enabled'] and p['expires'] > self.host.clock(), 'control_pair_expired_or_disabled', 403)
        require(type(data['generation']) is int and p['generation'] == data['generation'] and p['tab_nonce'] == data['tab_nonce'] and p['chat_url'] == data['chat_url'], 'control_binding_mismatch', 403)
        b = self.host.binding(db, thread=p['thread_id'])
        spec = self.host.targets.get(b['target_id']) or self.host.collaboration.definition(b['target_id'])
        require(b['spec'] == spec, 'control_target_changed_or_paused', 409)
        if not b['enabled']:
            require(data['action'] in ('sent','result','finish'),'control_target_changed_or_paused',409)
            original=self.attempt(db,p,data['attempt_id'])
            require(original['state'] in ('dispatching','sent','unknown','acknowledged','completed'),'control_send_not_committed',409)
        carrier=db.execute('SELECT state,generation FROM host_carrier_links WHERE thread_id=?',(b['thread_id'],)).fetchone()
        require(not carrier or (carrier['state']=='browser_bound' and carrier['generation']==p['generation']),'team_receiver_enrollment_revoked_or_changed',403)
        return p, b

    def page_safe(self, peer, page):
        unsafe = PAGE_BOOL - {'visible', 'controls_known'}
        return (page['visible'] and page['controls_known'] and not any(page[k] for k in unsafe)
                and guard_compatible(peer['model'], peer['effort'], page))

    def labels_compatible(self,peer,page):
        return guard_compatible(peer['model'],peer['effort'],page)

    def result_page_safe(self,peer,page):
        return self.page_safe(peer,page)

    def page_requests_disable(self,peer,page):
        return page['stopped'] or page['blocked']

    def sent_page_safe(self,page):
        return (page['visible'] and page['controls_known'] and not any(
            page[k] for k in ('blocked','stopped','draft','composing','focused')))

    def complete_browser_reply(self,db,b,r,receipt,a,data):
        return self.host.browser_reply(db,b,r,receipt['claim_id'],a['id'],data['text'],data['assistant_turn_hash'])

    def eligible(self, db, peer, b, page, git_probe=None):
        r = self.host.collaboration.candidate(db, b, git_probe=git_probe)
        if not r:
            return self.recovery_candidate(db, peer, b, page)
        r = dict(r)
        if self.host.future_paused(db,b,r):return None
        if r['cancel_requested']:
            return None
        epoch = self.epoch(db, r)
        latest = db.execute("SELECT COALESCE(MAX(seq),0) FROM events WHERE thread_id=? AND kind IN ('host_queued','host_delegated_input','host_waiting_children') AND json_extract(data,'$.request_id')=?", (b['thread_id'], r['id'])).fetchone()[0]
        adopted = db.execute('SELECT 1 FROM control_adoptions WHERE request_id=? AND epoch=? AND generation=?', (r['id'], epoch, peer['generation'])).fetchone()
        if latest <= peer['cutoff'] and not adopted:
            return None
        return r, epoch

    def wire(self, origin, token, data):
        require(isinstance(origin, str) and EXTENSION.fullmatch(origin), 'control_extension_origin_required', 403)
        return self.process(origin,token,data)

    def process(self,origin,token,data):
        with self.host.business_admission(read_only=data=={'action':'capabilities'}):return self._process(origin,token,data)
    def _process(self,origin,token,data):
        """Journal operations. Public HTTP must enter through wire(), never here.

        The managed carrier uses a separate process-private transport and policy,
        while retaining the same attempt, request, claim and result identities.
        """
        require(isinstance(data, dict), 'control_body_required')
        if data=={'action':'capabilities'}:return {'control_protocol':self.protocol_version,'receiver_enrollment':True,'run_budgets':True,'browser_public_result':True,'default_enabled':False}
        if data.get('action') == 'bootstrap':
            return self.bootstrap(origin, data)
        if data.get('action') == 'bind':
            return self.bind_discovery(origin, data)
        if data.get('action') == 'pair':
            return self.pair(origin, data)
        fields = {'pulse': {'page'}, 'dispatch': {'attempt_id', 'page'}, 'sent': {'attempt_id','page','assistant_before_hash'}, 'result': {'attempt_id','page','assistant_turn_hash','text'}, 'finish': {'attempt_id', 'result'}, 'disable': set()}
        action = data.get('action')
        require(action in fields and set(data) == {'action', 'generation', 'chat_url', 'tab_nonce'} | fields[action], 'control_wire_fields')
        if 'page' in data:
            validate_page(data['page'])
        # A missing legacy Git identity can be checked from the current public
        # scope before BEGIN IMMEDIATE. The later admission still rechecks the
        # authenticated peer and persisted scope; a stale probe only queues.
        git_probe = None
        if action in ('pulse','dispatch','sent'):
            tentative=self.tentative_thread_for_git_probe(origin,token,data)
            if tentative:git_probe=self.host.team.scopes.preflight_native_git(tentative)
        with self.host.lock, closing(self.state.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            p, b = self.authorize(db, origin, token, data)
            if 'page' in data:self.host.team.carriers.observe(db,b,p,data['page'])
            # A live authenticated document renews its bounded lease. Expired or
            # revoked tokens were already rejected above and cannot revive here.
            db.execute('UPDATE control_peers SET last_seen=?,expires=? WHERE thread_id=?', (self.host.clock(), self.host.clock()+3600, b['thread_id']))
            if action == 'disable' or ('page' in data and self.page_requests_disable(p,data['page'])):
                db.execute('UPDATE control_peers SET enabled=0 WHERE thread_id=?', (b['thread_id'],))
                self.host.emit(db, b['thread_id'], 'control_disabled', {'native_execution_stopped': False})
                db.commit()
                return {'state': 'disabled', 'native_execution_stopped': False}
            if action == 'sent':
                require(isinstance(data['assistant_before_hash'],str) and DIGEST.fullmatch(data['assistant_before_hash']),
                        'control_assistant_identity_required')
                a=self.attempt(db,p,data['attempt_id'])
                receipt=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(a['id'],)).fetchone()
                if receipt:
                    if not receipt['sent_user_hash'] and hasattr(self,'confirm_delayed_browser_receipt'):
                        receipt=self.confirm_delayed_browser_receipt(db,p,b,a,receipt,data)
                    require(receipt['sent_user_hash']==data['page']['user_hash'],'control_sent_user_changed',409)
                    db.commit();return {'state':'browser_result_pending','attempt_id':a['id'],
                        'sent_user_hash':receipt['sent_user_hash'],'assistant_before_hash':receipt['assistant_before_hash']}
                require(a['state']=='dispatching','control_send_not_committed',409)
                page=data['page']
                require(self.sent_page_safe(page),'control_sent_page_not_safe',409)
                require(self.labels_compatible(p,page),'control_visible_labels_changed',409)
                require(page['user_hash']!=a['user_hash'],'control_send_not_observed',409)
                r=self.original(db,b,a['request_id'])
                require(self.epoch(db,r)==a['epoch'] if a['epoch']>=0 else r['phase']=='processing',
                        'control_request_epoch_changed',409)
                claim=self.host.browser_claim(db,b,r,a['id'],git_probe=git_probe)
                db.execute("UPDATE control_attempts SET state='acknowledged',acknowledged=? WHERE id=?",
                           (self.host.clock(),a['id']))
                db.execute('DELETE FROM host_unread_notes WHERE request_id=? AND note_id IN (SELECT note_id FROM control_browser_note_receipts WHERE attempt_id=?)',(r['id'],a['id']))
                db.execute('INSERT INTO control_browser_receipts VALUES(?,?,?,?,?,?,NULL,NULL,NULL,NULL)',
                           (a['id'],r['id'],b['thread_id'],claim,page['user_hash'],data['assistant_before_hash']))
                self.host.emit(db,b['thread_id'],'control_received',
                               {'request_id':r['id'],'attempt_id':a['id'],'source':'bound_browser_public_receiver',
                                'task_completed':False})
                db.commit()
                return {'state':'browser_result_pending','attempt_id':a['id'],
                        'sent_user_hash':page['user_hash'],'assistant_before_hash':data['assistant_before_hash']}
            if action == 'result':
                require(isinstance(data['assistant_turn_hash'],str) and DIGEST.fullmatch(data['assistant_turn_hash']),
                        'control_assistant_identity_required')
                require(isinstance(data['text'],str) and 0<len(data['text'].strip())<=48000 and '\x00' not in data['text'],
                        'control_browser_result_text')
                a=self.attempt(db,p,data['attempt_id'])
                receipt=db.execute('SELECT * FROM control_browser_receipts WHERE attempt_id=?',(a['id'],)).fetchone()
                require(receipt and a['state']=='acknowledged','control_browser_result_not_pending',409)
                text_hash=digest(data['text'])
                if receipt['result_hash']:
                    require(receipt['result_hash']==text_hash and receipt['result_turn_hash']==data['assistant_turn_hash'],
                            'control_browser_result_conflict',409)
                    saved=db.execute('SELECT response FROM host_replies WHERE id=?',(receipt['reply_id'],)).fetchone()
                    require(saved,'control_browser_result_receipt_missing',409)
                    response=json.loads(saved['response'])
                    db.commit();return {'state':response['phase'] if response['phase'] in ('yielded','needs_attention') else 'completed','receipt':response,'replayed':True}
                require(self.result_page_safe(p,data['page']),'control_result_page_not_safe',409)
                require(data['page']['user_hash']==receipt['sent_user_hash'],'control_result_user_changed',409)
                require(data['assistant_turn_hash']!=receipt['assistant_before_hash'],'control_result_not_new_assistant_turn',409)
                r=self.original(db,b,receipt['request_id'])
                result=self.complete_browser_reply(db,b,r,receipt,a,data)
                db.execute('UPDATE control_browser_receipts SET result_turn_hash=?,result_hash=?,reply_id=?,completed=? WHERE attempt_id=?',
                           (data['assistant_turn_hash'],text_hash,result['reply_id'],self.host.clock(),a['id']))
                db.commit();return {'state':result['phase'] if result['phase'] in ('yielded','needs_attention') else 'completed','receipt':result,'replayed':False}
            if action == 'finish':
                require(data['result'] in ('sent', 'not_sent', 'unknown'), 'control_finish_value')
                a = self.attempt(db, p, data['attempt_id'])
                if a['state'] == 'acknowledged':
                    return {'state': 'acknowledged', 'task_completed': False}
                require(a['state'] in ('dispatching', data['result']), 'control_finish_conflict', 409)
                db.execute('UPDATE control_attempts SET state=? WHERE id=?', (data['result'], a['id']))
                if data['result']=='not_sent' and a['state']!='not_sent':
                    self.host.emit(db,b['thread_id'],'control_not_sent',
                                   {'request_id':a['request_id'],'attempt_id':a['id'],
                                    'source':'browser_preclick_failure','model_received':False,
                                    'automatic_retry':False})
                db.commit()
                return {'state': data['result'], 'model_received': False}
            if not self.page_safe(p, data['page']):
                db.commit()
                return {'state': 'page_not_safe_or_model_mismatch', 'dispatch': False}
            inflight = db.execute("SELECT 1 FROM control_attempts a JOIN host_requests r ON r.id=a.request_id WHERE a.thread_id<>? AND a.state IN ('dispatching','sent','unknown') AND r.phase IN ('queued','processing','suspended') LIMIT 1", (b['thread_id'],)).fetchone()
            if inflight and self.host.team.scopes.busy(db,b['thread_id'],git_probe=git_probe):
                db.commit()
                return {'state': 'workspace_waiting_other_control_receipt', 'dispatch': False}
            pending_result=db.execute(
                "SELECT br.* FROM control_browser_receipts br JOIN control_attempts a ON a.id=br.attempt_id "
                "JOIN host_requests r ON r.id=br.request_id WHERE br.thread_id=? AND a.generation=? "
                "AND br.result_hash IS NULL AND r.phase IN ('processing','suspended') ORDER BY a.acknowledged DESC LIMIT 1",
                (b['thread_id'],p['generation'])).fetchone()
            if action=='pulse' and pending_result:
                if not pending_result['sent_user_hash']:
                    db.commit();return {'state':'model_received_browser_confirmation_pending','attempt_id':pending_result['attempt_id']}
                page=data['page']
                if page['user_hash']!=pending_result['sent_user_hash']:
                    # A visible error on another user turn cannot retire this
                    # accepted Send or authorize a recovery prompt for it.
                    db.commit();return {'state':'browser_result_pending','attempt_id':pending_result['attempt_id'],
                        'sent_user_hash':pending_result['sent_user_hash'],
                        'assistant_before_hash':pending_result['assistant_before_hash']}
                base=db.execute('SELECT failure_hash FROM control_baselines WHERE request_id=?',
                                (pending_result['request_id'],)).fetchone()
                new_terminal=bool(page['failure_kind'] and base and base['failure_hash']!=page['failure_hash'])
                if not new_terminal:
                    db.commit();return {'state':'browser_result_pending','attempt_id':pending_result['attempt_id'],
                        'sent_user_hash':pending_result['sent_user_hash'],
                        'assistant_before_hash':pending_result['assistant_before_hash']}
                # The model received the original request, but this exact turn ended
                # in a new explicit generation error and has no public result to
                # commit. End result capture and hand the SAME original request to
                # the existing bounded recovery planner. Silence never enters here.
                db.execute('DELETE FROM control_browser_receipts WHERE attempt_id=?',
                           (pending_result['attempt_id'],))
                self.host.emit(db,b['thread_id'],'control_browser_result_failed',
                               {'request_id':pending_result['request_id'],
                                'attempt_id':pending_result['attempt_id'],
                                'failure_kind':page['failure_kind'],
                                'failure_hash':page['failure_hash'],
                                'public_result_committed':False})
                recovery=self.recovery_candidate(db,p,b,page)
                if not recovery:
                    db.commit();return {'state':'browser_result_failed_recovery_pending',
                        'attempt_id':pending_result['attempt_id'],'failure_kind':page['failure_kind']}
                candidate=recovery
            else:
                candidate = self.eligible(db, p, b, data['page'],git_probe=git_probe)
            if candidate and self.host.team.run_for_request(db,candidate[0]['id']) and not (data['page']['model_label'] and data['page']['effort_label']):
                db.commit();return {'state':'team_visible_model_and_effort_required','dispatch':False}

            if action == 'pulse':
                if not candidate:
                    db.commit()
                    return {'state': 'idle_or_old_request_not_adopted'}
                r, epoch = candidate
                a = db.execute('SELECT * FROM control_attempts WHERE request_id=? AND epoch=?', (r['id'], epoch)).fetchone()
                if not a:
                    aid = 'control_' + uuid.uuid4().hex
                    db.execute("INSERT INTO control_attempts VALUES(?,?,?,?,?,'offered',?,?,NULL,NULL)", (aid, r['id'], b['thread_id'], epoch, p['generation'], data['page']['user_hash'], self.host.clock()))
                    self.host.emit(db, b['thread_id'], 'control_offered', {'request_id': r['id'], 'attempt_id': aid, 'epoch': epoch, 'model_received': False})
                    a = db.execute('SELECT * FROM control_attempts WHERE id=?', (aid,)).fetchone()
                if a['state'] != 'offered' or a['generation'] != p['generation']:
                    db.commit()
                    return {'state': 'original_attempt_requires_reconciliation', 'attempt_id': a['id'], 'attempt_state': a['state'], 'dispatch': False}
                # Waiting for a managed slot is not an execution attempt. A fresh
                # safe pulse may renew only the same never-dispatched offer.
                if (getattr(self,'renew_initial_offer',False) or self.host.team.run_for_request(db,r['id'])) and a['dispatched'] is None and a['user_hash']==data['page']['user_hash'] and self.host.clock()-a['offered']>=60:
                    db.execute("UPDATE control_attempts SET offered=? WHERE id=? AND state='offered' AND dispatched IS NULL",(self.host.clock(),a['id']))
                db.commit()
                return {'state': 'offer', 'attempt_id': a['id'], 'request_id': r['id'], 'user_hash': a['user_hash'], 'failure_hash': data['page']['failure_hash'], 'recovery': epoch < 0,
                        'model_label': p['model'], 'effort_label': p['effort']}
            a = self.attempt(db, p, data['attempt_id'])
            require(a['state'] == 'offered', 'control_dispatch_already_committed_no_retry', 409)
            if not candidate and self.host.team.run_for_request(db,a['request_id']):
                db.commit();return {'state':'team_waiting_admission','dispatch':False}
            require(candidate and candidate[0]['id'] == a['request_id'] and candidate[1] == a['epoch'], 'control_original_not_runnable', 409)
            require(a['user_hash'] == data['page']['user_hash'], 'control_user_turn_changed', 409)
            require(self.host.clock() - a['offered'] <= 120, 'control_offer_expired_no_retry', 409)
            budget_stop=self.host.team.before_dispatch(db,candidate[0],a['id'],git_probe=git_probe)
            if budget_stop:
                db.commit();return {'state':budget_stop,'dispatch':False}
            if a['epoch'] >= 0:
                db.execute('INSERT OR REPLACE INTO control_baselines VALUES(?,?)', (a['request_id'], data['page']['failure_hash']))
            db.execute('INSERT OR IGNORE INTO control_browser_note_receipts(attempt_id,note_id) SELECT ?,note_id FROM host_unread_notes WHERE request_id=?',(a['id'],a['request_id']))
            db.execute("UPDATE control_attempts SET state='dispatching',dispatched=? WHERE id=?", (self.host.clock(), a['id']))
            self.host.emit(db, b['thread_id'], 'control_dispatch', {'request_id': a['request_id'], 'attempt_id': a['id'], 'model_received': False})
            # Preparing the prompt may reject an oversized result or fail to
            # persist its delivery cursor. Do not commit a Send grant until the
            # complete prompt is ready to return to the browser.
            prompt=self.prompt(db,b,a)
            db.commit()
            return {'dispatch': True, 'attempt_id': a['id'], 'prompt': prompt}

    def recovery_children_ready(self, db, request, page):
        if not self.host.collaboration.outstanding(db, request['id']):return True
        # A resumed controller retains its committed selected wait. Unselected
        # branches must not turn recovery of that same failed turn into wait-all.
        run=self.host.team.run_for_request(db,request['id'])
        if (page['failure_kind']!='generation_failed' or not run
                or run['controller_request']!=request['id'] or run['controller_thread']!=request['thread_id']
                or run['state']!='running' or run['wait_mode']!='selected'
                or self.host.team.ready(db,request) is not True):return False
        wait=db.execute("SELECT 1 FROM events WHERE seq=? AND thread_id=? AND kind='host_waiting_children' "
                        "AND json_extract(data,'$.request_id')=? AND json_extract(data,'$.run_id')=? "
                        "AND json_extract(data,'$.wait_mode')='selected'",
                        (self.epoch(db,request),request['thread_id'],request['id'],run['id'])).fetchone()
        spec=db.execute('SELECT selected_requests FROM host_team_wait_specs WHERE run_id=?',(run['id'],)).fetchone()
        if not wait or not spec:return False
        try:
            selected=self.host.team.journal.selection(db,run,'selected',json.loads(spec['selected_requests']))
            return self.host.team.journal.selected_terminal(db,selected)
        except (HarnessError,ValueError,TypeError):
            return False

    def recovery_candidate(self, db, peer, binding, page):
        # Only explicit NEW terminal-generation errors; never a silence timeout.
        r = db.execute("SELECT * FROM host_requests WHERE thread_id=? AND phase='processing' AND cancel_requested=0 ORDER BY created_at DESC LIMIT 1", (binding['thread_id'],)).fetchone()
        if not r or not self.recovery_children_ready(db,r,page):return None
        r = dict(r)
        if self.host.future_paused(db,binding,r):return None
        # A fresh pair must not adopt an older in-flight model by observing an error.
        latest=db.execute("SELECT id,acknowledged FROM control_attempts WHERE request_id=? AND generation=? AND state='acknowledged' ORDER BY acknowledged DESC LIMIT 1",
                          (r['id'], peer['generation'])).fetchone()
        if not latest:return None
        base = db.execute('SELECT failure_hash FROM control_baselines WHERE request_id=?', (r['id'],)).fetchone()
        if not base:
            db.execute('INSERT INTO control_baselines VALUES(?,?)', (r['id'], page['failure_hash']))
            return None  # Existing error when monitoring first starts is ignored.
        if not page['failure_kind'] or base['failure_hash'] == page['failure_hash']:return None
        # A missing receipt cannot be repaired by issuing another Send.
        if db.execute("SELECT 1 FROM control_attempts WHERE request_id=? AND state IN ('dispatching','sent','unknown')", (r['id'],)).fetchone():return None
        # Error wording is usually identical on successive failed turns.
        # Distinguish occurrences with the acknowledged attempt, while keeping
        # pre-migration rows usable for their exact original user turn.
        failure_key=digest(latest['id']+':'+page['failure_hash'])
        rec = db.execute('SELECT * FROM control_recoveries WHERE request_id=? AND failure_hash=?',
                         (r['id'], failure_key)).fetchone()
        if not rec:
            legacy=db.execute('SELECT * FROM control_recoveries WHERE request_id=? AND failure_hash=?',
                              (r['id'], page['failure_hash'])).fetchone()
            if (legacy and legacy['user_hash']==page['user_hash']
                    and legacy['generation']==peer['generation']
                    and latest['acknowledged'] < legacy['due']):
                rec=legacy
        if not rec:
            count = db.execute('SELECT COUNT(*) FROM control_recoveries WHERE request_id=?', (r['id'],)).fetchone()[0]
            if count >= len(DELAYS):return None
            db.execute('INSERT INTO control_recoveries VALUES(?,?,?,?,?,?,?)', (r['id'], failure_key, page['user_hash'], count+1, self.host.clock()+DELAYS[count], self.epoch(db,r), peer['generation']))
            self.host.emit(db, binding['thread_id'], 'control_recovery_planned', {'request_id':r['id'], 'ordinal':count+1, 'delay':DELAYS[count], 'silence_is_failure':False})
            return None
        if rec['generation'] != peer['generation'] or rec['base_epoch'] != self.epoch(db,r) or rec['user_hash'] != page['user_hash']:return None
        if self.host.clock() < rec['due']:return None
        if self.host.clock()-rec['due'] > 120 and not getattr(self,'renew_expired_recovery',False):return None
        return r, -rec['ordinal']

    def attempt(self, db, peer, attempt_id):
        require(isinstance(attempt_id, str) and re.fullmatch('control_[0-9a-f]{32}', attempt_id), 'control_attempt_id')
        a = db.execute('SELECT * FROM control_attempts WHERE id=? AND thread_id=? AND generation=?', (attempt_id, peer['thread_id'], peer['generation'])).fetchone()
        require(a is not None, 'control_attempt_foreign_or_stale', 403)
        return a

    def prompt(self,db,binding,attempt):
        r=self.original(db,binding,attempt['request_id'])
        account=original_account(db,binding)
        if attempt['epoch']<0:
            parts=[continuation_prompt(account)]
            notes=[x['text'] for x in db.execute('SELECT n.text FROM host_notes n JOIN host_unread_notes u ON u.note_id=n.id WHERE n.request_id=? ORDER BY n.created_at,n.rowid',(r['id'],))]
            if notes:parts+=['--- 新增要求 ---',*notes]
            prompt='\n'.join(parts)
            require(0<len(prompt)<=96000,'control_browser_prompt_too_large',413)
            return prompt
        notes=[x['text'] for x in db.execute('SELECT text FROM host_notes WHERE request_id=? ORDER BY created_at,rowid',(r['id'],))]
        current_run=self.host.team.run_for_request(db,r['id'])
        run=self.host.team.public_run(current_run) if current_run else None
        parts=[
            'CLW 原请求接管通知；这是原请求，不是新的任务或权限。'+connector_reference(account),
            '使用本对话自己的 Runtime Project / Workflow Session；不要复用其他对话的 Session，不要切换到 Pro、Codex 或其他模型。',
            '先读取实际项目 AGENTS.md / 当前入口，检查本对话自己的已有 Job/成果；已有工作不得重做。',
            '浏览器载体会自动确认领取并回传你本轮最终公开回复；不要运行 harness_host_client control-receive/reply，也不要复制 claim/ticket。',
            WORK_PACKAGE_GUIDANCE,
            '完成任务后，在本对话给出完整公开结果/交接。该公开回复会作为原 child 结果返回给父任务；不要只回复“完成”。',
            '--- 原请求 ---',r['text']]
        if notes:parts+=['--- 后续追加要求 ---',*notes]
        if run:parts+=['--- 当前持续运行状态（本地调度元数据，不是模型额度认证） ---',json.dumps(run,ensure_ascii=False)]
        prompt='\n'.join(parts)
        require(0<len(prompt)<=96000,'control_browser_prompt_too_large',413)
        return prompt

    def receive(self, binding, attempt_id):
        # Called ONLY behind existing project Host key + exact Session checks.
        with closing(self.state.connect()) as db:
            p = db.execute('SELECT * FROM control_peers WHERE thread_id=?', (binding['thread_id'],)).fetchone()
            require(p and p['enabled'] and p['expires'] > self.host.clock(), 'control_receiver_disabled', 409)
            a = self.attempt(db, p, attempt_id)
            require(a['state'] in ('dispatching', 'sent', 'unknown', 'acknowledged'), 'control_no_dispatch_to_receive', 409)
            r = self.original(db, binding, a['request_id'])
            require(not r['cancel_requested'], 'control_request_cancelled', 409)
            if a['epoch'] < 0:
                rec = db.execute('SELECT base_epoch FROM control_recoveries WHERE request_id=? AND ordinal=? AND generation=?', (r['id'], -a['epoch'], p['generation'])).fetchone()
                require(rec and rec['base_epoch'] == self.epoch(db,r) and r['phase']=='processing', 'control_recovery_epoch_changed', 409)
            else:
                require(self.epoch(db, r) == a['epoch'], 'control_request_epoch_changed', 409)
            if a['state'] == 'acknowledged':
                return {**self.host.project_request(binding, r), 'control_attempt_id': a['id'], 'already_received': True, 'original_claim_id': r['claim_id'], 'execution': 'recover_original_do_not_repeat'}
            require(r['phase'] in ('queued', 'processing', 'suspended'), 'control_original_terminal', 409)
            claim = r['claim_id'] or 'clw-control-claim-' + attempt_id.removeprefix('control_')
        result = self.host.private(self.host._key, {'action': 'claim', 'store_id': self.state.id,
            'target_id': binding['target_id'], 'session_id': binding['spec']['session_id'],
            'request_id': r['id'], 'claim_id': claim})
        with closing(self.state.connect()) as db:
            db.execute("UPDATE control_attempts SET state='acknowledged',acknowledged=? WHERE id=?", (self.host.clock(), attempt_id))
            self.host.emit(db, binding['thread_id'], 'control_received', {'request_id': r['id'], 'attempt_id': attempt_id, 'source': 'authorized_project_receiver', 'task_completed': False})
            db.commit()
        return {**result, 'control_attempt_id': attempt_id, 'original_claim_id': claim, 'already_received': False}
