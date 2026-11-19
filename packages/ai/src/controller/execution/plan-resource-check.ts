import {previewKnownDraftTransaction,type KnownPredictionDraft,type KnownForecastResponse} from '../../../../prediction/src/index.js';
import type {ToolContext} from './tools.js';
import {scheduledCommitments} from '../analysis/scheduled-commitments.js';
import {object,keys} from './tool-validation.js';
type ResourceContext = {snapshot:Pick<ToolContext['snapshot'],'observation'|'attackScreening'>};

export interface PlanResourceConflict {kind:'rule'|'reservation'|'constraint'|'unknown';code:string;source?:string;draftIds?:string[];detail:unknown}
export interface PlanResourceCheck {
 status:'not-required'|'unknown'|'conflict'|'satisfied';
 sources:{source:string;stationedDrillers:number|null;afterImmediateDrillers:number|null;pendingReserved:number;retainDrillers:number;scheduleIds?:string[]}[];
 conflicts:PlanResourceConflict[];
 warnings:{code:string;source:string;remaining:number;suggested:number;tick?:number}[];
 meaning?:string;
 queueChecks?:{tick:number;source:string;drillers:number|null;pendingReserved:number;retainDrillers:number}[];
}
/** Whole fixed-plan checks use the shared current-tick queue. They never create
 * a second reservation ledger or turn suggested defense into a hard constraint.
 * Future production/combat may change resources, so uncovered future checks
 * stay unknown rather than treating today's budget as a future guarantee. */
export function checkPlanResources(drafts:readonly KnownPredictionDraft[],rawConstraints:unknown,c:ResourceContext,options:{deferToForecast?:boolean}={}):PlanResourceCheck{
 const o=c.snapshot.observation,limits=new Map<string,number>(),conflicts:PlanResourceConflict[]=[];
 if(rawConstraints!==undefined){
  if(!Array.isArray(rawConstraints)||rawConstraints.length>16)throw Error('Invalid retained-force constraints');
  for(const value of rawConstraints){
   const constraint=object(value);keys(constraint,['source','retainDrillers']);
   if(typeof constraint.source!=='string'||limits.has(constraint.source)||!o.view.outposts.some(p=>p.id===constraint.source&&p.owner===o.view.player&&!p.destroyed)||!Number.isSafeInteger(constraint.retainDrillers)||Number(constraint.retainDrillers)<0)throw Error('Invalid retained-force constraint source or amount');
   limits.set(constraint.source,Number(constraint.retainDrillers));
  }
 }
 const sources=new Set(limits.keys());
 for(const draft of drafts){
  for(const source of [draft.action.source,draft.action.outpostId])if(typeof source==='string'&&o.view.outposts.some(p=>p.id===source&&p.owner===o.view.player))sources.add(source);
 }
 if(!drafts.length&&!limits.size)return {status:'not-required' as const,sources:[],conflicts:[],warnings:[]};
 const immediate=drafts.filter(d=>d.issueTick===o.view.tick),future=drafts.filter(d=>d.issueTick!==o.view.tick);
 const compute=()=>previewKnownDraftTransaction(o,immediate);
 const transaction=immediate.length&&!options.deferToForecast?compute():null;
 if(transaction?.status==='unsupported')conflicts.push({kind:'unknown',code:'current-transaction-unsupported',detail:transaction.reasons});
 for(const order of transaction?.orders??[])if(order.status==='failed')conflicts.push({kind:'rule',code:'engine-order-failed',draftIds:[order.id],detail:order});
 if(future.length)conflicts.push({kind:'unknown',code:'future-resource-constraints-unverified',draftIds:future.map(d=>d.id),detail:'未来操作合法性继续由联合推演检查；明确留兵及后续预约占用尚不能按当前驻兵证明，执行时须再校验。'});
 if(options.deferToForecast&&drafts.length)conflicts.push({kind:'unknown',code:'queue-resource-check-pending',draftIds:drafts.map(d=>d.id),detail:null});
 const commitments=new Map(scheduledCommitments(o,transaction?o.view.tick:-Infinity).map(s=>[s.source,s]));
 const warnings:{code:string;source:string;remaining:number;suggested:number}[]=[];
 const budgets=[...sources].map(source=>{
  const original=o.view.outposts.find(p=>p.id===source)!,effect=transaction?.sourceEffects.find(p=>p.outpostId===source),pending=commitments.get(source);
  const after=transaction?effect?.afterDrillers??null:original.drillers??null,reserved=pending?.drillers??0,retained=limits.get(source)??0;
  if(after===null)conflicts.push({kind:'unknown',code:'source-resource-effect-unavailable',source,detail:null});
  if(pending?.unknownSchedules.length)conflicts.push({kind:'unknown',code:'scheduled-resource-cost-unverified',source,detail:{scheduleIds:pending.unknownSchedules}});
  // Only evaluate a current-tick transaction against current resource promises.
  // A future-only candidate may rely on production or arrivals still to come.
  if(!future.length&&after!==null&&(!options.deferToForecast||!drafts.length)){
   if(after<reserved)conflicts.push({kind:'reservation',code:'aggregate-source-reservation-conflict',source,detail:{available:after,required:reserved,scheduleIds:pending?.scheduleIds??[]}});
   if(after-reserved<retained)conflicts.push({kind:'constraint',code:'aggregate-retained-force-conflict',source,detail:{remaining:after-reserved,required:retained}});
   const suggested=(c.snapshot.attackScreening?.basisRevision===o.revision?c.snapshot.attackScreening:undefined)?.sourceReserves.find(p=>p.id===source)?.reserve;
   if(suggested!==undefined&&after-reserved<suggested)warnings.push({code:'below-suggested-reserve',source,remaining:after-reserved,suggested});
  }
  return {source,stationedDrillers:original.drillers??null,afterImmediateDrillers:options.deferToForecast&&drafts.length?null:after,pendingReserved:reserved,retainDrillers:retained,...pending?.scheduleIds.length?{scheduleIds:pending.scheduleIds}:{}};
 });
 return {status:conflicts.some(c=>c.kind!=='unknown')?'conflict' as const:conflicts.length?'unknown' as const:'satisfied' as const,sources:budgets,conflicts,warnings,
  meaning:'条件性资源检查，不代表来源安全、战略最优或未来必然执行；建议留兵只产生警示，未预约计划不锁兵。'};
}

