"""Bounded private pipe owned by the dedicated desktop app, not a network API."""
import json,re,sys,threading,uuid
from pathlib import Path
from harness_state import HarnessError,require,stamp

def unexpected_diagnostic(service,key,op,p,error,slot):
    """One daemon writer; its storage can never hold the original pipe reply."""
    if not slot.acquire(blocking=False):return None
    try:
        identifier=uuid.uuid4().hex
        payload=p if isinstance(p,dict) else {}
        identity={}
        for name,pattern in {
            'page_id':r'web-[0-9a-f-]{36}',
            'thread_id':r'hthr_[0-9a-f]{32}',
            'request_id':r'[0-9a-f-]{36}',
        }.items():
            value=payload.get(name)
            if isinstance(value,str) and re.fullmatch(pattern,value):identity[name]=value
        path=Path(service.state.path).parent/'managed-pipe-error.json'
        frames=[];cursor=error.__traceback__
        # Avoid extract_tb/linecache: reading source files is diagnostic I/O too.
        for _ in range(128):
            if cursor is None:break
            code=cursor.tb_frame.f_code
            frames.append({'file':Path(code.co_filename).name[:160],'function':code.co_name[:100],'line':cursor.tb_lineno})
            cursor=cursor.tb_next
        value={'version':1,'diagnostic_id':identifier,'at':stamp(),
            'instance_id':service.instance,'store_id':service.state.id,
            'frame_id':key if isinstance(key,str) and re.fullmatch(r'[0-9a-f-]{36}',key) else None,
            'op':op if isinstance(op,str) and re.fullmatch(r'[a-z][a-z0-9-]{0,63}',op) else None,
            'identity':identity,'exception_type':type(error).__name__[:80],'frames':frames[-12:]}
        def save():
            try:
                from product_runtime import atomic_json
                atomic_json(path,value)
            except Exception:pass
            finally:slot.release()
        threading.Thread(target=save,name='clw-managed-error-diagnostic',daemon=True).start()
        return identifier
    except Exception:
        slot.release()
        return None

def start_pipe(service,server):
    diagnostic_slot=threading.Lock()
    def run():
        for raw in iter(lambda:sys.stdin.buffer.readline(12*1024*1024+1),b''):
            key=None;op=None;p=None
            try:
                require(len(raw)<=12*1024*1024 and raw.endswith(b'\n'),'managed_pipe_frame')
                data=json.loads(raw);key=data['id'];require(isinstance(key,str) and len(key)<=100,'managed_pipe_id')
                op,p=data['op'],data.get('payload',{})
                if op=='shutdown':
                    service.host_bridge.managed.browser('pause-all',{})
                    server.shutdown();break
                if op=='maintenance-shutdown':
                    from maintenance_exit_readiness import authorize_shutdown
                    result=authorize_shutdown(service,p)
                    print('CLW_MANAGED '+json.dumps({'id':key,'ok':True,'result':result},ensure_ascii=True),flush=True)
                    server.shutdown();return
                if op=='maintenance-readiness':
                    from maintenance_exit_readiness import readiness
                    result=readiness(service,p)
                elif op=='receipt':result=service.receipt(p['operation_id'])
                elif op=='start':
                    append=bool(p.get('expected_request_id'))
                    with service.state.connect() as db:
                        page=db.execute('SELECT * FROM managed_pages WHERE page_id=?',(p['page_id'],)).fetchone()
                        require(page and page['phase']=='bound' and (append or not service.host_bridge.managed.paused(db,page)),'managed_page_not_ready',409)
                        if not append:
                            from harness_managed_budget import ready_to_start
                            ready_to_start(db,page)
                    body={'text':p['objective']}
                    if append:body['expected_request_id']=p['expected_request_id']
                    result=service.command({'request_id':p['operation_id'],'thread_id':page['thread_id'],'action':'message.append' if append else 'message.send','data':body})
                else:result=service.host_bridge.managed.browser(op,p)
                reply={'id':key,'ok':True,'result':result}
            except (HarnessError,ValueError,KeyError,TypeError,OSError) as e:
                reply={'id':key,'ok':False,'code':getattr(e,'code','managed_invalid_operation')}
                if op in ('maintenance-readiness','maintenance-shutdown') and getattr(e,'blockers',None):
                    reply['blockers']=e.blockers
            except Exception as e:
                reply={'id':key,'ok':False,'code':'managed_operation_unknown_reconcile'}
                diagnostic=unexpected_diagnostic(service,key,op,p,e,diagnostic_slot)
                if diagnostic:reply.update(diagnostic_id=diagnostic,diagnostic_state='pending')
            print('CLW_MANAGED '+json.dumps(reply,ensure_ascii=True),flush=True)
        server.shutdown()
    thread=threading.Thread(target=run,name='clw-managed-private-pipe',daemon=True);thread.start()
    print('CLW_MANAGED_READY '+json.dumps({'protocol':'clw.managed-browser.v1','store_id':service.state.id,'instance_id':service.instance,**({'origin':service.listener_origin} if getattr(service,'listener_origin',None) else {})}),flush=True)
