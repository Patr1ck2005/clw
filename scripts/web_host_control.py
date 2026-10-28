"""Bounded local application control; no browser automation or model replay."""
from __future__ import annotations
import argparse, base64, hashlib, json, math, re, sqlite3, time, uuid, zlib
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

ROOT=Path(__file__).resolve().parents[1]
MAX_RESPONSE=1024*1024
OPERATION_PATTERN=re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}')
INSTANCE_PATTERN=re.compile(r'[A-Za-z0-9_-]{8,128}')
DURABLE_LIMIT=128*1024
TRANSPORT_ERRORS={'app_control_transport_unknown_query_original_operation','app_control_closed'}

class ControlError(RuntimeError):
    def __init__(self,code,accepted=None,original_receipt=None):
        super().__init__(code);self.accepted=accepted;self.original_receipt=original_receipt

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ControlError('app_control_redirect_refused')

def read_json(file,limit=65536):
    file=Path(file)
    if file.stat().st_size>limit:raise ControlError('app_control_file_too_large')
    return json.loads(file.read_text(encoding='utf-8-sig'))

def execution_reference(instance,operation):
    value=bytearray(hashlib.sha256((instance+'\0'+operation).encode('utf8')).digest()[:16])
    value[6]=(value[6]&15)|128;value[8]=(value[8]&63)|128
    return str(uuid.UUID(bytes=bytes(value)))

def stable_json(value,depth=0):
    """Match the control server's stableJSON over JSON.parse input values."""
    if depth>32:raise ControlError('app_control_envelope_invalid')
    if value is None:return 'null'
    if type(value) is bool:return 'true' if value else 'false'
    if isinstance(value,str):
        raw=json.dumps(value,ensure_ascii=False,separators=(',',':'))
        return re.sub('[\ud800-\udfff]',lambda match:'\\u'+format(ord(match[0]),'04x'),raw)
    if type(value) in (int,float):
        try:number=float(value)
        except (ValueError,OverflowError):raise ControlError('app_control_envelope_invalid') from None
        if not math.isfinite(number):raise ControlError('app_control_envelope_invalid')
        if number==0:return '0'
        negative=number<0;raw=repr(abs(number));mantissa,_,exponent=raw.partition('e')
        integer,_,fraction=mantissa.partition('.')
        digits=(integer+fraction).rstrip('0');position=len(integer)+int(exponent or 0)
        # JSON.stringify uses ordinary decimal for [1e-6,1e21), scientific
        # notation outside it, and never writes the redundant .0 suffix.
        if 0<position<=21:
            result=digits+'0'*(position-len(digits)) if position>=len(digits) else digits[:position]+'.'+digits[position:]
        elif -6<position<=0:result='0.'+'0'*(-position)+digits
        else:result=digits[0]+('.'+digits[1:] if len(digits)>1 else '')+'e'+('+' if position-1>=0 else '')+str(position-1)
        return ('-' if negative else '')+result
    if isinstance(value,list):return '['+','.join(stable_json(item,depth+1) for item in value)+']'
    if isinstance(value,dict) and all(isinstance(key,str) for key in value):
        if any(key in ('__proto__','constructor','prototype') for key in value):raise ControlError('app_control_envelope_invalid')
        keys=sorted(value,key=lambda key:key.encode('utf-16-be',errors='surrogatepass'))
        return '{'+','.join(stable_json(key)+':'+stable_json(value[key],depth+1) for key in keys)+'}'
    raise ControlError('app_control_envelope_invalid')

def request_hash(envelope):
    return hashlib.sha256(stable_json(envelope).encode('utf8')).hexdigest()

def durable_json(raw):
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise ValueError('duplicate key')
            result[key]=value
        return result
    def invalid(_):raise ValueError('nonfinite JSON')
    try:
        value=json.loads(raw,object_pairs_hook=pairs,parse_constant=invalid)
        stable_json(value)
        return value
    except (ValueError,UnicodeError,RecursionError,ControlError):
        raise ControlError('app_control_durable_receipt_invalid') from None

