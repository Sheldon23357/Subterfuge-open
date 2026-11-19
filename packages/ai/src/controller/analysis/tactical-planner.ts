import {botSearchBranch} from './tactical-progress.js';
import {BOT_ACTION_WEIGHTS,botWeightedEvaluation,botWeightedActionAllowed} from './tactical-selection.js';
export {BOT_ACTION_WEIGHTS,botWeightedEvaluation,botWeightedActionAllowed} from './tactical-selection.js';
import {botDispatchPlanAllowed} from './tactical-dispatch-policy.js';
import {executeBotForecast,type BotForecastRequest,type BotForecastResult} from './tactical-forecast.js';
import type {PlayerObservation,PlayerForecastResult,AttackRoutes} from '../../../../contracts/src/index.js';
import {resolveBotSettings,botEffectiveWeights,BOT_UTILITY_SCALE,BOT_SETTING_LIMITS,type BotSettings,type BotSettingsInput} from '../../../../contracts/src/index.js';
import {type KnownPathPredicate,type KnownPathEvent,type KnownPathEvidence} from '../../../../prediction/src/index.js';
import {generateBotCandidates,type BotCandidate,type BotCandidateKind} from './tactical-candidates.js';
import {evaluateBotFrame,compareBotEvaluations,botSituation,type BotEvaluation} from './tactical-evaluation.js';
import {checkPlanResources,finalizePlanResources} from '../../controller/execution/plan-resource-check.js';
import {manualProtectionEntities} from '../../controller/execution/manual-coordination.js';
import {botOpponentScenarios} from './tactical-opponents.js';
import {botAttackPressure,botBufferedForce,botCommitmentCost} from './tactical-force-policy.js';
import {botDiscoveryQueues,botDiscoveryOrder} from './tactical-search-order.js';
import {botCombinationCandidates,botCaptureSubplan} from './tactical-combinations.js';
import {mineHoldingAssessment} from '../../controller/analysis/mine-strategy.js';
import {createOutpostRiskAnalysis,type OutpostRisk} from './outpost-risk.js';
import {loadOutpostRiskConfig,type OutpostRiskConfig} from './outpost-risk-config.js';
import {internalTransferPrelude} from './internal-transfers.js';
import {openingExpansion} from './opening-expansion.js';
import {botGarrisonPolicy} from './tactical-force-policy.js';
import {strategicProgress} from './strategic-progress.js';
import {botStressShortlist} from './tactical-finalists.js';
import {botAttackValue,botAttritionAllowed,botAttritionBenefitUpperBound} from './tactical-attack-value.js';

export interface TacticalGuidance {
 contractAvoidTargets?:string[];
 targetDrillerLimits?:{target:string;drillers:number}[];
 allowedAttackTargets?:string[];attackSources?:string[];transferRoutes?:{source:string;target:string}[];
 mainEfforts?:{source:string;target:string;ready:boolean}[];
 attackDefenseFactors?:{target:string;factor:number;until?:number}[];
 forbiddenTargets?:string[];forbiddenPlayers:number[];protectedSources:string[];reserves:{source:string;drillers:number}[];
 objectives:{kind:string;targets:string[];priority:number}[];rotation:number;
}
export function tacticalGuidanceAllows(o:PlayerObservation,drafts:BotCandidate['drafts'],g:TacticalGuidance):boolean {
 for(const limit of g.targetDrillerLimits??[]){
  const committed=drafts.filter(d=>d.action.kind==='launch'&&d.action.destination===limit.target).reduce((n,d)=>n+Number(d.action.drillers??0),0);
  if(!Number.isFinite(committed)||committed>limit.drillers)return false;
 }
 const efforts=g.mainEfforts??[];
 if(efforts.length){
  const hostile=(destination:unknown)=>o.view.outposts.some(p=>p.id===destination&&p.owner!==o.view.player)||o.view.fleets.some(f=>f.id===destination&&f.owner!==o.view.player);
  const side=drafts.filter(d=>['launch'].includes(String(d.action.kind))&&hostile(d.action.destination)&&!efforts.some(e=>e.source===d.action.source&&e.target===d.action.destination));
  const active=o.view.fleets.filter(f=>f.owner===o.view.player&&!f.gift&&hostile(f.destination?.id)&&!efforts.some(e=>e.source===f.source&&e.target===f.destination?.id));
  if(side.length&&(side.length+active.length>1||side.some(d=>d.action.kind!=='launch')||side.reduce((n,d)=>n+Number(d.action.drillers??0),0)+active.reduce((n,f)=>n+f.drillers,0)>Math.floor(o.view.self.drillers*0.2)))return false;
  for(const d of side)if(Number(d.action.drillers??0)>botGarrisonPolicy(o,String(d.action.source)).spare)return false;
  if(drafts.some(d=>d.action.kind==='launch'&&efforts.some(e=>e.source===d.action.source&&(!e.ready||e.target!==d.action.destination))))return false;
 }
 return drafts.every(d=>{
  const a=d.action,returning=a.kind==='return-fleet'?o.view.fleets.find(f=>f.id===a.fleetId):undefined,destination=returning?.source??a.destination,source=String(a.source??a.outpostId??''),target=o.view.outposts.find(p=>p.id===destination),fleet=o.view.fleets.find(f=>f.id===destination);
  const owner=target?.owner??fleet?.owner;
  if(a.kind==='launch'&&g.transferRoutes?.some(r=>r.source===source&&r.target!==destination))return false;
  if(['launch'].includes(String(a.kind))&&(target||fleet)&&owner!==o.view.player){
   if(g.allowedAttackTargets&&!g.allowedAttackTargets.includes(String(destination)))return false;
   if(g.attackSources&&(!g.attackSources.includes(source)||a.kind!=='launch'))return false;
  }
  const friendlyReturn=a.kind==='return-fleet'&&returning?.owner===o.view.player&&target?.owner===o.view.player;
  if(!friendlyReturn&&['launch','return-fleet'].includes(String(a.kind))&&target&&(g.forbiddenTargets?.includes(target.id)||g.contractAvoidTargets?.includes(target.id)))return false;
  if(owner!=null&&owner!==o.view.player&&g.forbiddenPlayers.includes(owner))return false;
  if(g.protectedSources.includes(source)&&['launch','toggle-mine'].includes(String(a.kind)))return false;
  const reserve=Math.max(0,...g.reserves.filter(r=>r.source===source).map(r=>r.drillers));
  const committed=drafts.filter(x=>x.action.source===source).reduce((n,x)=>n+Number(x.action.drillers??0),0)+drafts.filter(x=>x.action.kind==='toggle-mine'&&x.action.outpostId===source&&o.view.outposts.some(p=>p.id===source&&p.type!=='mine'&&!p.minePending)).length*o.view.self.mineCreationCost;
  return !reserve||committed<=Math.max(0,(o.view.outposts.find(p=>p.id===source)?.drillers??0)-reserve);
 });
}
export interface BotPlannerOptions {
 onProgress?:(progress:import('../../../../contracts/src/index.js').BotSearchProgress)=>void;
 /** Exact-input forecast reuse across workers, within this controller round. */
 forecastCacheRound?:number;
 /** Revalidate one existing proposal against current hold and pressure cases.
  * Never discover, resize or combine alternatives in this lane. */
 validationCandidate?:BotCandidate;
 internalTransfers?:boolean;
 riskConfig?:OutpostRiskConfig;
 guidance?:TacticalGuidance;onCheckpoint?:(decision:BotDecision)=>void;parallelism?:number;settings?:BotSettingsInput;maxSimulations?:number;maxElapsedMs?:number;horizonTicks?:number;signal?:AbortSignal;incumbentObjective?:string;scoutedTargets?:readonly string[];
 /** Mode-owned policy is injected inside its worker, never serialized as code. */
 preludeCandidates?:readonly BotCandidate[];preludeOnly?:boolean;preludeIndependent?:boolean;policyDiagnostics?:Record<string,unknown>;
 protectedFleetIds?:readonly string[];
 scoreFrame?:(frame:PlayerForecastResult,score:BotEvaluation)=>BotEvaluation;
}
export interface BotAssessment {
  candidate:BotCandidate;status:'evaluated'|'invalid'|'unknown'|'protected';
  score:BotEvaluation|null;stress:BotEvaluation|null;reasons:string[];
  stressCases?:{id:string;status:'evaluated'|'unknown';score?:BotEvaluation}[];
  uncertaintyPenalty?:number;
}
export interface BotDecision {
  opening?:ReturnType<typeof openingExpansion>;
  risk?:{parameters:OutpostRiskConfig;outposts:OutpostRisk[]};
  format:'deterministic-bot-decision/1';basisRevision:string;observedTick:number;
  parameters:BotSettings;
  utilityScale:typeof BOT_UTILITY_SCALE;
  situation:ReturnType<typeof botSituation>;selected:BotCandidate;
  mining?:NonNullable<ReturnType<typeof mineHoldingAssessment>>;
  assessments:BotAssessment[];
  coverage:{generated:number;evaluated:number;simulations:number;complete:boolean;stopReason:'complete'|'simulation-budget'|'time-budget'|'stage-budget'|'cancelled';cacheHits?:number;earlyResourceStops?:number;stages?:{discovery:number;refinement:number;combination:number;continuation:number;stress:number}};
  assumptions:string[];
  policyDiagnostics?:Record<string,unknown>;
}
/** All autonomous action types use the same weighted-gain threshold. */
export function botActionGainThreshold(policy:Readonly<BotSettings>,candidate:Pick<BotCandidate,'captureTargets'|'combatIntent'>,o?:PlayerObservation):number {
  return policy.minActionGain;
}
const hold:BotCandidate={id:'hold',kind:'hold',objective:'hold',targets:[],drafts:[],priority:0,reasons:['维持已有行动作为比较基线']};
const improves=(a:BotEvaluation,b:BotEvaluation,margin=1)=>compareBotEvaluations(a,b)>0
  &&(a.outcome!==b.outcome||a.crossingTick!==b.crossingTick||a.utility>b.utility+margin);
