'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {journal}=require('../union-journal.cjs');
test('journal allowlists metadata and rotates bounded files without arguments or errors text',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clw-journal-')),file=path.join(dir,'activity.jsonl');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=journal(file,{maxBytes:600});
  for(let i=0;i<40;i++)write({event:'mcp_call_finished',callId:'id-'+i,tool:'read_files',httpStatus:200,isError:false,applicationSuccess:false,
    arguments:{authorization:'secret'},message:'private output',code:'error with private text',text:'payload'});
  for(const name of [file,file+'.previous']){
    const raw=fs.readFileSync(name,'utf8');assert.ok(Buffer.byteLength(raw)<=600);
    for(const row of raw.trim().split('\n').map(JSON.parse)){assert.equal(row.tool,'read_files');assert.equal(row.isError,false);assert.equal(row.applicationSuccess,false);assert.ok(row.at);}
    for(const secret of ['authorization','secret','private','payload','arguments'])assert.equal(raw.includes(secret),false);
  }
});

test('manifest diagnostic keeps catalog names and outcome flags without payloads',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clw-manifest-journal-')),file=path.join(dir,'activity.jsonl');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 journal(file)({event:'mcp_call_finished',manifestQuery:'codex_tool_call',manifestExtended:true,manifestOriginalSuccess:false,manifestResultSuccess:true,arguments:{turn_token:'secret'},result:{text:'private'}});
 const row=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(row.manifestQuery,'codex_tool_call');assert.equal(row.manifestExtended,true);assert.equal(row.manifestOriginalSuccess,false);assert.equal(row.manifestResultSuccess,true);
 assert.equal(row.arguments,undefined);assert.equal(row.result,undefined);
});

test('journal keeps only the numeric batch failure count',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clw-batch-journal-')),file=path.join(dir,'activity.jsonl');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 journal(file)({event:'mcp_call_finished',tool:'read_files',itemFailureCount:1,items:[{path:'private-file',error:'private error'}]});
 const row=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(row.itemFailureCount,1);assert.equal(row.items,undefined);
 assert.equal(fs.readFileSync(file,'utf8').includes('private'),false);
});

test('journal keeps MCP method and fixed storage diagnosis without paths or error text',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clw-storage-journal-')),file=path.join(dir,'activity.jsonl');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const write=journal(file);
 write({event:'mcp_result_delivery_attention',method:'tools/call',phase:'stream_store',
   storeCode:'RESULT_STORE_FULL',durationMs:21,callId:'original-call',message:'private payload'});
 write({event:'mcp_call_finished',method:'notifications/resources/list_changed'});
 write({event:'mcp_call_finished',method:'C:/private/path'});
 const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows[0].method,'tools/call');assert.equal(rows[0].storeCode,'RESULT_STORE_FULL');
 assert.equal(rows[0].phase,'stream_store');assert.equal(rows[0].durationMs,21);
 assert.equal(rows[0].callId,'original-call');assert.equal(rows[0].message,undefined);
 assert.equal(rows[1].method,'notifications/resources/list_changed');assert.equal(rows[2].method,undefined);
});
