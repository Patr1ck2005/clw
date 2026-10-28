'use strict';
const {createHash}=require('node:crypto');
const {crc32}=require('node:zlib');
const {performance}=require('node:perf_hooks');
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
const PREPARATION_TIMEOUT_MS=3000;
const STORAGE_TIMEOUT_MS=3000;
const pendingOwners=new WeakMap();
const pendingStores=new WeakMap();
const codes=Object.freeze({inspect:'capture_shell_inspect_failed',native:'capture_shell_native_failed',image:'capture_shell_image_invalid',png:'capture_shell_png_failed',storage:'capture_shell_storage_failed',
  inspectTimeout:'capture_shell_inspect_timeout',nativeTimeout:'capture_shell_native_timeout',storageTimeout:'capture_shell_storage_timeout',inspectPending:'capture_shell_inspect_pending',nativePending:'capture_shell_native_pending',storagePending:'capture_shell_storage_pending',options:'capture_shell_options_invalid'});
function stageError(stage,cause){
  // Raw native/OS errors remain local causes. Public receipts contain only the
  // fixed stage code, never arbitrary messages, stacks, paths or page content.
  const error=new Error(codes[stage],{cause});
  return Object.assign(error,{code:codes[stage],stage,accepted:stage==='storage'});
}
function syncStage(name,operation){try{return operation();}catch(error){throw stageError(name,error);}}
function preparationError(code,stage){return Object.assign(new Error(code),{code,stage,accepted:false});}
function deadlineError(name){return Object.assign(preparationError(codes[name+'Timeout'],name),{accepted:name==='storage'});}
function release(owner,slot){
  if(pendingOwners.get(owner)===slot)pendingOwners.delete(owner);
  if(slot.storageOwner&&pendingStores.get(slot.storageOwner)===slot)pendingStores.delete(slot.storageOwner);
}
function boundedStage(name,operation,owner,slot,deadline){
  const remaining=deadline-performance.now();
  if(remaining<=0)return Promise.reject(deadlineError(name));
  slot.stage=name;slot.pending=true;
  // There is no late caller continuation: reads never encode/save after timeout,
  // and a started store operation keeps its original IO/tail independently.
  // Late settlement only releases this exact owner's/store's pending slots.
  const raw=Promise.resolve().then(operation);
  return new Promise((resolve,reject)=>{
    let finished=false;
    const timer=setTimeout(()=>{finished=true;reject(deadlineError(name));},remaining);
    const settle=(failed,value)=>{
      slot.pending=false;if(slot.abandoned)release(owner,slot);
      if(finished)return;
      finished=true;clearTimeout(timer);
      // A delayed event loop must not turn a late image into a successful read.
      if(performance.now()>=deadline)reject(deadlineError(name));
      else if(failed)reject(stageError(name,value));
      else resolve(value);
    };
    raw.then(value=>settle(false,value),error=>settle(true,error));
  });
}
function imageSize(image){
  if(!image||typeof image.isEmpty!=='function'||typeof image.getSize!=='function'||typeof image.toPNG!=='function'||image.isEmpty()!==false)
    throw Error('capture_shell_image_empty_or_invalid');
  const size=image.getSize();
  if(!size||!Number.isSafeInteger(size.width)||!Number.isSafeInteger(size.height)||size.width<1||size.height<1||size.width>0x7fffffff||size.height>0x7fffffff)
    throw Error('capture_shell_image_dimensions_invalid');
  return {width:size.width,height:size.height};
}
function validatePNG(bytes,size){
  if(!Buffer.isBuffer(bytes)||bytes.length<57||!bytes.subarray(0,8).equals(signature))throw Error('capture_shell_png_signature_invalid');
  let offset=8,header=false,data=false,ended=false,width=0,height=0;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),end=offset+length+12;
    if(end>bytes.length)throw Error('capture_shell_png_truncated');
    const type=bytes.toString('ascii',offset+4,offset+8),content=bytes.subarray(offset+8,offset+8+length);
    if(crc32(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))throw Error('capture_shell_png_checksum_invalid');
    if(!header){
      if(type!=='IHDR'||length!==13)throw Error('capture_shell_png_header_invalid');
      width=content.readUInt32BE(0);height=content.readUInt32BE(4);
      const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(width!==size.width||height!==size.height||!depths[content[9]]?.includes(content[8])||content[10]!==0||content[11]!==0||content[12]>1)
        throw Error('capture_shell_png_dimensions_or_header_invalid');
      header=true;
    }else if(type==='IHDR')throw Error('capture_shell_png_duplicate_header');
    if(type==='IDAT'&&length>0)data=true;
    if(type==='IEND'){
      if(length!==0||!data||end!==bytes.length)throw Error('capture_shell_png_end_invalid');
      ended=true;break;
    }
    offset=end;
  }
  if(!header||!data||!ended)throw Error('capture_shell_png_incomplete');
  return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width,height};
}
async function captureShell({inspect,capture,save,assertOwner,nativeOwner=capture,storageOwner=save,timeoutMs=PREPARATION_TIMEOUT_MS,storageTimeoutMs=STORAGE_TIMEOUT_MS}){
  if(!nativeOwner||!['object','function'].includes(typeof nativeOwner)||!storageOwner||!['object','function'].includes(typeof storageOwner)||
      !Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>PREPARATION_TIMEOUT_MS||!Number.isFinite(storageTimeoutMs)||storageTimeoutMs<1||storageTimeoutMs>STORAGE_TIMEOUT_MS)
    throw preparationError(codes.options,'options');
  // A shared store can outlive a WebContents replacement. Do not even start a
  // new inspection/native read while its original IO/tail remains unsettled.
  if(pendingStores.has(storageOwner))throw preparationError(codes.storagePending,'storage');
  const previous=pendingOwners.get(nativeOwner);
  if(previous)throw preparationError(codes[previous.stage+'Pending'],previous.stage);
  const slot={stage:'inspect',pending:false,abandoned:false};pendingOwners.set(nativeOwner,slot);
  // Inspection and native acquisition share one finite preparation budget.
  // Callers creating fresh capture closures pass the stable WebContents object.
  const deadline=performance.now()+timeoutMs;
  try{
    const inspection=await boundedStage('inspect',inspect,nativeOwner,slot,deadline);
    assertOwner();
    const image=await boundedStage('native',capture,nativeOwner,slot,deadline);
    assertOwner();
    const size=syncStage('image',()=>imageSize(image));
    const {bytes,png}=syncStage('png',()=>{const bytes=image.toPNG();return {bytes,png:validatePNG(bytes,size)};});
    // Only this stage can create an artifact. Any storage failure keeps unknown
    // acceptance because a partial or complete file may already exist.
    // A concurrent different owner may have claimed this store during our read.
    if(pendingStores.has(storageOwner))throw preparationError(codes.storagePending,'storage');
    slot.storageOwner=storageOwner;pendingStores.set(storageOwner,slot);
    const saved=await boundedStage('storage',()=>save(bytes),nativeOwner,slot,performance.now()+storageTimeoutMs);
    assertOwner(true);
    return {...saved,inspection,png,model_sends:0};
  }finally{
    slot.abandoned=true;if(!slot.pending)release(nativeOwner,slot);
  }
}
module.exports={captureShell,validatePNG,codes,PREPARATION_TIMEOUT_MS,STORAGE_TIMEOUT_MS};
