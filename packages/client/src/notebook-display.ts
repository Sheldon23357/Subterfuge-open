import {aiOutpostMentions} from './outpost-mentions.js';

/** Presentation only: keep opaque record IDs, quantities and timestamps verbatim. */
export function notebookDisplayText(text:string,names:Record<string,string>):string{
 const posts=Object.entries(names).map(([id,name])=>({id,name}));
 const aliases=new Map(posts.flatMap(p=>{const n=/^据点\s*(\d+)$/.exec(p.id);return n?[[Number(n[1]),p.name] as const]:[];}));
 return aiOutpostMentions(text,posts).map(part=>part.outpostId?part.text:part.text.replace(/(?<![A-Za-z0-9_.-])(\d{1,3})(?![A-Za-z0-9_.-])(?=已(?:实际)?占领|方向|集结|维持|继续接收|留\d)/g,(value,n)=>aliases.get(Number(n))??value)).join('');
}

/** Abbreviate opaque identities for reading, without guessing whether they denote a command, fleet or schedule. */
export function notebookReadableText(text:string,names:Record<string,string>):string{
 return notebookDisplayText(text,names).replace(/\bp(\d+)-([a-f0-9]{64})\b/gi,(_,owner:string,hash:string)=>`p${owner}-${hash.slice(0,8).toUpperCase()}…`);
}
