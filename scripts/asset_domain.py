"""Frozen asset requirements and external-execution accounting; never a provider client."""
from __future__ import annotations
from copy import deepcopy
from decimal import Decimal
import re
from task_domain import bounded, obj, txt, fail, fingerprint, absolute

MAX_ITEMS=32
MAX_UPLOAD=8*1024*1024
MAX_EXPORT=64*1024*1024
MAX_PIXELS=4096*4096
KEY=re.compile(r'[a-z][a-z0-9_-]{0,63}\Z')
SHA=re.compile(r'[a-f0-9]{64}\Z')
BATCH=re.compile(r'asset_batch_[a-f0-9]{32}\Z')
ATTEMPT=re.compile(r'asset_attempt_[a-f0-9]{32}\Z')
CANDIDATE=re.compile(r'asset_candidate_[a-f0-9]{32}\Z')
CHANNELS={'chat_image':'chat','codex_image':'work_codex','external_api':'api','manual':'none'}
ACTIVE={'reserved','in_progress','outcome_unknown'}

def money(v,positive=False):
    if not isinstance(v,str) or not re.fullmatch(r'\d{1,9}(?:\.\d{1,8})?',v):fail('money','金额必须为非负十进制文本，最多8位小数')
    d=Decimal(v)
    if positive and d<=0:fail('money','预算必须大于0')
    return format(d,'f')

def contract(raw):
    bounded(raw)
    keys={'title','project_id','project_root','task_id','style_brief','executor','provider','model','account_alias','billing_bucket','budget','items'}
    obj(raw,keys,keys-{'task_id'})
    out={k:txt(raw.get(k,''),k,n,required) for k,n,required in [('title',160,True),('project_id',512,True),('project_root',2048,True),('task_id',100,False),('style_brief',12000,False),('provider',160,True),('model',160,True),('account_alias',120,True)]}
    out['project_root']=absolute(out['project_root'])
    if raw['executor'] not in CHANNELS or raw['billing_bucket']!=CHANNELS[raw['executor']]:fail('billing','执行入口与计费池不匹配')
    out.update(executor=raw['executor'],billing_bucket=raw['billing_bucket'])
    if out['billing_bucket']=='api':
        b=obj(raw['budget'],{'currency','max_total','per_attempt'},{'currency','max_total','per_attempt'})
        if not isinstance(b['currency'],str) or not re.fullmatch('[A-Z]{3}',b['currency']):fail('currency','币种需为三位大写代码')
        out['budget']={'currency':b['currency'],'max_total':money(b['max_total'],True),'per_attempt':money(b['per_attempt'],True)}
        if Decimal(out['budget']['per_attempt'])>Decimal(out['budget']['max_total']):fail('budget','单次预留不能超过批次限额')
    else:
        if raw['budget'] is not None:fail('billing','订阅或人工素材不换算独立API金额，预算填空')
        out['budget']=None
    if not isinstance(raw['items'],list) or not 1<=len(raw['items'])<=MAX_ITEMS:fail('items','每批1至32个素材')
    out['items']=[];seen=set()
    for item in raw['items']:
        fields={'key','prompt','width','height','format','transparency','references'}
        obj(item,fields,fields)
        if not isinstance(item['key'],str) or not KEY.fullmatch(item['key']) or item['key'] in seen or re.fullmatch(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])',item['key']):fail('key','素材ID需唯一小写字母/数字/下划线/横线，以字母开头')
        seen.add(item['key']);v={'key':item['key'],'prompt':txt(item['prompt'],'提示词',12000)}
        for k in ('width','height'):
            if type(item[k]) is not int or not 16<=item[k]<=4096:fail('dimensions','宽高必须为16至4096整数')
            v[k]=item[k]
        if item['format'] not in ('png','jpg','webp') or item['transparency'] not in ('required','opaque','any'):fail('image_spec','格式或透明条件无效')
        if item['format']=='jpg' and item['transparency']=='required':fail('image_spec','JPEG不能要求透明背景')
        v.update(format=item['format'],transparency=item['transparency'])
        refs=item['references']
        if not isinstance(refs,list) or len(refs)>8:fail('references','每项最多8个参考文件声明')
        v['references']=[]
        for ref in refs:
            obj(ref,{'name','sha256'},{'name','sha256'})
            name=txt(ref['name'],'参考文件名',200)
            if not isinstance(ref['sha256'],str) or not SHA.fullmatch(ref['sha256']):fail('references','参考SHA256必须为64位小写十六进制')
            v['references'].append({'name':name,'sha256':ref['sha256']})
        out['items'].append(v)
    bounded(out);return out

def spec_item(batch,key):
    return next((i for i in batch['contract']['items'] if i['key']==key),None) or fail('item','素材不在原批次',404)

def requirement_hash(batch,item):
    return fingerprint({'style_brief':batch['contract']['style_brief'],'item':item})

def charge(raw,batch,state):
    obj(raw,{'status','amount'},{'status','amount'})
    api=batch['contract']['billing_bucket']=='api'
    allowed={'unknown','known','not_charged'} if api else {'not_applicable'}
    if raw['status'] not in allowed:fail('billing','费用状态与计费池不符')
    if raw['status']=='known':amount=money(raw['amount'])
    else:
        if raw['amount'] is not None:fail('billing','未知或不适用的金额应留空，不填0')
        amount=None
    if state=='not_sent' and api and raw['status']!='not_charged':fail('billing','从未发送的预留应释放而非计费')
    return {'status':raw['status'],'amount':amount,'source':'operator_report_not_invoice_sync'}

