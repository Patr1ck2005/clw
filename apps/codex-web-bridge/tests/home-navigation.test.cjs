'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {installSlowNavigationNotice}=require('../home-navigation.cjs');

test('slow startup and later reloads leave unfinished resources running without claiming signed out',()=>{
  let loading=true,destroyed=false,clears=0;const timers=[],states=[];
  const contents={isDestroyed:()=>destroyed,isLoadingMainFrame:()=>loading,getURL:()=> 'https://chatgpt.com/',stop:()=>assert.fail('canceled unfinished bootstrap')};
  const host={view:{webContents:contents},logger:{warn(){}},clearHomeNavigationTimeout(){clears++;},setState:s=>states.push(s)};
  installSlowNavigationNotice(host,{setTimer:(callback,ms)=>{assert.equal(ms,180000);timers.push(callback);return {unref(){}};}});
  assert.equal(timers.length,1);timers[0]();assert.equal(states.length,1);
  assert.equal(states[0].loading,true);assert.equal(states[0].authenticated,undefined);
  host.armHomeNavigationTimeout(contents,contents.getURL());loading=false;timers[1]();assert.equal(states.length,1);
  host.armHomeNavigationTimeout(contents,contents.getURL());loading=true;destroyed=true;timers[2]();assert.equal(states.length,1);
  assert.equal(clears,4);
});
