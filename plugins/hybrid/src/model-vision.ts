import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {SituationBrief} from './contracts.js';
import {openingExpansion} from '@subterfuge/bot-sdk/analysis/opening-expansion';
import {hybridPlanning} from './planning.js';
import {namedBrief} from './model-names.js';
export const MODEL_VISION_RULES='地图目录、地图详情和新目标只覆盖当前visibility=2的据点；视野外不按公开归属或几何位置补全。任务、合同、指令和回执中的原有地点引用不代表当前可见；未列出不表示不存在、失守或被摧毁。';

/** The player protocol exposes public geometry outside sonar. Model materials
 * deliberately use a stricter, current-visible subset; program state stays full. */
export function currentModelVision(o:PlayerObservation):PlayerObservation{
 const outposts=o.view.outposts.filter(p=>p.visibility===2),ids=new Set(outposts.map(p=>p.id));
 return {...o,view:{...o.view,outposts},outpostNames:Object.fromEntries(Object.entries(o.outpostNames??{}).filter(([id])=>ids.has(id)))};
}
type Row=Record<string,any>;
const rows=(t:any):Row[]=>Array.isArray(t)?t:t?.columns&&t.rows?t.rows.map((r:any[])=>Object.fromEntries(t.columns.map((k:string,i:number)=>[k,r[i]]))):[];

/** Before diplomacy derives owner groups and feasibility, remove current map
 * facts outside vision. Original text, task parameters, contracts and receipts
 * remain evidence/obligations, never a replacement for current map observation. */
export function visibleModelBrief(input:SituationBrief,o:PlayerObservation,selected:ReadonlySet<string>){
 const brief=structuredClone(input),vision=currentModelVision(o),ids=new Set(vision.view.outposts.map(p=>p.id));
 const names=new Set(vision.view.outposts.map(p=>o.outpostNames?.[p.id]??p.id)),allNames=new Set(o.view.outposts.flatMap(p=>[p.id,o.outpostNames?.[p.id]??p.id])),allowed=(id:string)=>ids.has(id)||names.has(id);
 const g=brief.global as Row,f=brief.facts as Row,h=brief.guidance as Row;
 g.identities=(g.identities??[]).filter((p:any[])=>names.has(p[0]));
 f.outposts=(f.outposts??[]).filter((p:Row)=>allowed(p.name??p.id));
 f.coverage={...f.coverage,total:ids.size,selected:[...selected].filter(id=>ids.has(id)).length};
 g.criticalAssets.mines=(g.criticalAssets.mines??[]).filter((p:Row)=>allowed(p.name??p.id));
 const economic=g.economy;
 if(economic?.columns&&Array.isArray(economic.ownPosts)){
  economic.ownPosts=economic.ownPosts.filter((p:any[])=>allowed(p[0]));
  economic.coverage={...economic.coverage,listed:economic.ownPosts.length,total:vision.view.outposts.filter(p=>p.owner===o.view.player&&!p.destroyed).length};
 }
 if(h.editPolicy){
  h.editPolicy.friendlyTargets=(h.editPolicy.friendlyTargets??[]).filter(allowed);
  for(const contract of h.editPolicy.contracts??[])for(const key of ['captureTargets','avoidTargets'])contract[key]=contract[key].filter(allowed);
 }
 if(h.diplomacyPurpose?.needs)h.diplomacyPurpose.needs=h.diplomacyPurpose.needs.filter((n:Row)=>(n.targets??[]).every(allowed));
 // Recompute geography and conclusions from current visible facts. Filtering
 // target rows alone would still disclose an unseen nearest rival/source.
 const opening=openingExpansion(vision);
 if(g.opening){
  const targets=[...new Map([...opening.targets.filter(t=>selected.has(t.id)),...opening.targets.filter(t=>opening.uncoveredHome.includes(t.id)),...opening.targets].map(t=>[t.id,t])).values()].slice(0,12);
  g.opening=namedBrief({basis:opening.basis,untilWorldDay:opening.untilWorldDay,uncoveredHome:opening.uncoveredHome,coverage:{total:opening.targets.length,listed:targets.length},columns:['id','zone','ownSource','rivalPlayer','rivalSource','ownDistance','rivalDistance','claimForce','competitionForce','friendlyIncoming','hostileIncoming','covered'],rows:targets.map(t=>[t.id,t.zone,t.ownSource,t.rivalPlayer,t.rivalSource,t.ownDistance,t.rivalDistance,t.claimForce,t.competitionForce,t.friendlyIncoming,t.hostileIncoming,t.covered]),unknowns:opening.unknowns,interpretation:opening.interpretation},o);
 }
 g.planning=namedBrief(hybridPlanning(vision,[...selected].filter(id=>ids.has(id))),o);
 const tasks=rows(h.intentTasks),metadata=new Set(['taskId','kind','target','source','status','executionReason','ageWorldDays','deadline','remainingWorldDays','linkedLiveOperation','lastRetainedAcceptedTick','operationEvidence']);
 h.executionFeasibility=(h.executionFeasibility??[]).map((e:Row)=>{
  const task=tasks.find(t=>t.id===e.taskId),outside=task&&['target','source','rally'].some(key=>typeof task[key]==='string'&&!allowed(task[key]));
  return outside?{...Object.fromEntries(Object.entries(e).filter(([k])=>metadata.has(k))),mapFacts:'outside-current-vision'}:e;
 });
 return {brief,vision,visibleIds:ids,visibleNames:names};
}

/** Conditional options are not receipts. Do not reintroduce an unseen target
 * through action/goals after filtering the map directory. */
export function filterOutsideModelFeedback(brief:SituationBrief,o:PlayerObservation){
 const outside=new Set(o.view.outposts.filter(p=>p.visibility!==2).flatMap(p=>[p.id,o.outpostNames?.[p.id]??p.id])),feedback=(brief.global as Row).feedback;
 if(!feedback)return;
 const refs=new Set(['target','source','destination','outpostId','rally']);
 const hasOutside=(v:any,key=''):boolean=>{
  if(typeof v==='string')return (refs.has(key)||key==='targets')&&(outside.has(v)||v.split(/[,+]/).some(part=>outside.has(part.trim())));
  if(Array.isArray(v))return v.some(x=>hasOutside(x,key));
  return !!v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>hasOutside(x,k));
 };
 const invalid=(plan:Row)=>{
  if(hasOutside(plan))return true;
  for(const actions of [plan.actions,plan.differenceFromSelected?.add,plan.differenceFromSelected?.remove])if(Array.isArray(actions)){
   for(const row of actions)if(Array.isArray(row)&&row.some((v:any,i:number)=>refs.has(feedback.actionColumns?.[i])&&outside.has(v)))return true;
  }
  return false;
 };
 if(feedback.selected&&invalid(feedback.selected)){feedback.selected={status:'outside-current-vision'};feedback.conditionalAlternatives=[];}
 else feedback.conditionalAlternatives=(feedback.conditionalAlternatives??[]).filter((p:Row)=>!invalid(p));
 feedback.unverified=(feedback.unverified??[]).filter((p:Row)=>!invalid(p));
}
