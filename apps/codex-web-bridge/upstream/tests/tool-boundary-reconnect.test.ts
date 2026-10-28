import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGptBrowserWorker, type BrowserTurn } from '../src/adapters/chatgpt-web/browser-worker';
import { createChatGptWebAdapter } from '../src/adapters/chatgpt-web/index';
import { chatGptTurnSessions } from '../src/adapters/chatgpt-web/turn-execution';
import { callTurnBroker, TurnBroker, type BrokerToolResult } from '../src/adapters/chatgpt-web/turn-broker';
import { ChatGptExternalTurnProgress } from '../src/adapters/chatgpt-web/turn-progress';
import { defaultBrokerEndpoint } from '../src/config';
import { CHATGPT_WEB_MODEL_ID } from '../src/adapters/chatgpt-web/model';
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from '../src/types';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('call replay preserves the original observed boundary and duplicate results cannot retire another call', async () => {
  const progress = new ChatGptExternalTurnProgress();
  const first = progress.recordToolBatch(['call_a','call_b'],1000);
  await progress.acknowledgeToolBatch(first);
  const before = progress.snapshot();
  expect(progress.recordToolBatch(['call_b','call_a'],9000)).toBe(first);
  expect(progress.snapshot()).toEqual(before);
  await expect(progress.waitForToolBatchObservation(first)).resolves.toBeUndefined();
  progress.recordToolResult('call_a',10000);
  const oneLeft = progress.snapshot();
  progress.recordToolResult('call_a',11000);
  expect(progress.snapshot()).toEqual(oneLeft);
  expect(progress.snapshot().activeToolCalls).toBe(1);
  expect(()=>progress.recordToolResult('unrelated_call')).toThrow('without an active call');
  expect(()=>progress.recordToolBatch(['call_a'])).toThrow('completed call');
  progress.recordToolResult('call_b',12000);
  const next = progress.recordToolBatch(['call_c'],13000);
  expect(next).toBeGreaterThan(first);
  expect(progress.snapshot().activeToolCalls).toBe(1);
});

test('invalid call batches and timestamps leave accepted progress intact', () => {
  const progress = new ChatGptExternalTurnProgress();
  for (const ids of [[],[''],['call_a','call_a']]) expect(()=>progress.recordToolBatch(ids,1000)).toThrow();
  expect(()=>progress.recordToolBatch(['call_a'],NaN)).toThrow();
  expect(progress.snapshot().revision).toBe(0);
  progress.recordToolBatch(['call_a'],1000);
  const active = progress.snapshot();
  expect(()=>progress.recordToolResult('call_a',NaN)).toThrow();
  expect(progress.snapshot()).toEqual(active);
});

