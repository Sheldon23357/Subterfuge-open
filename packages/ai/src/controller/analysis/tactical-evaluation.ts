import type {PlayerObservation, PlayerMapView, PlayerForecastResult} from '../../../../contracts/src/index.js';
import {DEFAULT_BOT_SETTINGS,BOT_UTILITY_SCALE,botEffectiveWeights,type BotSettings} from '../../../../contracts/src/index.js';
import type {KnownPathEvidence} from '../../../../prediction/src/index.js';
import {RULES} from '../../../../rules/src/index.js';
import {mineHoldingAssessment,mineCaptureImpact} from '../../controller/analysis/mine-strategy.js';
import {createOutpostRiskAnalysis,riskObservation} from './outpost-risk.js';
import {loadOutpostRiskConfig,type OutpostRiskConfig} from './outpost-risk-config.js';
import {openingExpansion} from './opening-expansion.js';
import {botOpponentWeight,botAttackValue} from './tactical-attack-value.js';

type Frame = PlayerMapView | PlayerForecastResult;
export type BotPhase = 'survival' | 'deny-victory' | 'finish' | 'economy' | 'expansion';
export interface BotSituation {
  phase: BotPhase;
  goal: number;
  leader: number | null;
  enemyVictoryTicks: number | null;
  ownVictoryTicks: number | null;
  capacityPressure: number;
}
export interface BotEvaluation {
  /** Lexicographic: elimination / enemy crossing / ongoing / own crossing.
   * Crossings remain conditional predictions, never actual game results. */
  outcome: -2 | -1 | 0 | 1;
  crossingTick: number | null;
  terminalCertainty: 'determinate' | 'conditional' | 'unknown' | null;
  /** Fixed driller-anchored heuristic units; preference weights do not rescale this unit. */
  utility: number;
  components: Record<string, number>;
  unknowns: string[];
}
const clamp=(n:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,n));
export function botDistance(a:{x:number;y:number},b:{x:number;y:number},size:{width:number;height:number}) {
  const dx=Math.abs(a.x-b.x)%size.width,dy=Math.abs(a.y-b.y)%size.height;
  return Math.hypot(Math.min(dx,size.width-dx),Math.min(dy,size.height-dy));
}
export function botSituation(o:PlayerObservation):BotSituation {
  const v=o.view;
  const goal=v.match?.mode==='domination'
    ? RULES.GameParams.DominationRequirementByPlayerCount[v.playerCount]??Infinity
    : v.match?.neptuniumGoal??Infinity;
  const own=o.intel.find(p=>p.player===v.player);
  const remaining=Math.max(0,goal-v.self.neptunium);
  const ownVictoryTicks=v.match?.mode==='mining'&&own&&own.npPerDay>0?144*remaining/own.npPerDay:null;
  const enemies=o.intel.filter(p=>p.player!==v.player&&p.active).sort((a,b)=>{
    if(v.match?.mode==='domination')return b.numOutposts-a.numOutposts||a.player-b.player;
    const eta=(p:typeof a)=>p.npPerDay>0?144*Math.max(0,goal-p.neptunium)/p.npPerDay:Infinity;
    return eta(a)-eta(b)||b.neptunium-a.neptunium||a.player-b.player;
  });
  const leader=enemies[0];
  const enemyVictoryTicks=v.match?.mode==='mining'&&leader&&leader.npPerDay>0?144*Math.max(0,goal-leader.neptunium)/leader.npPerDay:null;
  const mines=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.type==='mine').length;
  return {phase:enemyVictoryTicks!==null&&enemyVictoryTicks<144&&(ownVictoryTicks===null||enemyVictoryTicks<ownVictoryTicks)?'deny-victory'
    :ownVictoryTicks!==null&&ownVictoryTicks<144?'finish':v.match?.mode==='mining'&&mines===0?'economy':'expansion',
    goal,leader:leader?.player??null,enemyVictoryTicks,ownVictoryTicks,
    capacityPressure:clamp(v.self.drillers/Math.max(1,v.self.capacity),0,2)};
}

/** Evaluate an authorized conditional frame. Missing foreign fields remain
 * unknown; they never become free targets or enemy economic predictions. */
