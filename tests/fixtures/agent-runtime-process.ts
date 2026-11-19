/** No server imports: this process has only a player URL and synthetic identity. */
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {AgentRuntime} from '../helpers/scripted-controller.js';
import {agentStoreKey} from '../../packages/ai/src/reference.js';
import {parseAgentConfig} from '../../packages/ai/src/controller/contracts/agent-config.js';
import type {AgentProvider} from '../../packages/ai/src/controller/contracts/types.js';
process.send?.({kind:'ready',pid:process.pid});
process.once('message',async raw=>{
 const input=raw as {config:unknown;live:boolean;env:Record<string,string>;seatId:string;attemptOrder:boolean};
 let runtime:AgentRuntime|undefined,calls=0;
 const provider:AgentProvider={step:async request=>{
   const o=JSON.parse(request.prompt).snapshot.observation;
   const own=o.view.outposts.find((p:{owner:number})=>p.owner===o.view.player);
   const ownName=own&&o.outpostNames[own.id];
   if(input.attemptOrder&&!ownName)throw Error('Missing authorized own outpost name');
   return {tokens:0,reply:++calls===1&&input.attemptOrder
     ?{tool:'order',arguments:{action:{kind:'set-shields',outpostId:ownName!,enabled:false}},summary:'Synthetic command'}
     :{tool:'finish',arguments:{},summary:'Synthetic finish'}};
 }};
 try{
  runtime=new AgentRuntime(parseAgentConfig(input.config),provider,input.env);
  await runtime.runOne(input.seatId);
  const status=runtime.status();
  const db=new DatabaseSync(join(runtime.config.storeDirectory,agentStoreKey(runtime.config.seats[0]!)+'.sqlite'),{readOnly:true});
  const rejected=db.prepare("SELECT payload FROM journal WHERE kind='tool-rejected'").all();db.close();
  process.send?.({kind:'result',pid:process.pid,calls,status,rejected});
 }catch(error){process.send?.({kind:'error',message:error instanceof Error?error.message:'Failed'});process.exitCode=1;}
 finally{await runtime?.shutdown();process.disconnect?.();}
});