/** Goal continuity may choose a slightly weaker good action, but must never
 * turn a rejected action back on after hold won the adversarial comparison. */
export function canRetainBotObjective(incumbent:BotEvaluation,baseline:BotEvaluation,next:BotEvaluation,margin=1,switchMargin=6):boolean {
  return improves(incumbent,baseline,margin)&&incumbent.outcome===next.outcome
    &&incumbent.crossingTick===next.crossingTick&&next.utility-incumbent.utility<=switchMargin;
}
function informationValue(candidate:BotCandidate,score:BotEvaluation):BotEvaluation{
  if(candidate.kind==='scout'){
    const credit=6-2*candidate.drafts.reduce((n,d)=>n+Number(d.action.drillers??0),0);
    score.components.scouting=credit;score.utility+=credit;score.unknowns.push('scout-target-outcome-unknown');
  }
  return score;
}

function protectedCandidate(o:PlayerObservation,c:BotCandidate):boolean {
  const protections=(o.manualCommands?.protections??[]).filter(p=>p.expiresAtTick===undefined||p.expiresAtTick>o.view.tick);
  const ids=new Set(protections.flatMap(manualProtectionEntities));
  return c.drafts.some(d=>{
    const a=d.action;
    return ['source','destination','fleetId','outpostId'].some(k=>typeof a[k]==='string'&&ids.has(a[k] as string));
  });
}

/** Bounded rolling search. No I/O and no model calls. This returns advice only;
 * execution/recovery belongs to the existing authorized runner. */
