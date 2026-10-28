"""Transactional, domain-neutral resource coordination on the canonical task DB.
This module never reads an artifact, starts a process/model, or verifies a third
party's identity. Original guard/job observations remain explicitly attributed.
"""
from __future__ import annotations
from copy import deepcopy
import json
import math
from pathlib import PureWindowsPath
import re
import time
from task_domain import ACTIVE, bounded, obj, txt, seq, ident, fail, now, encoded, fingerprint, absolute, within, role_of
from task_collaboration import assignment, artifact_path, artifacts

CATALOG_KEY='resource_catalog_v1'
ACTIONS={'resource.define','resource.observe','resource.request','resource.begin','resource.attach',
         'resource.unknown','resource.finish','resource.cancel','resource.reconcile_not_started'}
HELD={'reserved','starting','running','unknown'}
SETTLED={'released','cancelled'}
MAX_RESOURCES=64
MAX_GRANTS=16


def time_now():return time.time()


def catalog(db):
    row=db.execute('SELECT value FROM metadata WHERE key=?',(CATALOG_KEY,)).fetchone()
    if row is None:return {'schema_version':1,'resources':{}}
    try:result=json.loads(row[0])
    except ValueError:fail('resource_catalog','资源目录损坏，未尝试恢复或释放占用',409)
    if not isinstance(result,dict) or type(result.get('schema_version')) is not int or result['schema_version']!=1 or not isinstance(result.get('resources'),dict) or len(result['resources'])>MAX_RESOURCES:
        fail('resource_catalog','资源目录版本未知，不自动重建',409)
    return result


