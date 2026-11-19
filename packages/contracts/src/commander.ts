/** Private player/AI discussion, never the public diplomacy channel. */
export interface CommanderReference {
  kind: "outpost" | "fleet";
  id: string;
  label?: string;
}
export interface CommanderProposal {
  id: string;
  baseVersion: number;
  /** Complete merged instruction text, shown before confirmation. */
  text: string;
  summary: string;
  status: "pending" | "confirmed" | "superseded";
}
export interface CommanderMessage {
  id: string;
  role: "player" | "assistant" | "system";
  text: string;
  references: CommanderReference[];
  tick: number;
  sentAt: number;
  status: "queued" | "completed" | "failed";
  replyTo?: string;
  proposal?: CommanderProposal;
}
export interface CommanderDirectives {
  version: number;
  text: string;
  /** Directive synchronized and strategic memory reconciled; not proof that campaigns or fleet orders were executed. */
  appliedVersion: number;
}
export interface CommanderThread {
  roomId: string;
  player: number;
  messages: CommanderMessage[];
  directives: CommanderDirectives;
  /** Recent discussion-worker heartbeat, not a gameplay lease/readiness gate. */
  workerAvailable?: boolean;
}
export interface CommanderSend {
  id: string;
  text: string;
  references: CommanderReference[];
}
export type CommanderWorkerUpdate =
  | {
      op: "reply";
      messageId: string;
      reply: string;
      proposal?: { baseVersion: number; text: string; summary: string };
      error?: boolean;
    }
  | { op: "cleanup"; requestId:string; cleanup:CommanderCleanup }
  | { op: "ack"; version: number; reply: string }
  | { op: "notice"; id: string; reply: string };

/** Completed goals may be removed; additions and rewrites still need player confirmation. */
export interface CommanderCleanup {version:number;basisRevision:string;completed:{quote:string;reason:string;evidence:string[]}[]}
export function prepareCommanderCleanup(directives:{version:number;text:string},raw:unknown):{cleanup:CommanderCleanup;text:string}{
 const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid commander cleanup');return v as Record<string,unknown>;};
 const exact=(v:Record<string,unknown>,fields:string[])=>{if(Object.keys(v).sort().join(',')!==[...fields].sort().join(','))throw Error('Invalid commander cleanup fields');};
 const str=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v))throw Error('Invalid commander cleanup text');return v;};
 const value=record(raw);exact(value,['version','basisRevision','completed']);
 if(!Number.isSafeInteger(value.version)||value.version!==directives.version)throw Error('Commander cleanup version changed');
 const basisRevision=str(value.basisRevision,180);
 if(!Array.isArray(value.completed)||value.completed.length<1||value.completed.length>12)throw Error('Invalid commander cleanup items');
 const ranges:{start:number;end:number}[]=[];
 const completed=value.completed.map(rawItem=>{
  const item=record(rawItem);exact(item,['quote','reason','evidence']);const quote=str(item.quote,1200),reason=str(item.reason,300);
  if(!Array.isArray(item.evidence)||item.evidence.length<1||item.evidence.length>8)throw Error('Commander cleanup requires evidence');
  const evidence=item.evidence.map(v=>str(v,180));
  const start=directives.text.indexOf(quote),end=start+quote.length;
  if(start<0||directives.text.indexOf(quote,start+1)>=0)throw Error('Commander cleanup quote must match one exact current clause');
  const before=directives.text.slice(0,start).trimEnd(),after=directives.text.slice(end).trimStart(),trimmed=quote.trim();
  if(before&&!/[。；;\n]$/.test(directives.text.slice(0,start).replace(/[ \t]+$/,''))||after&&!/[。；;\n]$/.test(quote)&&!/^[。；;\n]/.test(directives.text.slice(end).replace(/^[ \t]+/,'')))throw Error('Commander cleanup must remove whole clauses');
  if(!trimmed||ranges.some(r=>start<r.end&&end>r.start))throw Error('Overlapping commander cleanup clauses');
  ranges.push({start,end});return {quote,reason,evidence};
 });
 let text=directives.text;for(const r of ranges.sort((a,b)=>b.start-a.start))text=text.slice(0,r.start)+text.slice(r.end);
 return {cleanup:{version:directives.version,basisRevision,completed},text:text.trim()};
}
