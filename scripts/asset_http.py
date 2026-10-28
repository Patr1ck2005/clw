"""Same-origin asset metadata, bounded binary upload, and approved download endpoints."""
from __future__ import annotations
import hmac,json,secrets,threading
from urllib.parse import parse_qs,urlsplit,unquote_to_bytes
from task_domain import MAX_JSON,TaskError,fail
from task_http import TaskHTTP
from asset_domain import MAX_UPLOAD

class AssetHTTP:
    def __init__(self,store):
        self.store=store;self.intent=secrets.token_urlsafe(32);self.uploads=threading.BoundedSemaphore(2)
    @staticmethod
    def binary(h,data,mime,filename=None):
        h.send_response(200);h.send_header('Content-Type',mime);h.send_header('Content-Length',str(len(data)))
        if filename:h.send_header('Content-Disposition','attachment; filename="'+filename+'"')
        h.end_headers();h.wfile.write(data)
    @staticmethod
    def body(h,cap):
        if h.headers.get('Transfer-Encoding') or len(h.headers.get_all('Content-Length',[]))!=1:fail('length','只接受单一定长请求',415)
        value=h.headers.get('Content-Length','')
        if not value.isdecimal() or not 1<=int(value)<=cap:fail('too_large','请求体大小超限或无效',413)
        h.connection.settimeout(8);data=h.rfile.read(int(value))
        if len(data)!=int(value):fail('incomplete','上传未完整接收')
        return data
    @staticmethod
    def parse(data):
        def pairs(xs):
            out={}
            for k,v in xs:
                if k in out:fail('invalid','重复JSON字段')
                out[k]=v
            return out
        return json.loads(data,object_pairs_hook=pairs)
    def handle(self,h):
        parsed=urlsplit(h.path)
        if not parsed.path.startswith('/api/assets/'):return False
        try:
            port=h.server.server_address[1];host=h.headers.get('Host','');origin='http://'+host
            if host not in {f'127.0.0.1:{port}',f'localhost:{port}'} or h.headers.get('Origin') not in (None,origin) or h.headers.get('Sec-Fetch-Site')=='cross-site':fail('origin','仅接受本机同源页面',403)
            if len(h.path)>4096:fail('invalid','查询过长',414)
            qs=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=bool(parsed.query))
            if any(len(v)!=1 for v in qs.values()):fail('invalid','重复参数')
            p={k:v[0] for k,v in qs.items()};path=parsed.path
            if h.command=='GET':
                allowed={'/api/assets/info':set(),'/api/assets/list':{'query','after','limit'},'/api/assets/get':{'id'},'/api/assets/projects':set(),'/api/assets/receipt':{'request_id'},'/api/assets/handoff':{'id','format'},'/api/assets/events':{'id','after'},'/api/assets/image':{'id','candidate'},'/api/assets/delivery':{'id'}}
                if path not in allowed or set(p)-allowed[path]:fail('not_found','未知素材查询',404)
                route=path.rsplit('/',1)[1]
                if route=='info':result={'store_id':self.store.store_id,'intent':self.intent,'schema_version':1,'execution':'external_handoff_only','model_calls':False,'max_upload_bytes':MAX_UPLOAD,'normalization':'decoded raster, metadata removed','quota_source':'operator_report_only'}
                elif route=='list':result=self.store.listing(p.get('query',''),int(p.get('after','0')),int(p.get('limit','30')))
                elif route=='get':result={'batch':self.store.get(p.get('id'))}
                elif route=='projects':result=self.store.projects()
                elif route=='receipt':result=self.store.receipt(p.get('request_id'))
                elif route=='handoff':result=self.store.export_handoff(p.get('id'),p.get('format','json'))
                elif route=='events':result=self.store.events(p.get('id'),int(p.get('after','0')))
                elif route=='image':
                    data,mime=self.store.image(p.get('id'),p.get('candidate'));self.binary(h,data,mime);return True
                else:self.binary(h,self.store.delivery(p.get('id')),'application/zip','clw-approved-assets.zip');return True
            elif h.command=='POST' and path in {'/api/assets/command','/api/assets/upload'} and not p:
                if h.headers.get('Origin')!=origin or not hmac.compare_digest(h.headers.get('X-CLW-Intent',''),self.intent):fail('intent','页面过期或非同源，请按原请求核对',403)
                if path.endswith('/command'):
                    if h.headers.get_content_type()!='application/json':fail('content_type','仅接受JSON',415)
                    result=self.store.command(self.parse(self.body(h,MAX_JSON)))
                else:
                    if h.headers.get_content_type()!='application/octet-stream':fail('content_type','图片通过定长二进制上传，不接收路径或URL',415)
                    meta=h.headers.get('X-CLW-Metadata','')
                    if not 1<=len(meta)<=12000:fail('metadata','上传元数据无效')
                    metadata=self.parse(unquote_to_bytes(meta).decode('utf-8'))
                    if not self.uploads.acquire(False):fail('busy','已有两项文件校验，请稍后核对原请求',429)
                    try:result=self.store.upload(metadata,self.body(h,MAX_UPLOAD))
                    finally:self.uploads.release()
            else:fail('method','不支持素材执行/路径写入操作',405)
            TaskHTTP.send(h,200,{'success':True,**result})
        except TaskError as exc:TaskHTTP.send(h,exc.status,{'success':False,'error_code':exc.code,'message':str(exc)})
        except (ValueError,TypeError,RecursionError,UnicodeError):TaskHTTP.send(h,400,{'success':False,'error_code':'invalid','message':'素材请求格式无效，未采用'})
        except ConnectionError:pass # Atomic SQLite receipt recovers a committed upload/command.
        except Exception:TaskHTTP.send(h,503,{'success':False,'error_code':'unavailable','message':'素材存储暂不可用；按原请求核对，不生成替代请求'})
        return True