def _store_catalog(db,value):
    bounded(value)
    db.execute('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(CATALOG_KEY,encoded(value)))


def tasks(db):
    for row in db.execute('SELECT data FROM tasks ORDER BY sequence'):
        yield json.loads(row[0])


def groups(db,phases=None):
    for task in tasks(db):
        for rid,state in task['roles'].items():
            group=state.get('resource_request')
            if group and (phases is None or group['phase'] in phases):yield task,rid,group


def _definition(book,rid):
    if not isinstance(rid,str) or not re.fullmatch(r'clw_resource_[0-9a-f]{32}',rid) or rid not in book['resources']:
        fail('resource_missing','资源尚未明确登记',409)
    return book['resources'][rid]


def available_capacity(resource,at=None):
    at=time_now() if at is None else at
    observation=resource.get('observation')
    if not observation or observation.get('availability')!='available' or at>observation['valid_until']:
        return 0
    return observation['available_capacity']


def _file(worktree,path):return absolute(str(PureWindowsPath(worktree)/artifact_path(path)))


def frozen_files(group):
    return [_file(source['worktree'],item['path']) for source in group['inputs'] for item in source['artifacts']]


def owner_stamp(task,rid):
    _,state=role_of(task,rid)
    return fingerprint({'contract_hash':task['contract_hash'],'attempt':state['attempt'],
                        'feedback_revision':state.get('feedback_revision',0),'binding':state['binding'],'external_ref':state['external_ref']})


def inputs_current(task,group,seen=None):
    if task['contract_hash']!=group['contract_hash']:return False
    for source in group['inputs']:
        state=task['roles'].get(source['role_id'])
        if not state or state['attempt']!=source['attempt'] or state.get('feedback_revision',0)!=source['feedback_revision'] or fingerprint(state['binding'])!=source['binding_hash']:
            return False
        if source['delivery_id'] is not None:
            delivery=state.get('delivery')
            if not delivery or delivery['id']!=source['delivery_id'] or state['status'] not in {'submitted','accepted'}:return False
            upstream=state.get('resource_request')
            if upstream and not group_current(task,source['role_id'],upstream,seen):return False
    return True


def group_current(task,rid,group,seen=None):
    seen=set() if seen is None else set(seen)
    if rid in seen:return False
    seen.add(rid)
    return owner_stamp(task,rid)==group['owner_stamp'] and inputs_current(task,group,seen)


def _capture_inputs(task,rid,raw,confirmed):
    rows=seq(raw,'冻结输入',8);result=[];seen=set();total=0
    for item in rows:
        source_id=ident(item.get('role_id')) if isinstance(item,dict) else None
        source_role,state=role_of(task,source_id)
        if source_id==rid:
            obj(item,{'role_id','artifacts'},{'role_id','artifacts'})
            selected=artifacts(item['artifacts']);delivery_id=None
        else:
            obj(item,{'role_id','delivery_id','paths'},{'role_id','delivery_id','paths'})
            delivery=state.get('delivery')
            if state['status'] not in {'submitted','accepted'} or not delivery or delivery.get('stopped_writing') is not True or delivery['id']!=item['delivery_id']:
                fail('inputs_still_writing','输入角色未停写交付或交付已经变化',409)
            upstream=state.get('resource_request')
            if upstream and not group_current(task,source_id,upstream):
                fail('resource_inputs_changed','上游成果已引用过期输入，不能作为新窗口的冻结来源',409)
            choices=seq(item['paths'],'输入文件子集',32)
            if not choices:fail('input_snapshot','输入文件子集不能为空')
            by_path={a['path']:a for a in delivery['artifacts']};selected=[]
            for path in choices:
                path=artifact_path(path)
                if path not in by_path:fail('input_snapshot','只能冻结确切交付内的实际文件',409)
                selected.append(deepcopy(by_path[path]))
            delivery_id=delivery['id']
        for entry in selected:
            key=_file(source_role['worktree'],entry['path'])
            if key in seen:fail('input_snapshot','冻结输入存在重复或别名路径')
            seen.add(key);total+=entry['bytes']
            if total>64*1024*1024:fail('input_snapshot','冻结输入总量超过64 MiB')
        result.append({'role_id':source_id,'project_id':source_role['project_id'],'worktree':source_role['worktree'],
                       'attempt':state['attempt'],'feedback_revision':state.get('feedback_revision',0),'binding_hash':fingerprint(state['binding']),
                       'delivery_id':delivery_id,'artifacts':selected})
    if result and confirmed is not True:fail('confirmation','必须确认相关输入已经停写，并保留原guard核对依据')
    return result


def _writer_conflict(db,files,except_task=None,except_role=None):
    for task in tasks(db):
        if task['status'] not in {'open','paused'}:continue
        for role in task['contract']['roles']:
            if task['id']==except_task and role['id']==except_role:continue
            if role['access']!='write' or task['roles'][role['id']]['status'] not in ACTIVE:continue
            for scope in role['scopes']:
                prefix=absolute(str(PureWindowsPath(role['worktree'])/scope))
                if any(within(f,prefix) or within(prefix,f) for f in files):return True
    return False


def preflight(db,task,action,data):
    """Extra fences do not replace existing task/role/native-run authorization."""
    if action=='claim':
        role,_=role_of(task,ident(data.get('role_id')))
        if role['access']=='write':
            scopes=[absolute(str(PureWindowsPath(role['worktree'])/s)) for s in role['scopes']]
            for _,_,group in groups(db,HELD):
                if any(within(f,s) or within(s,f) for f in frozen_files(group) for s in scopes):
                    fail('input_frozen','此写域包含仍在资源窗口内的冻结输入；先核对原执行结束',409)
    rid=data.get('role_id')
    if rid in task['roles']:
        if action in {'resource.request','resource.begin'}:
            from task_collaboration import assert_native_settled
            assert_native_settled(task['roles'][rid])
        group=task['roles'][rid].get('resource_request')
        if group:
            if action in {'specialist.prepare','specialist.start','specialist.retry_start'}:
                fail('resource_external_executor_required','资源角色须先核对begin回执，再从原获准执行入口启动；本页不旁路资源协议',409)
            if action in {'release','submit','deliver'} and group['phase'] not in SETTLED:
                fail('resource_unsettled','资源申请或原执行尚未核对结束，不能释放写入责任或交付',409)
            if action=='deliver' and not group_current(task,rid,group):
                fail('resource_inputs_changed','当前成果引用的执行输入或意见已变化；先完成新的核对/执行',409)
            if action in {'review','review_delivery'} and data.get('outcome')=='accepted' and not group_current(task,rid,group):
                fail('resource_inputs_changed','旧输入结果不能作为当前成果通过审阅',409)
    if action in {'revise','cancel','accept'}:
        for role_id,state in task['roles'].items():
            group=state.get('resource_request')
            if group and group['phase'] not in SETTLED:fail('resource_unsettled','仍有资源或原执行未核对，不改变共同合同或终结父任务',409)
            if action=='accept' and group and not group_current(task,role_id,group):fail('resource_inputs_changed','父验收包含旧输入结果，须先重做相关角色',409)


def transition(db,task,action,data,actor,store_id):
    task=deepcopy(task)
    if not task.get('collaboration',{}).get('enabled'):fail('collaboration_disabled','先明确启用通用任务协作',409)
    if task['status'] not in {'draft','open','paused'}:fail('state','任务已终结',409)
    book=catalog(db)
    if action=='resource.define':
        fields={'namespace','name','label','capacity','requires_frozen_inputs','authority_ref','confirm_schema_upgrade','expected_resource_version'}
        obj(data,fields,fields)
        if data['confirm_schema_upgrade'] is not True:fail('confirmation','须明确确认资源能力及任务库升级到3')
        namespace=txt(data['namespace'],'资源作用域',300).casefold();name=txt(data['name'],'资源名称',80).casefold()
        if not re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,79}',name):fail('invalid','资源名称需为稳定的逻辑ID')
        if type(data['capacity']) is not int or not 1<=data['capacity']<=1024 or type(data['requires_frozen_inputs']) is not bool:fail('invalid','资源容量或冻结要求无效')
        resource_id='clw_resource_'+fingerprint({'namespace':namespace,'name':name})[:32];old=book['resources'].get(resource_id)
        expected=data['expected_resource_version']
        if (old and (type(expected) is not int or expected!=old['version'])) or (not old and expected is not None):fail('resource_version','资源定义已变化，先重新核对',409)
        if old and any(any(r['resource_id']==resource_id for r in g['requirements']) for _,_,g in groups(db) if g['phase'] not in SETTLED):fail('resource_in_use','资源仍有申请或占用，不能重定义容量/身份',409)
        if not old and len(book['resources'])>=MAX_RESOURCES:fail('capacity','资源目录已达64项上限',409)
        book['resources'][resource_id]={'id':resource_id,'namespace':namespace,'name':name,'label':txt(data['label'],'资源显示名称',160),
             'capacity':data['capacity'],'requires_frozen_inputs':data['requires_frozen_inputs'],'authority_ref':txt(data['authority_ref'],'原权威来源',2000),
             'version':old['version']+1 if old else 1,'definition_version':old['definition_version']+1 if old else 1,'observation':None,'defined_by':actor,'defined_at':now()}
        _store_catalog(db,book);task.setdefault('resource_definitions',[])
        if resource_id not in task['resource_definitions']:task['resource_definitions'].append(resource_id)
        db.execute("UPDATE metadata SET value='3' WHERE key='schema_version' AND value IN ('1','2')")
    elif action=='resource.observe':
        fields={'resource_id','expected_resource_version','availability','available_capacity','source_observed_at','valid_for_seconds','evidence'};obj(data,fields,fields)
        resource=_definition(book,data['resource_id'])
        if type(data['expected_resource_version']) is not int or data['expected_resource_version']!=resource['version']:fail('resource_version','资源观测已被更新',409)
        if data['availability'] not in {'available','blocked','unknown'} or type(data['available_capacity']) is not int or not 0<=data['available_capacity']<=resource['capacity']:fail('invalid','可用容量无效')
        if data['availability']!='available' and data['available_capacity']!=0:fail('invalid','阻塞或未知资源不能声明可用容量')
        observed=data['source_observed_at'];ttl=data['valid_for_seconds']
        if type(observed) not in (int,float) or not math.isfinite(observed) or observed<0 or observed>time_now()+5 or type(ttl) is not int or not 1<=ttl<=600:fail('invalid','观测时间/有效期无效')
        if resource.get('observation') and observed<resource['observation']['source_observed_at']:
            fail('resource_observation_stale','迟到的旧观测不能覆盖新的资源状态',409)
        resource['observation']={'availability':data['availability'],'available_capacity':data['available_capacity'],'source_observed_at':observed,'valid_until':observed+ttl,
             'evidence':txt(data['evidence'],'实际核对依据',4000),'actor':actor,'recorded_at':now(),'source':'operator_recorded_external_observation_not_os_authentication'}
        resource['version']+=1;_store_catalog(db,book)
    else:
        if task['status'] not in {'open','paused'}:fail('state','资源执行需要已发布任务',409)
        rid=ident(data.get('role_id'));role,state=role_of(task,rid)
        if state['status'] not in ACTIVE:fail('state','资源执行只能由当前活动角色登记',409)
        if action=='resource.request':
            fields={'role_id','assignment_fence','requirements','inputs','freeze_confirmed','guard_evidence'};obj(data,fields,fields)
            if task['status']!='open' or task['collaboration'].get('shared_change_pending'):fail('paused','暂停/共同变更期间不申请新资源',409)
            previous=state.get('resource_request')
            if previous and previous['phase'] not in SETTLED:fail('resource_unsettled','保留当前整组申请，不能再申请第二组',409)
            if data['assignment_fence']!=assignment(task,rid,store_id)['assignment_fence']:fail('assignment_changed','角色职责已更新',409)
            requirements=seq(data['requirements'],'整组资源',8)
            if not requirements:fail('invalid','至少申请一种资源')
            normalized=[];seen=set();needs_freeze=False
            for req in requirements:
                obj(req,{'resource_id','units'},{'resource_id','units'});resource=_definition(book,req['resource_id'])
                if resource['id'] in seen or type(req['units']) is not int or not 1<=req['units']<=resource['capacity']:fail('invalid','资源重复或申请数量无效')
                seen.add(resource['id']);needs_freeze|=resource['requires_frozen_inputs'];normalized.append({'resource_id':resource['id'],'units':req['units'],'definition_version':resource['definition_version']})
            inputs=_capture_inputs(task,rid,data['inputs'],data['freeze_confirmed'])
            if needs_freeze and not inputs:fail('input_snapshot','本组资源必须冻结明确的实际输入',409)
            state['resource_generation']=state.get('resource_generation',0)+1
            group={'id':'clw_resource_request_'+fingerprint({'task':task['id'],'role':rid,'generation':state['resource_generation']})[:32],
                   'generation':state['resource_generation'],'phase':'queued','owner_stamp':owner_stamp(task,rid),'contract_hash':task['contract_hash'],
                   'requirements':normalized,'inputs':inputs,'input_snapshot_hash':fingerprint(inputs),'guard_evidence':txt(data['guard_evidence'],'原guard核对依据',4000),
                   'requested_at':now(),'queue_sequence':db.execute('SELECT COALESCE(MAX(sequence),0)+1 FROM events').fetchone()[0],
                   'start_intent':None,'execution':None,'terminal':None,'source':'product_coordination_not_executor_authority'}
            group['fence']=fingerprint({'id':group['id'],'owner_stamp':group['owner_stamp'],'requirements':normalized,'input_snapshot_hash':group['input_snapshot_hash']})
            state['resource_request']=group;state.pop('resource_input_invalidated',None)
        else:
            common={'role_id','resource_request_id','resource_fence'}
            extra={'resource.begin':{'input_snapshot_hash','inputs_verified','guard_evidence'},'resource.attach':{'original_job','evidence'},
                   'resource.unknown':{'reason'},'resource.finish':{'original_job','terminal_status','process_stopped','evidence'},
                   'resource.cancel':{'reason'},'resource.reconcile_not_started':{'confirmed_no_execution','evidence'}}
            if action not in extra:fail('invalid','未知资源动作')
            obj(data,common|extra[action],common|extra[action]);group=state.get('resource_request')
            if not group or group['id']!=data['resource_request_id'] or group['fence']!=data['resource_fence']:fail('resource_changed','不是当前资源申请或控制代次',409)
            if action=='resource.begin':
                if group['phase']!='reserved' or task['status']!='open' or state['status']!='running' or task['collaboration'].get('shared_change_pending'):fail('resource_state','没有当前可执行的资源机会',409)
                if not group_current(task,rid,group) or data['input_snapshot_hash']!=group['input_snapshot_hash'] or data['inputs_verified'] is not True:fail('resource_inputs_changed','输入或职责已变化，必须重新核对真实字节',409)
                occupied={x['resource_id']:0 for x in group['requirements']}
                for _,_,held in groups(db,HELD):
                    for need in held['requirements']:
                        if need['resource_id'] in occupied:occupied[need['resource_id']]+=need['units']
                if any(occupied[x['resource_id']]>available_capacity(_definition(book,x['resource_id'])) for x in group['requirements']):
                    fail('resource_observation_stale','资源观测过期或现有保留超过最新容量，尚不启动',409)
                if _writer_conflict(db,frozen_files(group),task['id'],rid):
                    fail('inputs_still_writing','开始前仍有相关活动写者，不能启动',409)
                group['phase']='starting';group['start_intent']={'id':'resource_start_'+fingerprint({'request':group['id'],'fence':group['fence']})[:32],
                    'at':now(),'actor':actor,'guard_evidence':txt(data['guard_evidence'],'开始前原guard核对',4000),'inputs_check_source':'operator_confirmed_file_check_not_service_read'}
            elif action=='resource.attach':
                if group['phase'] not in {'starting','unknown'} or not group['start_intent'] or group['execution'] is not None:fail('resource_state','须先核对原执行意图；原Job不能被替换',409)
                job=_job(data['original_job'],role,state)
                if any(other.get('execution') and other['execution']['original_job']==job
                       for owner,other_rid,other in groups(db,HELD)
                       if owner['id']!=task['id'] or other_rid!=rid):
                    fail('original_execution_conflict','同一原执行已归属另一个活动资源角色，不能重复关联',409)
                group['execution']={'original_job':job,'evidence':txt(data['evidence'],'原Job接纳依据',4000),'recorded_at':now(),'actor':actor};group['phase']='running'
            elif action=='resource.unknown':
                if group['phase'] not in HELD:fail('resource_state','尚无需要保留的执行占用',409)
                group['phase']='unknown';group['unknown']={'reason':txt(data['reason'],'未知原因',4000),'actor':actor,'at':now()}
            elif action=='resource.finish':
                if group['phase'] not in {'running','unknown'} or not group['execution']:fail('resource_state','先核对并关联确切原Job，不能释放未知执行',409)
                if data['original_job']!=group['execution']['original_job'] or data['terminal_status'] not in {'completed','failed','cancelled'} or data['process_stopped'] is not True:fail('original_execution','原执行身份或停止证据不符',409)
                group['terminal']={'status':data['terminal_status'],'process_stopped':True,'evidence':txt(data['evidence'],'原执行终态依据',4000),'actor':actor,'at':now(),'source':'operator_reconciled_original_execution'};group['phase']='released'
            elif action=='resource.cancel':
                if group['phase'] not in {'queued','reserved'} or group['start_intent'] or group['execution']:fail('resource_state','已越过执行边界或结果未知，不能按未开始取消',409)
                group['terminal']={'status':'not_started','reason':txt(data['reason'],'取消原因',4000),'actor':actor,'at':now()};group['phase']='cancelled'
            else:
                if group['phase'] not in {'starting','unknown'} or group['execution'] is not None or data['confirmed_no_execution'] is not True:fail('resource_state','不能抹掉已知原Job或未核对执行',409)
                group['terminal']={'status':'not_started','evidence':txt(data['evidence'],'确证未执行的依据',4000),'actor':actor,'at':now(),'source':'explicit_original_execution_reconciliation'};group['phase']='cancelled'
    task['updated_at']=now();return task


