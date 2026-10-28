"""Pure task contracts and transitions. No shell, filesystem inspection or model calls."""
from __future__ import annotations
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import ntpath
import re

MAX_JSON = 2 * 1024 * 1024
ACTIVE = {'running', 'blocked'}
# wc_agent_run_* are public opaque Run handles, not wc_agent_* transport tokens.
SECRET = re.compile(r'(?:wc_pat_|wc_oat_|wc_agent_(?!run_)|wck_|sk-)[A-Za-z0-9_-]{16,}')
ID = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,47}\Z')

class TaskError(ValueError):
    def __init__(self, code, message, status=400):
        self.code, self.status = code, status
        super().__init__(message)

def fail(code, message, status=400):
    raise TaskError(code, message, status)

def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def fingerprint(value):
    return hashlib.sha256(encoded(value).encode('utf-8')).hexdigest()

def bounded(value):
    try:
        if len(encoded(value).encode('utf-8')) > MAX_JSON:
            fail('too_large', '任务请求超过2 MiB', 413)
    except (TypeError, RecursionError, ValueError) as exc:
        if isinstance(exc, TaskError): raise
        fail('invalid', '任务数据无法解析')
    def walk(v, depth=0):
        if depth > 20: fail('invalid', '数据嵌套过深')
        if isinstance(v, dict):
            for k, x in v.items():
                if k.lower() in {'__proto__', 'constructor', 'prototype', 'password', 'api_key', 'access_token', 'refresh_token', 'cookie', 'authorization'}:
                    fail('invalid', '任务包不接受凭据或危险字段')
                walk(x, depth+1)
        elif isinstance(v, list):
            for x in v: walk(x, depth+1)
        elif isinstance(v, str) and SECRET.search(v):
            fail('secret', '检测到疑似凭据，请移除后再保存')
    walk(value)
    return value

def obj(value, keys, required=()):
    if not isinstance(value, dict) or set(value)-set(keys) or set(required)-set(value):
        fail('invalid', '对象字段不符合任务合同')
    return value

def txt(value, label, maximum=8000, required=True):
    if not isinstance(value, str) or len(value)>maximum or any(ord(c)<32 and c not in '\n\t' for c in value):
        fail('invalid', label+'格式或长度无效')
    if required and not value.strip(): fail('invalid', label+'不能为空')
    return value.strip()

def ident(value, label='角色ID'):
    if not isinstance(value,str) or not ID.fullmatch(value): fail('invalid',label+'格式无效')
    return value

def seq(value, label, maximum=32):
    if not isinstance(value,list) or len(value)>maximum: fail('invalid',label+'数量或格式无效')
    return value

def absolute(value):
    value=txt(value,'工作目录',2048).replace('/', '\\')
    if value.startswith('\\\\?\\'): value=value[4:]
    if not re.match(r'^[A-Za-z]:\\',value) or re.search(r'[<>"|?*\x00]',value) or ':' in value[2:]:
        fail('invalid','工作目录需为明确的本地Windows绝对路径')
    parts=value[3:].split('\\')
    if any(p in ('.','..') or p.endswith((' ','.')) for p in parts if p): fail('invalid','路径不能包含上级跳转或歧义段')
    return ntpath.normcase(ntpath.normpath(value))

def within(child, parent):
    return child==parent or child.startswith(parent.rstrip('\\')+'\\')

def scope_path(value):
    value=txt(value,'写域',1000).replace('\\','/').rstrip('/')
    if value=='.': return '.'
    if value.startswith('/') or re.search(r'[:*?<>"|]',value) or any(p in ('','.', '..') or p.endswith((' ','.')) for p in value.split('/')):
        fail('invalid','写域需为相对路径前缀，不接受glob或上级路径')
    return value