type ForecastSteps<T>=Generator<BotForecastRequest[],T,BotForecastResult[]>;
/** Synchronous reference and async workers share exactly the same planner. */
export function planBot(o:PlayerObservation,routes:AttackRoutes,options:BotPlannerOptions={}):BotDecision {
  const steps=planBotSteps(o,routes,options);let next=steps.next();
  while(!next.done)next=steps.next(next.value.map(request=>executeBotForecast(o,request)));
  return next.value;
}
export async function planBotAsync(o:PlayerObservation,routes:AttackRoutes,options:BotPlannerOptions,
 run:(requests:BotForecastRequest[])=>Promise<BotForecastResult[]>):Promise<BotDecision>{
  const steps=planBotSteps(o,routes,options);let next=steps.next();
  while(!next.done){options.signal?.throwIfAborted();const results=await run(next.value);options.signal?.throwIfAborted();
    if(results.length!==next.value.length)throw Error('Incomplete candidate batch');next=steps.next(results);}
  return next.value;
}
function* planBotSteps(o:PlayerObservation,routes:AttackRoutes,options:BotPlannerOptions):ForecastSteps<BotDecision> {
  const parallelism=options.parallelism??1;
  if(!Number.isSafeInteger(parallelism)||parallelism<1||parallelism>8)throw Error('Invalid bot candidate concurrency');
  const policy=resolveBotSettings(options.settings);
  const riskConfig=options.riskConfig??loadOutpostRiskConfig(),risks=createOutpostRiskAnalysis(o,riskConfig,routes);
  const weights=botEffectiveWeights(policy);
  const maximum=options.maxSimulations??policy.maxSimulations,horizon=options.horizonTicks??policy.horizonTicks,timeLimit=options.maxElapsedMs??policy.maxElapsedMs;
  const attackPressure=botAttackPressure(o);
  const margin=(candidate:BotCandidate)=>botActionGainThreshold(policy,candidate,o);
  if(!Number.isSafeInteger(maximum)||maximum<2||maximum>512||!Number.isSafeInteger(horizon)||horizon<1||horizon>BOT_SETTING_LIMITS.horizonTicks.max||!Number.isFinite(timeLimit)||timeLimit<1||timeLimit>60000)throw Error('Invalid bot search budget');
  if(o.view.teamSize!==0)throw Error('Programmatic bot currently requires the enabled solo game mode');
  const situation=botSituation(o),mining=mineHoldingAssessment(o,o.view,risks),assessments:BotAssessment[]=[];
  const baselineUncertainty=new Set<string>();
  const baselineArrivals=new Set<string>();
  let baselineCrossing:{player:number;tick:number}|null=null;
  const arrivalKey=(e:KnownPathEvent)=>JSON.stringify([e.subject,e.tick,e.fraction,e.details.outpost,e.details.owner]);
  const penalizeRemoteRisk=(score:BotEvaluation,penalty:number)=>{
    if(penalty){score.components.remoteUncertainty=-penalty;score.utility-=penalty;score.unknowns.push('bounded-attack-with-unresolved-remote-arrival');}
    return score;
  };
  const baselineProgress=new Map<string,Record<string,number>>();
  const costed=(candidate:BotCandidate,score:BotEvaluation,path:KnownPathEvidence|null,comparison='ordinary')=>{
    const cost=botCommitmentCost(o,candidate.drafts,path,risks);
    if(candidate.captureTargets?.length)cost.transit*=attackPressure.commitmentMultiplier;
    score.components.committedForce=-cost.transit;
    score.components.garrisonFlexibility=-cost.shortfall*weights.defenseWeight;
    score.utility-=cost.transit+cost.shortfall*weights.defenseWeight;
    const jointPressure=botAttackValue(o,path,options.guidance?.attackDefenseFactors).jointPressure;
    score.components.jointPressure=jointPressure;score.utility+=jointPressure;
    if(options.guidance){
      const progress=strategicProgress(o,path,options.guidance.objectives,horizon);
      if(candidate.id==='hold')baselineProgress.set(comparison,progress);
      const baseline=baselineProgress.get(comparison);
      const contribution=candidate.id==='hold'||!baseline?0:Object.entries(progress).reduce((sum,[key,value])=>sum+Math.max(0,value-(baseline[key]??0)),0);
      score.components.strategicContribution=contribution;score.utility+=contribution;
    }
    return score;
  };
  let simulations=0,stopReason:BotDecision['coverage']['stopReason']='complete';
  let cacheHits=0;
  let earlyResourceStops=0;
  const stages={discovery:0,refinement:0,combination:0,continuation:0,stress:0};
  let attritionUpperBoundStops=0,combinationAttempts=0,holdingSubplanAttempts=0;
  let stage:keyof typeof stages='discovery';
  const cached=new Map<string,BotAssessment>();
  const started=performance.now(),targetTick=o.view.tick+horizon;
  let lastProgress=-Infinity;
  const reportProgress=(active:BotCandidate[])=>{
    if(!options.onProgress||performance.now()-lastProgress<100)return;
    lastProgress=performance.now();
    const branch=botSearchBranch;
    options.onProgress({basisRevision:o.revision,observedTick:o.view.tick,elapsedMs:performance.now()-started,stage,generated:candidates.length,evaluated:assessments.filter(a=>a.status==='evaluated').length,simulations,maximum,horizon,timeLimitMs:timeLimit,stages:{...stages},branches:[...assessments.map(a=>branch(a.candidate,a.status,a.score?.utility??null)),...active.map(c=>branch(c,'running',null))]});
  };
  const canCompute=()=>{
    if(options.signal?.aborted){stopReason='cancelled';return false;}
    if(simulations>=maximum){stopReason='simulation-budget';return false;}
    if(performance.now()-started>=timeLimit){stopReason='time-budget';return false;}
    return true;
  };
  const assessment=function*(candidate:BotCandidate,stressReserve?:number):ForecastSteps<BotAssessment|null>{
    if(candidate.drafts.some(d=>['cancel-launch','return-fleet'].includes(String(d.action.kind))&&typeof d.action.fleetId==='string'&&options.protectedFleetIds?.includes(d.action.fleetId)))return {candidate,status:'protected',score:null,stress:null,reasons:['本轮刚接受的内部调动，等待实际结算；新紧急事件另行复查']};
    if(options.guidance&&!tacticalGuidanceAllows(o,candidate.drafts,options.guidance))return {candidate,status:'protected',score:null,stress:null,reasons:['当前战略资源或外交约束不允许该组合']};
    if(!botDispatchPlanAllowed(o,candidate.drafts))return {candidate,status:'protected',score:null,stress:null,reasons:['本日来源调度已锁定，不能新增或修改出兵计划']};
    if(protectedCandidate(o,candidate))return {candidate,status:'protected',score:null,stress:null,reasons:['与当前手动保护冲突']};
    if(candidate.drafts.some(d=>d.issueTick>targetTick))return {candidate,status:'unknown',score:null,stress:null,reasons:['候选操作超出本次推演窗口']};
    if(candidate.combatIntent==='attrition'&&botAttritionBenefitUpperBound(o,candidate.drafts,options.guidance?.attackDefenseFactors)+1e-9<=margin(candidate)){
      attritionUpperBoundStops++;
      return {candidate,status:'invalid',score:null,stress:null,reasons:['attrition-benefit-upper-bound']};
    }
    const signature=JSON.stringify([candidate.kind==='scout',candidate.combatIntent??null,candidate.captureTargets??[],candidate.drafts.map(d=>[d.issueTick,d.action])]);
    const saved=cached.get(signature);
    if(saved){cacheHits++;return {...structuredClone(saved),candidate};}
    if(candidate.id!=='hold'&&!options.preludeIndependent&&simulations+1+(stressReserve??2*botOpponentScenarios(o,routes,[candidate],horizon).length)>maximum)return null;
    if(!canCompute())return null;
    const context={snapshot:{observation:o}};
    const initial=checkPlanResources(candidate.drafts,undefined,context,{deferToForecast:true});
    const predicates:KnownPathPredicate[]=(candidate.captureTargets??(candidate.objective.startsWith('capture:')?candidate.targets:[])).map((outpostId,i)=>({id:`target-${i}`,kind:'controlledAtHorizon',outpostId}));
    const friendlyTransfer=options.preludeIndependent&&options.preludeCandidates?.some(c=>c.id===candidate.id)&&candidate.drafts.every(d=>d.action.kind==='launch');
    if(friendlyTransfer){
 for(const id of new Set(candidate.drafts.flatMap(d=>[d.action.source,d.action.destination]).filter((id):id is string=>typeof id==='string')))predicates.push({id:'prelude-'+id,kind:'controlsThroughout',outpostId:id});
    }
    if(candidate.kind==='scout')for(const d of candidate.drafts)if(typeof d.action.source==='string')predicates.push({id:`scout-source-${d.id}`,kind:'controlsThroughout',outpostId:d.action.source});
    simulations++;stages[stage]++;
    reportProgress([candidate]);
    const [computed]=yield [{targetTick,drafts:candidate.drafts,predicates,collectResourceFrames:true,resourcePrefix:true}];
    if(!computed)throw Error('Missing candidate forecast');
    if(computed.kind==='error')return {candidate,status:'invalid',score:null,stress:null,reasons:[computed.message]};
    if(computed.kind==='early'){earlyResourceStops++;return {candidate,status:computed.status,score:null,stress:null,reasons:computed.reasons};}
    const result=computed.result;
    if(result.forecast.status==='unsupported')return {candidate,status:'unknown',score:null,stress:null,reasons:result.forecast.reasons};
    const unknownArrivals=result.path?.events.filter(e=>e.kind==='future-unknown-arrival')??[];
    if(candidate.id==='hold')for(const arrival of unknownArrivals)baselineArrivals.add(arrivalKey(arrival));
    const resources=finalizePlanResources(initial,{...result.forecast,...result.path?{path:result.path}:{}},candidate.drafts,undefined,context);
    if(resources.status==='conflict'||resources.status==='unknown')return {candidate,status:resources.status==='conflict'?'invalid':'unknown',score:null,stress:null,reasons:resources.conflicts.map(c=>c.code)};
    if(candidate.combatIntent==='attrition'&&(!result.forecast.result.self.active||!botAttritionAllowed(o,result.path,candidate.drafts,options.guidance?.attackDefenseFactors,margin(candidate))))return {candidate,status:'invalid',score:null,stress:null,reasons:['attrition-exchange-not-verified']};
    if(friendlyTransfer){
      const path=result.path,frame=result.forecast.result;
      const delivered=path?.coverage.complete&&candidate.drafts.every(d=>{
        if(d.action.kind!=='launch')return false;
        const fleet=path.orderFleets.find(f=>f.orderId===d.id&&f.status==='executed');
        if(!fleet||!path.events.some(e=>e.subject===fleet.fleetId&&e.kind==='unloaded'&&e.details.outpost===d.action.destination))return false;
        return true;
      });
      if(!delivered)return {candidate,status:'unknown',score:null,stress:null,reasons:['内部调动未在完整窗口中确认友方交付，不采用']};
    }
    // A 1-troop probe intentionally accepts its own unknown arrival. This
    // exception never turns that uncertainty into a capture/safety proof and
    // never admits other incomplete paths or a known source loss.
    const unresolved=result.path?.predicates.filter(p=>p.truth!=='true'&&!(candidate.kind==='scout'&&p.truth==='unknown'&&p.reason==='arrival-outcome-unknown'
      &&result.path!.coverage.unknownReasons.every(r=>r==='arrival-outcome-unknown'||r==='asset-outcome-unknown'&&unknownArrivals.length>0||baselineUncertainty.has(r))));
    const targets=candidate.captureTargets??[],frame=result.forecast.result;
    const crossing=frame.terminalPrediction?.firstCrossing;
    if(candidate.id==='hold'&&crossing?.triggeringSeat!=null&&crossing.triggeringSeat!==o.view.player)
      baselineCrossing={player:crossing.triggeringSeat,tick:crossing.tick};
    const force=candidate.drafts.reduce((sum,d)=>sum+Number(d.action.drillers??0),0);
    // Risk policy, not a proof override: an unchanged foreign arrival at a
    // different fog location must not freeze every known-target attack. Keep
    // shared predicates unknown, limit committed force, and discount the line.
    const remoteRisk=!!unresolved?.length&&targets.length>0&&force>0&&force<=o.view.self.drillers*policy.remoteUncertaintyForceFraction
      &&unresolved.every(p=>p.truth==='unknown'&&p.reason==='unresolved-actors-may-affect-endpoint')
      &&result.path?.coverage.complete&&frame.self.active
      // Asset uncertainty is emitted for the same unresolved arrival. The
      // checks below still require every arrival to match the unchanged
      // foreign baseline and stay away from this attack's sources/targets.
      &&result.path.coverage.unknownReasons.every(r=>r==='arrival-outcome-unknown'||r==='asset-outcome-unknown'&&unknownArrivals.length>0)
      &&unknownArrivals.length>0&&unknownArrivals.every(a=>baselineArrivals.has(arrivalKey(a))
        &&!targets.includes(String(a.details.outpost))&&!candidate.drafts.some(d=>d.action.source===a.details.outpost)
        &&o.view.fleets.some(f=>f.id===a.subject&&f.owner!==o.view.player))
      &&targets.every(id=>frame.outposts.some(p=>p.id===id&&p.visibility===2&&p.owner===o.view.player&&!p.destroyed)
        &&result.path!.events.some(e=>e.subject===id&&e.kind==='outpost-captured'&&e.details.owner===o.view.player));
    // Holding the captured base is normally required. A verified raid can
    // instead improve the baseline winner's conditional crossing. The path
    // must reach the horizon or its known terminal boundary; unresolved
    // actors or an unrecorded capture cannot supply this denial evidence.
    const captures=(id:string)=>result.path?.events.filter(e=>e.kind==='outpost-captured'&&e.subject===id&&e.details.owner===o.view.player)??[];
    const coveredTerminal=!!crossing&&frame.terminalPrediction?.status!=='unknown'&&frame.terminalPrediction?.stoppedAtCrossing
      &&result.path?.actualTargetTick===crossing.tick;
    const improvedCrossing=!!baselineCrossing&&(!crossing||crossing.triggeringSeat===o.view.player||crossing.tick>baselineCrossing.tick);
    const temporaryDenial=!!unresolved?.length&&!!baselineCrossing&&frame.self.active&&improvedCrossing
      &&(result.path?.coverage.complete||coveredTerminal)
      &&result.path?.coverage.unknownReasons.every(reason=>coveredTerminal&&reason==='requested-horizon-not-covered')
      &&unresolved.every(p=>p.kind==='controlledAtHorizon'&&(p.truth==='false'||coveredTerminal&&p.truth==='unknown'&&p.reason==='requested-horizon-not-covered')&&captures(p.outpostId).length>0)
      &&targets.some(id=>o.view.outposts.some(p=>p.id===id&&p.type==='mine'&&p.owner===baselineCrossing!.player)
        &&captures(id).some(e=>e.details.before===baselineCrossing!.player&&e.tick+e.fraction<=baselineCrossing!.tick));
    if(unresolved?.length&&!remoteRisk&&!temporaryDenial)return {candidate,status:unresolved.some(p=>p.truth==='false')?'invalid':'unknown',score:null,stress:null,reasons:unresolved.map(p=>p.reason)};
    const uncertaintyPenalty=remoteRisk?12*targets.length+force*0.15:0;
    const baseScore=evaluateBotFrame(o,frame,result.path,policy,riskConfig);
    const score=costed(candidate,penalizeRemoteRisk(informationValue(candidate,options.scoreFrame?.(frame,baseScore)??baseScore),uncertaintyPenalty),result.path);
    const evaluated:BotAssessment={candidate,status:'evaluated',score,stress:null,uncertaintyPenalty,reasons:[...candidate.reasons,...remoteRisk?['接受有限兵力风险；远处未知抵达仍未解决，不保证最终占领']:[],...temporaryDenial?['路径确认短暂夺矿改善基线终局结果或延后对手条件冲线；不声称终点持有或保证获胜']:[],...score.unknowns.map(s=>`未知:${s}`)]};
    cached.set(signature,structuredClone(evaluated));return evaluated;
  };
  const decision=(selected:BotCandidate,generated:number):BotDecision=>({format:'deterministic-bot-decision/1',basisRevision:o.revision,observedTick:o.view.tick,parameters:{...policy,maxSimulations:maximum,maxElapsedMs:timeLimit,horizonTicks:horizon},situation,...mining?{mining}:{},selected,assessments,
    utilityScale:BOT_UTILITY_SCALE,risk:{parameters:riskConfig,outposts:risks.own()},opening:openingExpansion(o),policyDiagnostics:{...options.policyDiagnostics,selection:{...BOT_ACTION_WEIGHTS,minimumGain:policy.minActionGain},searchEfficiency:{attritionUpperBoundStops,combinationAttempts,holdingSubplanAttempts},attackPressure:{...attackPressure,baseCaptureGain:policy.minActionGain,effectiveCaptureGain:policy.minActionGain}},
    coverage:{generated,evaluated:assessments.filter(a=>a.status==='evaluated').length,simulations,complete:stopReason==='complete',stopReason,cacheHits,earlyResourceStops,stages},
    assumptions:selected.commanderDirected
     ?['仅授权观察','明确指挥官指令通过条件路径、友方交付、资源及生存检查，不以自主软收益取消指令','接受不代表实际交付，后续以回执和结算为准']
     :['仅授权观察','基线沿现有行动继续；另列可见资产的敌方反应假设','普通收益占60%、压力收益占40%，所有自主行动共用综合收益门槛','敌方反应是有限压力测试，不是已发生命令、意图预测或穷尽所有反击','矿场长期资本按可见局部守备折减，库存暴露是评分启发式而非失守概率；已结算失矿扣款只在引擎库存中计一次','未来执行仍需权限、资源及局面复核']});
  if(!o.view.self.active||o.view.match?.ended)return decision(hold,0);
  const guidance=options.guidance;
  const prelude=(options.validationCandidate?[options.validationCandidate]:[...(options.preludeCandidates??[]),...(options.internalTransfers?internalTransferPrelude(o,routes,horizon,risks,guidance):[])]).filter(c=>c.drafts.every(d=>d.issueTick===o.view.tick)&&(!guidance||tacticalGuidanceAllows(o,c.drafts,guidance)));
  // Shared candidates use the same path and delivery gates as mode-injected
  // independent reviews, rather than just a favourable endpoint score.
  options={...options,preludeCandidates:prelude};
  const ordinary=()=>generateBotCandidates(o,routes,options.scoutedTargets??[],policy.forceBufferRatio,risks,[...(guidance?.objectives.flatMap(g=>g.targets)??[]),...(options.incumbentObjective?.startsWith('capture:')?[options.incumbentObjective.slice(8)]:[])],guidance?.attackDefenseFactors??[]).filter(c=>c.drafts.every(d=>d.issueTick===o.view.tick)&&(!guidance||tacticalGuidanceAllows(o,c.drafts,guidance)));
  const candidates=[...prelude,...options.validationCandidate||options.preludeOnly?[]:ordinary()];
  const guidanceValue=(c:BotCandidate)=>guidance?.objectives.reduce((n,g)=>n+(c.targets.some(t=>g.targets.includes(t))?g.priority:0),0)??0;
  if(guidance)candidates.sort((a,b)=>guidanceValue(b)-guidanceValue(a));
  if(options.preludeOnly&&!candidates.length)return decision(hold,0);
  const baseline=yield* assessment(hold);
  if(!baseline)return decision(hold,candidates.length);
  assessments.push(baseline);
  if(!baseline.score)return decision(hold,candidates.length);
  options.onCheckpoint?.(decision(hold,candidates.length));
  for(const reason of baseline.score.unknowns)baselineUncertainty.add(reason);
  // A mode's cheap review runs before normal discovery. Validate its bounded
  // shortlist first against the same hold/path/resource and simulation budget.
  const preludeLimit=options.validationCandidate?maximum:Math.min(maximum,Math.max(2,Math.floor(maximum*0.24)));
  const preludeIds=new Set<string>();
  for(const candidate of prelude){
    if(simulations>=preludeLimit||performance.now()-started>=timeLimit*(options.validationCandidate?1:0.24))break;
    const evaluated=yield* assessment(candidate);if(!evaluated)break;
    assessments.push(evaluated);preludeIds.add(candidate.id);
    if(options.preludeIndependent&&candidate.commanderDirected&&evaluated.score
      &&compareBotEvaluations({...evaluated.score,utility:0},{...baseline.score,utility:0})>=0){
      options.policyDiagnostics={...options.policyDiagnostics,executionPhase:'independent'};
      return decision(candidate,candidates.length);
    }
  }
  // Reserve budget for joint bundles and adversarial waiting recalls. Fair
  // queues ensure economic/defense aren't starved by attack permutations.
  const kinds:BotCandidateKind[]=['defense','attack','economy','fleet','logistics','scout'];
  // Compare distinct objectives before spending the whole discovery window
  // on several troop amounts for one target. Keep ordering within each target.
  const groups=botDiscoveryQueues(candidates.filter(c=>!preludeIds.has(c.id)),kinds);
  if(guidance)for(const group of groups){
    const keys=[...new Set(group.map(c=>c.objective))];const offset=keys.length?guidance.rotation%keys.length:0;
    const rank=new Map([...keys.slice(offset),...keys.slice(0,offset)].map((key,i)=>[key,i]));
    group.sort((a,b)=>guidanceValue(b)-guidanceValue(a)||(rank.get(a.objective)??0)-(rank.get(b.objective)??0));
  }
  let checked=preludeIds.size;
  const checkedIds=new Set<string>(preludeIds);
  let discoveryStoppedForTime=false;
  // User-selected discovery share: 48 branch attempts at the default 80 total.
  // Constraints alone do not narrow search. An unavailable strategic model
  // must retain the programmatic discovery breadth.
  const strategic=!!guidance?.objectives.length;
  const discoveryBudget=Math.max(1,Math.floor(maximum*(strategic?0.30:0.6)));
  const urgentDefenseTargets=new Set(o.view.fleets.filter(f=>f.owner!==o.view.player&&!f.gift&&f.destination?.kind==='outpost'&&o.view.outposts.some(p=>p.id===f.destination!.id&&p.owner===o.view.player)).map(f=>f.destination!.id));
  const queue=botDiscoveryOrder(groups,Math.min(8,Math.max(1,Math.floor(discoveryBudget*0.4))),urgentDefenseTargets,guidanceValue);
  // Reserve simulation slots before dispatch, then fold results in queue order.
  // A duplicate branch waits for the preceding batch's cache rather than
  // consuming a second slot. Completion order never chooses the winner.
  for(let index=0;index<queue.length;){
    const pending:{iterator:ForecastSteps<BotAssessment|null>;request:BotForecastRequest;index:number}[]=[];
    const completed:{index:number;value:BotAssessment}[]=[];const inFlight=new Set<string>();let exhausted=false;
    while(index<queue.length&&pending.length<parallelism){
      if(simulations>=discoveryBudget)break;
      if(performance.now()-started>=timeLimit*0.45){discoveryStoppedForTime=true;break;}
      const candidate=queue[index]!,signature=JSON.stringify([candidate.kind==='scout',candidate.combatIntent??null,candidate.captureTargets??[],candidate.drafts.map(d=>[d.issueTick,d.action])]);
      if(inFlight.has(signature))break;
      const at=index++,iterator=assessment(candidate),next=iterator.next();
      if(next.done){if(!next.value){exhausted=true;break;}completed.push({index:at,value:next.value});}
      else{if(next.value.length!==1)throw Error('Invalid candidate request');pending.push({iterator,request:next.value[0]!,index:at});inFlight.add(signature);}
    }
    if(pending.length){
      const results=yield pending.map(p=>p.request);
      for(let i=0;i<pending.length;i++){const entry=pending[i]!,done=entry.iterator.next([results[i]!]);
        if(!done.done||!done.value)throw Error('Incomplete candidate assessment');completed.push({index:entry.index,value:done.value});}
    }
    for(const {value} of completed.sort((a,b)=>a.index-b.index)){assessments.push(value);checked++;checkedIds.add(value.candidate.id);}
    options.onCheckpoint?.(decision(hold,candidates.length));
    if(exhausted||!pending.length&&!completed.length)break;
  }
  const prioritizeHome=openingExpansion(o).uncoveredHome.length>0&&['economy','expansion'].includes(situation.phase)
    &&!o.view.fleets.some(f=>f.owner!==o.view.player&&!f.gift&&o.view.outposts.some(p=>p.owner===o.view.player&&p.id===f.destination?.id));
  const homePreference=(a:BotEvaluation,b:BotEvaluation)=>prioritizeHome&&a.outcome===b.outcome&&a.crossingTick===b.crossingTick
    ?(a.components.openingCoverage??0)-(b.components.openingCoverage??0):0;
  const compare=(a:BotAssessment,b:BotAssessment)=>{
    const left=botWeightedEvaluation(a.score!,a.stress),right=botWeightedEvaluation(b.score!,b.stress);
    return homePreference(left,right)||compareBotEvaluations(left,right)||b.candidate.drafts.length-a.candidate.drafts.length||b.candidate.id.localeCompare(a.candidate.id);
  };
  // Refine at most two promising capture topologies inside the existing budget.
  // Proportional reduction also covers joint waves and gather/attack bundles;
  // every trial rechecks schedules, resources and target control in the engine.
  // Combat is not assumed monotone: retain only verified successes, and label
  // the result as a tested bound, never a globally proven minimum.
  const superseded=new Set<string>();
  const topology=(c:BotCandidate)=>JSON.stringify(c.drafts.map(d=>[d.issueTick,{...d.action,drillers:0}]));
  const seeds=assessments.filter(a=>!options.validationCandidate&&a.score&&a.candidate.captureTargets?.length&&a.candidate.drafts.every(d=>d.action.kind==='launch')&&!a.uncertaintyPenalty)
    .sort((a,b)=>compare(b,a)).filter((a,i,all)=>all.findIndex(b=>topology(a.candidate)===topology(b.candidate))===i).slice(0,2);
  stage='refinement';
  const refinementLimit=Math.max(discoveryBudget,Math.floor(maximum*(strategic?0.60:0.64)));
  for(const seed of seeds){
    if(simulations>=refinementLimit-1||performance.now()-started>=timeLimit*0.58)break;
    const original=seed.candidate;
    const maxForce=Math.max(...original.drafts.map(d=>Number(d.action.drillers??0)));
    if(maxForce<2)continue;
    const variant=(force:number,label:string):BotCandidate=>({...original,...original.forceEstimate?{forceEstimate:{...original.forceEstimate,committed:Math.ceil(original.forceEstimate.committed*force/maxForce)}}:{},id:`${original.id}-${label}-${force}`,
      drafts:original.drafts.map((d,i)=>({...d,id:`${original.id}-${label}-${force}-${i}`,action:{...d.action,drillers:Number(d.action.drillers??0)===0?0:Math.max(1,Math.ceil(Number(d.action.drillers)*force/maxForce))}}))});
    let low=1,high=maxForce,smallest=seed;
    for(let n=0;n<3&&low<high;n++){
      if(simulations>=refinementLimit-1||performance.now()-started>=timeLimit*0.58)break;
      const middle=Math.floor((low+high)/2),trial=yield* assessment(variant(middle,'minimum'));
      if(!trial)break;assessments.push(trial);superseded.add(trial.candidate.id);
      if(trial.score&&!trial.uncertaintyPenalty&&trial.score.outcome>=seed.score!.outcome){smallest=trial;high=middle;}
      else low=middle+1;
    }
    const tested=Math.max(...smallest.candidate.drafts.map(d=>Number(d.action.drillers??0)));
    // Do not silently cap away the safety margin. If it cannot be funded or
    // verified, retain the original candidates (including emergency all-in).
    const buffered=botBufferedForce(tested,policy.forceBufferRatio),padded=variant(buffered,'buffered');
    const verified=yield* assessment(padded);
    if(!verified)continue;assessments.push(verified);
    if(!verified.score||verified.uncertaintyPenalty||verified.score.outcome<seed.score!.outcome)continue;
    padded.forceSizing={testedMinimum:tested,bufferedForce:buffered,margin:buffered-tested,search:'bounded-proportional',basis:'largest-launch'};
    padded.reasons=[...original.reasons,`等比例缩减后联合推演验证可行：最大单次出兵${tested}，追加${Number((policy.forceBufferRatio*100).toFixed(6))}%余量（兵数向上取整）至${buffered}，其余波次同比增加；非全局最小兵力证明`];
    // A smaller force is another alternative, not a dominance proof. Keep
    // original force variants for the same adversarial comparison; only an
    // identical effective branch can be replaced by its annotated version.
    const sameBranch=(c:BotCandidate)=>JSON.stringify(c.drafts.map(d=>[d.issueTick,d.action]));
    for(const a of assessments)if(a!==verified&&sameBranch(a.candidate)===sameBranch(padded))superseded.add(a.candidate.id);
  }
  const promisingCandidates=()=>assessments.filter(a=>a.score&&!superseded.has(a.candidate.id)&&a.candidate.id!=='hold').sort((a,b)=>compare(b,a)).slice(0,6);
  const combinationCap=Math.min(20,Math.floor(maximum*0.25)),combinedKeys=new Set<string>();
  const combinationQueue=()=>botCombinationCandidates(o,assessments.filter(a=>a.score&&!superseded.has(a.candidate.id)).sort((a,b)=>compare(b,a)).map(a=>a.candidate),candidates);
  const combine=function*(attemptLimit:number,timeFraction:number):ForecastSteps<void>{
    if(options.validationCandidate)return;
    stage='combination';
    for(const candidate of combinationQueue()){
      const key=JSON.stringify([[...(candidate.captureTargets??[])].sort(),candidate.drafts.map(d=>[d.issueTick,d.action])]);
      if(combinedKeys.has(key))continue;
      const scenarios=botOpponentScenarios(o,routes,[candidate,...promisingCandidates().slice(0,2).map(a=>a.candidate)],horizon).length;
      const reserve=scenarios*Math.min(5,Math.max(2,assessments.filter(a=>a.score).length));
      if(combinationAttempts>=attemptLimit||simulations>=Math.min(Math.floor(maximum*0.8),maximum-reserve)||performance.now()-started>=timeLimit*timeFraction)break;
      combinedKeys.add(key);combinationAttempts++;
      const evaluated=yield* assessment(candidate);if(evaluated)assessments.push(evaluated);
    }
  };
  // Compare bounded multi-command transactions, including joint assaults whose
  // single-source seeds failed. Keep room for the common reaction scenarios.
  yield* combine(Math.min(12,combinationCap),0.7);
  // One shared, bounded scenario set for hold and every finalist. Exhausting
  // the budget does not let an untested candidate inherit a tested score.
  // Reuse unspent refinement/combination budget for discovery. Reserve the
  // actual bounded scenario set instead of fixed 20/24-simulation constants.
  stage='continuation';
  const continuationLimit=guidance?maximum:Math.min(maximum,simulations+Math.max(1,Math.floor(maximum*0.1)));
  continuation:for(let i=0;groups.some(g=>i<g.length);i++)for(const group of groups){
    const candidate=group[i];if(!candidate||checkedIds.has(candidate.id))continue;
    if(simulations>=continuationLimit)break continuation;
    // A failed or unprofitable seed does not prove its objective impossible:
    // a stronger force can overcome losses omitted from the cheap estimate.
    // Revisit those variants inside the same bounded continuation share.
    const scenarioCount=botOpponentScenarios(o,routes,promisingCandidates().slice(0,3).map(a=>a.candidate),horizon).length;
    const reserve=scenarioCount*Math.min(5,assessments.filter(a=>a.score&&!superseded.has(a.candidate.id)).length)+Math.min(4,combinationCap-combinationAttempts);
    if(simulations>=maximum-reserve)break continuation;
    const estimatedMs=(performance.now()-started)/Math.max(1,simulations);
    if(performance.now()-started+estimatedMs*reserve*1.15>=timeLimit){discoveryStoppedForTime=true;break continuation;}
    const evaluated=yield* assessment(candidate);if(!evaluated)break continuation;
    assessments.push(evaluated);checked++;checkedIds.add(candidate.id);
  }
  // Newly discovered alternatives also get a chance to form a joint plan.
  yield* combine(combinationCap,0.82);
  const rankedFinalists=assessments.filter(a=>a.score&&a!==baseline&&!superseded.has(a.candidate.id)).sort((a,b)=>compare(b,a));
  const preferredCombination=rankedFinalists.find(a=>a.candidate.kind==='combined');
  const stressShortlist=botStressShortlist(o,routes,rankedFinalists,horizon,preferredCombination);
  let scenarios=botOpponentScenarios(o,routes,stressShortlist.map(a=>a.candidate),horizon);
  // Keep one bounded retry for a proper subset of an immediate capture bundle.
  // Its hold baseline is already tested against this exact shared scenario set.
  const canSplit=!options.validationCandidate&&stressShortlist.some(a=>botCaptureSubplan(o,a.candidate,new Set(a.candidate.captureTargets?.slice(0,1)))!==null);
  const subplanReserve=()=>canSplit&&scenarios.length?Math.min(scenarios.length+1,Math.max(0,maximum-simulations-2*scenarios.length)):0;
  // Remove finalists rather than silently dropping mandatory reaction cases.
  while(stressShortlist.length>1&&(stressShortlist.length+1)*scenarios.length>maximum-simulations-subplanReserve()){
    stressShortlist.pop();scenarios=botOpponentScenarios(o,routes,stressShortlist.map(a=>a.candidate),horizon);
  }
  const needsStress=scenarios.length>0;
  const failedHolding=new Set<string>();
  const failedHoldingTargets=new Map<string,Set<string>>();
  const baselineMineLosses=new Map<string,Set<string>>();
  const finalistLimit=needsStress?Math.max(0,Math.min(4,Math.floor((maximum-simulations-subplanReserve())/scenarios.length)-1)):4;
  const finalists=stressShortlist.slice(0,finalistLimit);
  const stressTest=function*(stressCandidates:BotAssessment[]):ForecastSteps<void>{
    stage='stress';
    const jobs=stressCandidates.flatMap(candidate=>scenarios.map(scenario=>({candidate,scenario})));
    for(const candidate of stressCandidates)candidate.stressCases=[];
    for(let index=0;index<jobs.length;){
      const batch:typeof jobs=[];
      while(index<jobs.length&&batch.length<parallelism&&canCompute()){batch.push(jobs[index++]!);simulations++;stages.stress++;}
      if(!batch.length)break;
      reportProgress(batch.map(j=>j.candidate.candidate));
      const results=yield batch.map(({candidate,scenario})=>({targetTick,drafts:candidate.candidate.drafts,...scenario.enemyWaiting?{enemyWaiting:scenario.enemyWaiting}:{},...scenario.enemyLaunches?{enemyLaunches:scenario.enemyLaunches}:{},collectResourceFrames:true}));
      for(let i=0;i<batch.length;i++){
        const {candidate,scenario}=batch[i]!;
        try{
          const computed=results[i]!;if(computed.kind!=='result')throw Error('反应场景推演失败');const result=computed.result;
          const context={snapshot:{observation:o}},initial=checkPlanResources(candidate.candidate.drafts,undefined,context,{deferToForecast:true});
          const resources=finalizePlanResources(initial,{...result.forecast,...result.path?{path:result.path}:{}},candidate.candidate.drafts,undefined,context);
          if(result.forecast.status!=='conditional'||['conflict','unknown'].includes(resources.status))throw Error('反应场景资源或执行未能确认');
          if(scenario.protectedMine&&!result.path?.coverage.complete&&!result.forecast.result.terminalPrediction?.stoppedAtCrossing)throw Error('矿场反击路径未覆盖完整窗口');
          if(candidate.candidate.combatIntent==='attrition'&&(!result.forecast.result.self.active||!botAttritionAllowed(o,result.path,candidate.candidate.drafts,options.guidance?.attackDefenseFactors,margin(candidate.candidate))))throw Error('消耗方案在反应场景中未验证有效交换');
          const baseScore=evaluateBotFrame(o,result.forecast.result,result.path,policy,riskConfig);
          const score=costed(candidate.candidate,penalizeRemoteRisk(informationValue(candidate.candidate,options.scoreFrame?.(result.forecast.result,baseScore)??baseScore),candidate.uncertaintyPenalty??0),result.path,scenario.id);
          const ownMines=new Set(o.view.outposts.filter(p=>p.owner===o.view.player&&p.type==='mine'&&!p.destroyed).map(p=>p.id));
          const lost=new Set((result.path?.events??[]).filter(e=>e.kind==='outpost-captured'&&ownMines.has(e.subject)&&e.details.owner!==o.view.player).map(e=>e.subject));
          if(candidate===baseline)baselineMineLosses.set(scenario.id,lost);
          else if([...lost].some(id=>!baselineMineLosses.get(scenario.id)?.has(id))){
            const base=baseline.stressCases?.find(c=>c.id===scenario.id)?.score;
            const terminalImprovement=base&&(score.outcome>base.outcome||score.outcome===base.outcome&&score.crossingTick!==null&&base.crossingTick!==null&&(score.outcome===1?score.crossingTick<base.crossingTick:score.outcome<0&&score.crossingTick>base.crossingTick));
            if(!terminalImprovement){failedHolding.add(candidate.candidate.id);candidate.reasons.push(`${scenario.id}相较同场景留守新增失矿，普通扩张收益不能抵销矿场路径安全`);}
          }
          if(scenario.holdingTarget&&candidate.candidate.captureTargets?.includes(scenario.holdingTarget)
            &&score.outcome===0&&baseline.score!.outcome>=0&&result.forecast.result.outposts.find(p=>p.id===scenario.holdingTarget)?.owner!==o.view.player){
            failedHolding.add(candidate.candidate.id);
            const targets=failedHoldingTargets.get(candidate.candidate.id)??new Set<string>();targets.add(scenario.holdingTarget);failedHoldingTargets.set(candidate.candidate.id,targets);
            candidate.reasons.push(`${scenario.holdingTarget}在可见反夺场景中未能保持占领`);
          }
          candidate.stressCases!.push({id:scenario.id,status:'evaluated',score});
        }catch{candidate.stressCases!.push({id:scenario.id,status:'unknown'});candidate.reasons.push(`${scenario.id}反应场景未能验证`);}
      }
    }
    for(const candidate of stressCandidates){
      if(candidate.stressCases!.length===scenarios.length&&candidate.stressCases!.every(c=>c.status==='evaluated')){
        let worst=candidate.score!;for(const c of candidate.stressCases!)if(c.score&&compareBotEvaluations(c.score,worst)<0)worst=c.score;candidate.stress=worst;
      }else candidate.reasons.push('压力测试覆盖不完整，不采用此方案');
    }
  };
  if(needsStress)yield* stressTest([baseline,...finalists]);
  // A failed component does not establish that the other captures are bad.
  // Try at most one proper subplan, with every original pressure case intact;
  // never split an executor's exact validation proposal or publish partial tests.
  if(needsStress&&baseline.stress&&!options.validationCandidate){
    for(const original of [...finalists]){
      const rejected=failedHoldingTargets.get(original.candidate.id);if(!rejected)continue;
      const subplan=botCaptureSubplan(o,original.candidate,rejected);if(!subplan)continue;
      const sameActions=(a:BotCandidate,b:BotCandidate)=>JSON.stringify([a.captureTargets,a.drafts.map(d=>[d.issueTick,d.action])])===JSON.stringify([b.captureTargets,b.drafts.map(d=>[d.issueTick,d.action])]);
      if(finalists.some(a=>a.stress&&sameActions(a.candidate,subplan)))continue;
      if(simulations+1+scenarios.length>maximum||!canCompute())break;
      holdingSubplanAttempts++;candidates.push(subplan);stage='combination';
      const evaluated=yield* assessment(subplan,scenarios.length);if(!evaluated)break;
      assessments.push(evaluated);
      if(evaluated.status==='evaluated'&&evaluated.score){yield* stressTest([evaluated]);finalists.push(evaluated);}
      break;
    }
  }

  let best=baseline;
  for(const candidate of finalists){
    if(failedHolding.has(candidate.candidate.id)||candidate.status!=='evaluated'||!candidate.score||needsStress&&(!candidate.stress||!baseline.stress))continue;
    if(!botWeightedActionAllowed(candidate.score,baseline.score,candidate.stress,baseline.stress,margin(candidate.candidate)))continue;
    const evaluated=botWeightedEvaluation(candidate.score,candidate.stress),current=botWeightedEvaluation(best.score!,best.stress);
    if(
      // The action margin is paid against hold. Among already admissible
      // alternatives, a smaller real improvement must not lose to loop order.
      homePreference(evaluated,current)>0||homePreference(evaluated,current)===0&&improves(evaluated,current,0))best=candidate;
  }
  // Modest hysteresis applies only within the same outcome/timing class. A
  // prior objective never overrides survival, an earlier win, or a failed plan.
  const incumbent=finalists.find(a=>a.candidate.objective===options.incumbentObjective&&!failedHolding.has(a.candidate.id)&&a.status==='evaluated'&&a.score&&(!needsStress||a.stress));
  if(incumbent?.score&&botWeightedActionAllowed(incumbent.score,baseline.score,incumbent.stress,baseline.stress,margin(incumbent.candidate))){
    const old=botWeightedEvaluation(incumbent.score,incumbent.stress),next=botWeightedEvaluation(best.score!,best.stress);
    const base=botWeightedEvaluation(baseline.score,baseline.stress);
    if(homePreference(old,next)>=0&&canRetainBotObjective(old,base,next,margin(incumbent.candidate),policy.objectiveSwitchTolerance))best=incumbent;
  }
  if(best!==baseline&&preludeIds.has(best.candidate.id))options.policyDiagnostics={...options.policyDiagnostics,executionPhase:'independent'};
  if(stopReason==='complete'&&checked<candidates.length)stopReason=discoveryStoppedForTime?'time-budget':simulations>=maximum?'simulation-budget':'stage-budget';
  return decision(best.candidate,candidates.length);
}
