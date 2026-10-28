'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {startAppControl}=require('../app-control.cjs');
const {createControlBodyReader}=require('../control-record-body.cjs');
const run=promisify(execFile);

test('Python client reads large Chinese and math body through actual HTTP and durable operation store',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clw-body-http-')),profile=path.join(root,'profile');
  const reader=createControlBodyReader();let reads=0,chunks=0;
  const original={row:{text:'中文公式 $\\alpha^2$\n```python\nprint("完整")\n```\n'.repeat(16000)}};
  const control=await startAppControl({root,profile,instanceId:'body-http-instance-0001',capabilities:['record-body'],
    snapshot:async()=>({runtime_generation:1,selected:null}),
    dispatch:async(action,payload)=>{
      assert.equal(action,'record-body');chunks++;
      return reader.readControlBody(payload,async request=>{reads++;assert.deepEqual(request,{mode:'codex',task_key:'original',traceId:'original-trace'});return original;});
    }});
  t.after(async()=>{reader.dispose();await control.close();await fs.rm(root,{recursive:true,force:true});});
  const scriptRoot=path.resolve(__dirname,'../../../scripts');
  const program=[
    'import sys,json,hashlib',
    'from pathlib import Path',
    'sys.path.insert(0,sys.argv[1])',
    'from web_host_control import AppControl',
    'client=AppControl(sys.argv[2],expected_root=sys.argv[3])',
    'identity={"app_instance_id":client.descriptor["app_instance_id"],"runtime_generation":1,"selected":None}',
    'value=client.read_record({"mode":"codex","task_key":"original","traceId":"original-trace"},identity)',
    'raw=json.dumps(value,ensure_ascii=False,separators=(",",":")).encode("utf8")',
    'print(json.dumps({"bytes":len(raw),"sha256":hashlib.sha256(raw).hexdigest(),"contains_math":"$\\\\alpha^2$" in value["row"]["text"],"lines":len(value["row"]["text"].splitlines())}))'
  ].join('\n');
  const result=await run(process.env.CLW_PYTHON||'python',['-X','utf8','-B','-c',program,scriptRoot,profile,root],{timeout:30000,windowsHide:true});
  const observed=JSON.parse(result.stdout),bytes=Buffer.from(JSON.stringify(original),'utf8');
  assert.equal(observed.bytes,bytes.length);
  assert.equal(observed.sha256,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
  assert.equal(observed.contains_math,true);assert.equal(observed.lines,64000);
  assert.ok(chunks>10);assert.equal(reads,1);
});
