"""Thin native-Web provider: exact existing Host, durable messages, public replies.
No browser automation, token issuance, model fallback, or second task executor.
"""
from __future__ import annotations
from contextlib import closing
from pathlib import Path
import hashlib,json,re,threading,time
from communication_bridge import CommunicationBridge
from harness_state import HarnessError,require,public,canonical,stamp
from task_domain import TaskError

BUSY={'working','stopping','unknown','web_waiting','web_processing'}
ID_PATTERNS={'agent_id':r'wc_dagent_[A-Za-z0-9_-]{16}', 'conversation_id':r'wc_conv_[A-Za-z0-9_-]{16}'}

class NativeWeb:
    def __init__(self,state,root,transport=None,targets=None,bridge=None):
        self.state,self.root=state,Path(root).resolve()
        self.bridge=bridge or CommunicationBridge(transport,enabled=False)
        self.lock=threading.RLock();self.last_poll={};self.denied=False;self.closed=False;self.transport_loader=None
        self.access={'status':'not_checked','sending_enabled':False,'history_mirror':False}
        raw=targets
        if raw is None:
            path=self.root/'config/harness-web-targets.json'
            raw=json.loads(path.read_text(encoding='utf-8')) if path.is_file() and path.stat().st_size<=16384 else {'schema_version':1,'targets':[]}
        require(isinstance(raw,dict) and raw.get('schema_version')==1,'web_targets_invalid')
        rows=raw.get('targets',[]);require(isinstance(rows,list) and len(rows)<=16,'web_targets_invalid')
        self.targets={}
        for item in rows:
            require(isinstance(item,dict) and isinstance(item.get('id'),str) and re.fullmatch(r'[a-z0-9_-]{1,64}',item['id']),'web_target_invalid')
            require(item['id'] not in self.targets,'web_target_duplicate')
            for field,pattern in ID_PATTERNS.items():require(isinstance(item.get(field),str) and re.fullmatch(pattern,item[field]),'web_target_invalid')
            require(type(item.get('controller_generation')) is int and item['controller_generation']>=1,'web_target_invalid')
            require(isinstance(item.get('title'),str) and 0<len(item['title'])<=160,'web_target_invalid')
            require(isinstance(item.get('project'),str) and isinstance(item.get('session_id'),str),'web_target_invalid')
            self.targets[item['id']]=dict(item)
        with closing(state.connect()) as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS web_bindings(thread_id TEXT PRIMARY KEY,target_id TEXT NOT NULL,route TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS web_outbox(request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text TEXT NOT NULL,native_request TEXT NOT NULL,phase TEXT NOT NULL,receipt TEXT,delivery_state TEXT);
            CREATE TABLE IF NOT EXISTS web_seen(thread_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(thread_id,message_id));''')
            db.execute("UPDATE web_outbox SET phase='unknown' WHERE phase='dispatching'")
            saved=db.execute("SELECT value FROM metadata WHERE key='web_access'").fetchone();db.commit()
        prior=json.loads(saved['value']) if saved else raw.get('prior_access_observation',{})
        if prior.get('namespace')==self.bridge.namespace and prior.get('status')=='blocked':
            self.access=prior;self.denied=True
    def _save_access(self,value):
        self.access=public({**value,'namespace':self.bridge.namespace,'observed_at':stamp(),'sending_enabled':False,'history_mirror':False})
        with closing(self.state.connect()) as db:
            db.execute("INSERT OR REPLACE INTO metadata VALUES('web_access',?)",(canonical(self.access),));db.commit()
        return self.snapshot()
    def snapshot(self):
        return {**self.access,'targets':[{'id':t['id'],'title':t['title']} for t in self.targets.values()],
                'automatic_fork':False,'native_stop':False,'credential_changed':False,
                'required_send_scopes':['communication:read','communication:manage'],
                'read_probe_is_not_send_authorization':True}
    def probe(self,authorization_changed=False):
        require(not self.denied or authorization_changed is True,'web_authorization_change_required',403)
        candidate=self.bridge
        if authorization_changed and self.transport_loader:
            candidate=CommunicationBridge(self.transport_loader(),enabled=False)
        try:
            candidate.check_runtime()
            observed=[]
            for t in self.targets.values():
                r=candidate.check_target(t['agent_id'],t['conversation_id'],t['controller_generation'])
                observed.append({'id':t['id'],'host_available':r['native_host_available']})
            if candidate.namespace!=self.bridge.namespace:
                with closing(self.state.connect()) as db:
                    unresolved=db.execute("SELECT 1 FROM web_outbox WHERE phase NOT IN ('completed','blocked','rejected')").fetchone()
                require(unresolved is None,'web_connection_changed_with_unresolved_request',409)
            self.bridge=candidate;self.denied=False
            return self._save_access({'status':'read_authorized','observed_targets':observed})
        except TaskError as exc:
            self.denied=self.denied or getattr(exc,'native_http_status',None) in (401,403)
            return self._save_access({'status':'blocked','code':exc.code,'http_status':getattr(exc,'native_http_status',None),'required_scopes':getattr(exc,'required_scopes',[])})
    def _route(self,key):
        with closing(self.state.connect()) as db:r=db.execute('SELECT * FROM web_bindings WHERE thread_id=?',(key,)).fetchone()
        require(r is not None,'web_binding_missing',409);route=json.loads(r['route'])
        require(route['namespace']==self.bridge.namespace,'web_connection_changed_reauthorize_binding',409)
        return dict(r),route
    def attach(self,target_id,confirm):
        require(confirm is True,'web_explicit_binding_confirmation_required',403)
        require(target_id in self.targets,'web_target_not_configured',403)
        require(not self.denied,'web_authorization_change_required',403)
        t=self.targets[target_id];route=self.bridge.check_target(t['agent_id'],t['conversation_id'],t['controller_generation'])
        native=t['conversation_id']+'/'+t['agent_id']
        with self.lock:
            row=self.state.by_native(native)
            if row:
                require(row['provider']=='native_web','web_native_identity_collision',409)
                with closing(self.state.connect()) as db:active=db.execute("SELECT 1 FROM web_outbox WHERE thread_id=? AND phase NOT IN ('completed','blocked','rejected')",(row['id'],)).fetchone()
                require(active is None,'web_original_request_unresolved',409)
            else:row=self.state.bind(native,t['title'],self.root,provider='native_web')
            with closing(self.state.connect()) as db:
                db.execute('INSERT INTO web_bindings(thread_id,target_id,route,cursor) VALUES(?,?,?,0) ON CONFLICT(thread_id) DO UPDATE SET route=excluded.route',(row['id'],target_id,canonical(route)));db.commit()
            self.state.event(row['id'],'web_bound',{'agent_id':t['agent_id'],'conversation_id':t['conversation_id'],'generation':t['controller_generation'],'host_available':route['native_host_available'],'history_mirror':False})
        return {'thread':row,'host_available':route['native_host_available'],'send_scope_verified':False}
    def request(self,request_id):
        with closing(self.state.connect()) as db:r=db.execute('SELECT * FROM web_outbox WHERE request_id=?',(request_id,)).fetchone()
        require(r is not None,'web_request_not_found',404);binding,route=self._route(r['thread_id'])
        require(r['receipt'] is not None,'web_delivery_not_confirmed',409)
        original=json.loads(json.loads(r['native_request'])['body'])
        return {'format':'clw.web.request.v1','request_id':r['request_id'],'store_id':self.state.id,'thread_id':r['thread_id'],
                'text':r['text'],'phase':r['phase'],'project':original['project'],'session_id':original['session_id'],
                'agent_id':route['agent_id'],'conversation_id':route['conversation_id'],'native_receipt':json.loads(r['receipt']),
                'guide':'docs/harness/WEB_RECEIVER.md','source':'operator_request_from_local_harness_not_a_new_permission_grant'}
    def send(self,key,text,request_id):
        require(isinstance(text,str) and 0<len(text.strip())<=24000,'invalid_message')
        require(not self.denied,'web_authorization_change_required',403)
        with self.lock:
            row=self.state.thread(key);require(row['provider']=='native_web','web_wrong_provider')
            require(row['status'] not in BUSY,'web_original_request_unresolved',409)
            binding,route=self._route(key);t=self.targets[binding['target_id']]
            # Read-only preflight must complete before the native POST boundary.
            self.bridge.check_target(route['agent_id'],route['conversation_id'],route['controller_generation'])
            payload={'format':'clw.web.request-notice.v1','request_id':request_id,'store_id':self.state.id,'thread_id':key,
                'agent_id':route['agent_id'],'project':t['project'],'session_id':t['session_id'],
                'guide':'docs/harness/WEB_RECEIVER.md',
                'read':{'script':'scripts/harness_web_client.py','operation':'receive','request_id':request_id,'store_id':self.state.id},
                'instruction':'Read authoritative full request through the local harness after normal project authorization. Preserve original Jobs and user stop. Publish public reply to this same Conversation as the exact Agent with reply_to set to the original Message. Do not use another model or claim Delivery consumed means work complete. No hidden reasoning or tokens in public replies.'}
            native={'conversation_id':route['conversation_id'],'body':canonical(payload),'recipient_agent_ids':[route['agent_id']],
                    'idempotency_key':'clw-web-'+hashlib.sha256(request_id.encode()).hexdigest()}
            require(len(native['body'].encode())<=4096,'web_native_message_too_large')
            with closing(self.state.connect()) as db:
                active=db.execute("SELECT 1 FROM web_outbox WHERE phase NOT IN ('completed','blocked','rejected')").fetchone()
                require(active is None,'web_original_request_unresolved',409)
                db.execute('INSERT INTO web_outbox VALUES(?,?,?,?,?,NULL,NULL)',(request_id,key,text,canonical(native),'dispatching'))
                db.execute("UPDATE threads SET status='web_waiting',updated_at=? WHERE id=?",(stamp(),key))
                db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',(key,'user_message',canonical(public({'text':text,'operation_id':request_id,'provider':'native_web'})),stamp()));db.commit()
            self.state.operation(request_id,'dispatching')
            self.bridge.enabled=True
            try:
                receipt=self.bridge.post({'route':route,'native_request':native})
            except TaskError as exc:
                known=getattr(exc,'notification_post_not_attempted',False) or getattr(exc,'native_http_status',None) in (401,403)
                phase='rejected' if known else 'unknown'
                with closing(self.state.connect()) as db:db.execute('UPDATE web_outbox SET phase=? WHERE request_id=?',(phase,request_id));db.commit()
                self.state.update(key,status='error' if known else 'unknown')
                if getattr(exc,'native_http_status',None) in (401,403):
                    self.denied=True;self._save_access({'status':'blocked','code':exc.code,'http_status':exc.native_http_status,'required_scopes':getattr(exc,'required_scopes',[])})
                err=HarnessError(exc.code,409 if known else 503);err.unknown=not known;raise err
            with closing(self.state.connect()) as db:
                db.execute("UPDATE web_outbox SET phase='sent',receipt=?,delivery_state=? WHERE request_id=?",(canonical(receipt),receipt['delivery_state'],request_id));db.commit()
            self.state.event(key,'web_delivery',{'request_id':request_id,**receipt,'completion_claim':False})
            return {'thread_id':key,'request_id':request_id,'native_receipt':receipt,'state':'message_posted_not_completed'}
    def sync(self,key,force=False):
        with self.lock:
            require(not self.denied,'web_authorization_change_required',403)
            binding,route=self._route(key)
            if not force and time.monotonic()-self.last_poll.get(key,-100)<2:return {'thread':self.state.thread(key),'throttled':True}
            self.last_poll[key]=time.monotonic()
            try:
                self.bridge.check_runtime()
                page=self.bridge.call('read_conversation',{'conversation_id':route['conversation_id'],'after_seq':binding['cursor'],'limit':50})
            except TaskError as exc:
                if getattr(exc,'native_http_status',None) in (401,403):
                    self.denied=True;self._save_access({'status':'blocked','code':exc.code,'http_status':exc.native_http_status,'required_scopes':getattr(exc,'required_scopes',[])})
                raise
            require(page.get('conversation',{}).get('conversation_id')==route['conversation_id'],'web_conversation_mismatch',502)
            messages=page.get('messages');require(isinstance(messages,list) and len(messages)<=50,'web_invalid_page',502)
            require(not self.closed,'web_observer_closed',409)
            cursor=binding['cursor'];updates=0
            with closing(self.state.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                require(not self.closed,'web_observer_closed',409)
                for m in messages:
                    require(isinstance(m,dict) and type(m.get('seq')) is int and m['seq']>cursor and m.get('conversation_id')==route['conversation_id'],'web_invalid_message_order',502)
                    cursor=m['seq'];mid=m.get('message_id');require(isinstance(mid,str) and re.fullmatch(r'wc_cmsg_[A-Za-z0-9_-]{16}',mid),'web_invalid_message_identity',502)
                    if db.execute('SELECT 1 FROM web_seen WHERE thread_id=? AND message_id=?',(key,mid)).fetchone():continue
                    db.execute('INSERT INTO web_seen VALUES(?,?)',(key,mid))
                    if m.get('author',{}).get('agent_id')!=route['agent_id'] or m.get('author',{}).get('participant_kind')!='agent':continue
                    try:body=json.loads(m.get('body',''))
                    except (ValueError,TypeError):continue
                    if not isinstance(body,dict) or body.get('format')!='clw.web.reply.v1' or body.get('store_id')!=self.state.id:continue
                    req=body.get('request_id')
                    if not isinstance(req,str):continue
                    out=db.execute('SELECT * FROM web_outbox WHERE request_id=? AND thread_id=?',(req,key)).fetchone()
                    if not out or not out['receipt'] or out['phase'] in ('completed','blocked','rejected','unknown'):continue
                    receipt=json.loads(out['receipt'])
                    if m.get('reply_to')!=receipt['message_id']:continue
                    status=body.get('status');text=body.get('text')
                    if status not in ('progress','completed','blocked') or not isinstance(text,str) or not 0<len(text)<=12000:continue
                    event={'item_id':mid,'text':text,'request_id':req,'provider':'native_web','native_message_id':mid,'reply_status':status,'source':'native_agent_public_reply_not_hidden_history'}
                    db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',(key,'assistant_message',canonical(public(event)),stamp()));updates+=1
                    if status!='progress':
                        db.execute('UPDATE web_outbox SET phase=? WHERE request_id=?',(status,req))
                        db.execute('UPDATE threads SET status=?,updated_at=? WHERE id=?',('idle' if status=='completed' else 'error',stamp(),key))
                        db.execute('INSERT INTO events(thread_id,kind,data,at) VALUES(?,?,?,?)',(key,'web_result',canonical({'request_id':req,'status':status,'source':'agent_report_not_independent_acceptance'}),stamp()))
                    else:db.execute("UPDATE threads SET status='web_processing',updated_at=? WHERE id=?",(stamp(),key))
                db.execute('UPDATE web_bindings SET cursor=? WHERE thread_id=?',(cursor,key));db.commit()
            return {'thread':self.state.thread(key),'imported_replies':updates,'native_cursor':cursor,'has_more':page.get('next_after_seq') is not None,'delivery_is_not_completion':True}
    def pending(self):
        with closing(self.state.connect()) as db:rows=db.execute("SELECT DISTINCT thread_id FROM web_outbox WHERE phase IN ('sent','processing')").fetchall()
        return [r['thread_id'] for r in rows]
