import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {saveSource} from '../turn-source.cjs';
import {saveReview,readReview} from '../turn-review.cjs';
const source={traceId:'abcdef123456',threadId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222',model:'chatgpt-web/pro',workingDirectory:'D:/fixture'};
const final='Original **Markdown**\n$$x^2$$\n```cs\nreturn 1;\n```';
function fixture(run:(home:string,file:string,replay:any)=>void){
 const home=mkdtempSync(join(tmpdir(),'clw-review-display-'));
 try{saveSource(home,source);saveReview(home,source.traceId,final);const dir=join(home,'runtime','native-final-replay');mkdirSync(dir,{recursive:true});
  const file=join(dir,source.traceId+'.json'),replay={...source,events:[{type:'text_delta',phase:'commentary',text:'Not the final'},{type:'text_delta',phase:'final_answer',text:final},{type:'done',endTurn:true,stopReason:'stop'}]};
  run(home,file,replay);
 }finally{rmSync(home,{recursive:true,force:true});}
}
test('record display reads exact saved final without flattening Markdown or changing original files',()=>fixture((home,file,replay)=>{
 writeFileSync(file,JSON.stringify(replay));const before=readFileSync(file,'utf8');
 expect(readReview(home,source.traceId).finalText).toBe(final);expect(readFileSync(file,'utf8')).toBe(before);
}));
test('record display rejects another turn, missing terminal, or mismatched final instead of guessing',()=>{
 for(const kind of ['identity','terminal','content'])fixture((home,file,replay)=>{
  if(kind==='identity')replay.turnId='33333333-3333-4333-8333-333333333333';
  if(kind==='terminal')replay.events.pop();if(kind==='content')replay.events[1].text='wrong result';
  writeFileSync(file,JSON.stringify(replay));expect(readReview(home,source.traceId).finalText).toBeNull();
 });
});
