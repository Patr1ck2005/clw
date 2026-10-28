import {test,expect} from 'bun:test';
import {guardWebRoute} from '../web-route';
test('native defaults cannot silently consume inference or image quota',async()=>{
  for (const path of ['/v1/responses','/v1/responses/compact']) {
    for (const model of [undefined,'gpt-6-astra']) {
      const r=await guardWebRoute(new Request('http://127.0.0.1'+path,{method:'POST',body:JSON.stringify({model,input:[]})}));
      expect(r?.status).toBe(400);
    }
    const req=new Request('http://127.0.0.1'+path,{method:'POST',body:JSON.stringify({model:'chatgpt-web/pro',input:[]})});
    expect(await guardWebRoute(req)).toBeUndefined();
    expect((await req.json()).model).toBe('chatgpt-web/pro');
  }
  expect((await guardWebRoute(new Request('http://127.0.0.1/v1/images/generations',{method:'POST'})))?.status).toBe(400);
  expect(await guardWebRoute(new Request('http://127.0.0.1/admin/cancel-turn',{method:'POST'}))).toBeUndefined();
});
