import type {HybridState,OperationState} from './contracts.js';
import {conversationKey} from './conversation-evidence.js';
const ended=(status:string)=>['completed','ended','cancelled','expired','failed'].includes(status);
/** Compact the working projection only. Original facts, receipts and model publications remain in the journal. */
export function compactHybrid(state:HybridState,operations:OperationState[],self:number){
 const tasks=new Map<string,HybridState['tasks'][number]>();for(const t of state.tasks){tasks.delete(t.id);tasks.set(t.id,t);}const taskRows=[...tasks.values()];
 state.tasks=taskRows.filter(t=>['queued','running'].includes(t.status)).concat(taskRows.filter(t=>!['queued','running'].includes(t.status)).slice(-8));
 const retained=operations.filter(p=>!ended(p.status)).concat(operations.filter(p=>ended(p.status)).sort((a,b)=>(a.finishedAt??a.basis.tick)-(b.finishedAt??b.basis.tick)).slice(-12));
 const bindings=new Set(retained.filter(p=>!ended(p.status)).flatMap(p=>p.intentBindings?.map(b=>b.id)??[]));
 const delivered=(t:NonNullable<HybridState['intents']>[number])=>t.authority==='commander'&&t.commanderVersion===state.commanderVersion&&t.spec.kind==='transfer'&&t.status==='completed';
 if(state.intents)state.intents=state.intents.filter(t=>!ended(t.status)||bindings.has(t.id)||delivered(t)).concat(state.intents.filter(t=>ended(t.status)&&!bindings.has(t.id)&&!delivered(t)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(-12));
 const activeConversations=new Set(state.directive?.agreements.filter(a=>['proposed','negotiating','confirmed'].includes(a.status)).map(a=>a.conversation));
 const liveFulfillment=new Set<string>();for(const conversation of activeConversations){const latest=state.messages.filter(m=>m.conversation===conversation&&m.status==='accepted'&&m.fulfillment?.state==='active').sort((a,b)=>a.basis.tick-b.basis.tick).at(-1);if(latest)liveFulfillment.add(latest.id);}
 const required=(m:HybridState['messages'][number])=>liveFulfillment.has(m.id)||['pending','unknown'].includes(m.status)||['staged','blocked'].includes(m.fulfillment?.state??'');
 state.messages=state.messages.filter(required).concat(state.messages.filter(m=>!required(m)).sort((a,b)=>a.basis.tick-b.basis.tick).slice(-8));
 const handled=new Set(state.handledMessages??[]),keep=new Set(state.messages.filter(m=>['pending','unknown'].includes(m.status)).flatMap(m=>m.messageIds));
 for(const a of state.directive?.agreements??[])if(['confirmed','proposed','negotiating'].includes(a.status))for(const id of a.evidence.slice(-2))keep.add(id);
 const conversations=new Map<string,typeof state.chat>();
 for(const m of state.chat){const key=conversationKey(m,self);const list=conversations.get(key)??[];list.push(m);conversations.set(key,list);}
 for(const messages of conversations.values()){
  const own=[...messages].reverse().find(m=>m.from===self),other=[...messages].reverse().find(m=>m.from!==self);if(own)keep.add(own.id);if(other)keep.add(other.id);
 }
 state.chat=state.chat.filter(m=>!handled.has(m.id)||keep.has(m.id));
 const ids=new Set(state.chat.map(m=>m.id));state.handledMessages=(state.handledMessages??[]).filter(id=>ids.has(id));
 return retained;
}
