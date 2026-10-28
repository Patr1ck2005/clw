'use strict';
// Isolated Electron/Node worker only; no BrowserWindow, production profile,
// connector, model, network request, or existing process is opened.
const {app}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createTurnDisplayIndex}=require('../turn-journal-cache.cjs');
const output=path.resolve(__dirname,'../../..','.local','backend-state-pipeline-20261004');
const home=path.join(output,'electron-display-cache');
app.setPath('userData',path.join(output,'electron-isolated-profile'));
let index;
(async()=>{
  await app.whenReady();fs.mkdirSync(path.join(home,'turns'),{recursive:true});
  const record={traceId:'123456abcdef',status:'completed',submission:'confirmed',startedAt:'2026-10-04T00:00:00Z'};
  fs.writeFileSync(path.join(home,'turns',record.traceId+'.json'),JSON.stringify(record));
  index=createTurnDisplayIndex(home,new Map([[record.traceId,record]]));
  await index.refresh({full:true});const first=index.snapshot();assert.equal(first.status.unavailable,false);assert.equal(first.rows.length,1);
  let reads=0;const original=fs.statSync;fs.statSync=function(...args){reads++;return original.apply(this,args);};
  try{for(let n=0;n<1000;n++)assert.equal(index.snapshot().rows[0].traceId,record.traceId);}finally{fs.statSync=original;}
  assert.equal(reads,0);await index.close();index=null;
  const result={isolatedElectron:true,workerLoaded:true,cachedSnapshots:1000,mainThreadSnapshotStatCalls:reads,
    productionProfileUsed:false,liveInstancesTouched:false,modelSends:0};
  fs.writeFileSync(path.join(output,'cache-electron-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));app.exit(0);
})().catch(async error=>{console.error(error.stack);await index?.close();app.exit(1);});