def contract(raw):
    bounded(raw)
    obj(raw, {'title','goal','constraints','baseline','sources','acceptance','mode','coordinator','roles'}, {'title','goal','acceptance','roles'})
    result={k:txt(raw.get(k,''),label,limit,required) for k,label,limit,required in [
        ('title','标题',160,True),('goal','完整目标',24000,True),('constraints','不可变条件',16000,False),
        ('baseline','基线',2000,False),('sources','输入来源与版本',16000,False),('coordinator','协调者别名',100,False)]}
    mode=raw.get('mode','pure_web')
    if mode not in {'pure_web','hybrid','codex'}: fail('invalid','未知协作模式')
    result['mode']=mode
    result['acceptance']=[txt(x,'验收条件',2000) for x in seq(raw['acceptance'],'验收条件',24)]
    if not result['acceptance']: fail('invalid','至少一条验收条件')
    roles=[]
    for x in seq(raw['roles'],'角色',16):
        obj(x,{'id','name','objective','executor','project_id','project_root','worktree','access','scopes','depends_on'}, {'id','objective','project_id','project_root','worktree','scopes','depends_on'})
        rid=ident(x['id']);executor=x.get('executor','web');access=x.get('access','write')
        if executor not in {'web','codex','manual'} or access not in {'read','write'}: fail('invalid','执行者或读写类型无效')
        root=absolute(x['project_root']);work=absolute(x['worktree'])
        if not within(work,root): fail('scope','工作目录不在声明的Project根内')
        scopes=[scope_path(p) for p in seq(x['scopes'],'写域',32)]
        if access=='write' and not scopes: fail('scope','写入角色必须指定写域')
        deps=[ident(d,'依赖ID') for d in seq(x['depends_on'],'依赖',16)]
        if len(set(deps))!=len(deps) or rid in deps: fail('dependency','依赖重复或自引用')
        roles.append({'id':rid,'name':txt(x.get('name',rid),'角色名称',100),'objective':txt(x['objective'],'角色目标',8000),
            'executor':executor,'project_id':txt(x['project_id'],'Project ID',512),'project_root':root,'worktree':work,'access':access,'scopes':list(dict.fromkeys(scopes)),'depends_on':deps})
    if not roles or len({r['id'] for r in roles})!=len(roles): fail('invalid','至少一个角色且ID必须唯一')
    by={r['id']:r for r in roles}
    def visit(rid,stack,done):
        if rid in stack: fail('dependency','角色依赖构成环')
        if rid in done: return
        for dep in by[rid]['depends_on']:
            if dep not in by: fail('dependency','依赖角色不存在')
            visit(dep,stack|{rid},done)
        done.add(rid)
    done=set()
    for r in roles: visit(r['id'],set(),done)
    result['roles']=roles
    return result

def initial(c):
    return {r['id']:{'status':'pending','binding':None,'operator':'','external_ref':'','checkpoint':None,'handoff':None,'review':None,'attempt':0} for r in c['roles']}

def role_of(task, rid):
    for r in task['contract']['roles']:
        if r['id']==rid: return r, task['roles'][rid]
    fail('not_found','角色不存在',404)

def task_phase(task):
    if task['status']!='open': return task['status']
    states=[r['status'] for r in task['roles'].values()]
    if all(s=='accepted' for s in states): return 'awaiting_acceptance'
    if any(s=='submitted' for s in states): return 'review'
    if any(s in ACTIVE for s in states): return 'working'
    return 'ready'

def view(task):
    result=deepcopy(task);result['phase']=task_phase(task)
    result['progress']={'accepted':sum(r['status']=='accepted' for r in task['roles'].values()),'total':len(task['roles'])}
    if task.get('goal',{}).get('enabled'):
        from task_goals import current_review, limit_reason
        result['goal_state']={'cycle_review_current':current_review(task) is not None,'limit_reason':limit_reason(task),'model_dispatched':False}
    return result

def write_paths(role):
    if role['access']=='read': return []
    return [ntpath.normcase(ntpath.normpath(ntpath.join(role['worktree'],s.replace('/','\\')))) for s in role['scopes']]

def collision(role, tasks, task_id, rid, binding=None):
    paths=write_paths(role)
    for other in tasks:
        for other_role in other['contract']['roles']:
            if other['id']==task_id and other_role['id']==rid: continue
            state=other['roles'][other_role['id']]
            if state['status'] not in ACTIVE: continue
            other_binding=state.get('binding')
            if binding and other_binding and binding['connection_id']==other_binding['connection_id'] and binding['session_id']==other_binding['session_id']:
                fail('session_conflict',f"同一Session已在 {other['id']} / {other_role['id']} 中开工；并行角色需独立会话",409)
            for left in paths:
                for right in write_paths(other_role):
                    if within(left,right) or within(right,left):
                        fail('write_conflict',f"协调写域已由 {other['id']} / {other_role['id']} 占用",409)

