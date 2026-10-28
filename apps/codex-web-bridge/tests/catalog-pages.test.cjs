'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCatalogPages,CatalogPageError,PREFIX}=require('../catalog-pages.cjs');
const principal='Bearer isolated-catalog-principal';
const tool=(index,size=210)=>({name:`tool_${index}`,description:'中🙂\\\"'.repeat(size),inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}});
const catalog=(count=8,size=210)=>({jsonrpc:'2.0',id:'original-id',result:{tools:Array.from({length:count},(_,index)=>tool(index,size)),resultType:'complete',_meta:{opaque:{preserved:true}}}});
const size=value=>Buffer.byteLength(JSON.stringify(value));
const coded=(code,fn)=>assert.throws(fn,error=>error instanceof CatalogPageError&&error.code===code);
function collect(paging,first,{identity=principal}={}){
  const pages=[first];let next=first.result.nextCursor,index=0;
  while(paging.handles(next)){
    const page=paging.read(next,{principal:identity,id:`request_${++index}`});pages.push(page);next=page.result.nextCursor;
  }
  return pages;
}

test('small catalogs are unchanged and allocate no snapshot capacity',()=>{
  const paging=createCatalogPages({inlineBytes:4096,maxSnapshots:1});
  const original=catalog(1,1);original.result.nextCursor='backend-page-2';
  for(let index=0;index<20;index++)assert.strictEqual(paging.paginate(original),original);
  assert.equal(paging.handles(original.result.nextCursor),false);
  const large=paging.paginate(catalog(),{principal});assert.ok(paging.handles(large.result.nextCursor));
});

test('unicode contracts arrive exactly once in valid bounded MCP catalog pages',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),original=catalog();
  const first=paging.paginate(original,{principal}),pages=collect(paging,first);
  assert.ok(pages.length>2);assert.equal(first.id,'original-id');
  assert.deepEqual(pages.flatMap(page=>page.result.tools),original.result.tools);
  for(const [index,page] of pages.entries()){
    assert.ok(size(page)<=paging.inlineBytes);assert.equal(page.jsonrpc,'2.0');
    assert.equal(page.result.resultType,'complete');assert.deepEqual(page.result._meta,original.result._meta);
    assert.equal(page.id,index?`request_${index}`:'original-id');assert.equal(page.result.content,undefined);
  }
  assert.equal(Object.hasOwn(pages.at(-1).result,'nextCursor'),false);
  assert.deepEqual(original,catalog());
});

test('the production 6 MiB budget paginates a catalog larger than the platform 10 MiB limit',()=>{
  const paging=createCatalogPages(),original={jsonrpc:'2.0',id:1,result:{tools:Array.from({length:12},(_,index)=>({
    name:`production_tool_${index}`,description:'x'.repeat(1024*1024),inputSchema:{type:'object'}
  }))}};
  assert.ok(size(original)>10*1024*1024);
  const pages=collect(paging,paging.paginate(original,{principal}));
  assert.ok(pages.length>=3);
  for(const page of pages)assert.ok(size(page)<=6*1024*1024);
  assert.deepEqual(pages.flatMap(page=>page.result.tools),original.result.tools);
});

test('continuation snapshot and repeated reads do not depend on later source or result mutation',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),original=catalog();
  const first=paging.paginate(original,{principal}),cursor=first.result.nextCursor;
  const before=paging.read(cursor,{principal,id:51});
  original.result.tools[1].description='source changed';first.result.tools[0].inputSchema.type='source changed';
  before.result.tools[0].description='read result changed';
  const again=paging.read(cursor,{principal,id:51});
  assert.deepEqual(again.result.tools,catalog().result.tools.slice(first.result.tools.length,first.result.tools.length+again.result.tools.length));
  assert.equal(again.id,51);
});

test('original backend cursor is returned only on the final local page',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),original=catalog();
  original.result.nextCursor='opaque-backend-cursor+/=';
  const pages=collect(paging,paging.paginate(original,{principal}));
  assert.equal(pages.at(-1).result.nextCursor,original.result.nextCursor);
  for(const page of pages.slice(0,-1))assert.ok(paging.handles(page.result.nextCursor));
  assert.deepEqual(pages.flatMap(page=>page.result.tools),original.result.tools);
});

test('a long backend cursor may use an empty final page without dropping contracts',()=>{
  const original=catalog(2,5);original.result.nextCursor='x'.repeat(2200);
  const paging=createCatalogPages({inlineBytes:2500});
  const pages=collect(paging,paging.paginate(original,{principal}));
  assert.ok(pages.length>1);assert.equal(pages.at(-1).result.nextCursor,original.result.nextCursor);
  assert.deepEqual(pages.flatMap(page=>page.result.tools),original.result.tools);
  for(const page of pages)assert.ok(size(page)<=2500);
});

