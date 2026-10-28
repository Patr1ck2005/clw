'use strict';

// MCP tools/list uses its own cursor protocol. Oversized catalogs must remain
// ListToolsResult objects rather than tool-result delivery receipts.
const crypto=require('node:crypto');
const PREFIX='clw_catalog_';
const MiB=1024*1024;
const bytes=value=>Buffer.byteLength(value,'utf8');

class CatalogPageError extends Error{
  constructor(code,message){super(message);this.name='CatalogPageError';this.code=code;}
}
const fail=(code,message)=>{throw new CatalogPageError(code,message);};
const positive=(value,label)=>{
  if(!Number.isSafeInteger(value)||value<=0)throw new TypeError(`${label} must be a positive integer`);
  return value;
};

function createCatalogPages({inlineBytes=6*MiB,maxSnapshots=4,maxBytes=64*MiB,
  maxSnapshotBytes=16*MiB,ttlMs=10*60*1000,now=Date.now}={}){
  for(const [label,value] of Object.entries({inlineBytes,maxSnapshots,maxBytes,maxSnapshotBytes,ttlMs}))positive(value,label);
  if(typeof now!=='function')throw new TypeError('now must be a function');
  const snapshots=new Set(),cursors=new Map();let retainedBytes=0;
  const principalKey=principal=>{
    if(typeof principal!=='string'||!principal)fail('CATALOG_INVALID_PRINCIPAL','Catalog paging requires the original authenticated principal.');
    return crypto.createHash('sha256').update(principal).digest('hex');
  };
  const prune=()=>{
    const time=now();
    for(const snapshot of snapshots){
      if(time<snapshot.expiresAt)continue;
      snapshots.delete(snapshot);retainedBytes-=snapshot.retainedBytes;
      for(const cursor of snapshot.cursors)cursors.delete(cursor);
    }
  };
  const makePage=(snapshot,page,id)=>{
    const catalog=JSON.parse(snapshot.base);
    catalog.id=id;
    catalog.result.tools=snapshot.tools.slice(page.start,page.end).map(raw=>JSON.parse(raw));
    if(page.nextCursor!==undefined)catalog.result.nextCursor=page.nextCursor;
    if(bytes(JSON.stringify(catalog))>inlineBytes)fail('CATALOG_RESPONSE_TOO_LARGE',
      'The current request ID or catalog metadata exceeds the delivery budget. Use a bounded request ID or an exact tool_manifest query.');
    return catalog;
  };
  const handles=cursor=>typeof cursor==='string'&&cursor.startsWith(PREFIX);

  function paginate(catalog,{principal}={}){
    // Ordinary catalogs, including backend error envelopes, retain their exact
    // object identity and wire semantics. No snapshot is allocated for them.
    const raw=JSON.stringify(catalog);
    if(raw===undefined)fail('CATALOG_INVALID','Invalid MCP catalog response.');
    const rawBytes=bytes(raw);
    if(rawBytes<=inlineBytes)return catalog;
    if(rawBytes>maxSnapshotBytes)fail('CATALOG_SNAPSHOT_TOO_LARGE',
      'The catalog exceeds the bounded snapshot budget. Query tool_manifest for the required tool or category.');
    const clone=JSON.parse(raw);
    if(!clone||Array.isArray(clone)||!clone.result||!Array.isArray(clone.result.tools))fail('CATALOG_INVALID',
      'The oversized response is not an MCP tools/list catalog.');
    const owner=principalKey(principal);
    const backendCursor=clone.result.nextCursor;
    if(backendCursor!==undefined&&typeof backendCursor!=='string')fail('CATALOG_INVALID',
      'The backend catalog cursor is not a string.');
    if(handles(backendCursor))fail('CATALOG_BACKEND_CURSOR_COLLISION',
      'The backend catalog uses the reserved local cursor namespace. Query an exact tool_manifest entry.');
    const tools=clone.result.tools.map(tool=>JSON.stringify(tool));
    clone.result.tools=[];delete clone.result.nextCursor;
    const base=JSON.stringify(clone);
    const placeholder=PREFIX+'0'.repeat(32);
    const baseWithCursor=cursor=>{
      const value=JSON.parse(base);
      if(cursor!==undefined)value.result.nextCursor=cursor;
      return bytes(JSON.stringify(value));
    };
    const continuationBytes=baseWithCursor(placeholder),finalBytes=baseWithCursor(backendCursor);
    if(Math.min(continuationBytes,finalBytes)>inlineBytes||finalBytes>inlineBytes)fail('CATALOG_METADATA_TOO_LARGE',
      'Catalog metadata or its backend cursor exceeds the delivery budget. Query an exact tool_manifest entry.');
    const prefix=[0];for(const tool of tools)prefix.push(prefix.at(-1)+bytes(tool));
    const rangeBytes=(start,end)=>prefix[end]-prefix[start]+Math.max(0,end-start-1);
    const pages=[];let start=0;
    while(true){
      if(finalBytes+rangeBytes(start,tools.length)<=inlineBytes){
        pages.push({start,end:tools.length,nextCursor:backendCursor});break;
      }
      let end=start;
      while(end<tools.length&&continuationBytes+rangeBytes(start,end+1)<=inlineBytes)end++;
      if(end===start)fail('CATALOG_ITEM_TOO_LARGE',
        `Catalog tool contract at index ${start} exceeds one delivery page. Query that tool through tool_manifest; the contract was not truncated.`);
      pages.push({start,end,nextCursor:placeholder});start=end;
      // An empty final page is valid when all contracts fit the preceding page
      // but a long original backend cursor needs the remaining delivery space.
    }
    prune();
    const storageBytes=bytes(base)+prefix.at(-1)+(backendCursor===undefined?0:bytes(JSON.stringify(backendCursor)))+pages.length*160;
    if(snapshots.size>=maxSnapshots||retainedBytes+storageBytes>maxBytes)fail('CATALOG_CAPACITY',
      'Catalog snapshot capacity is temporarily full. Existing cursors are preserved; use an exact tool_manifest query or retry discovery after expiry.');
    const snapshot={base,tools,pages,principal:owner,expiresAt:now()+ttlMs,retainedBytes:storageBytes,cursors:[]};
    for(let index=1;index<pages.length;index++){
      let cursor;do{cursor=PREFIX+crypto.randomBytes(16).toString('hex');}while(cursors.has(cursor));
      pages[index-1].nextCursor=cursor;snapshot.cursors.push(cursor);cursors.set(cursor,{snapshot,index});
    }
    snapshots.add(snapshot);retainedBytes+=storageBytes;
    return makePage(snapshot,pages[0],clone.id);
  }

  function read(cursor,{principal,id}={}){
    const owner=principalKey(principal);
    if(typeof cursor!=='string'||!/^clw_catalog_[0-9a-f]{32}$/.test(cursor))fail('CATALOG_INVALID_CURSOR',
      'Invalid local catalog cursor. Repeat tools/list discovery or query an exact tool_manifest entry.');
    prune();
    const entry=cursors.get(cursor);
    if(!entry)fail('CATALOG_CURSOR_UNAVAILABLE',
      'This catalog cursor has expired or is unavailable. Repeat tools/list discovery or query an exact tool_manifest entry.');
    if(entry.snapshot.principal!==owner)fail('CATALOG_PRINCIPAL_MISMATCH',
      'This catalog cursor belongs to another authenticated principal. Use the original connection.');
    if(!['string','number'].includes(typeof id)||typeof id==='number'&&!Number.isFinite(id))fail('CATALOG_INVALID_ID',
      'Catalog paging requires a valid JSON-RPC request ID.');
    return makePage(entry.snapshot,entry.snapshot.pages[entry.index],id);
  }
  return {paginate,read,handles,inlineBytes};
}

module.exports={createCatalogPages,CatalogPageError,PREFIX};