def transition(task, action, data, actor, all_tasks, verified_binding=None):
    """Apply one operator action; claiming never launches a model or a process."""
    task=deepcopy(task)
    if task.get('collaboration',{}).get('enabled') is True:
        if action in {'submit','review'}:
            fail('structured_delivery_required','协作任务必须使用版本绑定的结构化交付/审阅，不能用旧入口绕过',409)
        if action in {'resume','claim','accept'} and task['collaboration'].get('shared_change_pending'):
            fail('shared_change_pending','共同变更尚未修订合同；先核对停写，不直接恢复或验收',409)
    if action=='revise':
        obj(data,{'contract','reason'},{'contract','reason'})
        if any(r['status'] in ACTIVE for r in task['roles'].values()): fail('active','仍有开工/阻塞角色，请先明确释放写入责任',409)
        txt(data['reason'],'修订原因',2000)
        task['contract']=contract(data['contract']);task['contract_version']+=1
        task['contract_hash']=fingerprint(task['contract']);task['status']='draft';task['roles']=initial(task['contract']);task['acceptance_review']=None
        if task.get('collaboration',{}).get('enabled') is True:
            task['collaboration']['shared_change_pending']=False
    elif action=='publish':
        obj(data,set())
        if task['status']!='draft': fail('state','仅草稿可发布',409)
        task['status']='open'
    elif action in {'pause','resume','cancel'}:
        obj(data,{'reason'},{'reason'});txt(data['reason'],'原因',2000)
        if action=='pause':
            if task['status']!='open': fail('state','仅进行中任务可暂停',409)
            task['status']='paused'
        elif action=='resume':
            if task['status']!='paused': fail('state','任务并未暂停',409)
            task['status']='open'
        else:
            if any(r['status'] in ACTIVE for r in task['roles'].values()): fail('active','先释放活动角色；取消不是停止模型或Job',409)
            if task['status'] in {'accepted','cancelled'}: fail('state','终态任务需修订而不是重复取消',409)
            task['status']='cancelled'
    elif action=='accept':
        obj(data,{'checks','note'},{'checks','note'})
        if task['status']!='open' or not all(r['status']=='accepted' for r in task['roles'].values()): fail('state','全部角色通过审阅后才能验收父任务',409)
        checks=seq(data['checks'],'逐条验收',24)
        if len(checks)!=len(task['contract']['acceptance']): fail('evidence','必须覆盖每一条验收条件')
        results=[]
        for index,c in enumerate(checks):
            obj(c,{'index','outcome','evidence'},{'index','outcome','evidence'})
            if type(c['index']) is not int or c['index']!=index or c['outcome']!='passed': fail('evidence','验收条件未逐条通过')
            results.append({'index':index,'outcome':'passed','evidence':txt(c['evidence'],'验收依据',4000)})
        task['status']='accepted';task['acceptance_review']={'actor':actor,'at':now(),'checks':results,'note':txt(data['note'],'验收说明',4000),'source':'operator_review_not_automatic_test'}
    else:
        rid=ident(data.get('role_id'));r,s=role_of(task,rid)
        delegation=s.get('delegation')
        if action in {'release','submit','claim'} and delegation and delegation.get('phase') not in {'completed','failed','cancelled','not_started','abandoned'}:
            fail('native_active','原专项未结束或结果未知；先核对原 Run，不能释放写域或提交交接',409)
        if task['status'] not in {'open','paused'}: fail('state','角色操作需要已发布任务',409)
        if action=='bind':
            obj(data,{'role_id','session_id','connection_id'},{'role_id','session_id','connection_id'})
            if s['status']!='pending': fail('state','仅未开工角色可改绑定',409)
            if verified_binding is None: fail('identity','没有正式会话观测',409)
            s['binding']=verified_binding
        elif action=='claim':
            obj(data,{'role_id','external_ref'},{'role_id'})
            if task['status']!='open' or s['status']!='pending': fail('state','当前角色不能登记开工',409)
            if any(task['roles'][d]['status']!='accepted' for d in r['depends_on']): fail('dependency','依赖角色尚未通过审阅',409)
            if r['executor']=='web' and not s['binding']: fail('identity','Web角色需要先核对并绑定实际Session',409)
            if r['executor']!='web': s['external_ref']=txt(data.get('external_ref',''),'操作者声明的外部工作引用',500)
            collision(r,all_tasks,task['id'],rid,s['binding'])
            s.update(status='running',operator=actor,attempt=s['attempt']+1,review=None,handoff=None)
            if task.get('collaboration',{}).get('enabled') is True:
                s.pop('delivery',None)  # Previous immutable delivery remains in the event journal.
        elif action=='checkpoint':
            obj(data,{'role_id','completed','remaining','next_step','original_jobs'},{'role_id','completed','remaining','next_step','original_jobs'})
            if s['status'] not in ACTIVE: fail('state','仅工作中角色可保存恢复点',409)
            s['checkpoint']={k:txt(data[k],k,6000,False) for k in ('completed','remaining','next_step','original_jobs')}
            s['checkpoint'].update(at=now(),actor=actor,contract_version=task['contract_version'])
        elif action in {'block','unblock','release'}:
            obj(data,{'role_id','reason'},{'role_id','reason'});txt(data['reason'],'原因',2000)
            if s['status'] not in ACTIVE: fail('state','角色不在工作中',409)
            if action=='unblock' and task['status']!='open': fail('state','先恢复父任务',409)
            s['status']={'block':'blocked','unblock':'running','release':'pending'}[action]
        elif action=='submit':
            obj(data,{'role_id','contract_version','summary','changes','tests','limitations','artifacts','stopped_writing'}, {'role_id','contract_version','summary','changes','tests','limitations','artifacts','stopped_writing'})
            if s['status'] not in ACTIVE: fail('state','角色尚未登记开工',409)
            if type(data['contract_version']) is not int or data['contract_version']!=task['contract_version']: fail('version','交接基于过时合同',409)
            if data['stopped_writing'] is not True: fail('evidence','交接前必须明确声明停止写入')
            handoff={k:txt(data[k],k,12000,k!='limitations') for k in ('summary','changes','tests','limitations','artifacts')}
            handoff.update(contract_version=task['contract_version'],stopped_writing=True,source='operator_declared_not_auto_verified',at=now(),actor=actor)
            s.update(status='submitted',handoff=handoff,review=None)
        elif action=='review':
            obj(data,{'role_id','outcome','note'},{'role_id','outcome','note'})
            if task['status']!='open' or s['status']!='submitted': fail('state','仅已交接角色可审阅',409)
            if data['outcome'] not in {'accepted','rework'}: fail('invalid','审阅结果无效')
            s['review']={'outcome':data['outcome'],'note':txt(data['note'],'审阅依据',6000),'actor':actor,'at':now(),'source':'operator_review'}
            s['status']='accepted' if data['outcome']=='accepted' else 'pending'
        else: fail('invalid','未知任务动作')
    task['updated_at']=now()
    return task

