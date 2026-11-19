import type {CommunicationResult} from '../contracts/bot-mode.js';
import type {AiSnapshot,AiState,GameGateway} from '../contracts/types.js';
import {gameSeconds} from '../contracts/types.js';
import {executeTool} from '../execution/tools.js';
import {GameRequestError} from '../transport/gateway.js';
import {manualVersion} from '../execution/manual-coordination.js';

export interface CommunicationWrite extends CommunicationResult {
 arguments:{to:number|number[]|null;text:string};basisRevision:string;
}
interface Host {
 state:AiState;snapshot:AiSnapshot;gateway:GameGateway;signal:AbortSignal;
 latest:()=>CommunicationWrite|undefined;
 save:(write:CommunicationWrite)=>void;
 guard:(args:Record<string,unknown>)=>void;
}
/** One durable logical send. Unknown results are read by original identity,
 * never submitted again, and never enter the tactical pending-write ledger. */
export async function sendCommunication(host:Host,id:string,args:CommunicationWrite['arguments']):Promise<CommunicationResult>{
 const previous=host.latest();
 if(previous?.requestId===id){
  if(JSON.stringify(previous.arguments)!==JSON.stringify(args))throw Error('Communication identity reused with different content');
  if(previous.status!=='unknown')return previous;
  let resolutions;
  try{resolutions=await host.gateway.reconcileWrites?.([{id,tool:'say',arguments:previous.arguments,basisRevision:previous.basisRevision}]);}
  catch{return previous;}
  const resolution=resolutions?.find(r=>r.id===id);
  if(!resolution||resolution.status==='unknown')return previous;
  const next:CommunicationWrite={...previous,status:resolution.status==='committed'?'accepted':'rejected',result:resolution};
  if(next.status==='accepted')host.state.lastSpoke=gameSeconds(host.snapshot);
  host.save(next);return next;
 }
 if(previous?.status==='unknown')return {requestId:id,status:'unknown',result:{reason:'Previous communication outcome is unresolved'}};
 const write:CommunicationWrite={requestId:id,status:'unknown',arguments:args,basisRevision:host.snapshot.observation.revision,result:{reason:'Dispatch intent persisted'}};
 // Persist before transport. A crash at any later point must reconcile this ID.
 host.save(write);
 let dispatched=false,result:unknown,status:CommunicationResult['status'];
 try{
  await host.gateway.commanderCheck?.(host.state.commanderDirectives?.version??0);
  await host.gateway.manualCheck?.(manualVersion(host.snapshot.observation));
  host.signal.throwIfAborted();
  const gateway:GameGateway={snapshot:(...a)=>host.gateway.snapshot(...a),request:async(path,data)=>{dispatched=true;return host.gateway.request(path,data);}};
  result=await executeTool('say',args,{state:host.state,snapshot:host.snapshot,gateway,id,spoken:0,now:gameSeconds(host.snapshot),signal:host.signal,
   beforeEffect:()=>{host.signal.throwIfAborted();if(!host.state.enabled)throw Error('Communication paused');host.guard(args);}});
  const r=result as {accepted?:boolean;status?:string;receipt?:{effectCommitted?:boolean}};
  status=r?.accepted===true||r?.status==='sent'||r?.receipt?.effectCommitted===true?'accepted':'unknown';
 }catch(error){
  status=!dispatched||error instanceof GameRequestError&&error.status<500&&error.status!==408?'rejected':'unknown';
  result={reason:error instanceof Error?error.message:'Communication failed'};
 }
 if(status==='accepted')host.state.lastSpoke=gameSeconds(host.snapshot);
 const next={...write,status,result};host.save(next);return next;
}
