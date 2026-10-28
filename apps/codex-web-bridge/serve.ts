// Long-lived private loopback owner of the pinned upstream server, turn broker,
// helper and browser sessions. The published HTTP socket has a separate owner.
import {loadConfig,getConfigDir} from './upstream/src/config';
import {startServer} from './upstream/src/server';
import {guardWebRoute} from './web-route';
import {observedAdapter} from './observed-adapter';
import {runtimeOwnerEpoch} from './native-turn-admission';
import {readNativeOwnerAdmissions} from './native-owner-admissions';
import maintenanceSession from './native-maintenance-session.cjs';
import path from 'node:path';
import {settings} from './bridge-config.cjs';
import {createToolCheck} from './tool-readiness.cjs';
import {guardToolRoute} from './tool-route.cjs';
const config=loadConfig();
const root=path.resolve(import.meta.dir,'../..');
const checkTools=guardToolRoute(createToolCheck(root,{transport:settings(root).transport}));
const requestGuard=async(req:Request)=>(await guardWebRoute(req))||(await checkTools(req));
const server=startServer(config,{requestGuard,adapterFactory:observedAdapter,maintenanceAuthority:{ownerEpoch:runtimeOwnerEpoch,
 operationHistoryDirectory:path.join(getConfigDir(),'runtime/native-maintenance-operations'),
 // The reader retires only canonical verified terminals. Its history digest
 // remains part of the same fence CAS; pending/unknown original work stays live.
 read:()=>readNativeOwnerAdmissions(getConfigDir(),runtimeOwnerEpoch,process.env.CLW_WEB_ACCOUNT||'B'),
 verifySessions:(admitted,expected)=>{const current=maintenanceSession.readMaintenanceSessions(admitted,{account:process.env.CLW_WEB_ACCOUNT||'B'});
   if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('native_maintenance_session_changed');}},
 // The permanent owner await below is deliberate. Only a verified maintenance
 // shutdown settles it through an explicit normal exit after physical cleanup.
 onShutdownSettled:value=>{if(value.maintenance)process.exit(value.clean?0:1);}});
console.log(JSON.stringify({ready:true,port:server.port,mode:config.mode}));
// Upstream owns bounded turn/helper/broker shutdown on SIGTERM and SIGINT.
await new Promise(()=>{});
