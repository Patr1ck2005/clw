"""Versioned public-turn control block for newly opted-in managed conversations.

The parser only recognizes one trailing block in the confirmed controller's
final reply. It does not grant authority: the existing TeamRuntime validates
the bound actor, worker targets, claim, scopes, budget and resource leases.
"""
from __future__ import annotations

import json
import re
import hashlib
import uuid

from pathlib import Path

from harness_state import HarnessError, canonical, require, stamp
from harness_team_common import hash_value, identifier, object_fields, text
from harness_team_timing import result_timing
from harness_managed_models import effort_key, worker_settings, model_key
from harness_control_plane import label
from harness_team_scopes import validate_access, worker_access
from harness_accounts import connector_name
from harness_work_package import WORK_PACKAGE_GUIDANCE, goal_result_guidance
from harness_recovery import continuation_prompt
from harness_run_limits import deadline_live, sends_available
from harness_next_round import current_notes


TEXT_V1 = 'text_v1'
LEGACY = 'tool_v1'
FENCE = re.compile(
    r'(?m)^[ \t]*(?P<fence>`{3,}|~{3,})clw-plan-v1[ \t]*\r?\n'
    r'(?P<body>.*?)\r?\n[ \t]*(?P=fence)[ \t]*\s*\Z', re.S
)
SAFETY_REPORT = re.compile(
    r"(?:tool call was blocked by OpenAI|OpenAI (?:couldn.t|cannot) determine the safety status|"
    r"因\s*OpenAI\s*无法确定请求的安全状态|平台安全检查.{0,24}拦截)", re.I
)


