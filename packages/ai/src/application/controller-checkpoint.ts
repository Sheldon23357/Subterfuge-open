import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {AgentRuntime} from './agent-runtime.js';
import {atomicCheckpointJson,parseCheckpointRequest,readCheckpointJson} from '../controller/storage/checkpoint-files.js';

/** Same local handoff directory as bindings; request paths never come from a browser. */
export function controllerCheckpoints(runtime:AgentRuntime,directory:string){
 let pending:Promise<void>|undefined,active:string|undefined,expiresAt=0;
 const requestPath=join(directory,'checkpoint-request.json'),responsePath=join(directory,'checkpoint-response.json');
 const processRequest=async()=>{
  if(active&&Date.now()>=expiresAt){const id=active;active=undefined;try{await runtime.releaseCheckpoint();}finally{await atomicCheckpointJson(responsePath,{id,status:'expired'});}}
  let request;try{request=parseCheckpointRequest(await readCheckpointJson(requestPath));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(request.phase==='release'){
   if(active===request.id){active=undefined;try{await runtime.releaseCheckpoint();await atomicCheckpointJson(responsePath,{id:request.id,status:'released'});}catch(error){await atomicCheckpointJson(responsePath,{id:request.id,status:'release-failed',error:error instanceof Error?error.message:'控制权重新领取失败，请检查 AI 席位状态'});}return;}
   if(!active){
    let response;try{response=await readCheckpointJson(responsePath);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(response?.id!==request.id||!['released','release-failed'].includes(response.status))await atomicCheckpointJson(responsePath,{id:request.id,status:'released'});
   }
   return;
  }
  if(request.expiresAt<=Date.now()||request.expiresAt>Date.now()+900000||active)return;
  // An old completed/failed request is never replayed by a later timer or restart.
  try{if((await readCheckpointJson(responsePath)).id===request.id)return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  active=request.id;expiresAt=request.expiresAt;
  try{
   const destination=join(directory,'checkpoints','.pending-'+request.id,'ai');
   await mkdir(destination,{recursive:true,mode:0o700});
   const metadata=await runtime.prepareCheckpoint(destination,request.roomId,request.bindings,request.expiresAt);
   const latest=parseCheckpointRequest(await readCheckpointJson(requestPath));
   if(latest.id!==request.id||latest.phase!=='prepare')throw Error('Checkpoint cancelled');
   if(Date.now()>=request.expiresAt)throw Error('Checkpoint expired');
   await atomicCheckpointJson(join(destination,'controller.json'),metadata);
   await atomicCheckpointJson(responsePath,{id:request.id,status:'ready'});
  }catch{
   active=undefined;if(runtime.checkpointActive)await runtime.releaseCheckpoint().catch(()=>{});
   await atomicCheckpointJson(responsePath,{id:request.id,status:'failed',error:'AI 存档失败或等待收尾超时'});
  }
 };
 return ()=>pending??(pending=processRequest().finally(()=>{pending=undefined;}));
}
