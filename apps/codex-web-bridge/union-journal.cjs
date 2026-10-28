'use strict';
// Bounded metadata only. Never persist tool arguments, bodies, auth or errors' text.
const fs=require('node:fs'),path=require('node:path');
function journal(file,{maxBytes=4*1024*1024}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  return value=>{
    const row={at:new Date().toISOString()};
    for(const key of ['event','callId','tool','route','sessionHash','turnHash','catalogHash','code','manifestQuery','part','resultId','storeCode','phase']){
      const x=value[key];if(typeof x==='string'&&/^[\w.:-]{1,128}$/.test(x))row[key]=x;
    }
    if(typeof value.method==='string'&&value.method.length<=128&&/^[\w.-]+(?:\/[\w.-]+){0,3}$/.test(value.method))row.method=value.method;
    for(const key of ['httpStatus','durationMs','bytes','toolCount','rpcErrorCode','itemFailureCount'])if(Number.isFinite(value[key]))row[key]=value[key];
    for(const key of ['isError','rpcError','bodyInspected','applicationSuccess','runProcessPresent','manifestExtended','manifestOriginalSuccess','manifestResultSuccess','complete'])if(typeof value[key]==='boolean')row[key]=value[key];
    const line=JSON.stringify(row)+'\n';
    if(fs.existsSync(file)&&fs.statSync(file).size+Buffer.byteLength(line)>maxBytes){
      fs.copyFileSync(file,file+'.previous');fs.truncateSync(file,0);
    }
    fs.appendFileSync(file,line,{encoding:'utf8',mode:0o600});
  };
}
module.exports={journal};
