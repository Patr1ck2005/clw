"""Thin project-side autonomous Host client. No external models or private web API.

Uses the existing Host IPC key only in the process. Invoke this installed client
by its absolute path through the receiver's own authorized Runtime Project and
Session. Payload files are relative to that process's current workspace. Native
Runtime permission to run the client is still required; this is not an ACL bypass.
"""
from __future__ import annotations
import argparse,json,sys,uuid
from pathlib import Path
from harness_host_client import Client,ROOT
from harness_state import HarnessError,require,public
from harness_team import OPS,READS
from harness_workspace_paths import normalize_scope_payload
from task_worker import file_bytes,WorkerError


def parse_payload(raw):
    require(isinstance(raw,str) and len(raw.encode('utf-8'))<=96000,'team_payload_bounds')
    def unique_pairs(pairs):
        result={}
        for k,v in pairs:
            require(k not in result,'team_duplicate_json_key');result[k]=v
        return result
    value=json.loads(raw,object_pairs_hook=unique_pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite')))
    require(isinstance(value,dict),'team_payload_object_required')
    return value


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('operation',choices=sorted(OPS))
    p.add_argument('--origin',default='http://127.0.0.1:18944')
    p.add_argument('--store-id',required=True);p.add_argument('--target',required=True);p.add_argument('--session-id',required=True)
    p.add_argument('--operation-id',help='Required fixed idempotency key for mutations; never change it after an uncertain result.')
    group=p.add_mutually_exclusive_group();group.add_argument('--payload-file');group.add_argument('--payload-json');group.add_argument('--payload-stdin',action='store_true')
    a=p.parse_args(argv)
    if a.payload_file:raw=file_bytes(Path.cwd(),a.payload_file,96000).decode('utf-8-sig')
    elif a.payload_stdin:
        encoded=sys.stdin.buffer.read(96001);require(len(encoded)<=96000,'team_payload_bounds');raw=encoded.decode('utf-8-sig')
    else:raw=a.payload_json or '{}'
    payload=parse_payload(raw)
    if a.operation=='workspace':payload=normalize_scope_payload(payload)
    require(a.operation in READS or a.operation_id is not None,'team_fixed_operation_key_required')
    key=a.operation_id or 'team-read-'+uuid.uuid4().hex
    client=Client(a.origin,ROOT/'.local/harness',a.store_id,a.target,a.session_id)
    result=client.call('team',op=a.operation,operation_id=key,payload=payload)
    # Enrollment marker and bootstrap text are deliberately returned to the exact
    # project operator. Neither is a Host key or an execution/claim capability.
    print(json.dumps(public(result),ensure_ascii=False,allow_nan=False),flush=True)
    return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except (HarnessError,WorkerError,ValueError,OSError) as exc:
        print(json.dumps({'success':False,'code':getattr(exc,'code','team_client_failed'),'operation_replayed':False}),flush=True)
        raise SystemExit(2)
