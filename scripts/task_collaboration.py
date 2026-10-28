"""Fenced role deliveries on the existing task journal. No I/O or model dispatch."""
from copy import deepcopy
import re
from task_domain import ACTIVE, obj, txt, seq, ident, fail, now, fingerprint, role_of

ACTIONS = {'collaborate', 'feedback', 'deliver', 'review_delivery'}
SHA = re.compile(r'[0-9a-f]{64}\Z')
COMMIT = re.compile(r'[0-9a-f]{40}\Z')
MAX_ARTIFACT = 16 * 1024 * 1024
MAX_ARTIFACT_TOTAL = 64 * 1024 * 1024


def enabled(task):
    return task.get('collaboration', {}).get('enabled') is True


def artifact_path(value):
    value = txt(value, '产物路径', 512)
    if '\\' in value or ':' in value or value.startswith('/'):
        fail('artifact_path', '产物必须为规范的相对路径')
    parts = value.split('/')
    for part in parts:
        if (part in ('', '.', '..') or part.endswith((' ', '.')) or
                re.search(r'[<>"|?*\x00-\x1f]', part) or
                re.fullmatch(r'(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?', part)):
            fail('artifact_path', '产物路径含穿越、设备名或歧义段')
        low = part.casefold()
        if low in {'.git', '.local', '.ssh', '.aws', '.azure', '.gnupg', 'node_modules', '__pycache__'} or low.startswith('.env') or re.search(r'(?i)(?:credential|password|private[-_]?key|access[-_]?token|refresh[-_]?token)', part):
            fail('artifact_path', '不接受敏感或内部目录的产物引用')
    return value


def artifacts(raw):
    rows = seq(raw, '产物', 32)
    if not rows: fail('evidence', '至少引用一个真实产物')
    result = []; seen = set(); total = 0
    for row in rows:
        obj(row, {'path', 'sha256', 'bytes'}, {'path', 'sha256', 'bytes'})
        path = artifact_path(row['path'])
        if path.casefold() in seen: fail('artifact_path', '产物路径重复')
        seen.add(path.casefold())
        if not isinstance(row['sha256'], str) or not SHA.fullmatch(row['sha256']): fail('evidence', '产物SHA256无效')
        if type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_ARTIFACT: fail('evidence', '产物字节数超限')
        total += row['bytes']
        if total > MAX_ARTIFACT_TOTAL: fail('evidence', '产物总大小超过64 MiB')
        result.append({'path': path, 'sha256': row['sha256'], 'bytes': row['bytes']})
    return result


def assignment(task, rid, store_id):
    if not enabled(task): fail('collaboration_disabled', '任务尚未明确启用结构化交付', 409)
    role, state = role_of(task, ident(rid))
    if state['status'] not in ACTIVE: fail('state', '角色尚未开工或已经交接', 409)
    basis = {'task_id': task['id'], 'contract_version': task['contract_version'], 'contract_hash': task['contract_hash'],
             'role': role, 'attempt': state['attempt'], 'binding': state['binding'], 'external_ref': state['external_ref'],
             'feedback_revision': state.get('feedback_revision', 0), 'store_id': store_id}
    resource=state.get('resource_request')
    if resource:
        basis['resource_request']={k:resource[k] for k in ('id','fence','input_snapshot_hash')}
    return {'format': 'clw.assignment.v1', 'store_id': store_id, 'task_id': task['id'], 'task_version': task['version'],
            'contract': deepcopy(task['contract']), 'contract_version': task['contract_version'], 'contract_hash': task['contract_hash'],
            'role': deepcopy(role), 'attempt': state['attempt'], 'binding': deepcopy(state['binding']),
            'feedback_revision': state.get('feedback_revision', 0), 'feedback': deepcopy(state.get('feedback', [])),
            'assignment_fence': fingerprint(basis), 'parent_status': task['status'],
            'shared_change_pending': task['collaboration'].get('shared_change_pending', False),
            'resource_request': deepcopy(resource),
            'goal': deepcopy(task.get('goal')),
            'identity_source': 'observed_binding_and_operator_labels_not_account_authentication',
            'dispatch_performed': False}


def assert_native_settled(state):
    d = state.get('delegation')
    if d and d.get('phase') not in {'completed', 'failed', 'cancelled', 'not_started', 'abandoned'}:
        fail('native_active', '原Run未结束或结果未知，不能交付并释放责任', 409)


