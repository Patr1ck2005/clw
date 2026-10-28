import {test,expect} from 'bun:test';
import {compileChatGptWebPrompt} from '../upstream/src/adapters/chatgpt-web/prompt';
import {CHATGPT_WEB_MODEL_ID} from '../upstream/src/adapters/chatgpt-web/model';
import type {CodexParsedRequest} from '../upstream/src/types';

test('shared connector retains native authority for both working models without changing the user task',()=>{
  for(const reasoning of ['xhigh','max'] as const){
    const request:CodexParsedRequest={modelId:CHATGPT_WEB_MODEL_ID,stream:true,options:{reasoning},
      context:{systemPrompt:[],messages:[{role:'user',content:'Read the scoped input and report the sum.',timestamp:1}]}};
    const token='turn_12345678901234567890123456789012';
    const {text}=compileChatGptWebPrompt(request,{localToolsEnabled:true,solAvailable:true,extraHighAvailable:true,proAvailable:true},token);
    const context=JSON.parse(text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!);
    expect(context.messages).toContainEqual(expect.objectContaining({role:'user',content:request.context.messages[0]!.content}));
    expect(text).toContain('codex_tool_call for discovered native operations');
    expect(text).toContain('Do not substitute Workflow Session tools');
    expect(text).toContain('configured sandbox and approval rules');
    expect(text).toContain(`Pass turn_token ${token} unchanged`);
  }
});
