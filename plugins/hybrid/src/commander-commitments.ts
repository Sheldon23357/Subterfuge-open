import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {HybridState,IntentTask,OperationState,IntentEdits} from './contracts.js';
import {mentionedOutposts} from './model-names.js';
import {createOutpostRiskAnalysis} from '@subterfuge/bot-sdk/analysis/outpost-risk';
const live=(t:IntentTask,o:PlayerObservation,s:HybridState)=>t.authority==='commander'&&t.commanderVersion===s.commanderVersion&&!['cancelled','expired'].includes(t.status)&&t.spec.until>o.view.tick+o.secondsSinceLastTick/600;
/** Check both each reply and the merged multi-part publication. */
export function validateCommanderTransferSources(edits:IntentEdits,protectedSources:readonly string[]){
 for(const {task} of edits.upsert)if(task.kind==='transfer'&&protectedSources.includes(task.source))throw Error('Commander transfer conflicts with protectedSources: '+task.source+' cannot both dispatch and prohibit dispatch in the same published instructions');
}
/** Destination loss or an actual visible incoming deficit permits safety replanning;
 * a larger utility score alone never releases a commander transport. */
export function commanderTransportUnsafe(o:PlayerObservation,target:string):boolean{
 if(!o.view.outposts.some(p=>p.id===target&&p.owner===o.view.player&&!p.destroyed))return true;
 return o.view.fleets.some(f=>f.owner!==o.view.player&&!f.gift&&f.destination?.id===target)
  &&(createOutpostRiskAnalysis(o).get(target).arrivalShortfall??0)>0;
}
export function commanderProtectedFleets(o:PlayerObservation,state:HybridState,operations:OperationState[]):string[]{
 return [...new Set(operations.filter(p=>!['completed','ended','cancelled','failed'].includes(p.status)&&p.intentBindings?.some(b=>state.intents?.some(t=>t.id===b.id&&t.version===b.version&&live(t,o,state)&&['transfer','configure'].includes(t.spec.kind))))
  .flatMap(p=>p.drafts.filter(d=>d.action.kind==='launch'&&typeof d.action.destination==='string'&&!commanderTransportUnsafe(o,d.action.destination)).flatMap(d=>{
   const command=p.commands?.find(c=>c.draftId===d.id);
   return command?.fleetId?[command.fleetId]:[...p.fleets,...p.orders];
  })))];
}
/** Validate only concrete, recognized cross-post configuration claims. Prose is
 * never interpreted as a fallback route; ambiguous allocations fail closed. */