test('disconnect before browser boundary ACK replays the original call without a phantom active call', async () => {
  const home = join(tmpdir(), `clw-boundary-reconnect-${process.pid}-${Date.now()}`);
  const socketPath = defaultBrokerEndpoint(home, process.platform);
  const provider: CodexProviderConfig = {
    adapter:'chatgpt-web', baseUrl:`browser://boundary-reconnect-${Date.now()}`,
    chatgptWeb:{brokerSocketPath:socketPath, localToolsEnabled:true, solAvailable:true, extraHighAvailable:true, proAvailable:true},
  };
  const broker = TurnBroker.forSocket(socketPath);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const originalNext = broker.nextToolBatch;
  const firstBoundary = deferred();
  const replayDelivered = deferred();
  const allowAck = deferred();
  const nativeResultObserved = deferred();
  let progress!: ChatGptExternalTurnProgress;
  let browserStarts = 0;
  let receivedCalls: string[] = [];
  const disconnect = new AbortController();
  const runs: Promise<unknown>[] = [];
  broker.nextToolBatch = async (...args) => {
    const batch = await originalNext.apply(broker, args);
    receivedCalls.push(...batch.map(call => call.callId));
    if (receivedCalls.length === 2) replayDelivered.resolve();
    return batch;
  };
  worker.run = async (turn: BrowserTurn) => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw Error('Missing original token');
      turn.onSubmitted?.();
      const claimed = await callTurnBroker<{bindingId:string,activityId:string}>(socketPath,{method:'claim',token});
      const invocation = callTurnBroker<BrokerToolResult>(socketPath,{method:'invoke',bindingId:claimed.bindingId,wireName:'exec_command',arguments:{cmd:'synthetic single effect'}},null);
      // Consume retirement failures during test cleanup as well as the normal result.
      const outcome = invocation.then(value=>({value}),error=>({error}));
      progress = turn.externalProgress as ChatGptExternalTurnProgress;
      let snapshot = progress.snapshot();
      while (snapshot.lastToolBatchRevision === 0) snapshot = await progress.waitForChange(snapshot.revision);
      firstBoundary.resolve();
      await allowAck.promise;
      await progress.acknowledgeToolBatch(progress.snapshot().lastToolBatchRevision);
      const result = await outcome;
      if ('error' in result) throw result.error;
      await callTurnBroker(socketPath,{method:'activity_complete',token,activityId:claimed.activityId});
      nativeResultObserved.resolve();
      // completeTool's ACK and the adapter's progress receipt are adjacent microtasks.
      for (let i=0;i<50 && progress.snapshot().activeToolCalls!==0;i++) await Bun.sleep(2);
      expect(progress.snapshot().activeToolCalls).toBe(0);
      turn.onTextDelta('Original command completed once.');
      return 'Original command completed once.';
    } finally { prepared.release(); }
  };
  const environment = `<environment_context><cwd>${tmpdir()}</cwd><filesystem><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const request: CodexParsedRequest = {
    modelId:CHATGPT_WEB_MODEL_ID,stream:true,options:{reasoning:'high'},
    context:{tools:[{name:'exec_command',description:'Local synthetic command',parameters:{type:'object'}}],messages:[{role:'user',content:'Run the synthetic command once',timestamp:1}]},
    _rawBody:{client_metadata:{'x-codex-turn-metadata':JSON.stringify({thread_id:'boundary-thread',turn_id:'boundary-turn'})},input:[
      {type:'message',role:'user',content:[{type:'input_text',text:environment}],internal_chat_message_metadata_passthrough:{turn_id:'boundary-turn'}},
      {type:'message',role:'user',content:[{type:'input_text',text:'Run the synthetic command once'}],internal_chat_message_metadata_passthrough:{turn_id:'boundary-turn'}},
    ]},
  };
  try {
    const adapter = createChatGptWebAdapter(provider,{broker});
    const first = adapter.runTurn!(request,{headers:new Headers(),abortSignal:disconnect.signal},()=>{}).then(()=>null,error=>error);
    runs.push(first);
    await Promise.race([firstBoundary.promise,first.then(error=>{throw error ?? Error('First stream ended before boundary');})]);
    disconnect.abort();
    expect((await first)?.name).toBe('AbortError');
    const events: AdapterEvent[] = [];
    const replay = adapter.runTurn!(request,{headers:new Headers()},event=>events.push(event));
    runs.push(replay.catch(()=>{}));
    await replayDelivered.promise;
    await Bun.sleep(5);
    expect(receivedCalls).toHaveLength(2);
    expect(receivedCalls[0]).toBe(receivedCalls[1]);
    expect(progress.snapshot().activeToolCalls).toBe(1);
    allowAck.resolve();
    await replay;
    const call = events.find((e): e is Extract<AdapterEvent,{type:'tool_call_start'}> => e.type==='tool_call_start')!;
    expect(call.id).toBe(receivedCalls[0]);
    const continuation = structuredClone(request);
    continuation.context.messages.push(
      {role:'assistant',content:[{type:'toolCall',id:call.id,name:'exec_command',arguments:{cmd:'synthetic single effect'}}],timestamp:2},
      {role:'toolResult',toolCallId:call.id,toolName:'exec_command',content:'{"output":"once","exit_code":0}',isError:false,timestamp:3},
    );
    (continuation._rawBody as {input:unknown[]}).input.push(
      {type:'function_call',call_id:call.id,name:'exec_command',arguments:'{"cmd":"synthetic single effect"}'},
      {type:'function_call_output',call_id:call.id,output:'{"output":"once","exit_code":0}'},
    );
    const final: AdapterEvent[] = [];
    await adapter.runTurn!(continuation,{headers:new Headers()},event=>final.push(event));
    await nativeResultObserved.promise;
    expect(final.at(-1)).toMatchObject({type:'done',endTurn:true,stopReason:'stop'});
    expect(browserStarts).toBe(1);
  } finally {
    allowAck.resolve();
    chatGptTurnSessions.clear();
    await broker.close();
    await Promise.allSettled(runs);
    worker.run = originalRun;
    broker.nextToolBatch = originalNext;
  }
}, 10_000);
