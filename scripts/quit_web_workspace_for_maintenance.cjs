'use strict';
// The same durable application command as the UI; no browser automation.
const path=require('node:path');
const {spawn}=require('node:child_process');
function exitFailure(error,{dispatched=false}={}){
  const message=String(error?.message||'');
  // A received application rejection remains a rejection even if CDP closes
  // immediately afterwards. Only transport loss has an unknown receipt.
  if(/Error invoking remote method ['"]clw-command['"]|maintenance_[a-z_]+|Maintenance exit was not accepted/.test(message))return 'rejected';
  // Once evaluate has been dispatched, a timeout or a missing acknowledgement
  // cannot prove whether quit ran. A connected browser does not settle it.
  return dispatched?'unknown':'rejected';
}

async function main(){
  const argv=process.argv.slice(2),ordinary=argv.includes('--ordinary');
  if(argv.some(value=>value!=='--ordinary'))throw Error('Use this application API entry without a CDP port; --ordinary preserves unfinished work.');
  const root=path.resolve(__dirname,'..');
  const source=String.raw`
import json,sys,uuid
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'scripts'))
from web_host_control import AppControl,ControlError
root=Path(sys.argv[1]);c=AppControl(root/'.local/web-host',expected_root=root)
s=c.state();op=str(uuid.uuid4())
envelope={'operation_id':op,'action':'quit','payload':{'maintenance':sys.argv[2]!='ordinary'},
 'expected_identity':{'app_instance_id':s['app_instance_id'],'root':s['root'],'runtime_generation':s['runtime_generation']}}
try:receipt=c.command(envelope,wait_seconds=30)
except ControlError as e:
 try:receipt=c.durable_operation(op,s['app_instance_id'],envelope=envelope)
 except ControlError:receipt={'state':'unknown','operation_id':op,'app_instance_id':s['app_instance_id'],'error':str(e),'replay':False}
print(json.dumps(receipt,ensure_ascii=True))
sys.exit(0 if receipt.get('state')=='completed' and receipt.get('result',{}).get('exiting') is True else 1)
`;
  const child=spawn(process.env.CLW_PYTHON||'python',['-X','utf8','-B','-c',source,root,ordinary?'ordinary':'maintenance'],
    {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  process.exitCode=Number.isInteger(code)?code:1;
}
if(require.main===module)main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
module.exports={exitFailure};
