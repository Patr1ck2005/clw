"""Sustained work on the existing task journal, never a second Goal database.
A cycle is an explicit reviewed plan decision, not a timer, model invocation or
claim that a theorem/application goal has been achieved.
"""
from copy import deepcopy
from task_domain import (ACTIVE, obj, txt, seq, fail, now, fingerprint, contract,
                         initial, write_paths, within)
from task_collaboration import assert_native_settled

ACTIONS = {'goal.enable', 'goal.checkpoint', 'goal.review_cycle', 'goal.next_cycle', 'goal.extend_budget', 'goal.replan'}
INTENT_KEYS = ('title', 'goal', 'constraints', 'acceptance', 'sources', 'baseline', 'mode', 'coordinator')


def enabled(task):
    return isinstance(task.get('goal'), dict) and task['goal'].get('enabled') is True


def references(raw):
    values = [txt(x, '证据引用', 2000) for x in seq(raw, '证据引用', 12)]
    if not values or len(values) != len(set(values)):
        fail('goal_evidence', '提供至少一项不重复的实际证据引用；不以心跳代替成果')
    return values


def review_basis(task):
    return fingerprint({'contract_hash': task['contract_hash'], 'cycle': task['goal']['cycle'],
                        'roles': {rid: {key: state.get(key) for key in
                                  ('status', 'attempt', 'binding', 'feedback_revision', 'delivery', 'review', 'resource_request', 'delegation')}
                                  for rid, state in task['roles'].items()}})


def current_review(task):
    review = task['goal'].get('review')
    return review if review and review['basis'] == review_basis(task) else None


def limit_reason(task):
    if not enabled(task):
        return None
    goal = task['goal']; review = goal.get('review')
    if not review:
        return None
    if goal['cycle'] >= goal['max_cycles']:
        return 'cycle_limit'
    if review['consecutive_failures'] >= goal['failure_limit']:
        return 'failure_limit'
    return None


def preflight(task, action, data):
    if not enabled(task):
        return
    if fingerprint({key: task['contract'][key] for key in INTENT_KEYS}) != task['goal']['intent_hash']:
        fail('goal_intent_changed', '原目标与当前任务不一致，不猜测或自动修复', 409)
    if action == 'revise':
        fail('goal_revision_required', '持续目标通过版本绑定的下一轮计划更新职责；更换原目标需明确建立新任务', 409)
    if action in {'claim', 'resource.request', 'resource.begin', 'specialist.prepare', 'specialist.start'} and limit_reason(task):
        fail('goal_budget', '已达到明确的循环或连续失败上限；先核对证据并明确调整授权，不启动替代工作', 409)


def settled_reviews(task):
    from task_resources import SETTLED, group_current
    result = {}
    for rid, state in task['roles'].items():
        if state['status'] in ACTIVE:
            fail('goal_active', '仍有角色工作或阻塞；先核对原执行及停写交付', 409)
        assert_native_settled(state)
        group = state.get('resource_request')
        if group and (group['phase'] not in SETTLED or not group_current(task, rid, group)):
            fail('resource_unsettled', '资源或输入尚未核对，不进入下一轮', 409)
        delivery, review = state.get('delivery'), state.get('review')
        if (not delivery or not review or delivery.get('stopped_writing') is not True or
                review.get('delivery_id') != delivery['id'] or review.get('outcome') not in {'accepted', 'rework'} or
                delivery['feedback_revision'] != state.get('feedback_revision', 0) or
                state['status'] not in {'accepted', 'pending'}):
            fail('goal_review_required', '每个角色都需当前真实交付及独立审阅；失败路线也要交付报告，不能跳过未完成角色', 409)
        result[rid] = {'delivery_id': delivery['id'], 'attempt': state['attempt'], 'review': deepcopy(review)}
    return result


