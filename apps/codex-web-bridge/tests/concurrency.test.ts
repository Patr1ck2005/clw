import {expect,test} from 'bun:test';
import {ChatGptTextFeed,ChatGptTraceFeed,ChatGptTurnSessions} from '../upstream/src/adapters/chatgpt-web/turn-execution';
import {ChatGptBrowserWorker} from '../upstream/src/adapters/chatgpt-web/browser-worker';
test('more than five registered native turns retain independent ownership and cancellation',()=>{
  const sessions=new ChatGptTurnSessions();let cancelled=0;
  const create=()=>({mode:'read-only' as const,browser:new Promise<string>(()=>{}),physicalSettlement:Promise.resolve(),trace:new ChatGptTraceFeed(),text:new ChatGptTextFeed(),cancel:()=>{cancelled++;}});
  const entries=Array.from({length:12},(_,i)=>sessions.getOrCreate('clw-'+i,create));
  expect(sessions.activeCount()).toBe(12);
  expect(sessions.getOrCreate('clw-8',()=>{throw Error('must reuse original');})).toBe(entries[8]);
  sessions.clear();expect(cancelled).toBe(12);
});
test('browser worker does not reintroduce a five-turn queue',async()=>{
  const releases=new Map<string,()=>void>();
  const worker=Object.assign(Object.create(ChatGptBrowserWorker.prototype),{config:{browserHost:'managed-chrome'},activeRuns:new Map(),
    runExclusive:(turn:{traceId:string})=>new Promise<string>(resolve=>releases.set(turn.traceId,()=>resolve(turn.traceId)))}) as ChatGptBrowserWorker;
  const active=Array.from({length:12},(_,i)=>worker.run({traceId:'trace_'+i,modelId:'chatgpt-web/high',capabilities:{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},prepare:async()=>({text:'fixture',images:[],release(){}}),onTextDelta(){}}));
  await Promise.resolve();expect(releases.size).toBe(12);for(const release of releases.values())release();await Promise.all(active);
});
