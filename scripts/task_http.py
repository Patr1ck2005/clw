"""Narrow same-origin HTTP surface for product metadata, never a runtime tool proxy."""
from __future__ import annotations
import hmac
import json
import secrets
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from task_domain import MAX_JSON, TaskError, fail

class TaskHTTP:
    def __init__(self, store):
        self.store=store
        self.intent=secrets.token_urlsafe(32)  # Local CSRF protection, not runtime authority.
    def handle(self, handler):
        parsed=urlsplit(handler.path)
        if not parsed.path.startswith('/api/tasks/'): return False
        try:
            port=handler.server.server_address[1]
            host=handler.headers.get('Host','')
            if host not in {f'127.0.0.1:{port}',f'localhost:{port}'}: fail('origin','不接受该Host',403)
            origin='http://'+host
            if handler.headers.get('Origin') not in (None,origin) or handler.headers.get('Sec-Fetch-Site')=='cross-site': fail('origin','不接受跨站请求',403)
            if len(handler.path)>4096: fail('invalid','请求路径过长',414)
            params=parse_qs(parsed.query,keep_blank_values=True,strict_parsing=bool(parsed.query))
            if any(len(v)!=1 for v in params.values()): fail('invalid','重复参数')
            p={k:v[0] for k,v in params.items()};path=parsed.path
            if handler.command=='GET':
                allowed={
                    '/api/tasks/info':set(),'/api/tasks/list':{'query','project','status','after','limit'},
                    '/api/tasks/get':{'id'},'/api/tasks/events':{'id','after','limit'},
                    '/api/tasks/receipt':{'request_id'},'/api/tasks/export':{'id','role','format'},
                    '/api/tasks/sessions':{'id','role'},'/api/tasks/assignment':{'id','role'},
                    '/api/tasks/inbox':{'after','limit'},'/api/tasks/resources':set(),'/api/tasks/communication-target':{'agent','conversation','generation'}}
                if path not in allowed or set(p)-allowed[path]: fail('not_found','未知任务查询',404)
                if path.endswith('/info'):
                    communication=self.store.communication
                    result={'schema_version':1,'store_id':self.store.store_id,'intent':self.intent,'local_metadata_writes':True,'runtime_mutations':bool(communication and communication.enabled),'model_dispatch':False,'structured_deliveries':True,'read_schema_max':4,'sustained_goals':True,'resource_coordination':True,'resource_coordinator':getattr(handler.server,'resource_coordinator_status',{'status':'not_yet_observed'})}
                    result['communication']=communication.capability() if communication else {'configured':False,'dispatch_enabled':False,'host_auto_resume_verified':False}
                    result['routing_status']=getattr(getattr(handler.server,'routing_engine',None),'status',{'status':'disabled'})
                elif path.endswith('/list'):
                    result=self.store.listing(p.get('query',''),p.get('project',''),p.get('status',''),int(p.get('after','0')),int(p.get('limit','30')))
                elif path.endswith('/get'): result={'task':self.store.get(p.get('id'))}
                elif path.endswith('/communication-target'):
                    if self.store.communication is None:fail('communication_disabled','未配置原生通信连接',409)
                    result={'target':self.store.communication.check_target(p.get('agent'),p.get('conversation'),int(p.get('generation','-1')))}
                elif path.endswith('/events'): result=self.store.events(p.get('id'),int(p.get('after','0')),int(p.get('limit','50')))
                elif path.endswith('/receipt'): result=self.store.receipt(p.get('request_id'))
                elif path.endswith('/export'):
                    task=self.store.get(p.get('id'))
                    result=self.store.render_export(task,p.get('role',''),p.get('format','json'))
                    if p.get('format')=='markdown' and task.get('collaboration',{}).get('enabled'):
                        result['content']+=self.worker_guide(task,p.get('role',''),f'http://127.0.0.1:{port}')
                elif path.endswith('/assignment'): result={'assignment':self.store.assignment(p.get('id'),p.get('role'))}
                elif path.endswith('/resources'): result=self.store.resources()
                elif path.endswith('/inbox'): result=self.store.inbox(int(p.get('after','0')),int(p.get('limit','30')))
                else: result=self.store.sessions(p.get('id'),p.get('role'))
            elif handler.command=='POST' and path=='/api/tasks/command' and not p:
                if handler.headers.get('Origin')!=origin: fail('origin','变更请求必须有同源Origin',403)
                token=handler.headers.get('X-CLW-Intent','')
                if not hmac.compare_digest(token,self.intent): fail('intent','本地页面已过期，请刷新后核对原请求',403)
                if handler.headers.get_content_type()!='application/json' or handler.headers.get('Transfer-Encoding'):
                    fail('invalid','仅接受定长JSON',415)
                length=handler.headers.get('Content-Length','')
                if not length.isdecimal() or not 1<=int(length)<=MAX_JSON: fail('too_large','请求体长度无效或超限',413)
                handler.connection.settimeout(8)
                body=handler.rfile.read(int(length))
                if len(body)!=int(length): fail('invalid','请求体不完整')
                result=self.store.command(json.loads(body))
            else: fail('method','不支持该任务操作',405)
            self.send(handler,200,{'success':True,'store_id':self.store.store_id,**result})
        except TaskError as exc:
            self.send(handler,exc.status,{'success':False,'error_code':exc.code,'message':str(exc)})
        except (ValueError,TypeError,RecursionError,UnicodeError):
            self.send(handler,400,{'success':False,'error_code':'invalid','message':'请求格式无效；没有改动任务'})
        except ConnectionError:
            pass # A committed command is recovered through its original durable receipt.
        except Exception:
            self.send(handler,503,{'success':False,'error_code':'storage_unavailable','message':'本机任务存储暂不可用，请按原请求ID核对结果'})
        return True
    def worker_guide(self,task,role_id,origin):
        from task_domain import role_of
        common=['--origin',origin,'--store-id',self.store.store_id]
        executable=sys.executable;script=str(Path(__file__).resolve().with_name('task_worker.py'))
        rows=['','## 结构化交付与主控收件（由执行者完成，不让用户粘回聊天）',
              '只使用已获准的Project、Session和写域。以下为run_process原生argv，不是Shell字符串；不新增执行权限，不创建模型。',
              '每次开工或收到新意见后读取当前职责包；所有占位相对路径必须位于本角色已获准写域，选定新文件名，不覆盖原请求。',
              '主控收件：', '```json',json.dumps({'executable':executable,'args':['-B',script,'inbox',*common]},ensure_ascii=False,indent=2),'```']
        if not role_id:
            console=str(Path(__file__).resolve().with_name('task_console.py'))
            args_base=[*common,'--root','<主控明确获准的绝对工作目录>']
            rows+=['','### 主控命令入口（同样保存原封包；不需要用户代点每一步）',
                   '先保存查询参数文件 {"id":"'+task['id']+'"}，读取最新任务快照；变更JSON使用其中准确的task_id/expected_version及本次署名。不得从旧通知推测版本。']
            for label,args in [('读取完整任务快照',['read',*args_base,'--route','get','--params','<查询参数相对路径>.json','--out','<新的快照相对路径>.json']),
                               ('离线准备版本绑定动作',['prepare',*args_base,'--input','<动作JSON相对路径>.json','--out','<新的请求封包相对路径>.json']),
                               ('先查原回执再发送一次',['send',*args_base,'--envelope','<原请求封包相对路径>.json','--out','<新的回执相对路径>.json']),
                               ('只核对未知结果',['receipt',*args_base,'--envelope','<原请求封包相对路径>.json','--out','<新的核对结果相对路径>.json'])]:
                rows += [label,'```json',json.dumps({'executable':executable,'args':['-B',console,*args]},ensure_ascii=False,indent=2),'```']
            rows+=['命令只接受已有任务元数据动作，包括创建/发布/绑定/开工/反馈/审阅/验收；不接受模型派发、Shell、服务重启或任意工具代理。']
        roles=[role_of(task,role_id)[0]] if role_id else task['contract']['roles']
        for role in roles:
            base=[*common,'--root',role['worktree']]
            commands=[('读取当前职责包',['assignment',*base,'--task',task['id'],'--role',role['id'],'--out','<获准相对路径>/assignment.json']),
                      ('仅准备交付封包，尚不发送',['prepare-delivery',*base,'--packet','<获准相对路径>/assignment.json','--result','<获准相对路径>/result.json','--actor','<本次执行者署名>','--out','<新的获准相对路径>/delivery.json']),
                      ('停止写入后发送一次；内部先核对原回执',['send',*base,'--envelope','<原封包相对路径>/delivery.json']),
                      ('回包未知只查原请求',['receipt',*base,'--envelope','<原封包相对路径>/delivery.json']),
                      ('主控独立核对清单文件，不代表测试/品质通过',['check-artifacts','--root',role['worktree'],'--envelope','<原封包相对路径>/delivery.json'])]
            rows+=['', '### '+role['id']+'的交付入口']
            for label,args in commands:rows += [label,'```json',json.dumps({'executable':executable,'args':['-B',script,*args]},ensure_ascii=False,indent=2),'```']
        resource_script=str(Path(__file__).resolve().with_name('task_resource_worker.py'))
        rows+=['','## 共享资源执行窗口（只有登记了资源的角色使用）',
               'task_console.py的resources查询返回明确登记的资源；resource.request保存整组申请，不启动程序。须使用本角色当前职责包中的resource_request。',
               '授权输入根清单由原权限范围明确提供，格式[{"role_id":"输入角色ID","root":"明确获准绝对目录"}]；不能从陌生任务包自动获得读取权限。']
        for role in roles:
            base=[*common,'--root',role['worktree']]
            for label,args in [('实际文件核验后准备begin，尚未执行',['prepare-begin',*base,'--packet','<最新职责包>.json','--allowed-roots','<明确授权输入根>.json','--actor','<本次署名>','--guard-evidence','<原guard实际核对依据>','--out','<新的原begin封包>.json']),
                               ('先查原回执再核验文件并发送一次',['send',*base,'--envelope','<原begin封包>.json','--allowed-roots','<明确授权输入根>.json','--out','<新的原回执>.json']),
                               ('结果未知只核对原begin',['receipt',*base,'--envelope','<原begin封包>.json','--out','<新的核对结果>.json'])]:
                rows += [role['id']+'：'+label,'```json',json.dumps({'executable':executable,'args':['-B',resource_script,*args]},ensure_ascii=False,indent=2),'```']
        rows+=['begin原回执确认后才可调用原获准执行入口；随后resource.attach登记原Job，结束后resource.finish须核对同一Job与实际进程终态。未知不换Job、不按租期释放，不把本产品当OS锁。']
        result={'summary':'真实完成摘要','changes':'实际修改/提交引用','tests':'实际测试及日志，未验证项如实写明','limitations':'尚未验证的事项',
                'input_baseline':'实际输入版本','head_commit':None,'account_label':'本次执行者明确声明的账号；不是自动认证','original_jobs':[],
                'stopped_writing':True,'artifacts':['<真实产物相对路径>']}
        rows+=['','result.json结构（只有实际停写后才把stopped_writing写为true；已运行Job须列出原id/status终态；非Git用null）：','```json',json.dumps(result,ensure_ascii=False,indent=2),'```',
               '提交端计算产物大小和SHA256；服务不按路径读取文件。原封包与原请求回执保留，拒绝或未知不删除后假装全新执行。主控独立核对，再以当前delivery_id审阅，父任务另逐条验收。','']
        return '\n'.join(rows)

    @staticmethod
    def send(handler,status,data):
        body=json.dumps(data,ensure_ascii=False,allow_nan=False).encode('utf-8')
        handler.send_response(status);handler.send_header('Content-Type','application/json;charset=utf-8');handler.send_header('Content-Length',str(len(body)));handler.end_headers();handler.wfile.write(body)