def bounded_roles(task, raw):
    candidate = contract({**task['contract'], 'roles': raw})
    allowed = {r['id']: r for r in task['goal']['authorized_roles']}
    for role in candidate['roles']:
        original = allowed.get(role['id'])
        if not original:
            fail('goal_scope', '下一轮不能增加原授权之外的角色身份', 409)
        for key in ('project_id', 'project_root', 'worktree', 'executor'):
            if role[key] != original[key]:
                fail('goal_scope', '下一轮不能换项目、目录或执行渠道扩大原授权', 409)
        if original['access'] == 'read' and role['access'] != 'read':
            fail('goal_scope', '不能把原只读职责变为写入', 409)
        permitted = write_paths(original)
        if any(not any(within(path, parent) for parent in permitted) for path in write_paths(role)):
            fail('goal_scope', '下一轮写域不能超过原授权范围', 409)
    return candidate


def install_plan(task, candidate, review):
    goal=task['goal'];previous_states=deepcopy(task['roles'])
    task['contract']=candidate;task['contract_version']+=1;task['contract_hash']=fingerprint(candidate)
    task['roles']=initial(candidate)
    for rid,state in task['roles'].items():
        previous=previous_states.get(rid,{});state['attempt']=previous.get('attempt',0)
        for key in ('feedback','feedback_revision'):
            if key in previous:state[key]=deepcopy(previous[key])
    goal['last_cycle']=deepcopy(review);goal['consecutive_failures']=review['consecutive_failures']
    goal['cycle']+=1;goal['review']=None;goal['checkpoint']=None
    task['collaboration']['shared_change_pending']=False;task['acceptance_review']=None
    # Original pause remains in force; this never binds or starts a worker.


