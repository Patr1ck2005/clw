import { test, expect } from "bun:test";
import { forgetRetainedSystemContext, rememberRetainedSystemContext, retainedSystemContext, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
function request(): CodexParsedRequest {
  return {modelId:CHATGPT_WEB_MODEL_ID,stream:true,options:{reasoning:"high"},context:{systemPrompt:["Fixed project guidance"],messages:[
    {role:"user",content:"Initial task",timestamp:1},
    {role:"assistant",content:[{type:"text",text:"Completed initial work"}],timestamp:2},
    {role:"user",content:"New requirement",timestamp:3}]}};
}

test("retained system context is acknowledged only explicitly, preserves changes and is bounded", () => {
  const key="retained-context-test",parsed=request();forgetRetainedSystemContext(key);
  const prepared=retainedConversationResumeRequest(parsed,retainedSystemContext(key))!;
  expect(prepared.context.systemPrompt).toEqual(parsed.context.systemPrompt);
  expect(retainedSystemContext(key)).toBeUndefined();
  rememberRetainedSystemContext(key,parsed);
  const resumed=retainedConversationResumeRequest(parsed,retainedSystemContext(key))!;
  expect(resumed.context.systemPrompt).toEqual([]);expect(resumed.context.messages).toHaveLength(1);
  parsed.context.systemPrompt=["Revised project guidance"];
  const changed=retainedConversationResumeRequest(parsed,retainedSystemContext(key))!;
  expect(changed.context.systemPrompt).toContain("Revised project guidance");
  expect(changed.context.systemPrompt).not.toContain("Fixed project guidance");
  expect(retainedSystemContext(key)).toEqual(["Fixed project guidance"]);
  parsed.context.systemPrompt=[];
  expect(retainedConversationResumeRequest(parsed,retainedSystemContext(key))!.context.systemPrompt).toHaveLength(1);
  for(let i=0;i<65;i++)rememberRetainedSystemContext("bounded-context-"+i,parsed);
  expect(retainedSystemContext(key)).toBeUndefined();
  for(let i=0;i<65;i++)forgetRetainedSystemContext("bounded-context-"+i);
  parsed.context.systemPrompt=["x".repeat(2*1024*1024)];
  rememberRetainedSystemContext(key,parsed);expect(retainedSystemContext(key)).toBeUndefined();
});

test("retained work uses concise routing with a fresh native token and original tool identity",()=>{
  const parsed=request(),token="turn_12345678901234567890123456789012";
  const full=compileChatGptWebPrompt(parsed,caps,token);
  const resumed=retainedConversationResumeRequest(parsed,parsed.context.systemPrompt)!;
  const delta=compileChatGptWebPrompt(resumed,caps,token,{retainedContext:true});
  expect(delta.text.length).toBeLessThan(full.text.length/2);
  expect(delta.text).toContain("New requirement");expect(delta.text).not.toContain("Fixed project guidance");
  expect(delta.text).toContain("codex_tool_call");expect(delta.text).not.toContain("work_on_project");
  expect(delta.text.match(new RegExp(token,"g"))).toHaveLength(1);
  expect(delta.text).not.toContain("configured sandbox and approval rules");
});