def transition(task, action, data, actor, store_id):
    task = deepcopy(task)
    if action == 'collaborate':
        obj(data, {'confirm_schema_upgrade'}, {'confirm_schema_upgrade'})
        if data['confirm_schema_upgrade'] is not True: fail('confirmation', '须明确确认任务库能力升级')
        if enabled(task): fail('state', '已启用，请核对原请求', 409)
        if task['status'] not in {'draft', 'open'} or any(s['status'] != 'pending' for s in task['roles'].values()):
            fail('state', '在角色开工前启用协作；不接管在役责任', 409)
        task['collaboration'] = {'enabled': True, 'schema_version': 1, 'enabled_by': actor, 'enabled_at': now(), 'shared_change_pending': False}
    else:
        if not enabled(task): fail('collaboration_disabled', '任务尚未启用结构化交付', 409)
        if task['status'] not in {'open', 'paused'}: fail('state', '需要已发布且未终结的任务', 409)
        rid = ident(data.get('role_id')); role, state = role_of(task, rid)
        if action == 'feedback':
            obj(data, {'role_id', 'scope', 'note'}, {'role_id', 'scope', 'note'})
            note = txt(data['note'], '中途意见', 4000)
            if data['scope'] not in {'local', 'shared'}: fail('invalid', '反馈范围无效')
            history = state.setdefault('feedback', [])
            if len(history) >= 32: fail('capacity', '反馈已达上限，请核对停写后修订合同', 409)
            if data['scope'] == 'local':
                downstream = {rid}
                changed = True
                while changed:
                    old = set(downstream)
                    downstream.update(r['id'] for r in task['contract']['roles'] if any(d in downstream for d in r['depends_on']))
                    changed = old != downstream
                if any(task['roles'][d]['status'] != 'pending' for d in downstream - {rid}):
                    fail('shared_change_required', '下游已有工作或验收；请登记共同变更，不按局部意见放行', 409)
                if state['status'] in {'submitted', 'accepted'}:
                    state['status'] = 'pending'; state['review'] = None
                state['feedback_revision'] = state.get('feedback_revision', 0) + 1
            else:
                task['status'] = 'paused'; task['collaboration']['shared_change_pending'] = True
            history.append({'id': 'feedback_' + fingerprint({'task': task['id'], 'role': rid, 'version': task['version'], 'note': note})[:24],
                            'scope': data['scope'], 'note': note, 'actor': actor, 'at': now(),
                            'revision': state.get('feedback_revision', 0), 'contract_version': task['contract_version']})
        elif action == 'deliver':
            keys = {'role_id', 'assignment_fence', 'session_id', 'project_id', 'account_label', 'summary', 'changes', 'tests', 'limitations', 'artifacts', 'original_jobs', 'stopped_writing', 'input_baseline', 'head_commit'}
            obj(data, keys, keys)
            assert_native_settled(state)
            packet = assignment(task, rid, store_id)
            if data['assignment_fence'] != packet['assignment_fence']: fail('assignment_changed', '职责、尝试或意见已更新，旧交付不能提交；保留原封包并重新核对', 409)
            sid = (state['binding'] or {}).get('session_id')
            if data['session_id'] != sid or data['project_id'] != role['project_id']: fail('identity', '交付Session/Project与当前角色不符', 409)
            if data['stopped_writing'] is not True: fail('evidence', '必须明确停止写入后交付')
            commit = data['head_commit']
            if commit is not None and (not isinstance(commit, str) or not COMMIT.fullmatch(commit)): fail('evidence', '提交需完整SHA；非Git成果使用null')
            jobs = seq(data['original_jobs'], '原Job', 32); ids = set()
            for job in jobs:
                obj(job, {'id', 'status'}, {'id', 'status'}); jid = txt(job['id'], '原Job ID', 160)
                if jid in ids: fail('evidence', '原Job重复')
                ids.add(jid)
                if job['status'] not in {'completed', 'failed', 'cancelled', 'not_started'}: fail('native_active', '未核对终态的Job不能作为停写交付', 409)
            delivery = {k: txt(data[k], k, 12000, k != 'limitations') for k in ('summary', 'changes', 'tests', 'limitations')}
            delivery.update(artifacts=artifacts(data['artifacts']), original_jobs=deepcopy(jobs), head_commit=commit,
                            input_baseline=txt(data['input_baseline'], '实际输入基线', 2000),
                            account_label=txt(data['account_label'], '声明账号', 100), session_id=sid, project_id=role['project_id'],
                            contract_version=task['contract_version'], contract_hash=task['contract_hash'], attempt=state['attempt'],
                            assignment_fence=packet['assignment_fence'], feedback_revision=packet['feedback_revision'],
                            stopped_writing=True, at=now(), actor=actor, source='worker_declared_client_hashes_not_independent_verification')
            if state.get('resource_request'):
                delivery['resource_evidence']=deepcopy(state['resource_request'])
            delivery['id'] = 'clw_delivery_' + fingerprint({'task': task['id'], 'role': rid, 'data': data})[:32]
            state.update(status='submitted', delivery=delivery, review=None,
                         handoff={**{k: delivery[k] for k in ('summary', 'changes', 'tests', 'limitations', 'contract_version', 'stopped_writing', 'at', 'actor', 'source')},
                                  'artifacts': '\n'.join(f"{a['path']} sha256={a['sha256']} bytes={a['bytes']}" for a in delivery['artifacts']), 'delivery_id': delivery['id']})
        elif action == 'review_delivery':
            obj(data, {'role_id', 'delivery_id', 'outcome', 'note', 'evidence'}, {'role_id', 'delivery_id', 'outcome', 'note', 'evidence'})
            delivery = state.get('delivery')
            if task['status'] != 'open' or state['status'] != 'submitted' or not delivery: fail('state', '仅当前已提交成果可以审阅', 409)
            if data['delivery_id'] != delivery['id'] or delivery['feedback_revision'] != state.get('feedback_revision', 0): fail('assignment_changed', '不是当前交付或意见已变更', 409)
            if data['outcome'] not in {'accepted', 'rework'}: fail('invalid', '审阅结论无效')
            state['review'] = {'outcome': data['outcome'], 'delivery_id': delivery['id'], 'note': txt(data['note'], '审阅意见', 6000),
                               'evidence': txt(data['evidence'], '独立核验依据', 6000), 'actor': actor, 'at': now(), 'source': 'coordinator_declared_independent_review'}
            state['status'] = 'accepted' if data['outcome'] == 'accepted' else 'pending'
        else: fail('invalid', '未知协作动作')
    task['updated_at'] = now()
    return task
