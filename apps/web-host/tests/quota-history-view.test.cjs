'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {summary,render,historyLines,renderHistory}=require('../quota-view.js');
const good={checkedAt:1791890000000,window:{start:1791285200000,end:1791890000000,source:'rolling_7d'},completedProResponses:84,proConversations:12,coverage:{state:'complete'},byModel:[{model:'gpt-6-pro',completedProResponses:84}]};
test('history presentation separates completed responses, distinct conversations and official quota',()=>{
 const lines=historyLines({account:'A',usage:{lastGood:good,stale:false,lastAttempt:{coverage:{state:'complete'}}}}).join('\n');
 assert.match(lines,/已保存的 7 天统计.*84 次完成的 Pro 回复/);assert.match(lines,/涉及 12 个对话/);assert.doesNotMatch(lines,/剩余|余额|还有.*次/);
 assert.ok(lines.includes(new Date(good.window.start).toLocaleString()));assert.ok(lines.includes(new Date(good.window.end).toLocaleString()));
 assert.ok(lines.includes(new Date(good.checkedAt).toLocaleString()));
 assert.match(historyLines({usage:{lastGood:{...good,window:{...good.window,source:'custom_start'}}}})[0],/指定起点/);
});
test('failed historical reads preserve the complete local cache and never invent zero usage',()=>{
 const failed={coverage:{state:'failed',reason:'http_403'}};
 const cached={account:'B',historyPolicy:'cache_only',usage:{lastGood:{...good,completedProResponses:50,proConversations:13},lastAttempt:failed,stale:true}};
 const saved=historyLines(cached).join('\n');
 assert.match(saved,/50 次完成的 Pro 回复/);assert.match(saved,/涉及 13 个对话/);assert.match(saved,/显示已保存的完整缓存.*之后的采集未完成/);
 assert.match(summary(cached),/B · Pro 50 次 · 本机缓存/);
 assert.ok(saved.includes(new Date(good.window.start).toLocaleString()));assert.ok(saved.includes(new Date(good.window.end).toLocaleString()));
 assert.ok(saved.includes(new Date(good.checkedAt).toLocaleString()));
 const text=historyLines({usage:{lastGood:null,lastAttempt:failed,stale:true}}).join('\n');
 assert.match(text,/Pro 用量未知/);assert.match(text,/上次采集：.*拒绝历史读取/);assert.doesNotMatch(text,/0 次|本次|正在/);
});
test('obsolete in-flight progress cannot replace cached results or appear as current work',()=>{
 const cached={usage:{lastGood:good,stale:false},historyProgress:{state:'reading',conversationsRead:10}};
 assert.deepEqual(historyLines(cached),historyLines({usage:cached.usage}));
 const text=historyLines({historyProgress:{state:'reading',conversationsRead:10}}).join('\n');
 assert.match(text,/本机尚无已保存/);assert.doesNotMatch(text,/正在读取|已核对 10|剩余|0 次/);
});

test('old rate limits remain historical records and never imply a live wait or scheduled retry',()=>{
 const q={historyPolicy:'cache_only',usage:{lastGood:good,lastAttempt:{coverage:{state:'failed',reason:'rate_limited'}},stale:true},
   historyProgress:{state:'reading',conversationsRead:4,reason:'rate_limited',waitUntil:Date.now()+33000}};
 const text=historyLines(q).join('\n');
 assert.match(text,/84 次完成的 Pro 回复/);assert.match(text,/上次采集：.*受限/);
 assert.doesNotMatch(text,/等待至|等待后|正在读取|当前.*限流|稍后更新|统计已更新|0 次/);
 assert.deepEqual(historyLines({...q,historyProgress:{state:'failed',reason:'quota_history_page_unavailable'}}),historyLines(q));
});

test('a saved browser challenge is historical information with no action to verify or update',()=>{
 const failure={coverage:{state:'failed',reason:'http_403',diagnostic:{browserVerification:true}}};
 const text=historyLines({usage:{lastGood:null,lastAttempt:failure}}).join('\n');
 assert.match(text,/上次采集：网页访问验证未完成/);
 assert.doesNotMatch(text,/打开|请在|完成后|更新统计|稍后|正在/);
 const unavailable=historyLines({usage:{lastAttempt:{coverage:{state:'failed',reason:'http_403'}}},
   historyProgress:{state:'failed',reason:'quota_history_page_unavailable'}}).join('\n');
 assert.match(unavailable,/上次采集：.*拒绝历史读取/);assert.doesNotMatch(unavailable,/原网页尚未就绪|请.*登录/);
});

test('unidentified models remain visible rather than being silently classified as zero Pro usage',()=>{
 const text=historyLines({usage:{lastGood:{...good,completedProResponses:0,proConversations:0,
   byModel:[{model:'unknown',completedResponses:3,completedProResponses:0},{model:'auto',completedResponses:2,completedProResponses:0}]}}}).join('\n');
 assert.match(text,/已识别 0 次/);assert.match(text,/另有 5 次.*模型未明确/);
});

test('a saved partial A attempt preserves its 19 of 20 coverage and unknown usage',()=>{
 const text=historyLines({account:'A',historyPolicy:'cache_only',usage:{lastGood:null,lastAttempt:{checkedAt:good.checkedAt,
   coverage:{state:'partial',reason:'http_403',conversationsRead:19,conversationsListed:20}}}}).join('\n');
 assert.match(text,/Pro 用量未知.*尚无完整统计/);assert.match(text,/上次未完成.*19 \/ 20 个对话/);
 assert.ok(text.includes(new Date(good.checkedAt).toLocaleString()));assert.doesNotMatch(text,/0 次|84 次|正在读取|更新统计/);
});

test('rendered cache cards expose no verification buttons even with old challenge data and callbacks',()=>{
 const original=global.document;
 global.document={createElement:tag=>({tag,children:[],dataset:{},append(...children){this.children.push(...children);}})};
 try{
  const container={children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);}},opened=[];
  const quota=(account,browserVerification)=>({account,usage:{lastAttempt:{coverage:{state:'failed',reason:'http_403',diagnostic:{browserVerification}}}}});
  renderHistory(container,[quota('A',true),quota('B',false)],{onVerify:account=>opened.push(account)});
  const a=container.children[0].children.filter(c=>c.tag==='button'),b=container.children[1].children.filter(c=>c.tag==='button');
  assert.equal(a.length,0);assert.equal(b.length,0);assert.deepEqual(opened,[]);
  renderHistory(container,[quota('B',true)],{onVerify:account=>opened.push(account)});
  assert.equal(container.children.flatMap(card=>card.children).some(node=>node.tag==='button'||typeof node.onclick==='function'),false);
  assert.deepEqual(opened,[]);
  render(container,{models:[{id:'latest-pro',label:'Pro',status:'available',source:'public_model_menu',observedAt:good.checkedAt},
    {id:'latest-high',label:'High',status:'exhausted',source:'user_report',reportedAt:good.checkedAt}]});
  assert.match(container.children[0].children[2].textContent,/已保存的模型菜单观察/);
  assert.match(container.children[1].children[2].textContent,/本机手动记录/);
  assert.equal(container.children.flatMap(card=>card.children).some(node=>node.tag==='button'||typeof node.onclick==='function'),false);
 }finally{if(original===undefined)delete global.document;else global.document=original;}
});
