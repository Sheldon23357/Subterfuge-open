import type {CommanderThread} from '../../contracts/src/index.js';
import type {CommanderTransport} from './commander-chat-model.js';
/** The lab uses its existing seat capability, never the controller admin cookie. */
export function createLabCommanderTransport(player:number):CommanderTransport {
 let token='';let session:Promise<string>|null=null;
 async function claim(signal?:AbortSignal){
  if(token)return token;
  session??=fetch('/api/chat/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({seat:player}),...(signal?{signal}:{})}).then(async response=>{if(!response.ok)throw Error('Session unavailable');const value=await response.json();if(typeof value.token!=='string')throw Error('Session unavailable');return token=value.token;}).finally(()=>{session=null;});
  return session;
 }
 return async(action,data,signal)=>{
  const credential=await claim(signal);
  const response=await fetch('/api/commander/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Seat-Token':credential},body:JSON.stringify(data??{}),...(signal?{signal}:{})});
  if(!response.ok){
   // The lab's chat capability is held in memory by the server. After a
   // restart, the page may still have the old token; discard it so the next
   // list poll claims a fresh capability and reconnects the dock.
   if(response.status===400||response.status===401||response.status===403)token='';
   throw Error('Commander request rejected');
  }
  return response.json() as Promise<CommanderThread>;
 };
}
