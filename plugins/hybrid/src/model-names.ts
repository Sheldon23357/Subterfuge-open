import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {outpostNameIndex} from '@subterfuge/bot-sdk/presentation/outpost-references';
import {resolveFleetReferences} from '@subterfuge/bot-sdk/presentation/fleet-labels';

/** Names are the model namespace; engine identities stay in program state. */
export function namedBrief<T>(value:T,o:Pick<PlayerObservation,'view'|'outpostNames'>):T{
 const {byId,byName}=outpostNameIndex(o),name=(v:unknown)=>typeof v==='string'?byId.get(v)??v:v;
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const aliases=[...new Set([...byName.keys(),...[...byId.keys()].filter(id=>!/^[0-9]+$/.test(id))])].sort((a,b)=>b.length-a.length);
 const aliasesPattern=aliases.length?new RegExp(aliases.map(escape).join('|'),'gu'):null;
 const prose=(s:string)=>aliasesPattern?s.replace(aliasesPattern,(match:string,offset:number)=>{
  if(byName.has(match))return match;
  if(/[A-Za-z0-9_]/.test(match[0]!)&&/[A-Za-z0-9_]/.test(s[offset-1]??'')||/[A-Za-z0-9_]/.test(match.at(-1)!)&&/[A-Za-z0-9_]/.test(s[offset+match.length]??''))return match;
  return byId.get(match)??match;
 }):s;
 const proseKeys=new Set(['objective','summary','reason','reasons','issues','limitations','reviewOn','interpretation','unknowns','text','partitionSummaries','selected','limits']);
 const refs=new Set(['target','source','rally','outpostId','outpost','destinationId','ownSource','rivalSource','nearestOutpost','subject']);
 const arrays=new Set(['targets','sources','dependencies','forbiddenTargets','protectedSources','uncoveredHome','posts','entities','outposts','captureTargets','avoidTargets','friendlyTargets']);
 const visit=(v:any,key='',parent:any=null):any=>{
  if(Array.isArray(v)){
   if(key==='columns'&&(parent?.ownPosts||v.includes('zone')))return v.map(column=>column==='id'?'name':column);
   if(key==='identities')return v.map(row=>Array.isArray(row)?[name(row[0]),...row.slice(2)]:visit(row,'outpost'));
   if(key==='ownPosts')return v.map(row=>[name(row[0]),...row.slice(1)]);
   if(key==='rows'&&Array.isArray(parent?.columns))return v.map(row=>row.map((cell:any,i:number)=>{
    const column=parent.columns[i];
    if(column==='source'||column==='ownSource'||column==='rivalSource'||column==='id'&&parent.columns.includes('zone')||column==='destinationId'&&row[parent.columns.indexOf('destinationKind')]==='outpost')return name(cell);
    return visit(cell,column);
   }));
   return v.map(child=>arrays.has(key)&&typeof child==='string'?name(child):visit(child,key));
  }
  if(!v||typeof v!=='object'){
   if(refs.has(key)||key==='destination'&&parent?.destinationKind!=='fleet')return name(v);
   if(key==='id'&&(parent?.kind==='outpost'||key==='id'&&parent&&typeof parent.owner==='number'&&'visibility' in parent))return name(v);
   if(typeof v==='string'&&proseKeys.has(key)){
    const objective=/^(capture|defend|mine|expand|opening-cover):(.+)$/.exec(v);
    return objective&&byId.has(objective[2]!)?objective[1]+':'+byId.get(objective[2]!):prose(v);
   }
   return v;
  }
  return Object.fromEntries(Object.entries(v).map(([k,child])=>[k==='id'&&(['outposts','outpost','target','mines','relevantFacts'].includes(key)||v.kind==='outpost')?'name':k,
   k==='id'&&(['outposts','outpost','target','mines','relevantFacts'].includes(key)||v.kind==='outpost')?name(child):visit(child,k,v)]));
 };
 return visit(value);
}

export function mentionedOutposts(text:string,o:Pick<PlayerObservation,'view'|'outpostNames'>){
 const {byName}=outpostNameIndex(o),ids=new Set<string>();
 const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const names=[...byName.keys()].sort((a,b)=>b.length-a.length);if(!names.length)return [];
 for(const m of text.matchAll(new RegExp(names.map(escape).join('|'),'gu'))){
  const before=text[m.index!-1]??'',after=text[m.index!+m[0].length]??'';
  if(/[A-Za-z0-9_]/.test(m[0][0]!)&&/[A-Za-z0-9_]/.test(before)||/[A-Za-z0-9_]/.test(m[0].at(-1)!)&&/[A-Za-z0-9_]/.test(after))continue;
  ids.add(byName.get(m[0])!);
 }
 return [...ids];
}

export function resolveIntentNames(raw:unknown,o:PlayerObservation){
 const names=outpostNameIndex(o),a=resolveFleetReferences(structuredClone(raw),o) as any;
 if(!a||typeof a!=='object')return a;
 if(Array.isArray(a.tasks?.upsert))for(const e of a.tasks.upsert)if(e?.task)for(const key of ['target','source','rally'])if(key in e.task)e.task[key]=names.resolve(e.task[key]);
 if(Array.isArray(a.agreement?.forbiddenTargets))a.agreement.forbiddenTargets=a.agreement.forbiddenTargets.map(names.resolve);
 if(Array.isArray(a.diplomacyAction?.terms?.outposts))a.diplomacyAction.terms.outposts=a.diplomacyAction.terms.outposts.map(names.resolve);
 if(Array.isArray(a.constraints?.protectedSources))a.constraints.protectedSources=a.constraints.protectedSources.map(names.resolve);
 if(Array.isArray(a.constraints?.reserves))for(const r of a.constraints.reserves){
  if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join()!=='drillers,source'||!Number.isSafeInteger(r.drillers)||r.drillers<0)throw Error('constraints.reserves must contain {source: exact outpost name, drillers: non-negative integer}; use [] when no numeric reserve is specified. Do not put names or prose directly in reserves.');
  r.source=names.resolve(r.source);
 }
 return a;
}