def mode(settings):
    selected = settings.get('collaboration_protocol', LEGACY)
    require(selected in (LEGACY, TEXT_V1), 'managed_collaboration_protocol_invalid')
    return selected


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def parse_controller_reply(markdown):
    """Return a validated proposal, or raise without interpreting any command."""
    require(isinstance(markdown, str), 'managed_text_reply_invalid')
    # A reported rejection may be historical, quoted, or already recovered.
    # Only the confirmed controller's explicit decision is a proposal. The
    # existing scope, claim, budget and execution gates still validate it.
    match = FENCE.search(markdown)
    require(match and markdown.count('clw-plan-v1') == 1,
            'managed_text_control_block_missing_or_ambiguous', 409)
    require(len(match['body']) <= 4 * 1024 * 1024,
            'managed_text_control_block_too_large', 409)
    try:
        proposal = json.loads(match['body'], object_pairs_hook=_unique_pairs,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
    except (ValueError, TypeError) as exc:
        raise HarnessError('managed_text_control_block_invalid_json', 409) from exc
    require(isinstance(proposal, dict) and type(proposal.get('version')) is int
            and proposal['version'] == 1, 'managed_text_control_version', 409)
    action = proposal.get('action')
    require(action in ('dispatch', 'completed', 'needs_attention', 'retry_batch'),
            'managed_text_control_action', 409)
    if action == 'dispatch':
        object_fields(proposal, {'version', 'action', 'workers'}, {'wait', 'resume', 'resolve_batch'})
        workers = proposal['workers']
        require(isinstance(workers, list) and bool(workers),
                'managed_text_workers_required', 409)
        seen = set()
        for worker in workers:
            object_fields(worker, {'key', 'objective'},
                          {'target', 'title', 'model', 'effort', 'access',
                           'write_paths', 'resources', 'first_turn_instructions'})
            key = identifier(worker['key'])
            require(key not in seen, 'managed_text_worker_key_duplicate', 409)
            seen.add(key)
            text(worker['objective'], 'work', 24000)
            if 'target' in worker:
                identifier(worker['target'])
                require(set(worker) <= {'key', 'target', 'objective', 'effort', 'title'},
                        'managed_text_existing_worker_settings_immutable', 409)
                if 'title' in worker:text(worker['title'], 'title', 130)
            else:
                if 'title' in worker:text(worker['title'], 'title', 130)
                if 'model' in worker:text(worker['model'], 'model', 160)
                access = worker.get('access', 'read')
                validate_access(access, worker.get('write_paths', []),
                                worker.get('resources', []))
                if 'first_turn_instructions' in worker:
                    text(worker['first_turn_instructions'], 'first_turn_instructions', 12000)
            if 'effort' in worker:
                text(worker['effort'], 'effort', 120)
        # Waiting is a program responsibility. A controller only has to name
        # the recipients and their work; explicit older plans remain valid.
        proposal.setdefault('wait', {'mode': 'all', 'workers': [w['key'] for w in workers]})
        proposal.setdefault('resume', '结合全部协作者的完整结果，自主核对、整合并继续原目标。')
        wait = proposal['wait']
        object_fields(wait, {'mode', 'workers'})
        # The first version waits for the complete independent batch. This
        # avoids treating newly emitted delegation signals as child results.
        require(wait['mode'] == 'all', 'managed_text_wait_mode', 409)
        require(isinstance(wait['workers'], list)
                and len(wait['workers']) == len(seen)
                and all(isinstance(key, str) for key in wait['workers'])
                and set(wait['workers']) == seen,
                'managed_text_wait_workers_mismatch', 409)
        text(proposal['resume'], 'resume', 12000)
    elif action == 'completed':
        object_fields(proposal, {'version', 'action', 'summary'}, {'references', 'resolve_batch'})
        text(proposal['summary'], 'summary', 24000)
        refs = proposal.get('references', [])
        require(isinstance(refs, list) and len(refs) <= 32,
                'managed_text_references_invalid', 409)
        for ref in refs:
            text(ref, 'reference', 2000)
    elif action == 'retry_batch':
        object_fields(proposal, {'version', 'action', 'attempt_id'}, {'reason'})
        identifier(proposal['attempt_id'])
        if 'reason' in proposal:text(proposal['reason'], 'reason', 2000)
    else:
        object_fields(proposal, {'version', 'action', 'reason'})
        text(proposal['reason'], 'reason', 2000)
    if 'resolve_batch' in proposal:
        resolution = proposal['resolve_batch']
        object_fields(resolution, {'attempt_id', 'decision'})
        identifier(resolution['attempt_id'])
        require(resolution['decision'] == 'abandon', 'managed_text_batch_resolution', 409)
    return proposal


class TextCollaboration:
    """An opt-in adapter around the existing request/claim/team transaction."""

    def __init__(self, managed, db):
        self.managed = managed
        self.host = managed.host
        db.executescript('''
          CREATE TABLE IF NOT EXISTS managed_text_deliveries(
            attempt_id TEXT PRIMARY KEY,run_id TEXT,through_seq INTEGER NOT NULL,
            event_refs TEXT NOT NULL,created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS managed_text_artifact_turns(
            attempt_id TEXT PRIMARY KEY,assistant_turn_hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS managed_text_plans(
            attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,controller_request TEXT NOT NULL,
            plan TEXT NOT NULL,created REAL NOT NULL);
          CREATE INDEX IF NOT EXISTS managed_text_plans_by_run ON managed_text_plans(run_id,created);
          CREATE TABLE IF NOT EXISTS managed_text_batches(
            attempt_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,controller_request TEXT NOT NULL,
            claim_id TEXT NOT NULL,workers TEXT NOT NULL,state TEXT NOT NULL,
            issue TEXT,created REAL NOT NULL);
          CREATE INDEX IF NOT EXISTS managed_text_batches_pending ON managed_text_batches(state,created);
        ''')

    @staticmethod
    def artifact(db, attempt, data):
        source = db.execute('SELECT assistant_turn_hash FROM managed_text_artifact_turns WHERE attempt_id=?',
                            (attempt['id'],)).fetchone()
        require(source and source['assistant_turn_hash'] == data['assistant_turn_hash'],
                'managed_text_artifact_turn_mismatch', 409)
        row = db.execute("SELECT * FROM managed_artifacts WHERE id=? AND source='public_dom_markdown'",
                         (attempt['id'],)).fetchone()
        require(row, 'managed_text_public_artifact_required', 409)
        raw = Path(row['path']).read_bytes()
        require(len(raw) == row['bytes'] and hashlib.sha256(raw).hexdigest() == row['sha256'],
                'managed_text_public_artifact_changed', 409)
        value = raw.decode('utf-8')
        if value != data['text']:
            # The driver references large replies instead of copying them
            # through the bounded browser-result field. UTF-16 JS length and
            # Python code-point length differ for emoji, so use byte size as
            # the conservative lower bound for a legitimate large summary.
            require(len(raw) > 46000 and row['path'] in data['text'] and
                    row['sha256'] in data['text'],
                    'managed_text_public_reply_mismatch', 409)
        return value, row

    @staticmethod
    def _body(raw, artifact):
        return (raw if len(raw.encode('utf-8')) <= 46000 else
                raw[:1000] + '\n\n完整公开原文（必须读取）：' + artifact['path'] +
                '\nSHA256: ' + artifact['sha256'])

    @staticmethod
    def _within_paths(child_paths, parent_paths):
        if parent_paths == ['.']:
            return True
        allowed = [path.casefold() for path in parent_paths]
        return all(any(path.casefold() == base or path.casefold().startswith(base + '/')
                       for base in allowed) for path in child_paths)

    def _owned_child(self, db, parent_target, child):
        return bool(child and child['parent_target'] and
                    self.managed.handoffs.parent_target(db, child['parent_target']) == parent_target)

    def _resolve_worker(self, db, binding, page, attempt, worker):
        if 'target' in worker:
            child = db.execute('SELECT parent_target,settings,title FROM managed_pages WHERE target_id=?',
                               (worker['target'],)).fetchone()
            require(self._owned_child(db, page['target_id'], child) and
                    mode(json.loads(child['settings'])) == TEXT_V1,
                    'managed_text_worker_not_owned', 403)
            require('title' not in worker or worker['title']==child['title'],
                    'managed_text_existing_worker_title_changed',409)
            return {k:v for k,v in worker.items() if k!='title'}
        parent_settings = json.loads(page['settings'])
        scope = self.host.team.scopes.scope(db, binding['thread_id'])
        require(scope and scope['root'] == page['root'], 'managed_text_controller_scope_changed', 409)
        access, inherited_paths = worker_access(scope, page['root'], worker)
        paths, resources = validate_access(access, inherited_paths,
                                           worker.get('resources', []))
        require(access == 'read' or (scope['access'] == 'write' and
                self._within_paths(paths, json.loads(scope['write_paths']))),
                'managed_text_worker_write_scope_not_granted', 403)
        require(set(resources) <= set(json.loads(scope['resources'])),
                'managed_text_worker_resource_not_granted', 403)
        requested = dict(worker)
        requested['first_turn_instructions']=(worker.get('first_turn_instructions','').strip()+'\n\n'+worker['objective']).strip()
        requested['first_turn_mode']='task_v1'
        if requested.get('effort') == 'inherit':
            requested['effort'] = page['effort']
        selected = worker_settings(page, parent_settings, requested)
        page_id = 'web-' + str(uuid.uuid5(uuid.NAMESPACE_URL,
                                'clw-text-v1:' + attempt['id'] + ':' + worker['key']))
        require(not db.execute('SELECT 1 FROM managed_pages WHERE page_id=?', (page_id,)).fetchone(),
                'managed_text_worker_page_conflict', 409)
        title = worker.get('title') or (page['title'][:90] + ' · ' + worker['key'])
        self.managed.reserve(db, {
            'page_id': page_id, 'title': title, 'root': page['root'],
            'access': access, 'write_paths': paths, 'resources': resources,
            'duration_seconds': parent_settings.get('duration_seconds'),
            'max_dispatches': parent_settings.get('max_dispatches'),
            'first_turn_instructions': requested['first_turn_instructions'],
            'first_turn_mode':'task_v1',
            'collaboration_protocol': TEXT_V1, **selected,
        }, binding)
        return {**worker, 'target': page_id, 'initial_task':True}

    def _workers_ready(self, db, parent_target, workers):
        pending = False
        for worker in workers:
            child = db.execute('SELECT * FROM managed_pages WHERE target_id=?',
                               (worker['target'],)).fetchone()
            require(self._owned_child(db, parent_target, child) and
                    mode(json.loads(child['settings'])) == TEXT_V1,
                    'managed_text_worker_not_owned', 403)
            issue = db.execute('SELECT kind FROM managed_page_issues WHERE page_id=?',
                               (child['page_id'],)).fetchone()
            if issue:
                return 'needs_attention', child['page_id'] + ': ' + issue['kind']
            if child['phase'] != 'bound' or self.managed.paused(db, child) or \
                    json.loads(child['settings']).get('work_model_pending'):
                pending = True
                continue
            binding = self.host.binding(db, target=child['target_id'])
            if not binding['enabled'] or not self.host.team.carriers.projection(db, binding)['runnable']:
                pending = True
                continue
            if db.execute("SELECT 1 FROM host_requests WHERE thread_id=? AND phase IN ('queued','processing','suspended')",
                          (child['thread_id'],)).fetchone():
                pending = True
                continue
            if 'effort' in worker:
                parent = db.execute('SELECT effort FROM managed_pages WHERE target_id=?',
                                    (parent_target,)).fetchone()
                expected = parent['effort'] if worker['effort'] == 'inherit' else worker['effort']
                require(effort_key(expected) == effort_key(child['effort']),
                        'managed_text_worker_effort_mismatch', 409)
            if 'model' in worker:
                require(model_key(worker['model']) == model_key(child['model']),
                        'managed_text_worker_model_mismatch', 409)
        return ('waiting_pages', None) if pending else ('ready', None)

    def _assign_batch(self, db, binding, run, claim, attempt_id, workers, *, prepared=False):
        for worker in workers:
            if worker.get('initial_task'):
                page=db.execute('SELECT settings,thread_id FROM managed_pages WHERE target_id=?',(worker['target'],)).fetchone()
                request=json.loads(page['settings']).get('first_task_request_id') if page else None
                require(request and db.execute('SELECT 1 FROM host_team_work w JOIN host_requests q ON q.id=w.request_id WHERE w.request_id=? AND w.run_id=? AND q.thread_id=?',(request,run['id'],page['thread_id'])).fetchone(),'managed_first_task_assignment_missing',409)
                continue  # Already executed in enrollment; never dispatch it twice.
            child_key = 'text-' + hash_value({'attempt': attempt_id, 'key': worker['key']})[:40]
            self.host.team.assign(db, binding, {
                'run_id': run['id'], 'claim_id': claim, 'target': worker['target'],
                'text': worker['objective'], 'depends_on': [], 'resources': [],
            }, child_key, prepared=prepared)

    def reconcile(self, db):
        """Advance persisted page-enrollment batches without another M model turn."""
        rows = db.execute("SELECT * FROM managed_text_batches WHERE state IN ('waiting_pages','retry_requested') ORDER BY created").fetchall()
        for batch in rows:
            run = db.execute('SELECT * FROM host_runs WHERE id=?', (batch['run_id'],)).fetchone()
            request = db.execute('SELECT * FROM host_requests WHERE id=?',
                                 (batch['controller_request'],)).fetchone()
            page = db.execute('SELECT * FROM managed_pages WHERE thread_id=?',
                              (run['controller_thread'],)).fetchone() if run else None
            if not run or not request or not page or request['cancel_requested']:
                db.execute("UPDATE managed_text_batches SET state='stopped' WHERE attempt_id=?",
                           (batch['attempt_id'],))
                continue
            if self.managed.paused(db, page):
                continue
            workers = json.loads(batch['workers'])
            try:
                status, issue = self._workers_ready(db, page['target_id'], workers)
            except HarnessError as exc:
                status, issue = 'needs_attention', exc.code
            if status == 'waiting_pages' or (status == 'needs_attention' and batch['state'] == 'retry_requested'):
                continue
            if status == 'ready':
                db.execute('SAVEPOINT managed_text_batch')
                try:
                    require(request['phase'] == 'suspended' and
                            request['claim_id'] == batch['claim_id'] and
                            run['state'] == 'running' and run['wait_mode'] == 'all' and
                            not db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',
                                           (request['id'],)).fetchone(),
                            'managed_text_batch_original_changed', 409)
                    actor = self.host.binding(db, thread=run['controller_thread'])
                    self._assign_batch(db, actor, dict(run), batch['claim_id'],
                                       batch['attempt_id'], workers, prepared=True)
                    db.execute("UPDATE managed_text_batches SET state='assigned' WHERE attempt_id=?",
                               (batch['attempt_id'],))
                    db.execute('RELEASE managed_text_batch')
                    continue
                except (HarnessError, ValueError, TypeError) as exc:
                    db.execute('ROLLBACK TO managed_text_batch')
                    db.execute('RELEASE managed_text_batch')
                    issue = getattr(exc, 'code', 'managed_text_batch_invalid')
            db.execute("UPDATE managed_text_batches SET state='needs_attention',issue=? WHERE attempt_id=?",
                       (issue, batch['attempt_id']))
            self.host.team.signal(db, dict(run), 'managed_text_batch_attention', request['id'])

    def _results(self, db, binding, run):
        """Snapshot only public result events that this exact next Send includes."""
        team = self.host.team
        through = run['after_seq']
        parts = []
        refs = []
        signals = db.execute(
            'SELECT seq,request_id,kind,source_event FROM host_team_signals '
            'WHERE run_id=? AND seq>? ORDER BY seq', (run['id'], through)).fetchall()
        if signals:
            through = signals[-1]['seq']
        seen = set()
        for signal in signals:
            request_id = signal['request_id']
            if not request_id or request_id == run['controller_request'] or request_id in seen:
                continue
            seen.add(request_id)
            q = db.execute('SELECT thread_id,phase FROM host_requests WHERE id=?', (request_id,)).fetchone()
            if not q:
                continue
            page = db.execute('SELECT title,effort FROM managed_pages WHERE thread_id=?',
                              (q['thread_id'],)).fetchone()
            title = page['title'] if page else request_id
            prefix = f'协作者 {title}；原请求 {request_id}；阶段 {q["phase"]}；档位 {page["effort"] if page else "未知"}'
            attention = team.journal.attention(db, request_id, q['thread_id'])
            if attention:
                prefix += '\n待处理原文：' + str(attention.get('reason', ''))
            timing = result_timing(db, request_id)
            timing.pop('planning_note', None)
            prefix += '\n可观察历时：' + canonical(timing)
            cursor = db.execute(
                'SELECT through_seq FROM host_team_result_cursors WHERE run_id=? AND controller_thread=? AND request_id=?',
                (run['id'], binding['thread_id'], request_id)).fetchone()
            after = cursor['through_seq'] if cursor else 0
            events = db.execute(
                "SELECT seq,data FROM events WHERE thread_id=? AND kind='assistant_message' "
                "AND json_extract(data,'$.request_id')=? AND seq>? ORDER BY seq",
                (q['thread_id'], request_id, after)).fetchall()
            replies = []
            confirmed_attention = attention and db.execute(
                "SELECT 1 FROM managed_artifacts a "
                "JOIN control_browser_receipts r ON r.attempt_id=a.id AND r.request_id=a.request_id "
                "JOIN managed_text_artifact_turns t ON t.attempt_id=a.id "
                "WHERE a.id=? AND a.request_id=? AND a.source='public_dom_markdown' "
                "AND r.completed IS NOT NULL AND r.result_hash IS NOT NULL "
                "AND t.assistant_turn_hash=r.result_turn_hash",
                (attention['attempt_id'], request_id)).fetchone()
            if confirmed_attention:
                # A failed branch still has useful work. Carry its original
                # reply back with the failure state, not just an error label.
                original = self._full_public_reply(db, request_id, {
                    'item_id': 'clw-browser-reply-' + attention['attempt_id'].removeprefix('control_'),
                    'text': attention.get('reason', '')})
                replies.append('协作者受阻时保存的原文（不表示成功）：\n' + original)
                refs.append({'kind': 'attention', 'request_id': request_id,
                             'attempt_id': attention['attempt_id'], 'hash': hash_value(attention)})
            for event in events:
                reply = json.loads(event['data'])
                refs.append({'request_id': request_id, 'seq': event['seq'],
                             'hash': hash_value(reply)})
                replies.append(self._full_public_reply(db, request_id, reply))
            artifacts = [dict(row) for row in db.execute(
                'SELECT path,sha256,bytes,source FROM managed_artifacts WHERE request_id=? ORDER BY created',
                (request_id,))]
            parts.append(prefix + ('\n公开答复全文：\n' + '\n\n'.join(replies) if replies else '\n尚无已确认公开答复') +
                         ('\n原始成果文件：' + canonical(artifacts) if artifacts else ''))
        return '\n\n'.join(parts), through, refs

    @staticmethod
    def _full_public_reply(db, request_id, reply):
        """Copy the saved original, not its UI/transport-length summary."""
        item = reply.get('item_id', '')
        if item.startswith(('clw-initial-result-', 'first-task-result-')) or item == 'first-ta[redacted]':
            # Enrollment and useful work share one Send. Its result has no
            # control attempt yet; resolve it through the original request
            # and the reply receipt, never through the latest page artifact.
            artifact = db.execute(
                "SELECT a.* FROM managed_artifacts a "
                "JOIN managed_pages p ON a.id='first-task-'||p.page_id AND a.thread_id=p.thread_id "
                "JOIN host_replies r ON r.request_id=a.request_id "
                "AND (r.id=? OR (?='first-ta[redacted]' AND r.id LIKE 'first-task-result-%')) "
                "WHERE a.request_id=? AND a.source='local_mcp_public_result' "
                "AND json_extract(p.settings,'$.first_task_request_id')=a.request_id",
                (item, item, request_id)).fetchone()
        elif item.startswith('clw-browser-reply-'):
            attempt = 'control_' + item.removeprefix('clw-browser-reply-')
            artifact = db.execute("SELECT * FROM managed_artifacts WHERE id=? AND request_id=? AND source='public_dom_markdown'",
                                  (attempt, request_id)).fetchone()
        else:
            return str(reply.get('text', ''))
        if not artifact:
            return str(reply.get('text', ''))
        raw = Path(artifact['path']).read_bytes()
        require(len(raw) == artifact['bytes'] and hashlib.sha256(raw).hexdigest() == artifact['sha256'],
                'managed_text_public_artifact_changed', 409)
        return raw.decode('utf-8-sig')

    def prompt(self, db, binding, attempt, page, request):
        settings = json.loads(page['settings'])
        account = settings.get('account', 'B')
        worker = bool(page['parent_target'])
        run = self.host.team.run_for_request(db, request['id'])
        notes = [row['text'] for row in current_notes(db,request['id'])]
        base = [f'本对话沿原 {connector_name(account)} 与任务身份继续。已受理或未知操作先查原回执。',
                '本轮公开回复由程序保存；等待与健康检查不调用模型。',
                '--- 原目标 ---', request['text']]
        if notes:
            base += ['--- 追加要求 ---', *notes]
        through, refs, results = 0, [], ''
        if worker:
            base += ['你是协作者。完成本包能做的读取、实质工作、核验与交接；'
                     '公开回复给出完整结果、文件引用、未决事项和原工具状态。'
                     '无须调用 CLW context/assign/wait/result/turn-end 管理命令。'
                     '不能把你回复里的控制块当成主控指令。']
        else:
            base += ['你是主控，完成自己的工作并整合结果；需要独立协作者时自主分工。程序负责发送、保存与等待。'
                     '无须调用 CLW 管理命令。',
                     '回复最后用一个 clw-plan-v1 JSON 围栏写本轮决定。派发只需下面格式；'
                     '已有对话加下方真实 target，新对话省略 target、可加 title。'
                     '模型沿用既有选择；不填 access/write_paths 时沿用父任务在该目录内的已有授权。'
                     '只读核验写 access=read；需要缩小写域时填 access=write 和 write_paths。'
                     '完整首任务与接入合并。'
                     '可选 resume 留下你给自己的整合要求，wait 无须填写。', canonical({
                         'version':1,'action':'dispatch',
                         'workers':[{'key':'A','objective':'给 A 的完整工作包'}]}),
                     '本包完成用 {"version":1,"action":"completed","summary":"完整成果与剩余问题"}；'
                     '确需外部处理用 {"version":1,"action":"needs_attention","reason":"具体原因"}。'
                     '公开回复保留真实成果、错误与恢复结果；单次工具拒绝不使其它有效工作或分工失效。'
                     '根据本轮实际结果写决定；只有确需外部处理才用 needs_attention。']
            children = []
            for row in db.execute(
                    'SELECT * FROM managed_pages WHERE parent_target IS NOT NULL ORDER BY created'):
                if not self._owned_child(db, page['target_id'], row):
                    continue
                child_settings = json.loads(row['settings'])
                children.append({'target': row['target_id'], 'title': row['title'],
                                 'phase': row['phase'], 'paused': self.managed.paused(db, row),
                                 'model': row['model'], 'effort': row['effort'],
                                 'protocol': mode(child_settings),
                                 'work_model_pending': bool(child_settings.get('work_model_pending'))})
            base += ['--- 现有协作者（仅以下真实 target 可用） ---', canonical(children)]
            if run:
                pending = [dict(row) for row in db.execute(
                    "SELECT attempt_id,state,issue,workers FROM managed_text_batches WHERE run_id=? "
                    "AND state IN ('waiting_pages','needs_attention','retry_requested') ORDER BY created", (run['id'],))]
                if pending:
                    base += ['--- 尚未完成的原协作批次（不可重派同一工作） ---', canonical(pending)]
                    base += ['继续原批可用 {"version":1,"action":"retry_batch","attempt_id":"原批编号"}，'
                             '程序只等待原页，不重发已接受调用。放弃未派发原批时，可在新决定附 '
                             'resolve_batch={"attempt_id":"原批编号","decision":"abandon"}。']
                row = db.execute('SELECT plan FROM managed_text_plans WHERE run_id=? ORDER BY created DESC LIMIT 1',
                                 (run['id'],)).fetchone()
                if row:
                    base += ['--- 上轮主控自己留下的接续要求 ---', json.loads(row['plan'])['resume']]
                results, through, refs = self._results(db, binding, run)
                if results:
                    base += ['--- 本轮新到的结果与待处理事项（完整原文或附文件引用） ---', results]
            base += ['格式：```clw-plan-v1 换行写你的实际 JSON 决定，再换行用 ``` 结束；只输出一个决定块。']
        if attempt['epoch'] < 0:
            base = [continuation_prompt(account)]
            unread = [row['text'] for row in db.execute(
                'SELECT n.text FROM host_notes n JOIN host_unread_notes u ON u.note_id=n.id '
                'WHERE n.request_id=? ORDER BY n.created_at,n.rowid', (request['id'],))]
            if unread:
                base += ['--- 新增要求 ---', *unread]
            if results:
                base += ['--- 新到的协作结果 ---', results]
            if not worker:
                base += ['仍以一个 clw-plan-v1 JSON 围栏交付本轮决定。']
        goal_guidance=goal_result_guidance(db,binding['thread_id'],request['id'])
        base += [goal_guidance, 'Goal 状态与等待信息写在控制块之前。' if goal_guidance and not worker else '',WORK_PACKAGE_GUIDANCE]
        prompt = '\n'.join(part for part in base if part)
        require(len(prompt) <= 512000, 'managed_text_prompt_requires_result_batching', 409)
        db.execute('INSERT INTO managed_text_deliveries VALUES(?,?,?,?,?)',
                   (attempt['id'], run['id'] if run else None, through, canonical(refs), self.host.clock()))
        # The delivery cursor and dispatch grant commit together. An error in
        # prompt preparation leaves the original offered attempt retryable.
        return prompt

    def _ack_delivered(self, db, binding, run, attempt):
        row = db.execute('SELECT * FROM managed_text_deliveries WHERE attempt_id=?',
                         (attempt['id'],)).fetchone()
        # The first controller prompt is prepared before its original browser
        # Send opens the run. It carries no prior team result or signal cursor.
        require(row and (row['run_id'] == run['id'] or
                (row['run_id'] is None and row['through_seq'] == 0
                 and json.loads(row['event_refs']) == [])),
                'managed_text_delivery_missing', 409)
        for ref in json.loads(row['event_refs']):
            if ref.get('kind') == 'attention':
                result = self.host.team.journal.result(db, binding,
                    {'run_id': run['id'], 'request_id': ref['request_id']})
                attention = dict(result.get('attention') or {})
                attention.pop('controller_option', None)
                require(attention.get('attempt_id') == ref['attempt_id'] and
                        hash_value(attention) == ref['hash'],
                        'managed_text_delivered_attention_changed', 409)
                continue
            cursor = db.execute(
                'SELECT through_seq FROM host_team_result_cursors WHERE run_id=? AND controller_thread=? AND request_id=?',
                (run['id'], binding['thread_id'], ref['request_id'])).fetchone()
            after = cursor['through_seq'] if cursor else 0
            if after >= ref['seq']:
                continue
            result = self.host.team.journal.result(db, binding,
                {'run_id': run['id'], 'request_id': ref['request_id'], 'after_seq': after})
            require(result['event_seq'] == ref['seq'] and result['reply']
                    and hash_value(result['reply']) == ref['hash'],
                    'managed_text_delivered_result_changed', 409)
        return row['through_seq']

    def complete(self, db, binding, request, receipt, attempt, data):
        try:
            raw, artifact = self.artifact(db, attempt, data)
        except (HarnessError, UnicodeError, OSError) as exc:
            return self.managed.control.attention_reply(db, binding, request, receipt, attempt,
                {**data, 'text': '公开回复与当前网页回合未能核对；原执行保留：' +
                 getattr(exc, 'code', 'managed_text_artifact_unreadable')})
        page = db.execute('SELECT * FROM managed_pages WHERE thread_id=?',
                          (binding['thread_id'],)).fetchone()
        require(page and mode(json.loads(page['settings'])) == TEXT_V1,
                'managed_text_page_mode_changed', 409)
        if page['parent_target']:
            declared = db.execute('SELECT kind FROM managed_turn_outcomes WHERE attempt_id=?',
                                  (attempt['id'],)).fetchone()
            if declared and declared['kind'] == 'needs_attention':
                return self.managed.control.attention_reply(db, binding, request, receipt, attempt,
                    {**data, 'text': raw + '\n原文：' + artifact['path']})
            if SAFETY_REPORT.search(raw):
                self.host.emit(db, binding['thread_id'], 'managed_worker_reported_tool_rejection', {
                    'request_id': request['id'], 'attempt_id': attempt['id'],
                    'artifact_path': artifact['path'], 'source': 'public_report',
                    'meaning': 'reported_operation_issue_not_task_cancellation',
                    'task_accepted': False})
            if db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',
                          (request['id'],)).fetchone():
                db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?", (request['id'],))
                db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",
                           (stamp(), binding['thread_id']))
                self.host.team.scopes.release(db, request['id'])
                self.host.emit(db, binding['thread_id'], 'host_waiting_children',
                               {'request_id': request['id'], 'reason': 'additional_instructions', 'no_new_request': True})
                return self.host.browser_reply(db, binding, {**dict(request), 'phase': 'suspended'},
                                               receipt['claim_id'], attempt['id'], data['text'],
                                               data['assistant_turn_hash'])
            return self.host.browser_reply(db, binding, request, receipt['claim_id'], attempt['id'],
                                           self._body(raw, artifact), data['assistant_turn_hash'])
        if db.execute('SELECT 1 FROM host_unread_notes WHERE request_id=?',
                      (request['id'],)).fetchone():
            # A correction received after this browser Send invalidates an
            # unexecuted plan. Keep the same request/claim and present the new
            # input in the next program-woken turn; do not create pages now.
            db.execute("UPDATE host_requests SET phase='suspended' WHERE id=?", (request['id'],))
            db.execute("UPDATE threads SET status='waiting_children',updated_at=? WHERE id=?",
                       (stamp(), binding['thread_id']))
            self.host.team.scopes.release(db, request['id'])
            self.host.emit(db, binding['thread_id'], 'host_waiting_children',
                           {'request_id': request['id'], 'reason': 'new_controller_instructions',
                            'no_new_request': True})
            return self.host.browser_reply(db, binding, {**dict(request), 'phase': 'suspended'},
                                           receipt['claim_id'], attempt['id'],
                                           self._body(raw, artifact), data['assistant_turn_hash'])
        try:
            proposal = parse_controller_reply(raw)
        except HarnessError as exc:
            return self.managed.control.attention_reply(db, binding, request, receipt, attempt,
                {**data, 'text': '主控控制块未执行：' + exc.code + '\n原文：' + artifact['path']})
        if proposal['action'] == 'needs_attention':
            return self.managed.control.attention_reply(db, binding, request, receipt, attempt,
                {**data, 'text': proposal['reason'] + '\n原文：' + artifact['path']})
        db.execute('SAVEPOINT managed_text_apply')
        try:
            run = self.host.team.run_for_request(db, request['id'])
            require(run and run['controller_request'] == request['id'],
                    'managed_text_controller_run_missing', 409)
            through = self._ack_delivered(db, binding, run, attempt)
            unresolved = db.execute("SELECT * FROM managed_text_batches WHERE run_id=? "
                                    "AND state IN ('waiting_pages','needs_attention','retry_requested')",
                                    (run['id'],)).fetchall()
            require(len(unresolved) <= 1, 'managed_text_multiple_unresolved_batches', 409)
            prior = unresolved[0] if unresolved else None
            resolution = proposal.get('resolve_batch')
            if proposal['action'] == 'retry_batch':
                require(prior and prior['attempt_id'] == proposal['attempt_id'],
                        'managed_text_retry_batch_not_current', 409)
                require(run['state'] == 'running' and deadline_live(run,self.host.clock()),
                        'managed_text_run_not_accepting_work', 409)
                workers = json.loads(prior['workers'])
                require(sends_available(run,len(workers)+1),
                        'managed_text_batch_budget_insufficient', 409)
                status, issue = self._workers_ready(db, page['target_id'], workers)
                if status == 'ready':
                    self._assign_batch(db, binding, run, receipt['claim_id'], prior['attempt_id'], workers)
                    db.execute("UPDATE managed_text_batches SET state='assigned',issue=NULL WHERE attempt_id=?",
                               (prior['attempt_id'],))
                else:
                    db.execute("UPDATE managed_text_batches SET state='retry_requested',issue=? WHERE attempt_id=?",
                               (issue, prior['attempt_id']))
                wait = self.host.team.wait(db, binding,
                    {'run_id': run['id'], 'claim_id': receipt['claim_id'],
                     'after_seq': through, 'mode': 'all'}, browser_turn_ended=True)
                require(wait['state'] == 'waiting_events', 'managed_text_wait_needs_reconciliation', 409)
                result = self.host.browser_reply(db, binding,
                    {**dict(request), 'phase': 'suspended'}, receipt['claim_id'], attempt['id'],
                    self._body(raw, artifact), data['assistant_turn_hash'])
                db.execute('RELEASE managed_text_apply')
                return result
            if resolution:
                require(prior and prior['attempt_id'] == resolution['attempt_id'],
                        'managed_text_batch_resolution_not_current', 409)
                db.execute("UPDATE managed_text_batches SET state='abandoned',issue=NULL WHERE attempt_id=?",
                           (prior['attempt_id'],))
            else:
                require(not prior, 'managed_text_previous_batch_unresolved', 409)
            if proposal['action'] == 'completed':
                self.host.team.lifecycle(db, binding, 'close',
                    {'run_id': run['id'], 'claim_id': receipt['claim_id'],
                     'summary': proposal['summary'], 'references': proposal.get('references', [])})
                result = self.host.browser_reply(db, binding, request, receipt['claim_id'],
                    attempt['id'], self._body(raw, artifact), data['assistant_turn_hash'])
            else:
                require(run['state'] == 'running' and deadline_live(run,self.host.clock()),
                        'managed_text_run_not_accepting_work', 409)
                needed = len(proposal['workers']) + 1
                require(sends_available(run,needed),
                        'managed_text_batch_budget_insufficient', 409)
                workers = []
                for worker in proposal['workers']:
                    workers.append(self._resolve_worker(db, binding, page, attempt, worker))
                status, issue = self._workers_ready(db, page['target_id'], workers)
                require(status != 'needs_attention', issue or 'managed_text_worker_issue', 409)
                resolved = {**proposal, 'workers': workers}
                db.execute('INSERT INTO managed_text_plans VALUES(?,?,?,?,?)',
                           (attempt['id'], run['id'], request['id'], canonical(resolved), self.host.clock()))
                db.execute('INSERT INTO managed_text_batches VALUES(?,?,?,?,?,?,?,?)',
                           (attempt['id'], run['id'], request['id'], receipt['claim_id'],
                            canonical(workers), 'assigned' if status == 'ready' else 'waiting_pages',
                            None, self.host.clock()))
                if status == 'ready':
                    self._assign_batch(db, binding, run, receipt['claim_id'], attempt['id'], workers)
                wait = self.host.team.wait(db, binding,
                    {'run_id': run['id'], 'claim_id': receipt['claim_id'],
                     'after_seq': through, 'mode': 'all'}, browser_turn_ended=True)
                require(wait['state'] == 'waiting_events',
                        'managed_text_wait_needs_reconciliation', 409)
                result = self.host.browser_reply(db, binding,
                    {**dict(request), 'phase': 'suspended'}, receipt['claim_id'],
                    attempt['id'], self._body(raw, artifact), data['assistant_turn_hash'])
            db.execute('RELEASE managed_text_apply')
            return result
        except (HarnessError, ValueError, TypeError) as exc:
            db.execute('ROLLBACK TO managed_text_apply')
            db.execute('RELEASE managed_text_apply')
            return self.managed.control.attention_reply(db, binding, request, receipt, attempt,
                {**data, 'text': '协作控制未执行：' + getattr(exc, 'code', 'managed_text_invalid_plan')
                 + '\n原文：' + artifact['path']})