/** Inspect queue-time frames captured from the SAME joint simulation. This
 * replaces provisional future gaps only when those operations were covered;
 * it neither advances the engine again nor infers resources at missing frames. */
export function finalizePlanResources(initial:PlanResourceCheck,forecast:KnownForecastResponse,drafts:readonly KnownPredictionDraft[],rawConstraints:unknown,c:ResourceContext):PlanResourceCheck{
 const deferred=initial.conflicts.some(conflict=>conflict.code==='queue-resource-check-pending');
 const conflicts:PlanResourceConflict[]=initial.conflicts.filter(conflict=>!['future-resource-constraints-unverified','queue-resource-check-pending'].includes(conflict.code));
 const limits=new Map((Array.isArray(rawConstraints)?rawConstraints:[]).map(value=>{const limit=object(value);return [String(limit.source),Number(limit.retainDrillers)] as const;}));
 // Proven terminal skips were never issued. Their missing future resource
 // frames are not an unknown execution or an unavailable resource check.
 const skipped=new Set(forecast.status==='conditional'&&forecast.result?.terminalPrediction?.stoppedAtCrossing?forecast.orders.filter(order=>order.status==='skipped-terminal').map(order=>order.id):[]);
 const future=drafts.filter(d=>d.issueTick>c.snapshot.observation.view.tick&&!skipped.has(d.id)),expected=(deferred?drafts:future).filter(d=>!skipped.has(d.id)),covered=new Set<string>();
 const involved=new Set([...limits.keys(),...drafts.flatMap(d=>[d.action.source,d.action.outpostId].filter((id):id is string=>typeof id==='string'))]);
 const observation=c.snapshot.observation,player=observation.view.player;
 const queueChecks:{tick:number;source:string;drillers:number|null;pendingReserved:number;retainDrillers:number}[]=[];
 const warnings:{code:string;source:string;remaining:number;suggested:number;tick?:number}[]=[...initial.warnings];
 for(const frame of forecast.resourceFrames??[]){
  if(frame.tick<c.snapshot.observation.view.tick||!deferred&&frame.tick===c.snapshot.observation.view.tick)continue;
  for(const id of frame.draftIds)covered.add(id);
  if(frame.unknownReasons.length)conflicts.push({kind:'unknown',code:'future-frame-resource-unknown',draftIds:frame.draftIds,detail:{tick:frame.tick,reasons:frame.unknownReasons}});
  for(const source of frame.sources){
   if(!involved.has(source.source))continue;
   let reserved=0;const unknownSchedules:string[]=[];
   for(const schedule of frame.pendingSchedules){
    const action=object(schedule.action);
    if(action.kind==='launch'&&action.source===source.source){
     if(Number.isSafeInteger(action.drillers)&&Number(action.drillers)>=0)reserved+=Number(action.drillers);else unknownSchedules.push(schedule.id);
    }else if(action.kind==='toggle-mine'&&action.outpostId===source.source)unknownSchedules.push(schedule.id);
   }
   const retained=limits.get(source.source)??0;
   queueChecks.push({tick:frame.tick,source:source.source,drillers:source.drillers,pendingReserved:reserved,retainDrillers:retained});
   if(frame.pathUnknownReasons?.length)conflicts.push({kind:'unknown',code:'future-resource-coverage-incomplete',source:source.source,detail:{tick:frame.tick,reasons:frame.pathUnknownReasons}});
   if(source.drillers===null||frame.unknownReasons.length){conflicts.push({kind:'unknown',code:'future-source-resource-unavailable',source:source.source,detail:{tick:frame.tick}});continue;}
   if(source.owner!==c.snapshot.observation.view.player){conflicts.push({kind:'rule',code:'future-source-not-controlled',source:source.source,draftIds:frame.draftIds,detail:{tick:frame.tick,owner:source.owner}});continue;}
   if(unknownSchedules.length)conflicts.push({kind:'unknown',code:'scheduled-resource-cost-unverified',source:source.source,detail:{tick:frame.tick,scheduleIds:unknownSchedules}});
   if(source.drillers<reserved)conflicts.push({kind:'reservation',code:'future-source-reservation-conflict',source:source.source,draftIds:frame.draftIds,detail:{tick:frame.tick,available:source.drillers,required:reserved}});
   if(source.drillers-reserved<retained)conflicts.push({kind:'constraint',code:'future-retained-force-conflict',source:source.source,draftIds:frame.draftIds,detail:{tick:frame.tick,remaining:source.drillers-reserved,required:retained}});
   const suggested=(c.snapshot.attackScreening?.basisRevision===c.snapshot.observation.revision?c.snapshot.attackScreening:undefined)?.sourceReserves.find(p=>p.id===source.source)?.reserve;
   if(suggested!==undefined&&source.drillers-reserved<suggested)warnings.push({code:'below-suggested-reserve',source:source.source,remaining:source.drillers-reserved,suggested,tick:frame.tick});
  }
 }
 const missing=expected.filter(d=>!covered.has(d.id));
 if(missing.length)conflicts.push({kind:'unknown',code:'future-resource-frame-not-covered',draftIds:missing.map(d=>d.id),detail:null});
 // Queue-time evidence proves conditional resource availability only at the
 // actual operation boundary. Events later in the path cannot invalidate an
 // earlier payment. Pre-boundary uncertainty and missing frames stay unknown.
 const queueCovered=expected.every(d=>(forecast.resourceFrames??[]).some(frame=>frame.coverage==='queue-time/1'
   &&frame.pathUnknownReasons?.length===0
   &&frame.tick===d.issueTick&&frame.draftIds.includes(d.id)));
 if(future.length&&(forecast.status==='unsupported'||!queueCovered&&(!forecast.path?.coverage.complete||forecast.path.coverage.unknownReasons.length)))conflicts.push({kind:'unknown',code:'future-resource-coverage-incomplete',detail:forecast.status==='unsupported'?forecast.reasons:forecast.path?.coverage??null});
 const ownOrderIds=new Set([...drafts.map(d=>d.id),...observation.scheduled.filter(s=>s.player===player).map(s=>s.id)]);
 const hypotheticalIds=new Set(forecast.hypotheticalEnemyOrderIds??[]);
 if(forecast.status==='conditional')for(const order of forecast.orders)if(order.status==='failed'&&!conflicts.some(c=>c.code==='engine-order-failed'&&c.draftIds?.includes(order.id))){
   if(hypotheticalIds.has(order.id)&&!ownOrderIds.has(order.id)){
     // A known capture or resource loss may prevent the assumed enemy order.
     // That is a branch outcome, not our resource failure. Unresolved paths
     // still cannot explain the enemy's failure with sufficient certainty.
     const terminal=forecast.result.terminalPrediction;
     const terminalCovered=terminal?.status!=='unknown'&&terminal?.stoppedAtCrossing&&terminal.firstCrossing
       &&forecast.path?.actualTargetTick===terminal.firstCrossing.tick;
     // Source ownership was checked at the actual hypothetical issue tick.
     // An unresolved outcome cannot prove that a source was lost.
     const knownSourceLost=forecast.hypotheticalEnemySourceLossIds?.includes(order.id)&&order.code==='invalid-route'
       &&forecast.path?.coverage.complete&&forecast.path.coverage.unknownReasons.length===0;
     if(!knownSourceLost&&(!(forecast.path?.coverage.complete||terminalCovered)
       ||!forecast.path?.coverage.unknownReasons.every(reason=>terminalCovered&&reason==='requested-horizon-not-covered')))
       conflicts.push({kind:'unknown',code:'enemy-hypothesis-failure-unverified',draftIds:[order.id],detail:order});
   }else conflicts.push({kind:'rule',code:'engine-order-failed',draftIds:[order.id],detail:order});
 }
 const sources=initial.sources.map(source=>{const current=queueChecks.find(check=>check.source===source.source&&check.tick===c.snapshot.observation.view.tick);return current?{...source,afterImmediateDrillers:current.drillers,pendingReserved:current.pendingReserved}:source;});
 return {...initial,status:conflicts.some(c=>c.kind!=='unknown')?'conflict' as const:conflicts.length?'unknown' as const:initial.status==='not-required'?'not-required' as const:'satisfied' as const,sources,conflicts,warnings,...(expected.length?{queueChecks}:{}),
  meaning:'条件性资源检查；未来留兵在实际指令队列处理后核对，缺少时点／知识覆盖仍未知。检查不证明来源安全，不下令、不额外锁兵。'};
}
