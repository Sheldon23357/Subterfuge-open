import type {ChatMessage} from '@subterfuge/bot-sdk/contracts';
/** All unread evidence plus the latest two-sided exchange. Older processed chat lives in the conversation note and audit. */
export function conversationEvidence(messages:readonly ChatMessage[],handled:readonly string[],self:number):string[]{
 const seen=new Set(handled),keep=new Set(messages.filter(m=>!seen.has(m.id)).map(m=>m.id));
 const own=[...messages].reverse().find(m=>m.from===self),other=[...messages].reverse().find(m=>m.from!==self);
 if(own)keep.add(own.id);if(other)keep.add(other.id);
 return messages.filter(m=>keep.has(m.id)).map(m=>m.id);
}

/** Stable key shared by ingestion and publication, independent of recipient order. */
export const conversationKey=(m:{from:number;to:number|number[]|null},self:number)=>m.to===null?'public':[...new Set([m.from,...(Array.isArray(m.to)?m.to:[m.to])])].filter(p=>p!==self).sort((a,b)=>a-b).join(',');
