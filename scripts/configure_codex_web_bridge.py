"""Configure only the opt-in CLW bridge; never install/change native Codex settings."""
import argparse,json,os,subprocess,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def workspace_call(request):
    from web_host_control import AppControl,ControlError
    from product_runtime import atomic_json
    control=AppControl(ROOT/'.local/web-host',expected_root=ROOT)
    state=control.state()
    envelope={'operation_id':uuid.uuid4().hex,'action':'connection-'+request['action'],
              'payload':request.get('payload',{}),'expected_identity':{key:state[key] for key in
                  ('app_instance_id','root','runtime_generation','selected')}}
    file=ROOT/'.local/codex-web-bridge/connection-operations'/(envelope['operation_id']+'.json')
    file.parent.mkdir(parents=True,exist_ok=True)
    with file.open('x',encoding='utf8') as stream:
        json.dump({'request':envelope,'receipt':None},stream,ensure_ascii=False,indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    try:receipt=control.command(envelope,wait_seconds=20)
    except ControlError as error:
        receipt={'operation_id':envelope['operation_id'],'state':'rejected' if error.accepted is False else 'unknown',
                 'error':str(error),'replayed':False}
    atomic_json(file,{'request':envelope,'receipt':receipt})
    original={'operation_id':envelope['operation_id'],'receipt_file':str(file)}
    if receipt.get('state')!='completed':
        # The original request is never submitted again, including after a lost
        # response. Query this ID through web_host_control.py operation instead.
        print(json.dumps({'state':receipt.get('state','unknown'),'controlOperation':original,
                          'receipt':receipt,'replayed':False},ensure_ascii=False))
        raise SystemExit(1)
    return {**receipt['result'],'controlOperation':original}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tunnel-id')
    p.add_argument('--web-account',choices=['A','B'],help='Explicit Web inference account; existing tasks retain their account.')
    p.add_argument('--app-name',help='Explicit platform connector name; omit to preserve the current selection.')
    p.add_argument('--reuse-local-mcp',action='store_true',help='Preserve an already configured shared connection; fresh shared installation needs its external Union/backend setup.')
    p.add_argument('--runtime-key-file',type=Path)
    p.add_argument('--tunnel-binary',type=Path)
    p.add_argument('--expected-settings',help='SHA256 from --inspect-json, or absent for a fresh installation.')
    p.add_argument('--inspect-json',action='store_true',help='Read paths and readiness only; do not read key contents or write settings.')
    p.add_argument('--through-workspace',action='store_true',help='Use the running workspace execution checks; save only, without quitting or reopening it.')
    p.add_argument('--disable',action='store_true',help='Save this explicit connection disabled; it applies on normal reopen.')
    a=p.parse_args()
    bun=ROOT/'.local/runtimes/bun-1.4.0/bun.exe'
    if not a.through_workspace and not bun.is_file():p.error('The packaged Bun runtime is missing; no settings changed.')
    def call(request):
        if a.through_workspace:return workspace_call(request)
        completed=subprocess.run([str(bun),'run',str(ROOT/'apps/codex-web-bridge/connection-settings.cjs')],input=json.dumps(request),capture_output=True,text=True,encoding='utf-8',cwd=ROOT,timeout=30)
        try:response=json.loads(completed.stdout)
        except ValueError:p.error('Connection settings response unavailable; inspect the original settings before retrying.')
        if not response.get('ok'):p.error(response.get('code','connection_settings_failed'))
        return response['result']
    current=call({'action':'read'})
    if a.inspect_json:
        print(json.dumps(current,ensure_ascii=False));return
    if a.reuse_local_mcp:
        if not current['sharedExisting'] or a.tunnel_id or a.runtime_key_file or a.tunnel_binary:p.error('Shared mode only preserves the original complete shared setup. Use the workspace for execution checks.')
        tunnel=current['tunnel'];account=a.web_account or current['webAccount']
    else:
        if not all([a.tunnel_id,a.runtime_key_file,a.tunnel_binary,a.web_account]):p.error('Dedicated setup requires explicit account, tunnel ID, key-file path and tunnel-binary path.')
        tunnel={'tunnelId':a.tunnel_id,'runtimeKeyFile':str(a.runtime_key_file.absolute()),'binaryPath':str(a.tunnel_binary.absolute())};account=a.web_account
    payload={'expected_etag':a.expected_settings or current['etag'],'enabled':not a.disable,'transport':'shared-mcp' if a.reuse_local_mcp else 'dedicated','webAccount':account,'tunnel':tunnel}
    if a.app_name is not None:payload['appName']=a.app_name
    result=call({'action':'save','payload':payload})
    print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':main()
