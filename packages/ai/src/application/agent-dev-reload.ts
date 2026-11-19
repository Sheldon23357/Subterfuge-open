interface ReloadSeat {
 id:string;serverUrl:string;roomId:string;lobbySeat:number;gamePlayer?:number;
 enabled:boolean;bound?:boolean;status:string;busy?:boolean;starting?:boolean;owned?:boolean;
 checkpoint?:{blocked:boolean};error?:string|null;
}
export type ReloadIdentity=Pick<ReloadSeat,'id'|'serverUrl'|'roomId'|'lobbySeat'|'gamePlayer'>;
interface ReloadRuntime {status():ReloadSeat[];pause(id:string):Promise<void>;start(id:string):Promise<void>}
const identity=(s:ReloadSeat):ReloadIdentity=>({id:s.id,serverUrl:s.serverUrl,roomId:s.roomId,lobbySeat:s.lobbySeat,...s.gamePlayer!==undefined?{gamePlayer:s.gamePlayer}:{}});
const matches=(s:ReloadSeat,b:ReloadIdentity)=>s.bound!==false&&s.id===b.id&&s.roomId===b.roomId&&s.serverUrl===b.serverUrl&&s.lobbySeat===b.lobbySeat&&s.gamePlayer===b.gamePlayer;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** Only an in-memory handoff from the supervising development process resumes
 * seats. Bindings are checked again after startup; cold starts continue to
 * require explicit user authorization. */
export async function prepareDevReload(runtime:ReloadRuntime):Promise<ReloadIdentity[]>{
 const status=runtime.status();
 if(status.some(s=>s.checkpoint?.blocked))throw Error('A coordinated checkpoint is active');
 const running=status.filter(s=>s.bound!==false&&s.status!=='ended'&&(s.enabled||s.starting)).map(identity);
 const paused=await Promise.allSettled(status.filter(s=>s.bound!==false&&(s.enabled||s.busy||s.starting||s.owned)).map(s=>runtime.pause(s.id)));
 if(paused.some(r=>r.status==='rejected')){
  await Promise.allSettled(running.filter(b=>runtime.status().some(s=>matches(s,b))).map(b=>runtime.start(b.id)));
  throw Error('Development reload could not drain all seats');
 }
 return running;
}

export async function resumeDevReload(runtime:ReloadRuntime,seats:readonly ReloadIdentity[],timeoutMs=30000){
 const pending=new Map(seats.map(s=>[s.id,s]));
 const results:{id:string;status:'resumed'|'skipped'|'failed';reason?:string}[]=[];
 const deadline=Date.now()+timeoutMs;
 while(pending.size){
  const available=runtime.status();
  const ready:ReloadIdentity[]=[];
  for(const [id,before]of pending){
   const current=available.find(s=>s.id===id&&s.bound!==false);
   if(!current)continue;
   pending.delete(id);
   if(!matches(current,before)||current.status==='ended')results.push({id,status:'skipped',reason:'binding-changed-or-ended'});
   else ready.push(before);
  }
  const started=await Promise.allSettled(ready.map(s=>runtime.start(s.id)));
  for(let i=0;i<ready.length;i++){
   const before=ready[i]!,current=runtime.status().find(s=>matches(s,before));
   const ok=started[i]!.status==='fulfilled'&&current?.enabled&&!current.error;
   results.push({id:before.id,status:ok?'resumed':'failed',...ok?{}:{reason:'seat-start-failed'}});
  }
  if(!pending.size)break;
  if(Date.now()>=deadline){for(const id of pending.keys())results.push({id,status:'failed',reason:'binding-not-ready'});break;}
  await sleep(Math.min(100,Math.max(0,deadline-Date.now())));
 }
 return results;
}

/** Private parent/child IPC, with no HTTP shutdown endpoint or saved autorun flag. */
export function installDevReloadIPC(runtime:ReloadRuntime,close:()=>Promise<void>){
 if(process.env.AI_CONSOLE_DEV_RELOAD!=='1'||!process.send)return;
 let work=Promise.resolve();
 process.on('message',(raw:unknown)=>{
  const message=raw as {kind?:string;requestId?:string;seats?:ReloadIdentity[]};
  if(!message||typeof message.requestId!=='string'||!['dev-reload-prepare','dev-reload-resume','dev-reload-stop'].includes(message.kind??''))return;
  work=work.then(async()=>{
   try{
    const result=message.kind==='dev-reload-prepare'?await prepareDevReload(runtime)
     :message.kind==='dev-reload-resume'?await resumeDevReload(runtime,message.seats??[]):await close();
    if(process.connected)process.send!({kind:'dev-reload-result',requestId:message.requestId,result});
    if(message.kind==='dev-reload-stop'&&process.connected)process.disconnect();
   }catch{if(process.connected)process.send!({kind:'dev-reload-result',requestId:message.requestId,error:'Development reload handoff failed'});}
  });
 });
 process.once('disconnect',()=>{void close();});
}