def _job(raw,role,state):
    obj(raw,{'executor','id','project_id','session_id'},{'executor','id','project_id','session_id'})
    if raw['project_id']!=role['project_id'] or raw['session_id']!=(state['binding'] or {}).get('session_id'):fail('identity','原Job的Project/Session与当前角色不符',409)
    return {'executor':txt(raw['executor'],'执行器名称',100),'id':txt(raw['id'],'原执行ID',200),'project_id':raw['project_id'],'session_id':raw['session_id']}


def _save_automatic(db,task,action,data,trigger_request_id):
    task['version']+=1;task['updated_at']=now();bounded(task)
    from task_domain import MAX_JSON
    if len(encoded(task).encode('utf-8'))>MAX_JSON-32768:fail('too_large','资源记录已达任务容量上限，未部分更新',413)
    db.execute('UPDATE tasks SET version=?,data=? WHERE id=?',(task['version'],encoded(task),task['id']))
    db.execute('INSERT INTO events(task_id,version,action,actor,at,payload) VALUES(?,?,?,?,?,?)',
               (task['id'],task['version'],action,'program:resource-coordinator',now(),encoded({'data':data,'trigger_request_id':trigger_request_id,'model_called':False})))


def advance(db,trigger_request_id=None):
    """Caller owns one immediate transaction. Never contacts an external executor."""
    book=catalog(db)
    if not book['resources']:return 0
    changed=0;queue=[];occupied={key:0 for key in book['resources']}
    for task in tasks(db):
        invalid=[]
        for rid,state in task['roles'].items():
            group=state.get('resource_request')
            if not group:continue
            if group['phase'] in HELD:
                for need in group['requirements']:occupied[need['resource_id']]=occupied.get(need['resource_id'],0)+need['units']
            if group['phase']=='queued':queue.append((group['queue_sequence'],task['id'],rid,group['id']))
            if state['status'] in {'submitted','accepted'} and state.get('delivery') and group['phase'] in SETTLED and not group_current(task,rid,group):
                state['status']='pending';state['resource_input_invalidated']={'resource_request_id':group['id'],'delivery_id':state['delivery']['id'],'at':now()}
                state['review']={'outcome':'rework','note':'引用的输入或意见已变化，旧结果不能用于当前验收','source':'resource_input_invalidation','at':now()};invalid.append(rid)
        if invalid:
            _save_automatic(db,task,'resource.inputs_invalidated',{'role_ids':invalid},trigger_request_id);changed+=1
            if changed>=MAX_GRANTS:return changed
    blocked=set()
    for _,task_id,rid,group_id in sorted(queue):
        task=json.loads(db.execute('SELECT data FROM tasks WHERE id=?',(task_id,)).fetchone()[0]);state=task['roles'][rid];group=state.get('resource_request')
        if not group or group['id']!=group_id or group['phase']!='queued':continue
        if task['status']!='open' or task['collaboration'].get('shared_change_pending') or state['status']!='running' or not group_current(task,rid,group):continue
        needs=group['requirements'];ids={n['resource_id'] for n in needs}
        if any(n['resource_id'] not in book['resources'] or book['resources'][n['resource_id']]['definition_version']!=n['definition_version'] for n in needs):continue
        if _writer_conflict(db,frozen_files(group),task_id,rid):
            blocked.update(ids);continue
        if ids&blocked or any(occupied.get(n['resource_id'],0)+n['units']>available_capacity(book['resources'][n['resource_id']]) for n in needs):
            blocked.update(ids);continue
        group['phase']='reserved';group['reserved_at']=now()
        for need in needs:occupied[need['resource_id']]=occupied.get(need['resource_id'],0)+need['units']
        _save_automatic(db,task,'resource.reserved',{'role_id':rid,'resource_request_id':group['id'],'input_snapshot_hash':group['input_snapshot_hash']},trigger_request_id);changed+=1
        if changed>=MAX_GRANTS:break
    return changed


def listing(db):
    book=catalog(db);at=time_now();used={k:0 for k in book['resources']};waiting={k:0 for k in book['resources']};holders={k:[] for k in book['resources']}
    for task,rid,group in groups(db):
        for need in group['requirements']:
            key=need['resource_id']
            if key not in used:continue
            if group['phase'] in HELD:
                used[key]+=need['units']
                if len(holders[key])<32:holders[key].append({'task_id':task['id'],'role_id':rid,'resource_request_id':group['id'],'phase':group['phase'],'units':need['units'],'inputs_current':group_current(task,rid,group),'original_job':(group['execution'] or {}).get('original_job')})
            elif group['phase']=='queued':waiting[key]+=1
    rows=[]
    for key,value in book['resources'].items():
        resource=deepcopy(value);capacity=available_capacity(value,at)
        resource.update(occupied=used[key],grantable=max(0,capacity-used[key]),queued=waiting[key],holders=holders[key],holder_list_limit=32,
                        observation_current=bool(value.get('observation')) and at<=value['observation']['valid_until'])
        rows.append(resource)
    return {'resources':rows,'source':'task_journal_and_explicit_resource_observations','model_dispatch':False,'os_ownership_enforced':False,'observed_at':at}
