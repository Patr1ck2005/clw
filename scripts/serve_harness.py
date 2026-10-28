"""CLW conversation harness: an explicit normal local app, not a model Job daemon.
Run START_HARNESS.cmd for daily use. No auto-login, backend restart or forced retry.
"""
from pathlib import Path
import argparse,json,sys,webbrowser
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from serve_control_center import create_server
from product_runtime import StateLease
from web_workspace_runtime import runtime_identity
from live_transport import configuration
from harness_service import HarnessService
from harness_http import HarnessHTTP

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--port',type=int,default=18944);p.add_argument('--open',action='store_true')
    p.add_argument('--state-dir',type=Path,default=ROOT/'.local/harness');p.add_argument('--config',type=Path,default=ROOT/'.local/control-center/connection.json')
    p.add_argument('--channel',choices=('development','candidate'),default='development')
    p.add_argument('--managed-host-stdio',action='store_true',help='Private pipe to the dedicated desktop browser.')
    p.add_argument('--launch-owner',choices=('bounded-or-unknown','user-terminal','supervised-terminal'),default='bounded-or-unknown',help='Caller-declared lifetime owner; never bypasses a Runner deadline or proves durability.')
    a=p.parse_args()
    if not 0<=a.port<=65535:p.error('invalid_port')
    identity=runtime_identity(ROOT,a.channel)
    try:server=create_server(a.port,product_identity=identity)
    except OSError:raise SystemExit('CLW Harness port is in use. No process was stopped. Keep the original app or close only its terminal.')
    service=None
    try:
        with StateLease(a.state_dir) as owner:
            identity.base['state_id']=owner.identity
            try:transport=configuration(a.config)
            except (ValueError,OSError):transport=None
            service=HarnessService(ROOT,a.state_dir,transport)
            service.lifetime={'owner':a.launch_owner,'source':'launcher_declared_not_OS_attestation','durability_verified':False,'runner_deadline_bypassed':False}
            service.web.transport_loader=lambda:configuration(a.config)
            server.harness_api=HarnessHTTP(service)
            service.start_web_observer()
            origin=f'http://127.0.0.1:{server.server_address[1]}'
            if (ROOT/'.local/preview-installation.json').is_file():
                from harness_endpoint import publish
                from windows_process_owner import process_identity
                publish(ROOT,origin,service.instance,service.state.id,process_identity(identity.base['pid']))
            service.listener_origin=origin
            print('CLW_HARNESS '+json.dumps({'origin':origin,'pid':identity.base['pid'],'instance_id':service.instance,'state_id':owner.identity,'root':str(ROOT),'version':identity.base['version'],'model_called':False}),flush=True)
            print('Open '+origin+'/harness.html ; Ctrl+C stops only this application. Codex login/configuration is reused, never copied.',flush=True)
            print('CLW_LIFETIME '+json.dumps(service.lifetime),flush=True)
            if a.launch_owner=='bounded-or-unknown':print('This process may be a bounded Runner Job, NOT a durable daily service. Use the normal START_HARNESS terminal for daily operation; never retry an expired model request.',flush=True)
            if a.open:webbrowser.open(origin+'/harness.html')
            if a.managed_host_stdio:
                from harness_managed_stdio import start_pipe
                start_pipe(service,server)
            try:server.serve_forever()
            except KeyboardInterrupt:pass
            finally:
                # Finish inflight HTTP handlers while still holding state ownership.
                server.server_close()
                service.close()
    finally:
        server.server_close()
        if service and not service.closed:service.close()
if __name__=='__main__':main()