test('opaque local cursors are bound to the original authenticated principal',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),first=paging.paginate(catalog(),{principal}),cursor=first.result.nextCursor;
  assert.match(cursor,/^clw_catalog_[0-9a-f]{32}$/);assert.equal(cursor.includes(principal),false);
  coded('CATALOG_PRINCIPAL_MISMATCH',()=>paging.read(cursor,{principal:'Bearer other',id:2}));
  assert.ok(paging.read(cursor,{principal,id:3}).result.tools.length);
  coded('CATALOG_INVALID_PRINCIPAL',()=>paging.read(cursor,{id:4}));
});

test('expiry releases capacity while preserving the cursor protocol for expired values',()=>{
  let time=100;const paging=createCatalogPages({inlineBytes:4096,maxSnapshots:1,ttlMs:20,now:()=>time});
  const first=paging.paginate(catalog(),{principal}),cursor=first.result.nextCursor;
  time=119;assert.ok(paging.read(cursor,{principal,id:2}).result.tools.length);
  time=120;assert.equal(paging.handles(cursor),true);
  coded('CATALOG_CURSOR_UNAVAILABLE',()=>paging.read(cursor,{principal,id:3}));
  const replacement=paging.paginate(catalog(),{principal});assert.notEqual(replacement.result.nextCursor,cursor);
});

test('snapshot count and byte capacity never evict existing unexpired catalogs',()=>{
  const count=createCatalogPages({inlineBytes:4096,maxSnapshots:1}),first=count.paginate(catalog(),{principal});
  coded('CATALOG_CAPACITY',()=>count.paginate(catalog(),{principal}));
  assert.ok(count.read(first.result.nextCursor,{principal,id:2}).result.tools.length);
  const bounded=createCatalogPages({inlineBytes:4096,maxBytes:4200});
  coded('CATALOG_CAPACITY',()=>bounded.paginate(catalog(),{principal}));
  const snapshot=createCatalogPages({inlineBytes:4096,maxSnapshotBytes:5000});
  coded('CATALOG_SNAPSHOT_TOO_LARGE',()=>snapshot.paginate(catalog(),{principal}));
  const cursorBudget=createCatalogPages({inlineBytes:2500,maxBytes:2000}),longCursor=catalog(2,5);
  longCursor.result.nextCursor='x'.repeat(2200);
  coded('CATALOG_CAPACITY',()=>cursorBudget.paginate(longCursor,{principal}));
});

test('a single oversized contract fails honestly instead of truncating or changing MCP schema',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),original=catalog(2,600);
  coded('CATALOG_ITEM_TOO_LARGE',()=>paging.paginate(original,{principal}));
  assert.equal(original.result.tools[0].description,tool(0,600).description);
});

test('oversized metadata and malformed catalogs have typed bounded failures',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),original=catalog(0,0);
  original.result._meta.oversized='x'.repeat(5000);
  coded('CATALOG_METADATA_TOO_LARGE',()=>paging.paginate(original,{principal}));
  coded('CATALOG_INVALID',()=>paging.paginate({jsonrpc:'2.0',id:1,result:{other:'x'.repeat(5000)}},{principal}));
  const wrongCursor=catalog();wrongCursor.result.nextCursor={bad:true};
  coded('CATALOG_INVALID',()=>paging.paginate(wrongCursor,{principal}));
  const reserved=catalog();reserved.result.nextCursor=PREFIX+'backend-owned';
  coded('CATALOG_BACKEND_CURSOR_COLLISION',()=>paging.paginate(reserved,{principal}));
});

test('invalid cursor, ID, and oversized rewritten ID do not corrupt reusable snapshots',()=>{
  const paging=createCatalogPages({inlineBytes:4096}),first=paging.paginate(catalog(),{principal}),cursor=first.result.nextCursor;
  assert.equal(paging.handles('opaque-backend-cursor'),false);assert.equal(paging.handles(PREFIX+'broken'),true);
  coded('CATALOG_INVALID_CURSOR',()=>paging.read(PREFIX+'broken',{principal,id:2}));
  coded('CATALOG_CURSOR_UNAVAILABLE',()=>paging.read(PREFIX+'f'.repeat(32),{principal,id:2}));
  coded('CATALOG_INVALID_ID',()=>paging.read(cursor,{principal,id:NaN}));
  coded('CATALOG_INVALID_ID',()=>paging.read(cursor,{principal,id:null}));
  coded('CATALOG_RESPONSE_TOO_LARGE',()=>paging.read(cursor,{principal,id:'x'.repeat(5000)}));
  assert.ok(paging.read(cursor,{principal,id:2}).result.tools.length);
});

test('configuration errors fail before storing any catalog',()=>{
  for(const options of [{inlineBytes:0},{maxBytes:NaN},{maxSnapshots:0},{ttlMs:-1},{now:1}])assert.throws(()=>createCatalogPages(options),TypeError);
});
