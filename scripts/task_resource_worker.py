"""Verify explicitly allowed frozen inputs before recording one resource start intent.
No process is launched here. A recorded begin must be reconciled before using the
original authorized executor. Unknown effects never create a replacement Job.
"""
from __future__ import annotations
import argparse
from copy import deepcopy
import json
import re
import sys
import uuid
from task_domain import TaskError, bounded, obj, fingerprint, absolute, txt
from task_worker import Client, WorkerError, explicit_root, load, save_new, confined, check_files
from task_console import target, validate_command


def validate_snapshot(group):
    if not isinstance(group,dict) or not isinstance(group.get('inputs'),list) or len(group['inputs'])>8:
        raise WorkerError('invalid_resource_snapshot')
    if fingerprint(group['inputs'])!=group.get('input_snapshot_hash'):
        raise WorkerError('input_snapshot_corrupt')
    if not re.fullmatch(r'clw_resource_request_[a-f0-9]{32}',str(group.get('id',''))) or not re.fullmatch(r'[a-f0-9]{64}',str(group.get('fence',''))):
        raise WorkerError('invalid_resource_fence')


def verify_inputs(group,allowed_roots):
    """Explicit per-role roots are authority supplied separately from the packet."""
    validate_snapshot(group)
    if not isinstance(allowed_roots,list) or len(allowed_roots)>8:raise WorkerError('explicit_input_roots_required')
    roots={}
    for row in allowed_roots:
        obj(row,{'role_id','root'},{'role_id','root'})
        if not isinstance(row['role_id'],str) or row['role_id'] in roots:raise WorkerError('duplicate_or_invalid_input_root')
        roots[row['role_id']]=explicit_root(row['root'])
    result=[];total=0
    for source in group['inputs']:
        root=roots.get(source['role_id'])
        if root is None or absolute(str(root))!=source['worktree']:
            raise WorkerError('input_root_not_explicitly_authorized')
        checked=check_files(root,source['artifacts']);total+=sum(x['bytes'] for x in checked['files'])
        if total>64*1024*1024:raise WorkerError('input_total_too_large')
        if not checked['passed']:raise WorkerError('frozen_input_bytes_changed_no_start')
        result.append({'role_id':source['role_id'],'files':checked['files']})
    return {'passed':True,'input_snapshot_hash':group['input_snapshot_hash'],'sources':result,
            'source':'explicit_local_files_checked_not_guard_or_process_authentication'}


def prepare_begin(packet,allowed_roots,root,origin,store_id,actor,guard_evidence):
    target(origin,store_id);bounded(packet)
    if packet.get('format')!='clw.assignment.v1' or packet.get('store_id')!=store_id or packet['role']['worktree']!=absolute(str(root)):
        raise WorkerError('assignment_target_mismatch')
    group=packet.get('resource_request');validate_snapshot(group)
    if packet['parent_status']!='open' or packet.get('shared_change_pending') or group.get('phase')!='reserved':
        raise WorkerError('resource_not_currently_reserved')
    check=verify_inputs(group,allowed_roots)
    command={'request_id':'resource-begin-'+uuid.uuid4().hex,'action':'resource.begin','task_id':packet['task_id'],
        'expected_version':packet['task_version'],'actor':txt(actor,'操作者',100),
        'data':{'role_id':packet['role']['id'],'resource_request_id':group['id'],'resource_fence':group['fence'],
                'input_snapshot_hash':group['input_snapshot_hash'],'inputs_verified':True,'guard_evidence':txt(guard_evidence,'原guard核对依据',4000)}}
    validate_command(command)
    return {'format':'clw.resource-begin.v1','origin':origin,'store_id':store_id,'journal_root':absolute(str(root)),
        'command':command,'command_sha256':fingerprint(command),'snapshot':deepcopy(group),'input_check':check}


