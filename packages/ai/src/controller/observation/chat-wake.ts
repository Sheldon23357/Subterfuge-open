import type {ChatMessage} from '../../../../contracts/src/index.js';
// Intentionally narrow. Acceptance, rejection, new terms and threats never
// qualify, even if short. Meaning is not guessed from arbitrary prose.
export const courtesy=(text:string)=>/^(收到|明白|了解|谢谢|感谢|不客气|ok|thanks|ack)$/i.test(text.replace(/[\s，。！!,.~～]/g,''));
export const chatChannel=(m:ChatMessage)=>`${m.from}:${m.to===null?'public':Array.isArray(m.to)?[...m.to].sort((a,b)=>a-b).join(','):m.to}`;
export type ChatHandled=Record<string,{courtesy:boolean;tick:number}>;
export function chatWake(messages:ChatMessage[],self:number,handled:ChatHandled,tick:number){
 const muted=messages.filter(m=>m.from!==self&&courtesy(m.text)&&handled[chatChannel(m)]?.courtesy&&tick-handled[chatChannel(m)]!.tick>=0&&tick-handled[chatChannel(m)]!.tick<=36);
 const ids=new Set(muted.map(m=>m.id));
 return {muted,active:messages.filter(m=>!ids.has(m.id))};
}
export function handledChat(messages:ChatMessage[],self:number,previous:ChatHandled){
 const next={...previous};for(const m of messages)if(m.from!==self)next[chatChannel(m)]={courtesy:courtesy(m.text),tick:m.tick};
 return Object.fromEntries(Object.entries(next).sort((a,b)=>b[1].tick-a[1].tick).slice(0,128));
}

/** A new outbound proposal reopens receipt handling, even if the previous
 * exchange ended in acknowledgements. Public and private channels stay apart. */
export function reopenChat(previous:ChatHandled,channels:Set<string>):ChatHandled{
 return Object.fromEntries(Object.entries(previous).filter(([key])=>!channels.has('public')||!key.endsWith(':public')).filter(([key])=>key.endsWith(':public')||!channels.has(`player:${key.split(':')[0]}`)));
}
