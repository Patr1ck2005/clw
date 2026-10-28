import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssetClient,hashBytes,importedContract,availableKeys,phaseLabel,stateLabel,MAX_UPLOAD} from '../apps/control-center/asset-client.mjs';
function harness(){
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const h={map,storage,posts:[],receipts:new Map(),store:'local-store',lose:false,deny:0,hold:null};
 h.file=(text='pixel bytes')=>({name:'test.png',size:text.length,arrayBuffer:async()=>new TextEncoder().encode(text).buffer});
 h.fetcher=async(url,opts={})=>{
  let body,status=200;
  if(url.includes('info?'))body={success:true,store_id:h.store,intent:'intent'};
  else if(url.includes('receipt?')){const id=new URLSearchParams(url.split('?')[1]).get('request_id');body={success:true,store_id:h.store,found:h.receipts.has(id),receipt:h.receipts.get(id)};}
  else if(opts.method==='POST'){
   const raw=url.endsWith('upload')?JSON.parse(decodeURIComponent(opts.headers['X-CLW-Metadata'])):JSON.parse(opts.body);h.posts.push({url,raw});if(h.hold)await h.hold;
   if(h.deny){status=h.deny;body={success:false,message:'controlled denial'};}
   else{body={success:true,store_id:h.store,request_id:raw.request_id,batch:{id:raw.batch_id,version:2},candidate_id:'candidate-one'};h.receipts.set(raw.request_id,body);if(h.lose)throw Error('lost response');}
  }else throw Error('unexpected request');
  return {ok:status===200,status,text:async()=>JSON.stringify(body),json:async()=>body};
 };
 h.make=()=>createAssetClient({storage,fetcher:h.fetcher});return h;
}
const identity={batch_id:'batch-A',expected_version:1,attempt_id:'attempt-A',spec_hash:'frozen-A',actor:'tester'};
test('init and reload never POST',async()=>{const h=harness();await h.make().init();assert.equal(h.posts.length,0);});
test('upload contains actual byte hash and only small pending metadata',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));assert.equal(h.posts[0].raw.source_sha256,await hashBytes(await h.file().arrayBuffer()));assert.ok(![...h.map.values()].join('').includes('pixel bytes'));});
test('lost upload response recovers same durable receipt after reload',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));const n=h.make();const r=await n.recoverUpload();assert.equal(r.candidate_id,'candidate-one');assert.equal(n.pending().upload,null);assert.equal(h.posts.length,1);});
test('pending upload blocks metadata and new file writes',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));await assert.rejects(c.command('reserve',{},identity));await assert.rejects(c.upload(h.file('other'),identity));assert.equal(h.posts.length,1);});
test('retry requires identical file and original metadata',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));h.lose=false;await assert.rejects(c.retryUpload(h.file('different')));await c.retryUpload(h.file());assert.deepEqual(h.posts[0].raw,h.posts[1].raw);});
test('cross-store recovery refuses original clear and retry',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));h.store='other';await assert.rejects(c.recoverUpload());await assert.rejects(c.retryUpload(h.file()));assert.ok(c.pending().upload);assert.equal(h.posts.length,1);});
test('incorrect receipt identity does not clear pending',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));const p=c.pending().upload.command;h.receipts.set(p.request_id,{store_id:h.store,request_id:'wrong'});await assert.rejects(c.recoverUpload());assert.ok(c.pending().upload);});
test('403 preserves unresolved upload',async()=>{const h=harness(),c=h.make();h.deny=403;await assert.rejects(c.upload(h.file(),identity));assert.ok(c.pending().upload);});
test('definite first denial clears upload but later replay denial does not',async()=>{const h=harness(),c=h.make();h.deny=409;await assert.rejects(c.upload(h.file(),identity));assert.equal(c.pending().upload,null);h.deny=0;h.lose=true;await assert.rejects(c.upload(h.file(),identity));h.deny=409;await assert.rejects(c.retryUpload(h.file()));assert.ok(c.pending().upload);});
test('missing receipt is not automatic resend',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.upload(h.file(),identity));h.receipts.clear();assert.equal(await c.recoverUpload(),null);assert.equal(h.posts.length,1);});
test('tab storage failure happens before POST',async()=>{const h=harness(),c=h.make();h.storage.setItem=()=>{throw Error('storage denied');};await assert.rejects(c.upload(h.file(),identity));assert.equal(h.posts.length,0);assert.equal(c.busy(),false);});
test('oversize file refused before reading bytes',async()=>{const h=harness(),c=h.make();await assert.rejects(c.upload({size:MAX_UPLOAD+1,arrayBuffer(){throw Error('must not read');}},identity));assert.equal(h.posts.length,0);});
test('in-flight upload excludes other calls and releases lock',async()=>{const h=harness(),c=h.make();let release;h.hold=new Promise(r=>release=r);const p=c.upload(h.file(),identity);await new Promise(r=>setTimeout(r,20));await assert.rejects(c.command('reserve',{},identity));await assert.rejects(c.upload(h.file(),identity));release();await p;assert.equal(c.busy(),false);});
test('pending metadata blocks file upload',async()=>{const h=harness(),c=h.make();h.lose=true;await assert.rejects(c.command('reserve',{},identity));await assert.rejects(c.upload(h.file(),identity));assert.equal(h.posts.length,1);});
test('import only extracts contract not approvals or execution',()=>{const c={title:'x',items:[{key:'a'}]};const r=importedContract({contract:c,selected:{a:'approved'},attempts:[{state:'completed'}]});assert.equal(r.selected,undefined);assert.equal(r.attempts,undefined);assert.notEqual(r.items,c.items);});
test('oversize imported list refused',()=>assert.throws(()=>importedContract({items:Array(33).fill({key:'x'})})));
test('available list excludes active and approved',()=>{const b={contract:{items:[{key:'a'},{key:'b'},{key:'c'}]},attempts:[{asset_key:'a',state:'outcome_unknown'}],selected:{b:'chosen'}};assert.deepEqual(availableKeys(b),['c']);});
test('labels distinguish reserved from sent and unknown',()=>{assert.notEqual(stateLabel('reserved'),stateLabel('completed'));assert.equal(phaseLabel('reconcile'),'需核对原结果');});
