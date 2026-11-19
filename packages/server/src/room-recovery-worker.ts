import {parentPort,workerData} from 'node:worker_threads';
import {LobbyStore} from './lobby-store.js';
const {path,buildId,audit}=workerData as {path:string;buildId:string;audit:boolean};
let store:LobbyStore|undefined;
try{
 store=new LobbyStore(path,{}, {buildId,auditOnly:audit});
 if(audit)store.verify();else if(!store.current())throw Error('Room has no committed lobby');
 const usedCheckpoint=store.recoveredFromCheckpoint;
 if(!audit)store.checkpoint(true);store.close(false);store=undefined;
 parentPort!.postMessage({ok:true,usedCheckpoint});
}catch{
 try{store?.close(false);}catch{}
 parentPort!.postMessage({ok:false});
}