def export_packet(task, role_id=''):
    c=task['contract'];roles=c['roles'] if not role_id else [role_of(task,role_id)[0]]
    lines=['# '+c['title'],'',f"任务 {task['id']} · 合同 v{task['contract_version']} · SHA256 {task['contract_hash']}",'',
      '> 任务与路径为明确工作约定，不新增后端权限。导出不会派发、唤醒模型或执行命令。',
      '', '## 完整目标',c['goal'],'','## 不可变条件',c['constraints'] or '未另列；遵守项目规则','',
      '## 输入基线与来源',c['baseline'] or '开工时核对实际基线',c['sources'] or '读取实际项目入口','',
      '## 验收条件',*[f'{i+1}. {x}' for i,x in enumerate(c['acceptance'])], '',f"协调者：{c['coordinator'] or '未标注'}；模式：{c['mode']}"]
    if task.get('goal',{}).get('enabled'):
        g=task['goal'];lines+=['','## 持续原目标，不按时间拆轮',f"当前第 {g['cycle']} 轮；原目标 SHA256 {g['intent_hash']}；授权计划上限 {g['max_cycles']}，连续无进展上限 {g['failure_limit']}。",
          '先核对同一任务的当前合同、轮次、原Session/Job与实际文件。工作者交付后由主控独立审阅并以goal.review_cycle判断路线；goal.next_cycle只能引用当前审阅且不扩大原授权。轮次审阅不是最终验收，暂停不自动恢复。',
          '当前目标恢复点：'+encoded(g.get('checkpoint')),'上一轮决策：'+encoded(g.get('last_cycle'))]
    for r in roles:
        s=task['roles'][r['id']]
        lines+=['',f"## 角色 {r['id']} / {r['name']}",r['objective'],f"执行者：{r['executor']}（不会自动切换模型）",f"Project：{r['project_id']}",
          f"工作目录：{r['worktree']}",f"访问：{r['access']}；范围：{', '.join(r['scopes']) or '只读'}",f"依赖：{', '.join(r['depends_on']) or '无'}",
          f"登记状态：{s['status']}；此状态不是网页生成状态",f"已观测Session：{(s['binding'] or {}).get('session_id','未绑定')}"]
        if s['checkpoint']: lines+=['### 最近恢复点',encoded(s['checkpoint'])]
        if s['handoff']: lines+=['### 已提交交接（声明，仍需验证）',encoded(s['handoff'])]
        if s.get('feedback'): lines+=['### 当前角色的中途意见（必须处理）',encoded(s['feedback'])]
        if task.get('collaboration',{}).get('shared_change_pending'):
            lines+=['共同变更尚待修订合同；不能直接恢复协调或以旧要求验收。']
    lines+=['','## 开工 / 恢复规则','完整读取任务与必要原始资料，核对当前合同版本、实际root/HEAD/index及项目规则。使用独立工作会话；任务登记不替代项目guard。',
      '保存检查点后继续完整目标，不按时长截断。中断后核对原Session/Job与实际差异；已接受或结果未知的副作用不换ID重放。',
      '交接包括真实成果/提交、测试及未验证项、产物引用、原Job和停止写入声明。整合者审阅不等于父任务验收，父任务逐条核对原目标。','']
    return '\n'.join(lines)
