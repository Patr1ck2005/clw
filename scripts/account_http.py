"""Same-origin account metadata and observation API. No credential, arbitrary URL or process actions."""
from __future__ import annotations
import hmac,json,secrets
from urllib.parse import parse_qs,urlsplit
from task_domain import MAX_JSON,TaskError,fail
from task_http import TaskHTTP

class AccountHTTP:
    def __init__(self,store):self.store=store;self.intent=secrets.token_urlsafe(32)
    def handle(self,h):
        parsed=urlsplit(h.path)
        if not parsed.path.startswith('/api/accounts/'):return False
        try:
            port=h.server.server_address[1];host=h.headers.get('Host','');origin='http://'+host
            if host not in {f'127.0.0.1:{port}',f'localhost:{port}'} or h.headers.get('Origin') not in (None,origin) or h.headers.get('Sec-Fetch-Site')=='cross-site':fail('origin','只接受本机同源页面',403)
            if len(h.path)>4096:fail('invalid','查询过长',414)
            qs=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=bool(parsed.query))
            if any(len(v)!=1 for v in qs.values()):fail('invalid','参数重复')
            p={k:v[0] for k,v in qs.items()};path=parsed.path
            if h.command=='GET':
                allowed={'/api/accounts/info':set(),'/api/accounts/list':set(),'/api/accounts/dashboard':{'id'},'/api/accounts/inspect':{'id','project','session'},'/api/accounts/activity':{'id','binding'},'/api/accounts/history':{'id','after'},'/api/accounts/receipt':{'request_id'},'/api/accounts/export':set()}
                if path not in allowed or set(p)-allowed[path]:fail('not_found','未知账户观察操作',404)
                if path.endswith('/info'):result={'schema_version':1,'store_id':self.store.store_id,'intent':self.intent,'refresh_ms':5000,'account_authentication':False,'process_actions':False,'runtime_mutations':False}
                elif path.endswith('/list'):result=self.store.listing()
                elif path.endswith('/dashboard'):result=self.store.dashboard(p.get('id'))
                elif path.endswith('/inspect'):result=self.store.inspect(p.get('id'),p.get('project',''),p.get('session',''))
                elif path.endswith('/activity'):result=self.store.activity(p.get('id'),p.get('binding'))
                elif path.endswith('/history'):result=self.store.history(p.get('id'),int(p.get('after','0')))
                elif path.endswith('/receipt'):result=self.store.receipt(p.get('request_id'))
                else:result=self.store.export()
            elif h.command=='POST' and path=='/api/accounts/command' and not p:
                if h.headers.get('Origin')!=origin or not hmac.compare_digest(h.headers.get('X-CLW-Intent',''),self.intent):fail('intent','页面已过期或不是同源；按原请求核对',403)
                if h.headers.get_content_type()!='application/json' or h.headers.get('Transfer-Encoding'):fail('invalid','只接受定长JSON',415)
                length=h.headers.get('Content-Length','')
                if not length.isdecimal() or not 1<=int(length)<=MAX_JSON:fail('too_large','请求过大或无效',413)
                h.connection.settimeout(8);body=h.rfile.read(int(length))
                if len(body)!=int(length):fail('invalid','请求体不完整')
                result=self.store.command(json.loads(body))
            else:fail('method','不支持该动作',405)
            TaskHTTP.send(h,200,{'success':True,**result})
        except TaskError as exc:TaskHTTP.send(h,exc.status,{'success':False,'error_code':exc.code,'message':str(exc)})
        except (ValueError,TypeError,RecursionError,UnicodeError):TaskHTTP.send(h,400,{'success':False,'error_code':'invalid','message':'请求格式无效，未采用'})
        except ConnectionError:pass
        except Exception:TaskHTTP.send(h,503,{'success':False,'error_code':'unavailable','message':'本机状态暂不可用；修改结果未知时核对原请求'})
        return True