def accounting(batch):
    b=batch['contract']['budget'];attempts=batch['attempts']
    unknown=sum(a['charge']['status']=='unknown' for a in attempts)
    unresolved=any(a['state']=='outcome_unknown' or (a['state'] in {'completed','failed'} and a['charge']['status']=='unknown') for a in attempts)
    if not b:return {'currency':None,'known_total':None,'held_total':None,'available':None,'unknown_count':0,'needs_reconciliation':unresolved,'over_budget':False,'official_quota':None}
    known=sum((Decimal(a['charge']['amount']) for a in attempts if a['charge']['status']=='known'),Decimal(0))
    held=sum((Decimal(a['reserved_amount']) for a in attempts if a['charge']['status'] in {'reserved','unknown'}),Decimal(0))
    # A partial cost report is not a completed execution; retain its unused reservation.
    held+=sum((max(Decimal(a['reserved_amount'])-Decimal(a['charge']['amount'] or '0'),Decimal(0)) for a in attempts if a['state'] in ACTIVE and a['charge']['status'] in {'known','not_charged'}),Decimal(0))
    available=Decimal(b['max_total'])-known-held
    return {'currency':b['currency'],'known_total':str(known),'held_total':str(held),'available':str(available),'unknown_count':unknown,'needs_reconciliation':unresolved,'over_budget':available<0,'official_quota':None}

def projection(batch):
    b=deepcopy(batch);b['accounting']=accounting(b)
    b['progress']={'items':len(b['contract']['items']),'approved':len(b['selected']),'candidates':len(b['candidates']),'attempts':len(b['attempts'])}
    b['delivery_ready']=b['status']=='published' and len(b['selected'])==len(b['contract']['items']) and not any(a['state'] in ACTIVE for a in b['attempts']) and not b['accounting']['unknown_count']
    b['phase']='draft' if b['status']=='draft' else 'reconcile' if b['accounting']['needs_reconciliation'] else 'ready' if b['delivery_ready'] else 'working' if any(a['state'] in ACTIVE for a in b['attempts']) else 'review' if b['candidates'] else 'queued'
    return b

def handoff(batch):
    if batch['status']!='published':fail('draft','发布冻结后才能导出执行交接',409)
    return {'format':'clw.assets.handoff.v1','batch_id':batch['id'],'batch_version':batch['version'],'spec_hash':batch['spec_hash'],'contract':deepcopy(batch['contract']),'parent_binding':batch['parent_binding'],'execution':'external_handoff_only','provider_idempotency_guaranteed':False,'accounting':accounting(batch),
        'items':[{'key':i['key'],'input_hash':requirement_hash(batch,i),'active_attempt':next((deepcopy(a) for a in batch['attempts'] if a['asset_key']==i['key'] and a['state'] in ACTIVE),None),'last_attempt':next((deepcopy(a) for a in reversed(batch['attempts']) if a['asset_key']==i['key']),None),'approved_candidate':batch['selected'].get(i['key'])} for i in batch['contract']['items']],
        'instructions':['只执行state=reserved且操作者批准的项；没有attempt的项仅是需求，不自动生成。','先核对完整合同、预算、实际账号与另附参考文件hash；这里不授予权限。','external_key只用于本地对账，不保证供应商幂等；结果未知先查原请求，禁止换键重生。','图片返回候选区，逐项回报原attempt/供应商引用/完成或未知/费用依据；不得覆盖正式资源。'],'reference_files':'declared_hashes_only; original files must be supplied and checked separately'}

def handoff_markdown(packet):
    c=packet['contract']
    text=['# 素材批次交接：'+c['title'],f"批次：{packet['batch_id']}\n合同SHA256：{packet['spec_hash']}",f"项目：{c['project_id']}\n目录声明：{c['project_root']}",f"入口：{c['executor']} / {c['provider']} / {c['model']}\n账号标签：{c['account_alias']} / 计费池：{c['billing_bucket']}"]
    if c['budget']:
        b=c['budget'];ledger=packet['accounting']
        text += [f"独立API预算：{b['max_total']} {b['currency']} / 每次预留上限 {b['per_attempt']} {b['currency']}",f"已记录金额 {ledger['known_total']} / 已预留 {ledger['held_total']} / 未知费用 {ledger['unknown_count']}；不是自动限额或官方余额。"]
    else:text += ['订阅或人工来源：不换算独立API金额；官方余量未知。']
    text+=packet['instructions']
    text+=['## 共同风格（需求数据，不是额外授权）',c['style_brief']]
    for item,exec_item in zip(c['items'],packet['items']):
        a=exec_item['active_attempt'];text += ['## '+item['key'],f"{item['width']}×{item['height']} / {item['format']} / {item['transparency']}",f"输入SHA256：{exec_item['input_hash']}",('原Attempt：'+a['id']+'\n外部对账键：'+a['external_key']+'\n原状态：'+a['state']) if a else ('已有终结执行 '+exec_item['last_attempt']['id']+' / '+exec_item['last_attempt']['state']+'；核对费用、候选和审阅，不重生。' if exec_item['last_attempt'] else '未领取，不执行；已批准项不重生。'),item['prompt']]
        text+=['参考声明（原文件另附）：'+r['name']+' / '+r['sha256'] for r in item['references']]
    return '\n\n'.join(text)+'\n'