def transition(task, action, data, actor):
    task = deepcopy(task)
    if not task.get('collaboration', {}).get('enabled'):
        fail('collaboration_disabled', '持续目标使用原结构化交付；先明确启用协作', 409)
    if task['status'] not in {'draft', 'open', 'paused'}:
        fail('state', '原目标已结束，不自动另开目标', 409)
    if action == 'goal.enable':
        obj(data, {'confirm_schema_upgrade', 'max_cycles', 'failure_limit'}, {'confirm_schema_upgrade', 'max_cycles', 'failure_limit'})
        if enabled(task) or any(s['status'] != 'pending' or s['attempt'] for s in task['roles'].values()):
            fail('goal_active', '仅在角色首次开工前明确启用，不接管在役职责', 409)
        if data['confirm_schema_upgrade'] is not True:
            fail('confirmation', '须明确确认持续目标规则及任务库能力升级')
        if type(data['max_cycles']) is not int or not 1 <= data['max_cycles'] <= 100 or type(data['failure_limit']) is not int or not 1 <= data['failure_limit'] <= 20:
            fail('goal_budget', '循环上限1–100；连续失败上限1–20，均需明确整数')
        intent = {key: deepcopy(task['contract'][key]) for key in INTENT_KEYS}
        task['goal'] = {'enabled': True, 'schema_version': 1, 'intent': intent, 'intent_hash': fingerprint(intent),
                        'authorized_roles': deepcopy(task['contract']['roles']), 'cycle': 1,
                        'max_cycles': data['max_cycles'], 'failure_limit': data['failure_limit'],
                        'consecutive_failures': 0, 'checkpoint': None, 'review': None, 'last_cycle': None,
                        'enabled_by': actor, 'enabled_at': now(), 'source': 'canonical_task_goal_not_native_goal_or_model_liveness'}
    else:
        if not enabled(task):
            fail('goal_disabled', '尚未明确启用持续目标', 409)
        goal = task['goal']
        if type(data.get('expected_cycle')) is not int or data['expected_cycle'] != goal['cycle']:
            fail('goal_cycle_changed', '不是当前计划轮次，保留旧请求并重读任务', 409)
        if action == 'goal.checkpoint':
            fields = {'expected_cycle', 'completed', 'remaining', 'next_step', 'evidence'}
            obj(data, fields, fields)
            goal['checkpoint'] = {key: txt(data[key], key, 6000, key != 'completed') for key in ('completed', 'remaining', 'next_step')}
            goal['checkpoint'].update(evidence=references(data['evidence']), cycle=goal['cycle'], actor=actor, at=now())
        elif action == 'goal.review_cycle':
            fields = {'expected_cycle', 'outcome', 'note', 'evidence'}; obj(data, fields, fields)
            if data['outcome'] not in {'progress', 'inconclusive', 'failed_route'}:
                fail('goal_outcome', '记录真实进展、尚无结论或失败路线，不把轮次审阅当最终验收')
            reviewed = settled_reviews(task)
            if current_review(task):
                fail('goal_cycle_reviewed', '当前交付已审阅为同一轮决策，先核对原回执而非重复累计', 409)
            basis = review_basis(task)
            decision = {'cycle': goal['cycle'], 'basis': basis, 'outcome': data['outcome'], 'note': txt(data['note'], '路线决策', 6000),
                        'evidence': references(data['evidence']), 'roles': reviewed, 'actor': actor, 'at': now(),
                        'consecutive_failures': 0 if data['outcome'] == 'progress' else goal['consecutive_failures'] + 1}
            decision['id'] = 'clw_cycle_review_' + fingerprint({'basis': basis, 'data': data})[:32]
            goal['review'] = decision
        elif action == 'goal.next_cycle':
            fields = {'expected_cycle', 'review_id', 'roles', 'resolve_shared_change'}; obj(data, fields, fields)
            if type(data['resolve_shared_change']) is not bool:
                fail('confirmation', '共同变更处理声明必须明确')
            review = current_review(task)
            if not review or data['review_id'] != review['id']:
                fail('goal_review_changed', '原轮次审阅或输入交付已变化，不能使用旧决策', 409)
            settled_reviews(task)
            if limit_reason(task):
                fail('goal_budget', '已达到明确上限，保留失败路线；需要显式增加授权才能继续', 409)
            if task['collaboration'].get('shared_change_pending') and data['resolve_shared_change'] is not True:
                fail('shared_change_pending', '先明确处理共同意见；不能自动覆盖用户的新要求', 409)
            candidate = bounded_roles(task, data['roles'])
            install_plan(task,candidate,review)
        elif action == 'goal.replan':
            fields={'expected_cycle','roles','confirm','reason','evidence'};obj(data,fields,fields)
            if data['confirm'] is not True or task['status']!='paused' or not task['collaboration'].get('shared_change_pending'):
                fail('shared_change_pending','仅对明确暂停的共同变更处理旧轮，不代替普通交付审阅',409)
            if goal['cycle']>=goal['max_cycles'] or limit_reason(task):fail('goal_budget','先明确调整原授权上限，不把共同变更当预算重置',409)
            from task_resources import SETTLED
            old={}
            for rid,state in task['roles'].items():
                assert_native_settled(state)
                if state['status'] in ACTIVE or (state.get('resource_request') and state['resource_request']['phase'] not in SETTLED):
                    fail('goal_active','先核对所有原执行结束及停写责任，不能通过改计划释放未知占用',409)
                old[rid]={k:deepcopy(state.get(k)) for k in ('status','attempt','delivery','review','resource_request','checkpoint')}
            review={'cycle':goal['cycle'],'outcome':'interrupted_by_shared_change_not_completed',
                    'note':txt(data['reason'],'共同变更处理依据',6000),'evidence':references(data['evidence']),
                    'roles':old,'actor':actor,'at':now(),'consecutive_failures':goal['consecutive_failures']}
            install_plan(task,bounded_roles(task,data['roles']),review)
        elif action == 'goal.extend_budget':
            fields = {'expected_cycle', 'max_cycles', 'failure_limit', 'confirm', 'reason'}; obj(data, fields, fields)
            if data['confirm'] is not True or type(data['max_cycles']) is not int or type(data['failure_limit']) is not int:
                fail('confirmation', '明确确认新的整数授权上限')
            if not goal['max_cycles'] <= data['max_cycles'] <= 100 or not goal['failure_limit'] <= data['failure_limit'] <= 20:
                fail('goal_budget', '此入口只能显式提高已声明上限，不重置失败计数')
            if (goal['max_cycles'], goal['failure_limit']) == (data['max_cycles'], data['failure_limit']):
                fail('goal_budget', '上限未变化，核对原授权即可')
            goal['budget_revision'] = {'actor': actor, 'at': now(), 'reason': txt(data['reason'], '授权调整依据', 4000),
                                       'previous': {'max_cycles': goal['max_cycles'], 'failure_limit': goal['failure_limit']}}
            goal['max_cycles'] = data['max_cycles']; goal['failure_limit'] = data['failure_limit']
        else:
            fail('invalid', '未知持续目标动作')
    task['updated_at'] = now()
    return task
