import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {clwUserAuthorization} from '../src/adapters/chatgpt-web/clw-user-authorization';
test('absent private release consent yields no prompt authorization and creates no file',()=>{
 const old=process.env.CLW_WEB_AUTHORIZATION_FILE,folder=mkdtempSync(path.join(tmpdir(),'clw-consent-'));
 try{process.env.CLW_WEB_AUTHORIZATION_FILE=path.join(folder,'absent.json');expect(clwUserAuthorization()).toEqual([]);}
 finally{if(old===undefined)delete process.env.CLW_WEB_AUTHORIZATION_FILE;else process.env.CLW_WEB_AUTHORIZATION_FILE=old;rmSync(folder,{recursive:true,force:true});}
});
test('existing explicit policy works while malformed/unreadable policy preserves its error',()=>{
 const old=process.env.CLW_WEB_AUTHORIZATION_FILE,folder=mkdtempSync(path.join(tmpdir(),'clw-consent-')),file=path.join(folder,'policy.json');
 try{
  process.env.CLW_WEB_AUTHORIZATION_FILE=file;writeFileSync(file,JSON.stringify({version:1,enabled:true,text:'Explicit user consent',recover_ended_turns:true}));
  expect(clwUserAuthorization()).toEqual(['Explicit user consent']);
  for(const p of [[],{version:1,enabled:'true'},{version:1,enabled:true,text:'Explicit',auto_approve_returned_files:'true'}]){
   writeFileSync(file,JSON.stringify(p));expect(()=>clwUserAuthorization()).toThrow('web_user_authorization_invalid');
  }
  writeFileSync(file,'{invalid');expect(()=>clwUserAuthorization()).toThrow();
  process.env.CLW_WEB_AUTHORIZATION_FILE=folder;expect(()=>clwUserAuthorization()).toThrow();
 }finally{if(old===undefined)delete process.env.CLW_WEB_AUTHORIZATION_FILE;else process.env.CLW_WEB_AUTHORIZATION_FILE=old;rmSync(folder,{recursive:true,force:true});}
});
