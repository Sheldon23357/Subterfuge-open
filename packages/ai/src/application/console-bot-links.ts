import {randomBytes} from 'node:crypto';
import type {ConsoleService} from './console-service.js';
interface Link {id:string;slot:string;roomId:string;origin:string;code:string;token:string;name:string}
export class ConsoleBotLinks {
 private links=new Map<string,Link>();
 private timer:ReturnType<typeof setInterval>;
 private closed=false;
 private refreshing:Promise<void>|null=null;
 constructor(private runtime:ConsoleService){this.timer=setInterval(()=>{if(!this.refreshing)this.refreshing=this.refresh().finally(()=>{this.refreshing=null;});},10000);this.timer.unref();}
 private async write(link:Link,method:'POST'|'DELETE'){
  const seat=this.runtime.consoleConfig().seats.find(seat=>seat.id===link.slot);
  const model=seat?.providerConfig.kind==='offline'?'自主决策':seat?.providerConfig.model||seat?.settings.model||'未选择模型';
  const response=await fetch(new URL(`/api/rooms/${link.code}/bots`,link.origin),{method,headers:{Authorization:`Bearer ${link.token}`,'Content-Type':'application/json'},body:JSON.stringify({id:link.id,...(method==='POST'?{name:link.name,model}:{})}),redirect:'error',signal:AbortSignal.timeout(5000)});
  await response.body?.cancel();if(!response.ok)throw Error('大厅席位连接未获确认，可能已被其他 bot 连接。');
 }
 async reserve(input:Omit<Link,'id'>){const link={...input,id:randomBytes(24).toString('hex')};await this.write(link,'POST');return link;}
 commit(link:Link){this.links.set(link.slot,link);}
 roomCode(id:string){return this.links.get(id)?.code;}
 async release(link:Link){try{await this.write(link,'DELETE');}catch{ /* Presence expires without a successful heartbeat. */ }}
 private async refresh(){
  if(this.closed)return;
  for(const [id,link] of this.links){
   const seat=this.runtime.status().find(seat=>seat.id===id&&seat.bound!==false&&seat.roomId===link.roomId);
   if(!seat){this.links.delete(id);await this.release(link);continue;}
   try{await this.write(link,'POST');}catch{ /* Do not advertise connectivity when the authority cannot be reached. */ }
  }
 }
 async disconnect(id:string){const link=this.links.get(id);if(link){this.links.delete(id);await this.release(link);}}
 async close(){this.closed=true;clearInterval(this.timer);await this.refreshing;await Promise.all([...this.links.values()].map(link=>this.release(link)));this.links.clear();}
}
