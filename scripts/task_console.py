"""Coordinator metadata CLI. Uses the existing same-origin task API, never a tool proxy.
All writes are first saved as exclusive immutable request envelopes. A later send
reconciles that exact request before a single POST. No model or Job is launched.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
import uuid
from task_domain import TaskError, bounded, obj, txt, fingerprint, absolute
from task_worker import Client, WorkerError, explicit_root, load, save_new
from task_resources import ACTIONS as RESOURCE_ACTIONS
from task_goals import ACTIONS as GOAL_ACTIONS
from task_routing import ACTIONS as ROUTING_ACTIONS

ACTIONS = {'create','import','revise','publish','pause','resume','cancel','accept',
           'bind','claim','checkpoint','block','unblock','release','submit','review',
           'collaborate','feedback','review_delivery'} | RESOURCE_ACTIONS | GOAL_ACTIONS | ROUTING_ACTIONS
READS = {'info':set(),'list':{'query','project','status','after','limit'},'get':{'id'},
         'events':{'id','after','limit'},'inbox':{'after','limit'},'sessions':{'id','role'},
         'assignment':{'id','role'},'export':{'id','role','format'},'resources':set(),'communication-target':{'agent','conversation','generation'}}


def target(origin, store_id):
    if not isinstance(origin,str) or not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{1,5}',origin) or not 1<=int(origin.rsplit(':',1)[1])<=65535:
        raise WorkerError('explicit_loopback_origin_required')
    if not isinstance(store_id,str) or not re.fullmatch(r'[0-9a-f]{32}',store_id):raise WorkerError('exact_store_id_required')


def validate_command(raw):
    bounded(raw)
    obj(raw,{'request_id','action','actor','task_id','expected_version','data'},{'request_id','action','actor','data'})
    if raw['action'] not in ACTIONS:raise WorkerError('metadata_action_not_allowed')
    if not isinstance(raw['request_id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,100}',raw['request_id']):raise WorkerError('invalid_request_id')
    txt(raw['actor'],'本次操作者',100)
    if not isinstance(raw['data'],dict):raise WorkerError('command_data_must_be_object')
    if raw['action'] in {'create','import'}:
        if 'task_id' in raw or 'expected_version' in raw:raise WorkerError('create_must_not_adopt_previous_identity')
    elif not isinstance(raw.get('task_id'),str) or not re.fullmatch(r'clw_task_[0-9a-f]{32}',raw['task_id']) or type(raw.get('expected_version')) is not int or raw['expected_version']<1:
        raise WorkerError('exact_task_and_current_version_required')
    return raw


def prepare(raw, origin, store_id, root):
    target(origin,store_id)
    raw=dict(raw)
    if 'request_id' not in raw:raw['request_id']='console-'+uuid.uuid4().hex
    validate_command(raw)
    return {'format':'clw.command-envelope.v1','origin':origin,'store_id':store_id,
            'journal_root':absolute(str(root)),'command':raw,'command_sha256':fingerprint(raw)}


def validate(envelope, origin, store_id, root):
    obj(envelope,{'format','origin','store_id','journal_root','command','command_sha256'},
        {'format','origin','store_id','journal_root','command','command_sha256'})
    if envelope['format']!='clw.command-envelope.v1' or envelope['origin']!=origin or envelope['store_id']!=store_id or envelope['journal_root']!=absolute(str(root)):
        raise WorkerError('envelope_target_mismatch')
    validate_command(envelope['command'])
    if fingerprint(envelope['command'])!=envelope['command_sha256']:raise WorkerError('envelope_corrupt_no_send')


def reconcile(client, envelope, root):
    validate(envelope,client.origin,client.store_id,root)
    raw=envelope['command'];result=client.get('receipt',{'request_id':raw['request_id']})
    if result['found']:
        receipt=result['receipt']
        if receipt.get('request_fingerprint')!=envelope['command_sha256'] or receipt.get('request_id')!=raw['request_id'] or receipt.get('store_id')!=client.store_id:
            raise WorkerError('original_request_conflict_no_send')
    return result


def send(client, envelope, root):
    result=reconcile(client,envelope,root)
    if result['found']:return result
    result=client.request('command',body=envelope['command'])
    if result.get('request_fingerprint')!=envelope['command_sha256'] or result.get('request_id')!=envelope['command']['request_id']:
        raise WorkerError('unconfirmed_receipt_keep_envelope')
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='operation',required=True)
    for name in ('read','prepare','send','receipt'):
        cmd=sub.add_parser(name);cmd.add_argument('--origin',required=True);cmd.add_argument('--store-id',required=True);cmd.add_argument('--root',required=True)
        if name=='read':cmd.add_argument('--route',choices=sorted(READS),required=True);cmd.add_argument('--params');cmd.add_argument('--out',required=True)
        elif name=='prepare':cmd.add_argument('--input',required=True);cmd.add_argument('--out',required=True)
        else:cmd.add_argument('--envelope',required=True);cmd.add_argument('--out',required=True)
    args=p.parse_args()
    try:
        target(args.origin,args.store_id);root=explicit_root(args.root)
        # Preflight exclusive output before any possible remote metadata effect.
        from task_worker import confined
        if confined(root,args.out,new=True).exists():raise WorkerError('output_exists_preserve_original')
        if args.operation=='prepare':
            envelope=prepare(load(root,args.input),args.origin,args.store_id,root);save_new(root,args.out,envelope)
            result={'prepared':True,'request_id':envelope['command']['request_id'],'sent':False,'output':args.out}
        else:
            client=Client(args.origin,args.store_id)
            if args.operation=='read':
                params=load(root,args.params) if args.params else {}
                if not isinstance(params,dict) or set(params)-READS[args.route] or any(type(x) not in (str,int) for x in params.values()):raise WorkerError('invalid_read_parameters')
                reply=client.get(args.route,params);reply.pop('intent',None)  # Do not persist the local CSRF proof.
            else:
                envelope=load(root,args.envelope)
                reply=reconcile(client,envelope,root) if args.operation=='receipt' else send(client,envelope,root)
            save_new(root,args.out,reply)
            receipt=reply.get('receipt') or reply
            result={'saved':args.out,'store_id':client.store_id,'request_id':receipt.get('request_id'),
                    'task_id':receipt.get('task_id',reply.get('task',{}).get('id')),'task_version':receipt.get('version',reply.get('task',{}).get('version')),
                    'found':reply.get('found'),'metadata_only':True,'model_started':False}
        print(json.dumps(result,ensure_ascii=True,indent=2));return 0
    except (TaskError,WorkerError,OSError,ValueError,KeyError,TypeError,RecursionError) as exc:
        code=str(exc) if isinstance(exc,WorkerError) else exc.code if isinstance(exc,TaskError) else type(exc).__name__
        print(json.dumps({'success':False,'error_code':code,'instruction':'Preserve the original envelope. Reconcile its original receipt before any explicit same-request retry.'}));return 1


if __name__=='__main__':raise SystemExit(main())
