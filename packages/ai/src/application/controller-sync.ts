import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {localAgentConnections} from './local-agent-connections.js';
import {probeAgentConnection} from './agent-console.js';
import type {AgentRuntime} from './agent-runtime.js';

/** Project-local handoff: player credentials only, never the game database. */
export function controllerSynchronizer(runtime:AgentRuntime,directory:string,port:number){
 if(!runtime.fixedController)throw Error('Local controller synchronization requires fixed slots');
 let pending:Promise<void>|undefined,applied='';
 const readRequested=async()=>{
  let requested:{format:string;roomId:string;bindings:{seat:number;slot:number}[]}|undefined;
  try{requested=JSON.parse(await readFile(join(directory,'controller-bindings.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Invalid controller bindings');}
  if(requested){
   if(requested.format!=='controller-bindings/1'||typeof requested.roomId!=='string'||!Array.isArray(requested.bindings)||requested.bindings.length>8)throw Error('Invalid controller bindings');
   const slots=new Set<number>(),seats=new Set<number>();
   for(const binding of requested.bindings){if(!Number.isInteger(binding.slot)||binding.slot<0||binding.slot>7||!Number.isInteger(binding.seat)||binding.seat<0||binding.seat>9||slots.has(binding.slot)||seats.has(binding.seat))throw Error('Duplicate or invalid binding');slots.add(binding.slot);seats.add(binding.seat);}
  }
  return requested;
 };
 const sync=async()=>{
  if(runtime.checkpointActive)return;
  const requested=await readRequested();
  const signature=JSON.stringify(requested??null);if(signature===applied)return;
  const targets=new Map<number,{config:Awaited<ReturnType<typeof probeAgentConnection>>;token:string}>();
  if(requested){
   const credentials=await localAgentConnections(directory,port);
   for(const binding of requested.bindings){
    const candidate=credentials.find(c=>c.roomId===requested!.roomId&&c.player===binding.seat);if(!candidate)throw Error('Binding does not match current player credentials');
    const identity=await probeAgentConnection(candidate.serverUrl,candidate.token,AbortSignal.timeout(2000));
    if(identity.roomId!==requested.roomId||identity.lobbySeat!==binding.seat)throw Error('Binding identity changed');
    targets.set(binding.slot,{config:identity,token:candidate.token});
   }
  }
  for(const status of runtime.status()){
   const config=runtime.consoleConfig().seats.find(s=>s.id===status.id);
   if(status.bound&&config?.serverUrl!==`http://127.0.0.1:${port}`)continue;
   const target=targets.get(status.controllerSlot!);
   if(status.bound&&(!target||target.config.roomId!==status.roomId||target.config.lobbySeat!==status.lobbySeat))await runtime.unbindControllerSlot(status.controllerSlot!);
  }
  for(const [slot,target]of targets){
   const current=runtime.consoleConfig().seats.find(s=>s.controllerSlot===slot);
   if(current?.bound&&current.serverUrl!==`http://127.0.0.1:${port}`)continue;
   await runtime.bindControllerSlot(slot,{...target.config,id:`ai-${String(slot+1).padStart(2,'0')}`,tokenEnv:'LOCAL_CONTROLLER_TOKEN',settings:{model:'',personality:'schemer'}},target.token);
  }
  applied=signature;
 };
 const publish=async()=>{
  const configs=runtime.consoleConfig().seats;
  const slots=runtime.status().map(s=>({slot:s.controllerSlot,id:s.id,bound:s.bound,roomId:s.roomId,seat:s.bound?s.lobbySeat:null,gamePlayer:s.bound?s.gamePlayer:null,enabled:s.enabled,status:s.status,busy:s.busy,provider:configs.find(c=>c.id===s.id)?.providerConfig.kind,model:configs.find(c=>c.id===s.id)?.settings.model??''}));
  const path=join(directory,'ai-controller-slots.json');await writeFile(path+'.tmp',JSON.stringify({format:'ai-controller-slots/1',checkpointProtocol:1,pid:process.pid,updatedAt:Date.now(),slots}));await rename(path+'.tmp',path);
 };
 const enqueue=(task:()=>Promise<void>)=>{
  const next=(pending??Promise.resolve()).catch(()=>{}).then(task).finally(()=>{if(pending===next)pending=undefined;});
  pending=next;return next;
 };
 const synchronize=()=>pending??enqueue(async()=>{try{await sync();}finally{await publish();}});
 return Object.assign(synchronize,{disconnect:(id:string)=>enqueue(async()=>{
  const status=runtime.status().find(s=>s.id===id);
  if(!status?.bound||status.controllerSlot===undefined)throw Error('Slot is not connected');
  const requested=await readRequested();
  if(requested?.roomId===status.roomId){
   requested.bindings=requested.bindings.filter(b=>b.slot!==status.controllerSlot||b.seat!==status.lobbySeat);
   const path=join(directory,'controller-bindings.json');
   await writeFile(path+'.disconnect.tmp',JSON.stringify(requested));await rename(path+'.disconnect.tmp',path);
  }
  await runtime.unbindControllerSlot(status.controllerSlot);
  // Force the next synchronization to apply any other changes in the handoff file.
  applied='';await publish();
 })});
}
