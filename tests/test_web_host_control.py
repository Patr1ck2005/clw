"""Local CLI contracts against disposable loopback HTTP fixtures, never an app."""
from contextlib import closing,contextmanager,redirect_stdout
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
import base64,hashlib,io,json,os,socket,sqlite3,sys,tempfile,threading,unittest,zlib

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import web_host_control as control


class WebHostControlTests(unittest.TestCase):
    def test_adapter_reload_pins_loaded_revision_and_requested_source_without_second_post(self):
        state={'app_instance_id':self.instance,'root':str(self.root),'runtime_generation':7,'selected':'original-page',
               'page_adapter':{'sha256':'a'*64,'revision':3}}
        client=self.client()
        with patch.object(client,'state',return_value=state),patch.object(client,'command',return_value={'state':'unknown'}) as command:
            result=client.ui_command('reload-page-adapter',{'expected_page_dom_sha256':'b'*64},wait_seconds=0)
        self.assertEqual(result['state'],'unknown');self.assertEqual(command.call_count,1)
        envelope=command.call_args.args[0]
        self.assertEqual(envelope['expected_identity']['page_adapter'],state['page_adapter'])
        self.assertEqual(envelope['payload'],{'expected_page_dom_sha256':'b'*64})
    def test_old_instance_without_adapter_contract_is_not_given_a_reload_command(self):
        state={'app_instance_id':self.instance,'root':str(self.root),'runtime_generation':7,'selected':None}
        client=self.client()
        for adapter in (None,{}, {'sha256':123,'revision':1}, {'sha256':'a'*64,'revision':True}, {'sha256':'a'*64,'revision':0}):
            with self.subTest(adapter=adapter),patch.object(client,'state',return_value={**state,'page_adapter':adapter}),patch.object(client,'command') as command:
                with self.assertRaisesRegex(control.ControlError,'page_adapter_not_available_in_running_version'):
                    client.ui_command('reload-page-adapter',{'expected_page_dom_sha256':'b'*64})
            command.assert_not_called()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        self.profile=self.root/'.local/web-host';(self.profile/'control').mkdir(parents=True)
        self.instance='original-app-instance-0001';self.operation_id='original-operation-0001'
        self.descriptor={'version':1,'root':str(self.root),'profile':str(self.profile),
            'url':'http://127.0.0.1:8123','app_instance_id':self.instance,'token':'fixture_token_'+'x'*40}
        self.write_descriptor(self.descriptor)
    def tearDown(self):self.tmp.cleanup()
    def write_descriptor(self,value):
        (self.profile/'control/app-control.json').write_text(json.dumps(value),encoding='utf-8')
    def client(self):return control.AppControl(self.profile,expected_root=self.root)
    def envelope(self,operation_id=None):
        return {'operation_id':operation_id or self.operation_id,'action':'inspect-ui','payload':{},
            'expected_identity':{'app_instance_id':self.instance,'root':str(self.root),'runtime_generation':7,'selected':'original-page'}}
    def receipt(self,state='completed',**overrides):
        return {'operation_id':self.operation_id,'app_instance_id':self.instance,'state':state,**overrides}
    @contextmanager
    def server(self,responses):
        requests=[];queue=list(responses)
        class Handler(BaseHTTPRequestHandler):
            def handle_request(self):
                body=self.rfile.read(int(self.headers.get('Content-Length','0')))
                requests.append({'method':self.command,'path':self.path,'body':body,'authorization':self.headers.get('Authorization')})
                item=queue.pop(0) if queue else {'status':503,'value':{'error':{'code':'fixture_queue_exhausted','accepted':False}}}
                if item.get('disconnect'):
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();self.close_connection=True;return
                raw=item.get('raw')
                if raw is None:raw=json.dumps(item.get('value',{})).encode('utf-8')
                self.send_response(item.get('status',200));self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw)))
                for key,value in item.get('headers',{}).items():self.send_header(key,value)
                self.end_headers()
                try:self.wfile.write(raw)
                except (BrokenPipeError,ConnectionResetError):pass
            do_GET=handle_request;do_POST=handle_request
            def log_message(self,*_):pass
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=.01),daemon=True);thread.start()
        self.write_descriptor({**self.descriptor,'url':'http://127.0.0.1:'+str(server.server_port)})
        try:yield requests,control.AppControl(self.profile,expected_root=self.descriptor['root'])
        finally:server.shutdown();server.server_close();thread.join(timeout=1)
    def test_descriptor_is_bounded_and_bound_to_exact_root_profile_instance_and_token(self):
        self.assertEqual(self.client().descriptor['app_instance_id'],self.instance)
        for patch_value in ({'root':str(self.root/'foreign')},{'profile':str(self.root/'foreign')},
                            {'root':None},{'profile':[]},{'app_instance_id':'short'},
                            {'token':'short'},{'version':2}):
            with self.subTest(patch_value=patch_value):
                self.write_descriptor({**self.descriptor,**patch_value})
                with self.assertRaisesRegex(control.ControlError,'descriptor_invalid'):self.client()
        for value in (None,[],['descriptor'],42):
            with self.subTest(value=value):
                self.write_descriptor(value)
                with self.assertRaisesRegex(control.ControlError,'descriptor_invalid'):self.client()
        (self.profile/'control/app-control.json').write_bytes(b' '*65537)
        with self.assertRaisesRegex(control.ControlError,'file_too_large'):self.client()
        (self.profile/'control/app-control.json').unlink()
        with self.assertRaisesRegex(control.ControlError,'not_available_in_running_version'):self.client()
    def test_descriptor_refuses_remote_alias_credentials_redirect_paths_and_control_characters(self):
        urls=['http://localhost:8123','https://127.0.0.1:8123','http://127.0.0.2:8123',
              'http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:bad',
              'http://127.0.0.1:8123/','http://127.0.0.1:8123?forward=1','http://127.0.0.1:8123#fragment',
              'http://user:password@127.0.0.1:8123','http://:password@127.0.0.1:8123',
              'http://@127.0.0.1:8123','http://127.0.0.1:8123\r\n']
        for url in urls:
            with self.subTest(url=url):
                self.write_descriptor({**self.descriptor,'url':url})
                with self.assertRaisesRegex(control.ControlError,'descriptor_invalid'):self.client()
    def test_ambient_proxy_configuration_cannot_capture_local_control(self):
        proxy={key:'http://127.0.0.1:1' for key in ('HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy')}
        proxy.update(NO_PROXY='',no_proxy='')
        with patch.dict(os.environ,proxy),self.server([{'value':{'app_instance_id':self.instance,'state':{'app_instance_id':self.instance,'root':str(self.root),'runtime_generation':7,'selected':None}}}]) as (requests,client):
            self.assertEqual(client.state()['root'],str(self.root))
        self.assertEqual([(r['method'],r['path']) for r in requests],[('GET','/state')])
        self.assertEqual(requests[0]['authorization'],'Bearer '+self.descriptor['token'])
    def test_redirect_is_not_followed_with_authentication_or_command_body(self):
        with self.server([{'status':307,'headers':{'Location':'/redirected'},'value':{}}]) as (requests,client):
            result=client.command(self.envelope(),wait_seconds=0)
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['error'],'app_control_redirect_refused')
        self.assertEqual([(r['method'],r['path']) for r in requests],[('POST','/commands')]);self.assertFalse(result['replayed'])
    def test_lost_post_response_keeps_original_operation_unknown_and_never_posts_it_again(self):
        with self.server([{'disconnect':True},{'value':self.receipt()}]) as (requests,client):
            result=client.command(self.envelope(),wait_seconds=1)
            self.assertEqual(result['state'],'unknown');self.assertEqual(result['operation_id'],self.operation_id)
            self.assertEqual(result['app_instance_id'],self.instance);self.assertFalse(result['replayed'])
            recovered=client.operation(self.operation_id,self.instance)
        self.assertEqual(recovered['state'],'completed')
        self.assertEqual([(r['method'],r['path']) for r in requests],[('POST','/commands'),('GET','/operations/'+self.operation_id)])
        self.assertEqual(json.loads(requests[0]['body']),self.envelope())
    def test_after_202_a_rejected_original_query_is_unknown_rather_than_unaccepted(self):
        responses=[{'status':202,'value':self.receipt('accepted')},
                   {'status':404,'value':{'error':{'code':'app_control_operation_missing','accepted':False}}}]
        with self.server(responses) as (requests,client):result=client.command(self.envelope(),wait_seconds=1)
        self.assertEqual(result,{'operation_id':self.operation_id,'app_instance_id':self.instance,'state':'unknown',
            'error':'app_control_operation_missing','replayed':False})
        self.assertEqual([r['method'] for r in requests],['POST','GET'])
    def test_pre_acceptance_rejection_and_unverified_failure_have_distinct_receipts(self):
        for accepted,state in ((False,'rejected'),(True,'unknown'),(None,'unknown')):
            with self.subTest(accepted=accepted),self.server([{'status':409,'value':{'error':{'code':'original_request_refused','accepted':accepted}}}]) as (requests,client):
                result=client.command(self.envelope(),wait_seconds=1)
                self.assertEqual(result['state'],state);self.assertEqual(result['operation_id'],self.operation_id)
                self.assertFalse(result['replayed']);self.assertEqual(len(requests),1)
    def test_original_operation_and_instance_are_checked_on_submit_and_each_query(self):
        with self.server([{'value':self.receipt(operation_id='foreign-operation-0001')},
                          {'value':self.receipt(operation_id='foreign-operation-0001')},
                          {'value':self.receipt(app_instance_id='foreign-app-instance-0001')}]) as (requests,client):
            result=client.command(self.envelope(),wait_seconds=0)
            self.assertEqual(result['state'],'unknown');self.assertEqual(result['operation_id'],self.operation_id)
            self.assertEqual(result['error'],'app_control_original_operation_identity_invalid')
            with self.assertRaisesRegex(control.ControlError,'original_operation_identity_invalid'):client.operation(self.operation_id,self.instance)
            with self.assertRaisesRegex(control.ControlError,'owner_changed'):client.operation(self.operation_id,self.instance)
            for operation,instance in ((self.operation_id,'foreign'),('../outside',self.instance)):
                with self.subTest(operation=operation,instance=instance),self.assertRaisesRegex(control.ControlError,'original_operation_identity_invalid'):
                    client.operation(operation,instance)
        self.assertEqual(len(requests),3)
    def test_running_receipts_poll_only_the_original_id_and_end_at_the_original_completion(self):
        with self.server([{'status':202,'value':self.receipt('accepted')},{'value':self.receipt('running')},{'value':self.receipt()}]) as (requests,client):
            result=client.command(self.envelope(),wait_seconds=1)
        self.assertEqual(result,self.receipt());self.assertEqual([r['method'] for r in requests],['POST','GET','GET'])
        self.assertEqual([r['path'] for r in requests[1:]],['/operations/'+self.operation_id]*2)

    def test_new_owner_reads_previous_instance_receipt_without_resubmitting(self):
        old='previous-app-instance-0001'
        original=self.receipt('unknown',app_instance_id=old,execution_reference='original-execution-reference')
        wrapped={'version':1,'app_instance_id':self.instance,'original_identity':{
            'app_instance_id':old,'root':str(self.root/'previous-install-root'),'profile':str(self.profile)},'operation':original}
        with self.server([{'value':wrapped}]) as (requests,client):
            self.assertEqual(client.operation(self.operation_id,old),original)
            with self.assertRaisesRegex(control.ControlError,'app_control_owner_changed'):
                client.command({**self.envelope(),'expected_identity':{**self.envelope()['expected_identity'],'app_instance_id':old}},0)
        self.assertEqual([(r['method'],r['path']) for r in requests],
            [('GET','/operations/'+self.operation_id+'?original_instance_id='+old)])

    def test_previous_instance_query_checks_original_profile_and_receipt_identity(self):
        old='previous-app-instance-0001'
        base={'version':1,'app_instance_id':self.instance,'original_identity':{
            'app_instance_id':old,'root':str(self.root),'profile':str(self.profile)},
            'operation':self.receipt(app_instance_id=old)}
        values=[{**base,'original_identity':{**base['original_identity'],'profile':str(self.root/'foreign')}},
                {**base,'original_identity':{**base['original_identity'],'app_instance_id':self.instance}},
                {**base,'operation':self.receipt()},
                {**base,'operation':self.receipt(app_instance_id=old,operation_id='foreign-operation-0001')}]
        with self.server([{'value':value} for value in values]) as (requests,client):
            for _ in values:
                with self.assertRaisesRegex(control.ControlError,'original_operation_identity_invalid'):
                    client.operation(self.operation_id,old)
        self.assertEqual(len(requests),4);self.assertTrue(all(row['method']=='GET' for row in requests))
    def test_invalid_or_excessive_post_response_is_bounded_and_retains_unknown_original_identity(self):
        for raw in (b'{unfinished',b'[]',b'['*1500+b'0'+b']'*1500,b' '* (control.MAX_RESPONSE+1)):
            with self.subTest(bytes=len(raw)),self.server([{'status':202,'raw':raw}]) as (requests,client):
                result=client.command(self.envelope(),wait_seconds=0)
                self.assertEqual(result['state'],'unknown');self.assertEqual(result['operation_id'],self.operation_id)
                self.assertEqual(result['app_instance_id'],self.instance);self.assertFalse(result['replayed'])
                self.assertIn(result['error'],('app_control_response_invalid','app_control_response_too_large'))
                self.assertEqual(len(requests),1)
    def test_response_byte_limit_reads_only_the_bound_and_large_envelopes_never_reach_http(self):
        class Response(io.BytesIO):
            def read(self,size=-1):self.requested=size;return super().read(size)
        client=self.client();response=Response(b' '*(control.MAX_RESPONSE+10))
        with patch.object(client.opener,'open',return_value=response) as opened:
            with self.assertRaisesRegex(control.ControlError,'response_too_large'):client.request('/state')
        self.assertTrue(response.closed);self.assertEqual(opened.call_count,1);self.assertEqual(response.requested,control.MAX_RESPONSE+1)
        with patch.object(client.opener,'open',side_effect=AssertionError('No envelope should be transmitted')) as opened:
            with self.assertRaisesRegex(control.ControlError,'envelope_too_large'):client.request('/commands',{'payload':'x'*65537})
        self.assertEqual(opened.call_count,0)
    def test_foreign_nested_state_or_unbounded_wait_cannot_create_a_command(self):
        with self.server([{'value':{'app_instance_id':self.instance,'state':{'app_instance_id':self.instance,'root':'foreign-root'}}}]) as (requests,client):
            with self.assertRaisesRegex(control.ControlError,'state_identity_invalid'):client.state()
            for wait in (-1,31,float('nan'),float('inf'),'forever'):
                with self.subTest(wait=wait),self.assertRaisesRegex(control.ControlError,'wait_invalid'):client.command(self.envelope(),wait)
        self.assertEqual(len(requests),1)
    def test_incomplete_original_state_cannot_escape_as_keyerror_or_post_a_ui_command(self):
        with self.server([{'value':{'app_instance_id':self.instance,'state':{'app_instance_id':self.instance,'root':str(self.root)}}}]) as (requests,client):
            with self.assertRaisesRegex(control.ControlError,'state_identity_invalid'):client.ui_command('inspect-ui')
        self.assertEqual([(r['method'],r['path']) for r in requests],[('GET','/state')])
    def test_cli_operation_refuses_foreign_receipt_and_exits_with_bounded_json(self):
        self.descriptor['root']=str(control.ROOT)
        with (self.server([{'value':self.receipt(operation_id='foreign-operation-0001')}]) as (requests,_),
              redirect_stdout(io.StringIO()) as out,
              patch.object(sys,'argv',['web_host_control.py','--profile',str(self.profile),'operation',self.operation_id,'--expected-instance',self.instance])):
            status=control.main()
        self.assertEqual(status,2);self.assertEqual(json.loads(out.getvalue()),{'error':'app_control_original_operation_identity_invalid','replayed':False})
        self.assertEqual([(r['method'],r['path']) for r in requests],[('GET','/operations/'+self.operation_id)])

    def test_long_record_reads_one_exact_revision_and_validates_utf8_digest(self):
        original={'row':{'text':'中文 $\\alpha$\n```python\nprint(1)\n```\n'*18000}}
        raw=json.dumps(original,ensure_ascii=False).encode('utf8');digest=hashlib.sha256(raw).hexdigest()
        client=self.client();requests=[]
        def command(envelope,wait_seconds=20):
            requests.append(envelope);payload=envelope['payload'];offset=payload['byte_offset'];chunk=raw[offset:offset+payload['byte_limit']]
            if offset:self.assertEqual(payload['expected_sha256'],digest)
            return {'state':'completed','result':{'encoding':'json-utf8-base64','sha256':digest,
                'byte_length':len(raw),'byte_offset':offset,'next_offset':offset+len(chunk),
                'complete':offset+len(chunk)==len(raw),'data':base64.b64encode(chunk).decode('ascii')}}
        with patch.object(client,'command',side_effect=command):
            self.assertEqual(client.read_record({'mode':'codex','task_key':'original'},self.envelope()['expected_identity']),original)
        self.assertGreater(len(requests),4);self.assertEqual(len({row['operation_id'] for row in requests}),len(requests))
        self.assertTrue(all(row['action']=='record-body' for row in requests))

    def test_record_reader_does_not_retry_unknown_and_rejects_a_false_completion_or_digest(self):
        client=self.client();identity=self.envelope()['expected_identity']
        original={'state':'unknown','operation_id':'original-chunk-0001'}
        with patch.object(client,'command',return_value=original) as request:
            with self.assertRaisesRegex(control.ControlError,'original_operation_unknown') as failure:client.read_record({},identity)
            self.assertEqual(failure.exception.original_receipt,original)
            self.assertEqual(request.call_count,1)
        chunk={'encoding':'json-utf8-base64','sha256':'a'*64,'byte_length':2,'byte_offset':0,
            'next_offset':2,'complete':True,'data':base64.b64encode(b'{}').decode('ascii')}
        with patch.object(client,'command',return_value={'state':'completed','result':chunk}):
            with self.assertRaisesRegex(control.ControlError,'digest_mismatch'):client.read_record({},identity)
        with patch.object(client,'command',return_value={'state':'completed','result':{**chunk,'complete':False}}):
            with self.assertRaisesRegex(control.ControlError,'response_invalid'):client.read_record({},identity)

    def journal(self,state='completed',result=None,*,instance=None,root=None,codec='json',envelope=None):
        """Disposable source-compatible SQLite journal; never a live Host DB."""
        instance=instance or self.instance;root=root or self.root;envelope=envelope or self.envelope()
        file=self.profile/'control/app-control-operations.sqlite'
        value={'ok':True} if result is None else result
        raw=json.dumps(value,ensure_ascii=False,separators=(',',':')).encode('utf8')
        digest=hashlib.sha256(raw).hexdigest()
        data=raw
        if codec=='deflate':
            compressor=zlib.compressobj(wbits=-zlib.MAX_WBITS);data=compressor.compress(raw)+compressor.flush()
        entry={'operation_id':self.operation_id,'app_instance_id':instance,'action':envelope['action'],
            'execution_reference':control.execution_reference(instance,self.operation_id),'state':state,
            'accepted_at':'2026-10-06T18:35:12.017Z','updated_at':'2026-10-06T18:35:12.039Z',
            'request_hash':control.request_hash(envelope),'result_observed':True}
        if state=='unknown':entry['error']={'code':'original_execution_unresolved','accepted':True}
        with closing(sqlite3.connect(file)) as db,db:
            db.executescript('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);'
                'CREATE TABLE IF NOT EXISTS instances(instance_id TEXT PRIMARY KEY,root TEXT NOT NULL,profile TEXT NOT NULL,migrated INTEGER NOT NULL);'
                'CREATE TABLE IF NOT EXISTS results(sha256 TEXT PRIMARY KEY,codec TEXT NOT NULL,data BLOB NOT NULL);'
                'CREATE TABLE IF NOT EXISTS operations(instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,'
                'execution_reference TEXT NOT NULL,state TEXT NOT NULL,entry_json TEXT NOT NULL,result_sha256 TEXT,'
                'PRIMARY KEY(instance_id,operation_id));')
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',('identity',json.dumps({'version':1,'profile':str(self.profile)})))
            db.execute('INSERT OR REPLACE INTO instances VALUES(?,?,?,1)',(instance,str(root),str(self.profile)))
            db.execute('INSERT OR REPLACE INTO results VALUES(?,?,?)',(digest,codec,data))
            db.execute('INSERT OR REPLACE INTO operations VALUES(?,?,?,?,?,?,?)',
                (instance,self.operation_id,entry['request_hash'],entry['execution_reference'],state,json.dumps(entry),digest))
        return {key:value for key,value in {**entry,'result':value}.items() if key!='request_hash'}

    def mutate_journal(self,sql,parameters=()):
        with closing(sqlite3.connect(self.profile/'control/app-control-operations.sqlite')) as db,db:db.execute(sql,parameters)

    def test_post_disconnect_recovers_committed_original_without_another_post(self):
        expected=self.journal()
        with self.server([{'disconnect':True}]) as (requests,client):
            self.assertEqual(client.command(self.envelope(),wait_seconds=1),expected)
        self.assertEqual([r['method'] for r in requests],['POST'])

    def test_accepted_then_get_disconnect_recovers_completed_original(self):
        expected=self.journal();accepted={**expected,'state':'accepted'}
        with self.server([{'status':202,'value':accepted},{'disconnect':True}]) as (requests,client):
            self.assertEqual(client.command(self.envelope(),wait_seconds=1),expected)
        self.assertEqual([r['method'] for r in requests],['POST','GET'])

    def test_closed_endpoint_reads_only_original_receipt_and_preserves_unknown(self):
        expected=self.journal('unknown',{'original_result':7})
        with self.server([{'disconnect':True}]) as (requests,client):
            self.assertEqual(client.command(self.envelope(),wait_seconds=0),expected)
        self.assertEqual(expected['state'],'unknown');self.assertTrue(expected['result_observed'])
        self.assertEqual([r['method'] for r in requests],['POST'])

    def test_pending_durable_state_is_not_promoted_to_completed(self):
        for state in ('accepted','running'):
            with self.subTest(state=state):
                expected=self.journal(state)
                with self.server([{'disconnect':True}]) as (requests,client):
                    self.assertEqual(client.command(self.envelope(),wait_seconds=0)['state'],state)
                self.assertEqual(len(requests),1)

    def test_authoritative_auth_rejection_and_redirect_do_not_use_a_stale_completion(self):
        self.journal()
        for response in ({'status':401,'value':{'error':{'code':'app_control_unauthorized','accepted':False}}},
                         {'status':307,'headers':{'Location':'/outside'},'value':{}}):
            with self.subTest(response=response),self.server([response]) as (requests,client),\
                 patch.object(client,'durable_operation',side_effect=AssertionError('no policy fallback')):
                receipt=client.command(self.envelope(),wait_seconds=1)
            self.assertNotEqual(receipt['state'],'completed');self.assertEqual(len(requests),1)

    def test_foreign_live_http_owner_cannot_be_hidden_by_an_old_journal(self):
        self.journal()
        with self.server([{'value':self.receipt(app_instance_id='foreign-app-instance-0001')}]) as (requests,client),\
             patch.object(client,'durable_operation',side_effect=AssertionError('no owner fallback')):
            result=client.command(self.envelope(),0)
        self.assertEqual(result['error'],'app_control_owner_changed');self.assertEqual(len(requests),1)

    def test_missing_descriptor_allows_only_original_read_not_a_new_command(self):
        expected=self.journal();(self.profile/'control/app-control.json').unlink()
        client=control.AppControl(self.profile,expected_root=self.root,allow_offline=True)
        self.assertEqual(client.operation(self.operation_id,self.instance,envelope=self.envelope()),expected)
        with self.assertRaisesRegex(control.ControlError,'not_available'):client.command(self.envelope(),0)
        with self.assertRaisesRegex(control.ControlError,'not_available'):client.state()

    def test_cli_reads_original_request_after_descriptor_disappears(self):
        expected=self.journal();(self.profile/'control/app-control.json').unlink()
        request=self.root/'original-envelope.json';request.write_text(json.dumps(self.envelope()),encoding='utf8')
        argv=['web_host_control.py','--profile',str(self.profile),'--expected-root',str(self.root),
            'operation',self.operation_id,'--expected-instance',self.instance,'--request-file',str(request)]
        with redirect_stdout(io.StringIO()) as out,patch.object(sys,'argv',argv):status=control.main()
        self.assertEqual(status,0);self.assertEqual(json.loads(out.getvalue()),expected)

    def test_previous_installation_requires_its_explicit_original_envelope_root(self):
        old='previous-app-instance-0001';old_root=self.root/'old-version'
        envelope={**self.envelope(),'expected_identity':{**self.envelope()['expected_identity'],'app_instance_id':old,'root':str(old_root)}}
        expected=self.journal(instance=old,root=old_root,envelope=envelope)
        client=self.client()
        with self.assertRaisesRegex(control.ControlError,'durable_owner_mismatch'):
            client.durable_operation(self.operation_id,old)
        self.assertEqual(client.durable_operation(self.operation_id,old,envelope=envelope),expected)

    def test_same_key_from_new_instance_does_not_replace_original_unknown(self):
        original=self.journal('unknown')
        new='new-app-instance-0001';new_envelope={**self.envelope(),'expected_identity':{
            **self.envelope()['expected_identity'],'app_instance_id':new}}
        self.journal(instance=new,envelope=new_envelope)
        client=self.client()
        self.assertEqual(client.durable_operation(self.operation_id,self.instance,envelope=self.envelope()),original)
        with self.assertRaisesRegex(control.ControlError,'durable_receipt_unavailable'):
            client.durable_operation(self.operation_id,'missing-app-instance-0001')

    def test_exact_request_hash_action_and_accepted_reference_are_checked(self):
        expected=self.journal();changed={**self.envelope(),'payload':{'changed':True}}
        client=self.client()
        with self.assertRaisesRegex(control.ControlError,'durable_request_mismatch'):
            client.durable_operation(self.operation_id,self.instance,envelope=changed)
        with self.assertRaisesRegex(control.ControlError,'durable_request_mismatch'):
            client.durable_operation(self.operation_id,self.instance,envelope={**self.envelope(),'action':'quit'})
        accepted={**expected,'state':'accepted','execution_reference':'wrong-original-reference'}
        with self.server([{'status':202,'value':accepted},{'disconnect':True}]) as (requests,client):
            result=client.command(self.envelope(),1)
        self.assertEqual(result['state'],'unknown');self.assertEqual(result['error'],'app_control_durable_receipt_mismatch')
        self.assertEqual([r['method'] for r in requests],['POST','GET'])

    def test_metadata_profile_or_instance_root_mismatch_refuses_recovery(self):
        self.journal();client=self.client()
        self.mutate_journal("UPDATE metadata SET value=? WHERE key='identity'",
                            (json.dumps({'version':1,'profile':str(self.root/'foreign')}),))
        with self.assertRaisesRegex(control.ControlError,'durable_owner_mismatch'):client.durable_operation(self.operation_id,self.instance)
        self.journal();self.mutate_journal('UPDATE instances SET root=?',(str(self.root/'foreign'),))
        with self.assertRaisesRegex(control.ControlError,'durable_owner_mismatch'):client.durable_operation(self.operation_id,self.instance)

    def test_typed_receipt_rejects_column_drift_bad_reference_and_duplicate_json(self):
        client=self.client()
        for sql,args in [('UPDATE operations SET state=?',('unknown',)),
                         ('UPDATE operations SET execution_reference=?',('00000000-0000-0000-0000-000000000000',)),
                         ('UPDATE operations SET request_hash=?',('b'*64,)),
                         ('UPDATE operations SET entry_json=?',('{"state":"completed","state":"unknown"}',))]:
            self.journal();self.mutate_journal(sql,args)
            with self.subTest(sql=sql),self.assertRaisesRegex(control.ControlError,'durable_receipt_invalid'):
                client.durable_operation(self.operation_id,self.instance)

    def test_bad_result_hash_unknown_codec_and_truncated_data_are_rejected(self):
        client=self.client()
        for sql,args in [('UPDATE results SET data=?',(b'{"wrong":true}',)),
                         ('UPDATE results SET codec=?',('gzip',)),
                         ('UPDATE operations SET result_sha256=?',('a'*64,))]:
            self.journal();self.mutate_journal(sql,args)
            with self.subTest(sql=sql),self.assertRaisesRegex(control.ControlError,'durable_result_invalid'):
                client.durable_operation(self.operation_id,self.instance)

    def test_raw_deflate_formula_result_is_checksum_verified_and_decoded(self):
        original={'value':'中文 𝄞 $\\alpha$\n'*5000}
        expected=self.journal(result=original,codec='deflate')
        self.assertEqual(self.client().durable_operation(self.operation_id,self.instance,envelope=self.envelope()),expected)

    def test_deflate_bomb_truncation_and_trailing_garbage_stay_bounded(self):
        client=self.client()
        compressor=zlib.compressobj(wbits=-zlib.MAX_WBITS);bomb=compressor.compress(b'"'+b'x'*300000+b'"')+compressor.flush()
        for data in (bomb,bomb[:-1],bomb+b'junk'):
            self.journal(codec='deflate');self.mutate_journal('UPDATE results SET data=?',(data,))
            with self.assertRaisesRegex(control.ControlError,'durable_result_invalid'):
                client.durable_operation(self.operation_id,self.instance)

    def test_read_only_missing_operation_creates_no_database_or_directory(self):
        client=self.client();before={p.relative_to(self.profile):p.read_bytes() for p in self.profile.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(control.ControlError,'durable_receipt_unavailable'):
            client.durable_operation(self.operation_id,self.instance)
        self.assertEqual(before,{p.relative_to(self.profile):p.read_bytes() for p in self.profile.rglob('*') if p.is_file()})
        self.journal();file=self.profile/'control/app-control-operations.sqlite';original=file.read_bytes()
        with self.assertRaisesRegex(control.ControlError,'durable_receipt_unavailable'):
            client.durable_operation('missing-original-operation-0001',self.instance)
        self.assertEqual(file.read_bytes(),original)

    def test_live_WAL_commit_is_visible_to_read_only_receipt_recovery(self):
        expected=self.journal();file=self.profile/'control/app-control-operations.sqlite'
        with closing(sqlite3.connect(file)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            row=writer.execute('SELECT entry_json FROM operations').fetchone()
            entry=json.loads(row[0]);entry['updated_at']='2026-10-06T18:35:12.041Z'
            writer.execute('UPDATE operations SET entry_json=?',(json.dumps(entry),));writer.commit()
            expected['updated_at']=entry['updated_at']
            self.assertTrue(Path(str(file)+'-wal').exists())
            with self.server([{'disconnect':True}]) as (requests,client):
                self.assertEqual(client.command(self.envelope(),0),expected)
            self.assertEqual([r['method'] for r in requests],['POST'])

    def test_original_unknown_without_observed_result_remains_unknown(self):
        expected=self.journal('unknown');expected.pop('result');expected.pop('result_observed')
        with closing(sqlite3.connect(self.profile/'control/app-control-operations.sqlite')) as db,db:
            entry=json.loads(db.execute('SELECT entry_json FROM operations').fetchone()[0]);entry.pop('result_observed')
            db.execute('UPDATE operations SET entry_json=?,result_sha256=NULL',(json.dumps(entry),))
        self.assertEqual(self.client().durable_operation(self.operation_id,self.instance,envelope=self.envelope()),expected)

    def test_durable_typed_error_observation_and_metadata_size_are_checked(self):
        client=self.client()
        for patch_value in ({'result_observed':False},{'error':{'code':'original','accepted':1}},
                            {'error':{'code':'bad\ncode','accepted':True}}, {'accepted_at':7},
                            {'updated_at':'not-an-original-time'}, {'extra':'x'* (control.DURABLE_LIMIT+1)}):
            self.journal()
            with closing(sqlite3.connect(self.profile/'control/app-control-operations.sqlite')) as db,db:
                entry=json.loads(db.execute('SELECT entry_json FROM operations').fetchone()[0]);entry.update(patch_value)
                db.execute('UPDATE operations SET entry_json=?',(json.dumps(entry),))
            with self.subTest(patch_value=list(patch_value)),self.assertRaisesRegex(control.ControlError,'durable_receipt_invalid'):
                client.durable_operation(self.operation_id,self.instance)

    def test_stable_request_json_matches_control_server_number_and_UTF16_key_contract(self):
        vectors=[(0,'0'),(-0.0,'0'),(1.0,'1'),(1e-7,'1e-7'),(1e-6,'0.000001'),(1e20,'100000000000000000000'),
                 (1e21,'1e+21'),(9007199254740993,'9007199254740992'),({'\uffff':2,'😀':1},'{"😀":1,"\uffff":2}')]
        for value,expected in vectors:
            with self.subTest(value=value):self.assertEqual(control.stable_json(value),expected)
        self.assertEqual(control.execution_reference('5a4ae37e5d0847feadc329f3a50c92ac',
            'candidate17-7527a03aa4c049f8aede21443969ec0d'),'90d5a414-27c6-8d4c-921b-2f76e12810ff')


if __name__=='__main__':unittest.main()
