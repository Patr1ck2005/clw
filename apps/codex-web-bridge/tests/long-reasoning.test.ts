import {test,expect} from 'bun:test';
import {CHATGPT_STOP_BUTTON_SELECTOR} from '../upstream/src/chatgpt-session';
import {ChatGptBrowserWorker} from '../upstream/src/adapters/chatgpt-web/browser-worker';
const {createDocument}=require('../upstream/node_modules/@mixmark-io/domino');
test('new Chinese/English stop controls are generation evidence, unrelated page buttons are not',()=>{
 for(const label of ['Stop','停止','停止生成']){
  const doc=createDocument(`<button type="button" aria-label="${label}" id="unrelated"></button><form data-chatgpt-composer><button type="button" aria-label="${label}" id="current"></button></form>`);
  const selected=[...doc.querySelectorAll(CHATGPT_STOP_BUTTON_SELECTOR)];expect(selected.length).toBe(1);expect(selected[0].id).toBe('current');
 }
});
test('a reasoning phase outlives DOM grace and still binds the eventual assistant without a resend',async()=>{
 const invisible:any={isVisible:async()=>false,count:async()=>0,all:async()=>[],last(){return this;},first(){return this;},filter(){return this;}};
 const page:any={isClosed:()=>false,locator:()=>invisible,getByRole:()=>invisible,getByText:()=>invisible};
 let observations=0;
 const worker:any={submissionDomState:async()=>({turnIdentities:['group:user:1','group:assistant:1'],userIdentities:['group:user:1'],responseIdentities:++observations>3?['group:assistant:1']:[],visibleStopButtonCount:1}),waitForTurnDomOrExternalProgress:async()=>{await new Promise(r=>setTimeout(r,5));}};
 Object.setPrototypeOf(worker,ChatGptBrowserWorker.prototype);
 const result=await worker.waitForNewAssistantTurn(page,{initialTurnIdentities:[],domCache:{}},Date.now()+1000,undefined,undefined,1);
 expect(result.identity).toBe('group:assistant:1');expect(observations).toBe(4);
});
test('virtualizing the submitted user before assistant binding does not misclassify its remount as new input',async()=>{
 const invisible:any={isVisible:async()=>false,count:async()=>0,all:async()=>[],last(){return this;},first(){return this;},filter(){return this;}};
 const page:any={isClosed:()=>false,locator:()=>invisible,getByRole:()=>invisible,getByText:()=>invisible};
 let state:any={turnIdentities:['group:assistant:a'],userIdentities:[],responseIdentities:['group:assistant:a'],visibleStopButtonCount:0};
 const worker:any={submissionDomState:async()=>state,responseDomSnapshot:async()=>({responsePresent:true,completionActionVisible:true})};
 Object.setPrototypeOf(worker,ChatGptBrowserWorker.prototype);
 const baseline={initialTurnIdentities:[],domCache:{},acceptedUserIdentity:'group:user:u'};
 const binding=await (ChatGptBrowserWorker.prototype as any).waitForNewAssistantTurn.call(worker,page,baseline,Date.now()+1000);
 state={turnIdentities:['group:user:u','group:assistant:u'],userIdentities:['group:user:u'],responseIdentities:['group:assistant:u'],visibleStopButtonCount:0};
 const rebound=await (ChatGptBrowserWorker.prototype as any).reconcileAssistantTurnBinding.call(worker,page,baseline,binding);
 expect(rebound.identity).toBe('group:assistant:u');
 state={...state,userIdentities:['group:user:u','group:user:unrelated']};
 await expect((ChatGptBrowserWorker.prototype as any).reconcileAssistantTurnBinding.call(worker,page,baseline,binding)).rejects.toThrow('another user turn');
});