export function evaluateBotFrame(o:PlayerObservation,frame:Frame,path:KnownPathEvidence|null=null,preferences:Readonly<BotSettings>=DEFAULT_BOT_SETTINGS,riskConfig:OutpostRiskConfig=loadOutpostRiskConfig()):BotEvaluation {
  const weights=botEffectiveWeights(preferences);
  const situation=botSituation(o),player=o.view.player,own=frame.outposts.filter(p=>p.owner===player&&!p.destroyed);
  const posts=new Map(frame.outposts.map(p=>[p.id,p]));
  const fleets=new Map(frame.fleets.map(f=>[f.id,f]));
  const risks=createOutpostRiskAnalysis(riskObservation(o,frame),riskConfig);
  const unknowns=new Set<string>();
  const combatValue=botAttackValue(o,path);
  const economicHorizon=96;
  const factories=own.filter(p=>p.type==='factory');
  const capacityPressure=clamp(frame.self.drillers/Math.max(1,frame.self.capacity),0,1);
  // Capacity is valued only when there are factories to exploit it. Value of
  // output falls near the cap, but never vanishes (future losses free capacity).
  const rate=factories.reduce((sum,p)=>sum+(p.metrics?.cycleMinutes&&p.metrics.cycleMinutes>0?p.metrics.output*10/p.metrics.cycleMinutes:0),0);
  for(const p of factories)if(!p.metrics||p.metrics.cycleMinutes===null)unknowns.add(`production:${p.id}`);
  const holding=mineHoldingAssessment(o,frame,risks);
  const mining=o.view.match?.mode==='mining';
  const progress=mining?clamp(frame.self.neptunium/Math.max(1,situation.goal),0,1):0;
  const npWeight=2+4*progress;
  // A common, observation-based economic window keeps candidate values
  // comparable. With no income, one mine at today's territory count supplies
  // a reference time, not an assumed construction or booked future income.
  // The rival's public static ETA bounds this preference, never its orders.
  const referenceFinish=situation.ownVictoryTicks??144*Math.max(0,situation.goal-o.view.self.neptunium)/Math.max(1,o.view.self.outpostCount);
  const economicWindow=Math.max(1,Math.min(referenceFinish,situation.enemyVictoryTicks??Infinity));
  const remaining=Math.max(0,situation.goal-frame.self.neptunium);
  const creditedIncome=(holding?.holdingCredits??0)*own.length/144;
  const elapsed='targetTick'in frame?Math.max(0,frame.targetTick-o.view.tick):0;
  // Discount a goal/timing option, not additional NP. Existing NP remains its
  // own asset component. A fixed income cap erased the benefit of a second
  // mine before either line crossed within 144 ticks. Both times below start
  // at this observation, so a later endpoint cannot receive an earlier finish.
  // This bounded static-hold utility never establishes a certain crossing;
  // unknown enemies remain unknown in the path/terminal evidence below.
  const completionValue=(income:number)=>mining&&Number.isFinite(situation.goal)&&remaining>0&&income>0
    ?situation.goal*npWeight*economicWindow/(economicWindow+elapsed+remaining/income):0;
  const miningPotential=completionValue(creditedIncome);
  // Construction ties up a larger share of a small army. Use the current
  // authorized total (including fleets), never forecast production or capacity,
  // so extending the horizon cannot dilute this investment burden. Pending
  // mines have already been paid for; captured existing mines are not builds.
  const newMines=(holding?.mines??[]).filter(m=>{
    const before=o.view.outposts.find(p=>p.id===m.id);
    return before?.owner===player&&before.type!=='mine'&&!before.minePending;
  });
  let constructionCost=0,nextCost=o.view.self.mineCreationCost;
  for(const _ of newMines){
    constructionCost+=nextCost;
    nextCost=nextCost===RULES.OutpostParams.BaseMineCreationCostInDrillers?nextCost*2:nextCost+RULES.OutpostParams.BaseMineCreationCostInDrillers*2;
  }
  const constructionRatio=clamp(constructionCost/Math.max(1,o.view.self.drillers),0,1);
  const newMineCredit=newMines.reduce((sum,m)=>sum+m.holdingCredit,0);
  const forceAdjustedIncome=Math.max(0,(holding?.holdingCredits??0)-newMineCredit*(1-(1-constructionRatio)**2))*own.length/144;
  const mineForceCommitment=completionValue(forceAdjustedIncome)-miningPotential;
  const components:Record<string,number>={
    troops:frame.self.drillers*BOT_UTILITY_SCALE.drillerValue,
    territory:own.length*(mining?16:38),
    production:rate*economicHorizon*(1-0.65*capacityPressure),
    capacity:rate>0?Math.min(frame.self.capacity,frame.self.drillers+rate*economicHorizon)*0.14:0,
    neptunium:mining?frame.self.neptunium*npWeight:0,
    miningPotential,
    mineForceCommitment,
    mineHoldingRisk:-(holding?.inventoryExposure??0)*npWeight*weights.economyWeight,
    shields:own.reduce((sum,p)=>sum+(p.shield??0)*0.2,0),
    exposure:0,
    logistics:0,
    denial:0,
    mineLosses:-(path?.mineLosses.count??0)*20,
    information:0,
    enemyAttrition:combatValue.enemyAttrition,
    capacityPressure:combatValue.capacityPressure,
    // Count unique delivered holdings only; an extra fleet to the same post
    // cannot manufacture another opening-coverage reward.
    openingCoverage:openingExpansion(o).targets.filter(t=>t.zone==='own-near'&&posts.get(t.id)?.owner===player&&!posts.get(t.id)?.destroyed).length*80,
  };
  for(const mine of holding?.mines??[])if(mine.uncertain||mine.shortfall===null)unknowns.add(`mine-holding:${mine.id}`);
  // New holdings can reveal known map locations without inventing their contents.
  if(!o.view.fullMapVisible){
    const covered=o.view.outposts.filter(p=>p.visibility<2&&!p.destroyed&&p.owner!==player
      &&(frame.fullMapVisible||frame.sonar.some(s=>botDistance(p.position,s.center,frame.size)<=s.radius)));
    components.information=Math.min(48,covered.length*6);
    if(covered.length)unknowns.add('future-sonar-contacts-unknown');
  }
  for(const risk of risks.own()){
    components.exposure!-=risk.penalty;
    for(const reason of risk.unknowns)unknowns.add(reason);
  }
  // Infantry at the rear and infantry in transit have the same base value.
  // Only positional utility differs. No reward for issuing a transport itself.
  const objectives=frame.outposts.filter(p=>p.owner!==player&&!p.destroyed);
  const positionValue=(position:{x:number;y:number},troops:number)=>{
    if(!objectives.length)return 0;
    const nearest=Math.min(...objectives.map(p=>botDistance(position,p.position,frame.size)));
    return troops*0.16/(1+nearest);
  };
  components.logistics=own.reduce((sum,p)=>sum+positionValue(p.position,p.drillers??0),0)
    +frame.fleets.filter(f=>f.owner===player&&!f.gift).reduce((sum,f)=>sum+positionValue(f.position,f.drillers),0);
  // Value only changes to observed hostile ownership, not fabricated enemy
  // forecast income (hidden holdings make that income unreliable).
  for(const before of o.view.outposts){
    if(before.owner===player||before.owner===null||before.owner===undefined||before.destroyed)continue;
    const after=posts.get(before.id);
    if(after?.owner===player&&!after.destroyed)components.denial!+=(before.type==='mine'?32:before.type==='factory'?16:8)*botOpponentWeight(o,before.owner);
  }
  const capturedMines=o.view.outposts.filter(p=>p.type==='mine'&&p.owner!==player&&p.owner!=null&&posts.get(p.id)?.owner===player&&!posts.get(p.id)?.destroyed
    &&path?.events.some(e=>e.kind==='outpost-captured'&&e.subject===p.id&&e.details.owner===player&&e.details.before===p.owner)).map(p=>p.id);
  // Public current inventory only; compound simultaneous captures once per
  // owner, never credit their lost inventory to ourselves or extrapolate it.
  components.miningDenial=mineCaptureImpact(o,capturedMines).opponents.reduce((sum,p)=>{
    const captures=p.targets.map(id=>path?.events.filter(e=>e.kind==='outpost-captured'&&e.subject===id&&e.details.owner===player).at(-1));
    const heldTicks=captures.every(e=>e!==undefined)&&path?Math.max(0,path.actualTargetTick-Math.max(...captures.map(e=>e!.tick+e!.fraction))):0;
    return sum+Math.min(120,p.deductionAtCurrentBalance*(2+4*clamp(p.currentBalance/Math.max(1,situation.goal),0,1))
      +Math.max(0,p.currentIncomePerEconomicDay-p.incomeAfterAtCurrentHoldings)*Math.min(144,heldTicks)/144*2);
  },0);
  const terminal='terminalPrediction'in frame?frame.terminalPrediction:undefined;
  const crossing=terminal?.firstCrossing;
  let outcome:BotEvaluation['outcome']=frame.self.active?0:-2;
  if(crossing?.triggeringSeat!==null&&crossing?.triggeringSeat!==undefined)outcome=crossing.triggeringSeat===player?1:-1;
  for(const reason of terminal?.reasons??[])unknowns.add(reason);
  for(const reason of path?.coverage.unknownReasons??[])unknowns.add(reason);
  for(const key of ['production','capacity','neptunium','miningPotential','mineForceCommitment'])components[key]!*=weights.economyWeight;
  for(const key of ['shields','exposure','mineLosses','mineHoldingRisk'])components[key]!*=weights.defenseWeight;
  for(const key of ['territory','denial','miningDenial'])components[key]!*=weights.territoryWeight;
  return {outcome,crossingTick:crossing?.tick??null,terminalCertainty:terminal?.status??null,
    utility:Object.values(components).reduce((sum,n)=>sum+n,0),components,unknowns:[...unknowns].sort()};
}

/** Positive means a is preferable; terminal timing is compared before wealth.
 * Unknown crossings never get promoted to a certain victory claim. */
export function compareBotEvaluations(a:BotEvaluation,b:BotEvaluation):number {
  if(a.outcome!==b.outcome)return a.outcome-b.outcome;
  if(a.outcome===1&&a.crossingTick!==null&&b.crossingTick!==null&&a.crossingTick!==b.crossingTick)return b.crossingTick-a.crossingTick;
  if(a.outcome<0&&a.crossingTick!==null&&b.crossingTick!==null&&a.crossingTick!==b.crossingTick)return a.crossingTick-b.crossingTick;
  return a.utility-b.utility;
}
