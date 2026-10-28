"""Same-origin, bounded HTTP surface; never an arbitrary tool/command proxy."""
from urllib.parse import urlsplit,parse_qs
import hmac,json
from harness_state import HarnessError,require
from harness_recovery_http import handle_recovery_wire
from harness_control_http import handle_control_wire

class HarnessHTTP:
    def __init__(self,service):self.service=service
    @staticmethod
    def send(h,status,value):
        data=json.dumps(value,ensure_ascii=False,allow_nan=False).encode('utf-8')
        h.send_response(status);h.send_header('Content-Type','application/json;charset=utf-8');h.send_header('Content-Length',str(len(data)));h.end_headers();h.wfile.write(data)
    def handle(self,h):
        if not h.path.startswith('/api/harness/'):return False
        if h.path=='/api/harness/control-wire':return handle_control_wire(h,self.service.host_bridge.control)
        if h.path=='/api/harness/recovery-wire':return handle_recovery_wire(h,self.service.host_bridge.recovery)
        try:
            port=h.server.server_address[1];allowed={f'http://127.0.0.1:{port}',f'http://localhost:{port}'}
            require(h.headers.get('Host') in {v[7:] for v in allowed},'host_not_allowed',403)
            require(h.headers.get('Sec-Fetch-Site')!='cross-site','cross_site_request',403)
            origin=h.headers.get('Origin');require(not origin or origin in allowed,'origin_not_allowed',403)
            require(len(h.path)<=4096,'request_too_large',414)
            parsed=urlsplit(h.path);q=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=bool(parsed.query))
            require(all(len(v)==1 for v in q.values()),'duplicate_query')
            params={k:v[0] for k,v in q.items()};route=parsed.path.removeprefix('/api/harness/')
            if h.command=='GET':
                allowed_queries={'info':set(),'threads':set(),'events':{'thread_id','after'},'diff':{'thread_id'},'approvals':{'thread_id'},'receipt':{'request_id'},'artifacts':{'thread_id'},'artifact':{'thread_id','artifact_id'},'web':set(),'web-request':{'request_id','store_id'},'host':set(),'recovery':{'thread_id'},'branches':{'thread_id'},'control':{'thread_id'},'team':set()}
                require(route in allowed_queries and not set(params)-allowed_queries[route],'unknown_route',404)
                if route=='info':result=self.service.info()
                elif route=='threads':
                    self.service.refresh_liveness();result={'items':self.service.state.listing()}
                elif route=='events':result=self.service.state.events(params.get('thread_id'),int(params.get('after','0')))
                elif route=='diff':result=self.service.diff(params.get('thread_id'))
                elif route=='approvals':result={'items':self.service.pending(params.get('thread_id'))}
                elif route=='receipt':result=self.service.receipt(params.get('request_id'))
                elif route=='artifacts':result=self.service.artifacts(params.get('thread_id'))
                elif route=='artifact':result=self.service.artifact(params.get('thread_id'),params.get('artifact_id'))
                elif route=='branches':result=self.service.host_bridge.public_branch_state(params.get('thread_id'))
                elif route=='team':result=self.service.host_bridge.team.public_status()
                elif route=='control':result=self.service.host_bridge.control.snapshot(params.get('thread_id'))
                elif route=='recovery':result=self.service.host_bridge.recovery.snapshot(params.get('thread_id'))
                elif route=='host':result=self.service.host_bridge.snapshot()
                elif route=='web':result=self.service.native_diagnostics()
                elif route=='web-request':
                    require(params.get('store_id')==self.service.state.id,'web_store_mismatch',409)
                    result=self.service.web.request(params.get('request_id'))
            else:
                require(h.command=='POST' and route in ('command','host-control') and not params,'method_not_allowed',405)
                require(origin in allowed,'explicit_origin_required',403)
                if route=='host-control':self.service.host_bridge.authorize(h.headers.get('X-CLW-Host'))
                else:require(hmac.compare_digest(h.headers.get('X-CLW-Intent',''),self.service.intent),'intent_expired_refresh_before_retry',403)
                require(h.headers.get_content_type()=='application/json','json_required',415)
                require(not h.headers.get('Transfer-Encoding'),'transfer_encoding_not_supported',400)
                length=h.headers.get('Content-Length','');require(length.isdecimal() and len(length)<=8,'content_length_required',411)
                length=int(length);require(0<length<=262144,'body_too_large',413)
                raw=h.rfile.read(length);require(len(raw)==length,'incomplete_body')
                value=json.loads(raw)
                result=self.service.host_bridge.private(h.headers.get('X-CLW-Host'),value) if route=='host-control' else self.service.command(value)
            self.send(h,200,{'success':True,**result})
        except HarnessError as exc:self.send(h,exc.status,{'success':False,'code':exc.code})
        except (ValueError,TypeError,KeyError):self.send(h,400,{'success':False,'code':'invalid_input'})
        except (BrokenPipeError,ConnectionError):pass
        except Exception:self.send(h,503,{'success':False,'code':'service_error_reconcile_original'})
        return True
