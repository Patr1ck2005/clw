import {test, expect} from 'bun:test';
import {ChatGptBrowserWorker} from '../upstream/src/adapters/chatgpt-web/browser-worker';

// Exercise the production selector without a model or any external page.
for(const draft of ['', 'another task\n{"transport":"do not append"}']){
  test(draft?'restored foreign draft is cleared before selecting the same connector':'empty selected connector is reused without edits',async()=>{
    let selected=true,clears=0,mentions=0,body=draft;
    const composer={fill:async()=>{body='';},focus:async()=>{},pressSequentially:async(value:string)=>{expect(value).toBe('@Local-MCP-B');mentions++;},press:async(key:string)=>{expect(key).toBe('Enter');selected=true;}};
    const row={waitFor:async()=>{},count:async()=>1,getAttribute:async()=>''};
    const page={url:()=> 'https://chatgpt.com/',getByText:()=>({}),locator:()=>({filter:()=>row})};
    const worker={config:{appName:'Local-MCP-B'},activeComposer:async()=>composer,connectorIsSelected:async()=>selected,
      attachedPromptText:async()=>body,clearChatGptComposerState:async()=>{clears++;body='';selected=false;},selectedConnectorControl:()=>row};
    const checkpoints:string[]=[];
    const result=await (ChatGptBrowserWorker.prototype as any).selectConnector.call(worker,page,async(c:string)=>{checkpoints.push(c);});
    expect(result).toBe(composer);expect(body).toBe('');expect(clears).toBe(draft?1:0);expect(mentions).toBe(draft?1:0);
    if(draft)expect(checkpoints).toContain('restored-draft-before-attachment');
  });
}
test('a draft observation failure cannot clear or submit anything',async()=>{
  let edits=0;
  const worker={config:{appName:'Local-MCP-B'},activeComposer:async()=>({}),connectorIsSelected:async()=>true,
    attachedPromptText:async()=>{throw Error('renderer unavailable');},clearChatGptComposerState:async()=>{edits++;}};
  const page={url:()=> 'https://chatgpt.com/',getByText:()=>({}),locator:()=>({filter:()=>({})})};
  await expect((ChatGptBrowserWorker.prototype as any).selectConnector.call(worker,page)).rejects.toThrow('renderer unavailable');
  // Selector owns cleanup on failure; it must never attempt another connector/send.
  expect(edits).toBeLessThanOrEqual(1);
});