export function validateCommanderEdits(edits:IntentEdits,o:PlayerObservation,text='',existing:readonly IntentTask[]=[]){
 const replaced=new Set([...edits.cancel,...edits.upsert.flatMap(e=>e.id?[e.id]:[])]);
 const specs=[...existing.filter(t=>!replaced.has(t.id)&&!['cancelled','expired'].includes(t.status)).map(t=>t.spec),...edits.upsert.map(e=>e.task)];
 if(/单线|避免两线|不并行追加|唯一集结/.test(text)&&specs.some(t=>t.kind==='capture')&&!specs.some(t=>t.kind==='focus'))throw Error('指挥官单线范围未结构化：使用focus填写target和rally，不能只在summary/reason描述单线限制');
 // Recognize only explicit named A -> B clauses. Other natural-language
 // requirements remain the translator's responsibility, never guessed routes.
 const names=new Map(o.view.outposts.map(p=>[o.outpostNames?.[p.id]??p.id,p.id]));
 const slash=String.fromCharCode(92);
 const escape=(s:string)=>[...s].map(c=>'^$.*+?()[]{}|'.includes(c)||c===slash?slash+c:c).join('');
 const alternatives=[...names.keys()].sort((a,b)=>b.length-a.length).map(escape).join('|');
 const routePattern='('+alternatives+')[^。；;'+String.fromCharCode(10)+']{0,80}?(?:转往|撤往|调往|运往|送往|撤到|调到|送到)'+slash+'s*('+alternatives+')';
 if(alternatives)for(const match of text.matchAll(new RegExp(routePattern,'gu'))){
  const source=names.get(match[1]!)!,target=names.get(match[2]!)!;
  const references=mentionedOutposts(match[0],o);if(!references.includes(source)||!references.includes(target))continue;
  if(source!==target&&!specs.some(t=>t.kind==='transfer'&&t.source===source&&t.target===target))throw Error(`指挥官指定运输未落实：${match[1]}→${match[2]}必须使用transfer；历史来源减兵完成不代表实际交付`);
 }
 for(const {task} of edits.upsert){
  if(task.kind!=='configure'||task.maxDrillers===null||!/转往|撤往|调往|运往|送往|集中.*(?:到|至)|转移.*(?:到|至)/.test(task.reason))continue;
  const destinations=mentionedOutposts(task.reason,o).filter(id=>id!==task.target&&o.view.outposts.some(p=>p.id===id&&p.owner===o.view.player));
  if(destinations.length)throw Error('指挥官运输关系未结构化：configure.maxDrillers不能表达指定去向，请使用transfer填写source、target和drillers；不要用两个独立库存任务替代运输');
 }
}
export function commanderFocusGuidance(o:PlayerObservation,state:HybridState){
 const tasks=(state.intents??[]).filter(t=>live(t,o,state)),focus=tasks.filter(t=>t.spec.kind==='focus'&&t.status!=='completed');
 const allowed=focus.map(t=>{
  if(t.spec.kind!=='focus')return [];
  const rally=t.spec.rally;
  const waiting=tasks.some(x=>{
   const spec=x.spec;if(x.status==='completed'||!('target'in spec)||spec.target!==rally)return false;
   if(spec.kind==='transfer')return true;
   if(spec.kind!=='configure')return false;
   const post=o.view.outposts.find(p=>p.id===rally&&p.owner===o.view.player&&p.visibility===2);
   const satisfied=spec.maintain&&post?.drillers!==undefined&&(spec.minDrillers===null||post.drillers>=spec.minDrillers)&&(spec.maxDrillers===null||post.drillers<=spec.maxDrillers);
   return !satisfied;
  });
  return waiting||commanderTransportUnsafe(o,rally)?[]:[t.spec.target];
 });
 return {
  ...(focus.length?(/只(?:能|准|允许)|仅(?:能|准|允许)|禁止.*(?:其他|其它)|不得.*(?:其他|其它)|严格单线/.test(state.commanderText)
    ?{allowedAttackTargets:allowed.reduce((a,b)=>a.filter(id=>b.includes(id))),attackSources:[...new Set(focus.flatMap(t=>t.spec.kind==='focus'?[t.spec.rally]:[]))]}
    :{mainEfforts:focus.flatMap((t,i)=>t.spec.kind==='focus'?[{source:t.spec.rally,target:t.spec.target,ready:allowed[i]!.length>0}]:[])}):{}),
  transferRoutes:[...tasks.flatMap(t=>t.spec.kind==='transfer'&&t.status!=='completed'?[{source:t.spec.source,target:t.spec.target}]:[]),...focus.flatMap(t=>t.spec.kind==='focus'&&!commanderTransportUnsafe(o,t.spec.rally)?[{source:t.spec.rally,target:t.spec.target}]:[])],
 };
}
export function commanderPlanIssue(state:HybridState,o:PlayerObservation):string|null{
 if(!state.commanderText.trim())return null;
 try{validateCommanderEdits({cancel:[],upsert:[]},o,state.commanderText,(state.intents??[]).filter(t=>t.authority==='commander'&&t.commanderVersion===state.commanderVersion&&(live(t,o,state)||t.spec.kind==='transfer'&&t.status==='completed')));return null;}
 catch(e){return e instanceof Error?e.message:'指挥官安排尚未结构化';}
}
