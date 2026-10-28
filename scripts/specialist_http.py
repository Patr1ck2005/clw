"""Closed local endpoints for explicit delegation and three-pool metadata."""
import hmac
import json
import secrets
from urllib.parse import urlsplit,parse_qs
from task_domain import MAX_JSON,TaskError,fail
from task_http import TaskHTTP

class SpecialistHTTP:
    def __init__(self,specialists,usage):
        self.specialists=specialists;self.usage=usage;self.intent=secrets.token_urlsafe(32)
    def handle(self,h):
        path=urlsplit(h.path)
        if not path.path.startswith(('/api/specialists/','/api/usage/')):return False
        try:
            port=h.server.server_address[1];host=h.headers.get('Host','');origin='http://'+host
            if host not in {f'127.0.0.1:{port}',f'localhost:{port}'}:fail('origin','Host无效',403)
            if h.headers.get('Origin') not in (None,origin) or h.headers.get('Sec-Fetch-Site')=='cross-site':fail('origin','拒绝跨站请求',403)
            if len(h.path)>4096:fail('large','路径超限',414)
            parts=parse_qs(path.query,keep_blank_values=True,strict_parsing=bool(path.query))
            if any(len(v)!=1 for v in parts.values()):fail('params','重复参数')
            p={k:v[0] for k,v in parts.items()};area=path.path.split('/')[2];route=path.path.split('/')[3:]
            if len(route)!=1:fail('not_found','未知路径',404)
            route=route[0];store=self.usage if area=='usage' else self.specialists.store
            if h.command=='GET':
                allowed={'info':set(),'receipt':{'request_id'}}
                allowed.update({'summary':set(),'list':{'after','limit'},'history':{'id'}} if area=='usage' else {'capabilities':{'id','role'}})
                if route not in allowed or set(p)-allowed[route]:fail('not_found','未知查询',404)
                if route=='info':result={'store_id':store.store_id,'intent':self.intent,'dispatch_enabled':self.specialists.bridge.enabled,'model_dispatch':area=='specialists' and self.specialists.bridge.enabled,'paid_api_dispatch':False}
                elif route=='receipt':result=store.receipt(p.get('request_id'))
                elif route=='summary':result=store.summary()
                elif route=='list':result=store.listing(int(p.get('after','0')),int(p.get('limit','50')))
                elif route=='history':result=store.history(p.get('id',''))
                else:result=self.specialists.capabilities(p.get('id',''),p.get('role',''))
            elif h.command=='POST' and route=='command' and not p:
                if h.headers.get('Origin')!=origin or not hmac.compare_digest(h.headers.get('X-CLW-Intent',''),self.intent):fail('intent','页面状态过期；刷新后先核对原请求',403)
                if h.headers.get_content_type()!='application/json' or h.headers.get('Transfer-Encoding'):fail('type','只接受定长JSON',415)
                size=h.headers.get('Content-Length','')
                if not size.isdecimal() or not 1<=int(size)<=MAX_JSON:fail('large','请求体超限',413)
                h.connection.settimeout(8);body=h.rfile.read(int(size))
                if len(body)!=int(size):fail('body','请求体不完整')
                data=json.loads(body);result=(store.command(data) if area=='usage' else self.specialists.command(data))
            else:fail('method','不支持的请求',405)
            TaskHTTP.send(h,200,{'success':True,**result})
        except TaskError as e:TaskHTTP.send(h,e.status,{'success':False,'error_code':e.code,'message':str(e)})
        except (ValueError,TypeError,RecursionError,UnicodeError):TaskHTTP.send(h,400,{'success':False,'error_code':'invalid','message':'格式不符合合同，请核对输入'})
        except ConnectionError:pass
        except Exception:TaskHTTP.send(h,503,{'success':False,'error_code':'unknown','message':'结果未确认；先核对原请求及当前记录，不自动重发'})
        return True
