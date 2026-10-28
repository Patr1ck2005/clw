'use strict';
// Pure startup protocol. Requiring this module has no app or project effects.
const FLAG='--clw-focus-existing-only',TARGET='--clw-focus-target=';
const validToken=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const isFocusOnly=argv=>Array.isArray(argv)&&argv.some(value=>typeof value==='string'&&
  (value===FLAG||value.startsWith(FLAG+'=')||value.startsWith(TARGET)));
function runFocusOnly({app,argv,profile}){
  const targets=argv.filter(value=>typeof value==='string'&&value.startsWith(TARGET));
  const token=argv.filter(value=>value===FLAG).length===1&&targets.length===1?targets[0].slice(TARGET.length):null;
  // A duplicate can lose its target between observation and process creation.
  // Even if it wins the Electron lock it never initializes a workspace.
  if(validToken(token)){
    app.setPath('userData',profile);app.setName('CLWWebWorkspace');
    app.requestSingleInstanceLock({clwFocusExistingOnly:1,expectedGuiToken:token});
  }
  app.quit();
}
function shouldFocusExisting(argv,data,token){
  const marked=isFocusOnly(argv)||(Array.isArray(argv)&&argv.some(value=>typeof value==='string'&&value.startsWith(TARGET)))||
    (data&&typeof data==='object'&&(Object.hasOwn(data,'clwFocusExistingOnly')||Object.hasOwn(data,'expectedGuiToken')));
  if(!marked)return true; // Keep ordinary user launches compatible.
  return !!(data&&typeof data==='object'&&!Array.isArray(data)&&
    Object.keys(data).length===2&&Object.hasOwn(data,'clwFocusExistingOnly')&&Object.hasOwn(data,'expectedGuiToken')&&
    data.clwFocusExistingOnly===1&&validToken(data.expectedGuiToken)&&data.expectedGuiToken===token);
}
module.exports={FLAG,TARGET,isFocusOnly,runFocusOnly,shouldFocusExisting};
