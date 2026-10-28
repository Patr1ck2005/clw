import test from 'node:test';
import assert from 'node:assert/strict';
import {createJournalClient} from '../apps/control-center/journal-client.mjs';
const base='./api/usage/';
function harness(){
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const h={map,storage,calls:[],receipt:null,store:'store-A',lose:false,deny:false,block:null};
 h.fetcher=async(url,options)=>{h.calls.push({url,options});let body,status=200;
  if(url.includes('info?'))body={success:true,store_id:h.store,intent:'local-page-intent'};
  else if(url.includes('receipt?')){if(h.block)await h.block;body={success:true,store_id:h.store,found:!!h.receipt,receipt:h.receipt};}
  else{const command=JSON.parse(options.body);if(h.deny){status=h.denyStatus||403;body={success:false,message:'denied'};}else{h.receipt={request_id:command.request_id,store_id:h.store,effect:'metadata'};if(h.lose)throw Error('lost');body={success:true,...h.receipt};}}
  return {ok:status===200,status,text:async()=>JSON.stringify(body)};
 };
 h.client=()=>createJournalClient(base,{fetcher:h.fetcher,storage,newId:()=>crypto.randomUUID()});return h;
}
test('constructor refuses arbitrary API prefix',()=>assert.throws(()=>createJournalClient('https://outside.invalid',{storage:{}})));
test('initialization never POSTs',async()=>{const h=harness();await h.client().init();assert.equal(h.calls.filter(x=>x.options.method==='POST').length,0);});
test('successful exact receipt clears pending',async()=>{const h=harness(),c=h.client();await c.command('record',{}, {actor:'M'});assert.equal(c.pending(),null);});
test('lost response retains original ID',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));assert.equal(c.pending().command.request_id,h.receipt.request_id);});
test('reload recovery reads receipt without POST',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));const n=h.client();await n.recover();assert.equal(n.pending(),null);assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1);});
test('new command forbidden while pending',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));await assert.rejects(c.command('record',{new:true},{actor:'M'}));assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1);});
test('cross-store receipt recovery refuses to clear or retry',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));h.store='other';await assert.rejects(c.recover(true));assert.ok(c.pending());assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1);});
test('mismatched exact receipt identity preserves pending',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));h.receipt.request_id='wrong';await assert.rejects(c.recover());assert.ok(c.pending());});
test('explicit missing-receipt retry uses same bytes',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));h.lose=false;h.receipt=null;await c.recover(true);const posts=h.calls.filter(x=>x.options.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].options.body,posts[1].options.body);});
test('403 does not prove original action never committed',async()=>{const h=harness(),c=h.client();h.deny=true;await assert.rejects(c.command('record',{}, {actor:'M'}));assert.ok(c.pending());});
test('later 409 admission failure preserves earlier unresolved request',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));const key=c.pending().command.request_id;h.receipt=null;h.deny=true;h.denyStatus=409;await assert.rejects(c.recover(true));assert.equal(c.pending().command.request_id,key);});
test('storage refusal happens before network mutation',async()=>{const h=harness();h.storage.setItem=()=>{throw Error('quota');};const c=h.client();await assert.rejects(c.command('record',{}, {actor:'M'}));assert.equal(h.calls.filter(x=>x.options.method==='POST').length,0);assert.equal(c.busy(),false);});
test('reconciliation holds exclusion until receipt cleared',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));let release;h.block=new Promise(r=>release=r);const p=c.recover();await new Promise(r=>setTimeout(r,5));await assert.rejects(c.command('record',{}, {actor:'M'}));await assert.rejects(c.recover(true));release();await p;assert.equal(c.pending(),null);});
test('recovery failure releases lock without losing pending',async()=>{const h=harness(),c=h.client();h.lose=true;await assert.rejects(c.command('record',{}, {actor:'M'}));h.receipt.store_id='wrong';await assert.rejects(c.recover());assert.equal(c.busy(),false);assert.ok(c.pending());});
