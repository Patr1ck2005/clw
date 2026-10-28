'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('clw',Object.freeze({
  command:(action,payload={})=>ipcRenderer.invoke('clw-command',{action,payload}),
  onState:callback=>ipcRenderer.on('clw-state',(_event,state)=>callback(state)),
  onIntent:callback=>ipcRenderer.on('clw-intent',(_event,intent)=>callback(intent)),
  onControl:callback=>ipcRenderer.on('clw-ui-control',(_event,request)=>callback(request)),
  respondControl:message=>ipcRenderer.send('clw-ui-control-response',message)
}));