class AppControl:
    def __init__(self,profile,expected_root=ROOT,*,allow_offline=False):
        self.profile=Path(profile).resolve()
        self.expected_root=Path(expected_root).resolve()
        self.descriptor=None
        self.opener=build_opener(ProxyHandler({}),NoRedirect())
        try:self.descriptor=read_json(self.profile/'control/app-control.json')
        except FileNotFoundError:
            if allow_offline:return
            raise ControlError('app_control_not_available_in_running_version') from None
        d=self.descriptor
        if not isinstance(d,dict) or any(not isinstance(d.get(key),str) for key in
            ['url','profile','root','app_instance_id','token']):raise ControlError('app_control_descriptor_invalid')
        try:u=urlsplit(d['url']);port=u.port
        except ValueError:raise ControlError('app_control_descriptor_invalid') from None
        if type(d.get('version')) is not int or d['version']!=1 or not Path(d['profile']).is_absolute() or not Path(d['root']).is_absolute() or Path(d['profile']).resolve()!=self.profile or \
           Path(d['root']).resolve()!=Path(expected_root).resolve() or \
           not re.fullmatch(r'http://127\.0\.0\.1:[1-9][0-9]{0,4}',d['url']) or \
           u.scheme!='http' or u.hostname!='127.0.0.1' or not port or u.netloc!='127.0.0.1:'+str(port) or u.path or u.query or u.fragment or u.username is not None or u.password is not None or \
           not re.fullmatch(r'[A-Za-z0-9_-]{8,128}',d.get('app_instance_id','')) or \
           not re.fullmatch(r'[A-Za-z0-9_-]{40,128}',d.get('token','')):
            raise ControlError('app_control_descriptor_invalid')

    def request(self,path,body=None):
        d=self.descriptor
        if d is None:raise ControlError('app_control_not_available_in_running_version')
        raw=None if body is None else json.dumps(body,ensure_ascii=False,allow_nan=False).encode('utf8')
        if raw is not None and len(raw)>65536:raise ControlError('app_control_envelope_too_large')
        req=Request(d['url']+path,data=raw,headers={'Authorization':'Bearer '+d['token'],
            **({'Content-Type':'application/json'} if raw is not None else {})})
        try:
            with self.opener.open(req,timeout=10) as response:
                data=response.read(MAX_RESPONSE+1)
                if len(data)>MAX_RESPONSE:raise ControlError('app_control_response_too_large')
                value=json.loads(data)
        except HTTPError as e:
            try:
                error=json.loads(e.read(8192)).get('error',{});code=error.get('code','app_control_http_error');accepted=error.get('accepted')
                if not isinstance(code,str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',code) or accepted not in (True,False,None):raise ValueError('invalid error')
            except (ValueError,UnicodeError,AttributeError,TypeError,RecursionError):code='app_control_http_error';accepted=None
            raise ControlError(code,accepted) from None
        except (URLError,TimeoutError,OSError):
            raise ControlError('app_control_transport_unknown_query_original_operation') from None
        except (ValueError,UnicodeError,RecursionError):raise ControlError('app_control_response_invalid') from None
        if not isinstance(value,dict):raise ControlError('app_control_response_invalid')
        if value.get('app_instance_id')!=d['app_instance_id']:
            raise ControlError('app_control_owner_changed')
        return value

    def state(self):
        value=self.request('/state').get('state')
        if not isinstance(value,dict) or value.get('app_instance_id')!=self.descriptor['app_instance_id'] or \
            value.get('root')!=self.descriptor['root'] or type(value.get('runtime_generation')) is not int or value['runtime_generation']<0 or \
            'selected' not in value or value['selected'] is not None and not isinstance(value['selected'],str):
            raise ControlError('app_control_state_identity_invalid')
        return value

    def original_receipt(self,receipt,operation_id):
        if not isinstance(receipt,dict) or receipt.get('operation_id')!=operation_id:
            raise ControlError('app_control_original_operation_identity_invalid')
        if receipt.get('state') not in ('accepted','running','completed','rejected','unknown'):
            raise ControlError('app_control_receipt_invalid')
        return receipt

    def durable_operation(self,operation_id,expected_instance,*,envelope=None,expected_execution=None):
        """Read one original durable receipt. Never create or mutate a journal."""
        if not isinstance(expected_instance,str) or not INSTANCE_PATTERN.fullmatch(expected_instance) or \
           not isinstance(operation_id,str) or not OPERATION_PATTERN.fullmatch(operation_id):
            raise ControlError('app_control_original_operation_identity_invalid')
        original_root=self.expected_root
        if envelope is not None:
            identity=envelope.get('expected_identity') if isinstance(envelope,dict) else None
            if not isinstance(identity,dict) or envelope.get('operation_id')!=operation_id or \
               identity.get('app_instance_id')!=expected_instance or \
               not isinstance(identity.get('root'),str) or not Path(identity['root']).is_absolute():
                raise ControlError('app_control_original_operation_identity_invalid')
            original_root=Path(identity['root']).resolve()
            expected_hash=request_hash(envelope)
        file=self.profile/'control/app-control-operations.sqlite'
        if not file.is_file():raise ControlError('app_control_durable_receipt_unavailable')
        db=None
        try:
            db=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True,timeout=1.5)
            db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
            metadata=db.execute("SELECT value FROM metadata WHERE key='identity' AND length(value)<=4096").fetchone()
            identity=db.execute('SELECT root,profile FROM instances WHERE instance_id=?',(expected_instance,)).fetchone()
            row=db.execute('SELECT request_hash,execution_reference,state,length(entry_json) AS entry_bytes,'
                'CASE WHEN length(CAST(entry_json AS BLOB))<=? THEN entry_json END AS entry_json,result_sha256 '
                'FROM operations WHERE instance_id=? AND operation_id=?',(DURABLE_LIMIT,expected_instance,operation_id)).fetchone()
            if metadata is None or identity is None or row is None:
                raise ControlError('app_control_durable_receipt_unavailable')
            owner=durable_json(metadata['value'])
            if not isinstance(owner,dict) or set(owner)!={'version','profile'} or type(owner['version']) is not int or owner['version']!=1 or \
               not isinstance(owner['profile'],str) or not Path(owner['profile']).is_absolute() or Path(owner['profile']).resolve()!=self.profile or \
               not isinstance(identity['profile'],str) or not Path(identity['profile']).is_absolute() or Path(identity['profile']).resolve()!=self.profile or \
               not isinstance(identity['root'],str) or not Path(identity['root']).is_absolute() or Path(identity['root']).resolve()!=original_root:
                raise ControlError('app_control_durable_owner_mismatch')
            if not isinstance(row['entry_json'],str):raise ControlError('app_control_durable_receipt_invalid')
            entry=durable_json(row['entry_json'])
            required={'operation_id','app_instance_id','action','execution_reference','state','accepted_at','updated_at','request_hash'}
            optional={'result_observed','error'}
            if not isinstance(entry,dict) or not required<=set(entry) or not set(entry)<=required|optional or \
               entry['operation_id']!=operation_id or entry['app_instance_id']!=expected_instance or \
               not isinstance(entry['action'],str) or not re.fullmatch('[a-z][a-z0-9-]{0,63}',entry['action']) or \
               entry['state'] not in ('accepted','running','completed','rejected','unknown') or row['state']!=entry['state'] or \
               not isinstance(row['request_hash'],str) or not re.fullmatch('[a-f0-9]{64}',row['request_hash']) or \
               entry['request_hash']!=row['request_hash'] or row['execution_reference']!=entry['execution_reference'] or \
               entry['execution_reference']!=execution_reference(expected_instance,operation_id):
                raise ControlError('app_control_durable_receipt_invalid')
            for key in ('accepted_at','updated_at'):
                if not isinstance(entry[key],str):raise ControlError('app_control_durable_receipt_invalid')
                try:
                    parsed=datetime.fromisoformat(entry[key].replace('Z','+00:00'))
                    if parsed.tzinfo is None:raise ValueError('unbound time')
                except ValueError:raise ControlError('app_control_durable_receipt_invalid') from None
            if expected_execution is not None and entry['execution_reference']!=expected_execution:
                raise ControlError('app_control_durable_receipt_mismatch')
            if envelope is not None and (entry['action']!=envelope.get('action') or row['request_hash']!=expected_hash):
                raise ControlError('app_control_durable_request_mismatch')
            if 'error' in entry:
                error=entry['error']
                if not isinstance(error,dict) or set(error)!={'code','accepted'} or type(error['accepted']) is not bool or \
                   not isinstance(error['code'],str) or not re.fullmatch('[A-Za-z0-9_.:-]{1,128}',error['code']):
                    raise ControlError('app_control_durable_receipt_invalid')
            result_hash=row['result_sha256']
            if result_hash is not None:
                if not isinstance(result_hash,str) or not re.fullmatch('[a-f0-9]{64}',result_hash):
                    raise ControlError('app_control_durable_result_invalid')
                result=db.execute('SELECT codec,CASE WHEN length(data)<=? THEN data END AS data FROM results WHERE sha256=?',
                                  (DURABLE_LIMIT,result_hash)).fetchone()
                if result is None or not isinstance(result['data'],bytes) or result['codec'] not in ('json','deflate'):
                    raise ControlError('app_control_durable_result_invalid')
                raw=result['data']
                if result['codec']=='deflate':
                    try:
                        decoder=zlib.decompressobj(-zlib.MAX_WBITS);raw=decoder.decompress(raw,DURABLE_LIMIT+1)
                        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:raise ValueError('incomplete deflate')
                    except (ValueError,zlib.error):raise ControlError('app_control_durable_result_invalid') from None
                if len(raw)>DURABLE_LIMIT or hashlib.sha256(raw).hexdigest()!=result_hash:
                    raise ControlError('app_control_durable_result_invalid')
                entry['result']=durable_json(raw)
            if 'result_observed' in entry and (entry['result_observed'] is not True or result_hash is None):
                raise ControlError('app_control_durable_receipt_invalid')
            del entry['request_hash']
            return entry
        except (sqlite3.Error,OSError,ValueError,TypeError,OverflowError,UnicodeError) as error:
            raise ControlError('app_control_durable_receipt_unavailable') from None
        finally:
            if db is not None:db.close()

    def operation(self,operation_id,expected_instance,*,envelope=None,expected_execution=None):
        if not isinstance(expected_instance,str) or not INSTANCE_PATTERN.fullmatch(expected_instance) or \
           not isinstance(operation_id,str) or not OPERATION_PATTERN.fullmatch(operation_id):
            raise ControlError('app_control_original_operation_identity_invalid')
        if self.descriptor is None:return self.durable_operation(operation_id,expected_instance,
            envelope=envelope,expected_execution=expected_execution)
        path='/operations/'+operation_id
        try:
            if expected_instance==self.descriptor['app_instance_id']:
                return self.original_receipt(self.request(path),operation_id)
            value=self.request(path+'?'+urlencode({'original_instance_id':expected_instance}))
        except ControlError as error:
            if str(error) not in TRANSPORT_ERRORS:raise
            try:return self.durable_operation(operation_id,expected_instance,
                envelope=envelope,expected_execution=expected_execution)
            except ControlError as original:
                if str(original)=='app_control_durable_receipt_unavailable':raise error
                raise
        identity=value.get('original_identity')
        if not isinstance(identity,dict) or identity.get('app_instance_id')!=expected_instance or \
           not isinstance(identity.get('profile'),str) or not Path(identity['profile']).is_absolute() or \
           Path(identity['profile']).resolve()!=self.profile or \
           not isinstance(identity.get('root'),str) or not Path(identity['root']).is_absolute():
            raise ControlError('app_control_original_operation_identity_invalid')
        receipt=self.original_receipt(value.get('operation'),operation_id)
        if receipt.get('app_instance_id')!=expected_instance:
            raise ControlError('app_control_original_operation_identity_invalid')
        return receipt

    def command(self,envelope,wait_seconds=20):
        if not isinstance(envelope,dict) or not isinstance(envelope.get('expected_identity'),dict) or \
           not isinstance(envelope.get('operation_id'),str) or not OPERATION_PATTERN.fullmatch(envelope['operation_id']):
            raise ControlError('app_control_envelope_invalid')
        if not isinstance(wait_seconds,(int,float)) or not 0<=wait_seconds<=30:raise ControlError('app_control_wait_invalid')
        if self.descriptor is None:raise ControlError('app_control_not_available_in_running_version')
        if envelope['expected_identity'].get('app_instance_id')!=self.descriptor['app_instance_id']:
            raise ControlError('app_control_owner_changed')
        acknowledged=False;original_execution=None
        try:
            receipt=self.request('/commands',envelope)
            acknowledged=True
            self.original_receipt(receipt,envelope['operation_id'])
            original_execution=receipt.get('execution_reference')
            end=time.monotonic()+wait_seconds
            while receipt.get('state') in ('accepted','running') and time.monotonic()<end:
                time.sleep(.1)
                receipt=self.operation(envelope['operation_id'],self.descriptor['app_instance_id'],
                    envelope=envelope,expected_execution=original_execution)
            return receipt
        except ControlError as error:
            if str(error) in TRANSPORT_ERRORS:
                try:return self.durable_operation(envelope['operation_id'],self.descriptor['app_instance_id'],
                    envelope=envelope,expected_execution=original_execution)
                except ControlError as original:
                    if str(original)!='app_control_durable_receipt_unavailable':error=original
            return {'operation_id':envelope['operation_id'],'app_instance_id':self.descriptor['app_instance_id'],
                'state':'rejected' if error.accepted is False and not acknowledged else 'unknown','error':str(error),'replayed':False}

    def ui_command(self,action,payload=None,wait_seconds=20):
        state=self.state()
        identity={k:state[k] for k in ['app_instance_id','root','runtime_generation','selected']}
        if action=='reload-page-adapter':
            adapter=state.get('page_adapter')
            if not isinstance(adapter,dict) or not isinstance(adapter.get('sha256'),str) or \
               not re.fullmatch(r'[a-f0-9]{64}',adapter['sha256']) or \
               type(adapter.get('revision')) is not int or adapter['revision']<1:
                raise ControlError('page_adapter_not_available_in_running_version')
            identity['page_adapter']={'sha256':adapter['sha256'],'revision':adapter['revision']}
        return self.command({'operation_id':uuid.uuid4().hex,'action':action,
            'payload':payload or {},'expected_identity':identity},wait_seconds)

    def read_record(self,payload,expected_identity,*,max_bytes=32*1024*1024):
        """Read one original record revision in bounded, byte-exact chunks."""
        if not isinstance(payload,dict) or not isinstance(expected_identity,dict) or \
           type(max_bytes) is not int or max_bytes<1:
            raise ControlError('record_chunk_request_invalid')
        parts=[];offset=0;digest=None;length=None
        while True:
            request={**payload,'byte_offset':offset,'byte_limit':64*1024,
                     **({'expected_sha256':digest} if digest else {})}
            receipt=self.command({'operation_id':'read-'+uuid.uuid4().hex,'action':'record-body',
                'payload':request,'expected_identity':expected_identity})
            if receipt.get('state')!='completed':
                raise ControlError('record_chunk_original_operation_'+str(receipt.get('state')),original_receipt=receipt)
            result=receipt.get('result',{})
            if result.get('encoding')!='json-utf8-base64' or \
               not re.fullmatch(r'[a-f0-9]{64}',result.get('sha256','')) or \
               type(result.get('byte_length')) is not int or not 0<=result['byte_length']<=max_bytes or \
               result.get('byte_offset')!=offset or type(result.get('next_offset')) is not int or \
               type(result.get('complete')) is not bool:
                raise ControlError('record_chunk_response_invalid')
            if digest is None:digest=result['sha256'];length=result['byte_length']
            if result['sha256']!=digest or result['byte_length']!=length:
                raise ControlError('record_chunk_revision_changed')
            try:chunk=base64.b64decode(result.get('data',''),validate=True)
            except (ValueError,TypeError):raise ControlError('record_chunk_response_invalid') from None
            if len(chunk)>64*1024 or result['next_offset']!=offset+len(chunk) or \
               result['next_offset']>length or result['complete']!=(result['next_offset']==length) or \
               not result['complete'] and not chunk:
                raise ControlError('record_chunk_response_invalid')
            parts.append(chunk);offset=result['next_offset']
            if result['complete']:break
        raw=b''.join(parts)
        if hashlib.sha256(raw).hexdigest()!=digest:raise ControlError('record_chunk_digest_mismatch')
        try:return json.loads(raw.decode('utf8'))
        except (ValueError,UnicodeError):raise ControlError('record_chunk_body_invalid') from None

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile',type=Path,default=ROOT/'.local/web-host')
    p.add_argument('--expected-root',type=Path,default=ROOT)
    sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('state');sub.add_parser('capabilities')
    op=sub.add_parser('operation');op.add_argument('operation_id');op.add_argument('--expected-instance',required=True)
    op.add_argument('--request-file',type=Path,help='Original envelope binding when reading the durable receipt after its endpoint exits')
    cmd=sub.add_parser('command');cmd.add_argument('--request-file',type=Path,required=True);cmd.add_argument('--wait-seconds',type=float,default=20)
    for name in ['inspect-ui','capture-shell','reload-shell','show']:
        sub.add_parser(name)
    adapter=sub.add_parser('reload-page-adapter')
    adapter.add_argument('--expected-page-dom-sha256',required=True)
    view=sub.add_parser('view');view.add_argument('view',choices=['records','web','goal','settings','navigation-open','navigation-close','web-workflow','codex-workflow','local-workflow'])
    args=p.parse_args()
    try:
        client=AppControl(args.profile,expected_root=args.expected_root,allow_offline=args.command=='operation')
        if args.command=='state':result=client.request('/state')
        elif args.command=='capabilities':result=client.request('/capabilities')
        elif args.command=='operation':
            result=client.operation(args.operation_id,args.expected_instance,
                envelope=read_json(args.request_file) if args.request_file else None)
        elif args.command=='command':
            if not 0<=args.wait_seconds<=30:raise ControlError('app_control_wait_invalid')
            result=client.command(read_json(args.request_file),args.wait_seconds)
        elif args.command=='view':result=client.ui_command('ui-view',{'view':args.view})
        elif args.command=='reload-page-adapter':
            if not re.fullmatch(r'[a-f0-9]{64}',args.expected_page_dom_sha256):raise ControlError('page_adapter_digest_invalid')
            result=client.ui_command(args.command,{'expected_page_dom_sha256':args.expected_page_dom_sha256})
        else:result=client.ui_command(args.command)
        print(json.dumps(result,ensure_ascii=False))
        return 0 if result.get('state') not in ('rejected','unknown') else 2
    except (ControlError,OSError,ValueError,RecursionError) as e:
        print(json.dumps({'error':str(e),'replayed':False},ensure_ascii=False));return 2

if __name__=='__main__':raise SystemExit(main())