def validate_envelope(envelope,origin,store_id,root):
    bounded(envelope)
    obj(envelope,{'format','origin','store_id','journal_root','command','command_sha256','snapshot','input_check'},
        {'format','origin','store_id','journal_root','command','command_sha256','snapshot','input_check'})
    if envelope['format']!='clw.resource-begin.v1' or envelope['origin']!=origin or envelope['store_id']!=store_id or envelope['journal_root']!=absolute(str(root)):
        raise WorkerError('resource_envelope_target_mismatch')
    command=validate_command(envelope['command']);group=envelope['snapshot'];validate_snapshot(group)
    if command['action']!='resource.begin' or command['data'].get('resource_request_id')!=group['id'] or command['data'].get('resource_fence')!=group['fence'] or command['data'].get('input_snapshot_hash')!=group['input_snapshot_hash'] or fingerprint(command)!=envelope['command_sha256']:
        raise WorkerError('resource_envelope_corrupt_no_send')


def reconcile(client,envelope,root):
    validate_envelope(envelope,client.origin,client.store_id,root)
    raw=envelope['command'];reply=client.get('receipt',{'request_id':raw['request_id']})
    if reply['found']:
        receipt=reply['receipt']
        if receipt.get('request_id')!=raw['request_id'] or receipt.get('request_fingerprint')!=envelope['command_sha256'] or receipt.get('store_id')!=client.store_id:
            raise WorkerError('original_request_conflict_no_send')
    return reply


def send(client,envelope,root,allowed_roots):
    previous=reconcile(client,envelope,root)
    if previous['found']:return previous  # Accepted intent remains observable even after a later file change.
    verify_inputs(envelope['snapshot'],allowed_roots)
    result=client.request('command',body=envelope['command'])
    if result.get('request_id')!=envelope['command']['request_id'] or result.get('request_fingerprint')!=envelope['command_sha256']:
        raise WorkerError('unconfirmed_original_begin_keep_envelope')
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='operation',required=True)
    for name in ('check-inputs','prepare-begin','send','receipt'):
        cmd=sub.add_parser(name);cmd.add_argument('--root',required=True);cmd.add_argument('--out',required=True)
        if name!='check-inputs':cmd.add_argument('--origin',required=True);cmd.add_argument('--store-id',required=True)
        if name in ('check-inputs','prepare-begin'):cmd.add_argument('--packet',required=True)
        else:cmd.add_argument('--envelope',required=True)
        if name!='receipt':cmd.add_argument('--allowed-roots',required=True)
        if name=='prepare-begin':cmd.add_argument('--actor',required=True);cmd.add_argument('--guard-evidence',required=True)
    a=p.parse_args()
    try:
        root=explicit_root(a.root)
        if confined(root,a.out,new=True).exists():raise WorkerError('output_exists_preserve_original')
        if a.operation in ('check-inputs','prepare-begin'):
            packet=load(root,a.packet);allowed=load(root,a.allowed_roots)
            if a.operation=='check-inputs':result=verify_inputs(packet['resource_request'],allowed)
            else:result=prepare_begin(packet,allowed,root,a.origin,a.store_id,a.actor,a.guard_evidence)
        else:
            envelope=load(root,a.envelope);client=Client(a.origin,a.store_id)
            result=reconcile(client,envelope,root) if a.operation=='receipt' else send(client,envelope,root,load(root,a.allowed_roots))
        save_new(root,a.out,result)
        print(json.dumps({'saved':a.out,'request_id':result.get('command',result.get('receipt',result)).get('request_id'),
            'process_started':False,'instruction':'Reconcile the exact begin receipt before invoking the original authorized executor. Attach its original identity; do not replace unknown execution.'},ensure_ascii=True))
        return 0
    except (TaskError,WorkerError,OSError,ValueError,TypeError,KeyError,RecursionError) as exc:
        code=str(exc) if isinstance(exc,WorkerError) else exc.code if isinstance(exc,TaskError) else type(exc).__name__
        print(json.dumps({'success':False,'error_code':code,'process_started':False,'instruction':'Keep the original envelope and reconcile its receipt; no automatic replay.'}));return 1

if __name__=='__main__':raise SystemExit(main())
