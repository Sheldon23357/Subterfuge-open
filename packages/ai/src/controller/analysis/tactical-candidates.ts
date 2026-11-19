import {botDispatchPlanAllowed} from './tactical-dispatch-policy.js';
import {DEFAULT_BOT_SETTINGS,type PlayerObservation,type AttackRoutes} from '../../../../contracts/src/index.js';
import {type KnownPredictionDraft} from '../../../../prediction/src/index.js';
import {scheduledCommitments} from '../../controller/analysis/scheduled-commitments.js';
import {botDistance} from './tactical-evaluation.js';
import {botBufferedForce,botGarrisonPolicy} from './tactical-force-policy.js';
import {assertCurrentAttackRoutes} from '../../controller/analysis/analysis-efficiency.js';
import {mineLossCost} from '../../controller/analysis/mine-strategy.js';
import {botOpponentScenarios} from './tactical-opponents.js';
import {createOutpostRiskAnalysis,type OutpostRiskAnalysis} from './outpost-risk.js';
import {openingExpansion} from './opening-expansion.js';
import {botOpponentWeight,MAX_ATTRITION_FORCE_FRACTION} from './tactical-attack-value.js';

export type BotCandidateKind='attack'|'defense'|'economy'|'logistics'|'fleet'|'scout'|'hold'|'combined';
export interface BotCandidate {
  id:string;kind:BotCandidateKind;objective:string;targets:string[];
  drafts:KnownPredictionDraft[];priority:number;reasons:string[];
  captureTargets?:string[];
  combatIntent?:'attrition';
  /** Confirmed human instruction; execute after safety checks, not autonomous utility choice. */
  commanderDirected?:true;
  components?:Pick<BotCandidate,'id'|'kind'|'targets'|'drafts'|'reasons'>[];
  forceEstimate?:{committed:number;required:number;defenseFactor?:number;unadjustedRequired?:number};
  forceSizing?:{testedMinimum:number;bufferedForce:number;margin:number;search:'bounded-proportional';basis:'largest-launch'};
}

/** Candidate discovery is deliberately independent of initial screening's
 * conservative reserves. The engine judges the resulting joint source risk. */
export function generateBotCandidates(o:PlayerObservation,routes:AttackRoutes,scoutedTargets:readonly string[]=[],forceBufferRatio=DEFAULT_BOT_SETTINGS.forceBufferRatio,risks:OutpostRiskAnalysis=createOutpostRiskAnalysis(o,undefined,routes),requiredTargets:readonly string[]=[],attackDefenseFactors:readonly {target:string;factor:number;until?:number}[]=[]):BotCandidate[] {
  assertCurrentAttackRoutes(o,routes);
  const v=o.view,own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.visibility===2);
  const commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
  const available=(id:string)=>{const p=own.find(p=>p.id===id),c=commitments.get(id);return c?.unknownSchedules.length?0:Math.max(0,(p?.drillers??0)-(c?.drillers??0));};
  const route=(a:string,b:string)=>routes.postTicks[a]?.[b]??null;
  const waiting=(a:string,b:string)=>v.fleets.some(f=>f.owner===v.player&&f.state==='waiting'&&f.source===a&&f.destination?.id===b);
  const candidates:BotCandidate[]=[];const seen=new Set<string>();
  const garrisons=new Map(own.map(p=>[p.id,botGarrisonPolicy(o,p.id,risks)]));
  const garrison=(id:string)=>garrisons.get(id)!;
  const fronts=new Map(own.map(p=>[p.id,hostileDistance(p)]));
  function hostileDistance(p:typeof own[number]){const others=v.outposts.filter(h=>h.owner!==v.player&&!h.destroyed);return others.length?Math.min(...others.map(h=>botDistance(p.position,h.position,v.size))):Infinity;}
  const add=(kind:BotCandidateKind,objective:string,targets:string[],actions:{action:Record<string,unknown>}[],priority:number,reasons:string[],hints:Pick<BotCandidate,'forceEstimate'|'combatIntent'>={})=>{
    if(!actions.length||actions.length>8||!botDispatchPlanAllowed(o,actions.map((a,i)=>({id:`candidate-${i}`,issueTick:v.tick,action:a.action}))))return;
    const signature=JSON.stringify([hints.combatIntent??null,actions.map(a=>({issueTick:v.tick,action:a.action}))]);if(seen.has(signature))return;seen.add(signature);
    const id=`${kind}-${candidates.length}`;
    candidates.push({id,kind,objective,targets,...objective.startsWith('capture:')||objective.startsWith('opening-cover:')?{captureTargets:targets}:{},...hints,drafts:actions.map((a,i)=>({id:`${id}-${i}`,issueTick:v.tick,action:a.action})),priority,reasons:[...reasons,...hints.forceEstimate?.defenseFactor===0.6&&objective.startsWith('capture:')?['已确认夹击：目标防御按60%估算；实际战斗推演未折减']:[]]});
  };
  const launch=(source:string,destination:string,drillers:number)=>({kind:'launch',source,destination,drillers});
  const opening=openingExpansion(o),openingTargets=new Map(opening.targets.map(t=>[t.id,t]));
  const hostile=v.outposts.filter(p=>p.owner!==v.player&&!p.destroyed);
  const incoming=new Set(v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost').map(f=>f.destination!.id));
  // Offer a response to the same bounded concentration we pressure-test.
  // Reuse its one-opponent/two-source budget; never invent a coalition or
  // make hypothetical pressure an actual incoming fleet/evacuation trigger.
  const concentration=botOpponentScenarios(o,routes,[]).find(s=>s.id==='counterattack')?.enemyLaunches??[];
  const concentratedNeed=new Map<string,number>();
  if(concentration.length===2&&concentration.every(l=>l.player===concentration[0]!.player&&l.destination===concentration[0]!.destination)){
    const target=own.find(p=>p.id===concentration[0]!.destination);
    if(target&&target.type==='mine'){
      concentratedNeed.set(target.id,Math.max(0,concentration.reduce((sum,l)=>sum+l.drillers,0)+1-available(target.id)-(target.shield??0)));
    }
  }
  const targetValue=(p:typeof own[number])=>(p.type==='mine'?60+Math.min(45,mineLossCost(p.owner===v.player?v.self.neptunium:o.intel.find(i=>i.player===p.owner)?.neptunium??0)):p.type==='factory'?40:25)*(p.owner!=null&&p.owner!==v.player?botOpponentWeight(o,p.owner):1)+(p.owner===null?10:0);
  // Allocate a shared reserve across fronts before considering isolated
  // half/all-force moves. These are ordinary-combat seeds, not safety claims:
  // fleet timing, shields and losses are checked by the joint engine.
  const threatened=own.filter(p=>incoming.has(p.id)||p.type==='mine'&&garrison(p.id).desired>available(p.id)||(concentratedNeed.get(p.id)??0)>0).map(target=>({target,
    need:Math.max(0,garrison(target.id).desired-available(target.id),concentratedNeed.get(target.id)??0,v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===target.id)
      .reduce((sum,f)=>sum+f.drillers,0)+(incoming.has(target.id)?1:0)-available(target.id)-(target.shield??0)),
    value:targetValue(target),
  })).filter(t=>t.need>0);
  if(threatened.length>=2)for(const buffered of [true,false])for(const cheapFirst of [false,true]){
    const remaining=new Map(own.filter(p=>!threatened.some(t=>t.target.id===p.id)).map(p=>[p.id,garrison(p.id).spare]));
    const allocations:{action:Record<string,unknown>}[]=[],targets:string[]=[];
    const fronts=threatened.map(t=>({...t,need:!buffered&&incoming.has(t.target.id)?Math.max(0,
      v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===t.target.id).reduce((sum,f)=>sum+f.drillers,0)+1-available(t.target.id)-(t.target.shield??0),
      concentratedNeed.get(t.target.id)??0):t.need})).filter(t=>t.need>0)
      .sort((a,b)=>cheapFirst?a.need-b.need||b.value-a.value:b.value-a.value||a.need-b.need);
    for(const {target,need} of fronts){
      const donors=own.filter(p=>(remaining.get(p.id)??0)>0&&!waiting(p.id,target.id)&&route(p.id,target.id)!==null&&route(p.id,target.id)!<=120)
        .sort((a,b)=>route(a.id,target.id)!-route(b.id,target.id)!||a.id.localeCompare(b.id));
      const moves:{action:Record<string,unknown>}[]=[];let missing=need;
      for(const donor of donors){
        const amount=Math.min(missing,remaining.get(donor.id)!);
        moves.push({action:launch(donor.id,target.id,amount)});missing-=amount;
        if(missing===0)break;
      }
      // Do not consume the reserve on a front this seed cannot cover.
      if(missing>0||allocations.length+moves.length>8)continue;
      for(const move of moves)remaining.set(String(move.action.source),remaining.get(String(move.action.source))!-Number(move.action.drillers));
      allocations.push(...moves);targets.push(target.id);
    }
    if(targets.length>=2)add('defense',`defend-fronts:${targets.join(',')}`,targets,allocations,120,
      [cheapFirst?'按补兵缺口分配全局预备队':'按据点价值分配全局预备队',buffered?'比较带估算余量的增援':'比较普通战斗下限，不作为时序安全保证','各来源共用一份兵力预算；多战线结算仍须整体推演确认']);
  }
  const unknownTargets=hostile.filter(p=>p.visibility!==2);
  const scoutingInFlight=v.fleets.some(f=>f.owner===v.player&&unknownTargets.some(p=>p.id===f.destination?.id));
  if(!scoutingInFlight)for(const target of unknownTargets.filter(p=>!scoutedTargets.includes(p.id))){
    const source=own.filter(p=>available(p.id)>=20&&!incoming.has(p.id)&&!waiting(p.id,target.id)&&route(p.id,target.id)!==null&&route(p.id,target.id)!<=120)
      .sort((a,b)=>route(a.id,target.id)!-route(b.id,target.id)!)[0];
    if(source)add('scout',`scout:${target.id}`,[target.id],[{action:launch(source.id,target.id,1)}],10-route(source.id,target.id)!/10+(openingTargets.get(target.id)?.zone==='own-near'?80:0),['一次性1兵探测；最多损失此兵，不承诺攻占或获得完整情报','开局同类探测优先己方近点，未知驻军不补零']);
  }
  const attackTargets=risks.targets([...requiredTargets,...opening.uncoveredHome.slice(0,10)]);
  // Cover separate home-side neutrals with one shared source budget before
  // spending discovery on repeated small waves to an already assigned target.
  const expansionBudget=new Map(own.map(p=>[p.id,garrison(p.id).spare]));
  const expansionMoves:{action:Record<string,unknown>}[]=[],expansionIds:string[]=[];
  for(const target of opening.targets.filter(t=>t.zone==='own-near'&&!t.covered&&t.claimForce!==null)){
    if(expansionMoves.length>=8)break;
    const force=botBufferedForce(target.claimForce!+(target.competitionForce??0),forceBufferRatio);
    const source=own.filter(p=>(expansionBudget.get(p.id)??0)>=force&&!waiting(p.id,target.id)&&route(p.id,target.id)!=null&&route(p.id,target.id)!<=120)
      .sort((a,b)=>route(a.id,target.id)!-route(b.id,target.id)!||a.id.localeCompare(b.id))[0];
    if(!source)continue;
    expansionMoves.push({action:launch(source.id,target.id,force)});expansionIds.push(target.id);
    expansionBudget.set(source.id,expansionBudget.get(source.id)!-force);
  }
  if(expansionMoves.length)add('attack','opening-cover:'+expansionIds.join(','),expansionIds,expansionMoves,180,
    ['开局优先覆盖己方近点；每个目标只分配一次，各来源共用可调兵预算；在途不代表已占领']);
  for(const target of hostile.filter(p=>attackTargets.has(p.id))){
    // Unknown nodes can receive a separate bounded scout, never an alleged
    // profitable capture inferred from the prediction's inert placeholders.
    if(target.visibility!==2||target.drillers===undefined||target.shield===undefined)continue;
    const openingTarget=openingTargets.get(target.id);
    const cooperation=attackDefenseFactors.find(f=>f.target===target.id);
    const defenseFactor=(eta:number)=>cooperation&&(cooperation.until===undefined||v.tick+o.secondsSinceLastTick/600+eta<cooperation.until)?cooperation.factor:1;
    const rawRequired=(eta:number)=>openingTarget?.claimForce!==null&&openingTarget?.claimForce!==undefined&&openingTarget.competitionForce!==null
      ?openingTarget.claimForce+openingTarget.competitionForce
      :target.drillers!+(target.shieldsEnabled?Math.max(target.shield!,target.shieldMax??target.shield!):target.shield!)
      +(target.type==='factory'&&target.metrics?.cycleMinutes&&target.metrics.cycleMinutes>0?Math.ceil(eta*10/target.metrics.cycleMinutes)*target.metrics.output:0)+1;
    const required=(eta:number)=>defenseFactor(eta)===1?rawRequired(eta):Math.ceil(Math.max(0,rawRequired(eta)-1)*defenseFactor(eta))+1;
    const forceEstimate=(committed:number,eta:number)=>({committed,required:required(eta),...defenseFactor(eta)!==1?{defenseFactor:defenseFactor(eta),unadjustedRequired:rawRequired(eta)}:{}});
    const reachable=own.filter(p=>available(p.id)>0&&!waiting(p.id,target.id)&&route(p.id,target.id)!==null&&route(p.id,target.id)!<=120)
      .sort((a,b)=>route(a.id,target.id)!-route(b.id,target.id)!||a.id.localeCompare(b.id));
    // Keep the four-source bound, but do not let four nearby token garrisons
    // exclude the only funded direct attacker. Remaining slots favor arrival.
    const strongest=[...reachable].sort((a,b)=>available(b.id)-available(a.id)||route(a.id,target.id)!-route(b.id,target.id)!||a.id.localeCompare(b.id))[0];
    const sources=reachable.slice(0,4);
    if(strongest&&!sources.includes(strongest))sources[3]=strongest;
    for(const source of sources){
      const eta=route(source.id,target.id)!;if(eta>120)continue;
      // Arrival-strength seed: current depleted shields can recharge while
      // sailing, and a visible factory can produce. These are bounded search
      // estimates only; the joint engine still decides every battle.
      const budget=available(source.id),seed=required(eta);
      // Start with the arrival-strength estimate. Sorting by troop count puts
      // a knowingly undersized half-force first every round, and a bounded
      // search may never reach the feasible seed. Keep cheaper probes later.
      const spare=garrison(source.id).spare;
      const amounts=[...new Set([Math.min(budget,botBufferedForce(seed,forceBufferRatio)),Math.min(budget,seed),spare,Math.ceil(budget/2),budget])].filter(n=>n>0);
      const targetRisk=risks.get(target.id);
      const openingPriority=openingTarget?(openingTarget.covered?-60:openingTarget.zone==='own-near'?80:openingTarget.zone==='rival-near'?-30:0):0;
      for(const amount of amounts)add('attack',`capture:${target.id}`,[target.id],[{action:launch(source.id,target.id,amount)}],targetValue(target)-eta/4+Math.min(15,targetRisk.priority*5)+openingPriority,['单点攻击；兵力是搜索种子，战果由联合推演确认',`目标局部压力比${targetRisk.pressureRatio.toFixed(2)}；静态估算，不代表战果`,...(openingTarget?[`开局分区${openingTarget.zone}；竞争兵力${openingTarget.competitionForce??'未知'}，为规划假设，不是实际驻军`]:[])],{forceEstimate:forceEstimate(amount,eta)});
    }
    // One bounded raid seed per target. It competes in the existing budget;
    // acceptance requires explicit direct enemy losses and a favorable exchange.
    const raidSource=sources[0];
    if(raidSource&&target.owner!=null&&target.drillers!>0){
      const amount=Math.min(available(raidSource.id),Math.floor(v.self.drillers*MAX_ATTRITION_FORCE_FRACTION),Math.max(1,Math.floor(required(route(raidSource.id,target.id)!)*0.5)));
      if(amount>0)add('attack',`attrition:${target.id}`,[target.id],[{action:launch(raidSource.id,target.id,amount)}],targetValue(target)-route(raidSource.id,target.id)!/4-5,['有限消耗进攻；只计明确战斗损耗，不要求占领，不把出兵本身当作收益'],{combatIntent:'attrition'});
    }
    // Multiple sources may depart together; later actions are reconsidered on a new wake.
    const group=sources.slice(0,3);if(group.length>=2){
      const end=Math.max(...group.map(s=>route(s.id,target.id)!));
      if(end<=120)for(const fraction of [0.5,1])
        add('attack',`capture:${target.id}`,[target.id],group.map(s=>({action:launch(s.id,target.id,Math.ceil(available(s.id)*fraction))})),targetValue(target)-end/4+3,['多来源立即分波候选'],{forceEstimate:forceEstimate(group.reduce((sum,s)=>sum+Math.ceil(available(s.id)*fraction),0),end)});
    }

  }
  for(const target of own){
    if(v.match?.mode==='mining'&&target.type!=='mine'&&!target.minePending&&available(target.id)>=v.self.mineCreationCost)
      add('economy',`mine:${target.id}`,[target.id],[{action:{kind:'toggle-mine',outpostId:target.id}}],45,['比较开矿的兵力投入、原产能损失与获胜进度']);
    if(target.minePending&&incoming.has(target.id))add('defense',`defend:${target.id}`,[target.id],[{action:{kind:'toggle-mine',outpostId:target.id}}],90,['比较取消受威胁建设']);
    if(target.shieldsEnabled===false||target.shieldDisablePending)add('defense',`shield:${target.id}`,[target.id],[{action:{kind:'set-shields',outpostId:target.id,enabled:true}}],35,['比较恢复防御护盾']);
    for(const source of own){
      if(source.id===target.id||waiting(source.id,target.id))continue;
      const eta=route(source.id,target.id);
      const budget=available(source.id),threat=incoming.has(target.id);
      if(eta!==null&&eta<=120){
        const front=(p:typeof source)=>fronts.get(p.id)!;
        const forward=front(target)+0.3<front(source);
        const need=threat?Math.max(0,v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===target.id)
          .reduce((sum,f)=>sum+f.drillers,0)+1-available(target.id)-(target.shield??0)):0;
        const spare=garrison(source.id).spare;
        const deficit=Math.max(0,garrison(target.id).desired-garrison(target.id).available,concentratedNeed.get(target.id)??0);
        const concentrationDefense=(concentratedNeed.get(target.id)??0)>0;
        const mineDefense=target.type==='mine'&&deficit>0;
        const protectedDefense=deficit>0||concentrationDefense;
        const amounts=threat?[...(need>0?[Math.min(budget,botBufferedForce(need,forceBufferRatio))]:[]),spare,Math.ceil(budget/2),budget]
          :[concentrationDefense?Math.min(budget,botBufferedForce(deficit,forceBufferRatio)):mineDefense?Math.min(spare,botBufferedForce(deficit,forceBufferRatio)):deficit>0?Math.min(budget,Math.max(deficit,spare)):spare];
        if(budget>0&&(threat||forward||protectedDefense))for(const amount of [...new Set(amounts)].filter(n=>n>0))
          add(threat||protectedDefense?'defense':'logistics',`${threat||protectedDefense?'defend':'reinforce'}:${target.id}`,[target.id],[{action:launch(source.id,target.id,amount)}],(threat||concentrationDefense?100:mineDefense?70+Math.min(30,mineLossCost(v.self.neptunium)):25+Math.min(deficit,amount)*0.5+Math.min(10,front(source)-front(target)))-eta/4,[threat?'增援实际来袭目标':concentrationDefense?'补防同一对手两个可见来源的集中压力；仅是假设，来源安全与实际抵达由联合推演确认':mineDefense?'补防可见邻敌压力下的矿；压力不表示敌方已出兵，仍须比较来源和运输时序':'后方兵力前送；优先缓解已观察压力，运输变体限额属于搜索偏好']);

      }
    }
    if(incoming.has(target.id)){
      const donors=own.filter(s=>s.id!==target.id&&available(s.id)>0&&!waiting(s.id,target.id)&&route(s.id,target.id)!==null)
        .sort((a,b)=>route(a.id,target.id)!-route(b.id,target.id)!).slice(0,3);
      if(donors.length>=2)add('defense',`defend:${target.id}`,[target.id],donors.map(s=>({action:launch(s.id,target.id,available(s.id))})),105,['多来源联合增援实际来袭目标']);
    }
  }
  for(const fleet of v.fleets.filter(f=>f.owner===v.player)){
    if(fleet.canReturn&&fleet.source)add('fleet',`return:${fleet.id}`,[fleet.source],[{action:{kind:'return-fleet',fleetId:fleet.id}}],45,['比较返航止损与继续执行：舰数减半，每舰一次，敌占出发点仍需交战']);
    if(fleet.canCancelLaunch)add('fleet',`review:${fleet.id}`,[],[{action:{kind:'cancel-launch',fleetId:fleet.id}}],incoming.has(fleet.source??'')?110:40,['复核待发舰撤回与继续执行的差异']);
    if(fleet.state==='waiting'&&fleet.canCancelLaunch&&fleet.source&&fleet.destination&&!fleet.gift&&own.some(p=>p.id===fleet.source)){
      const total=fleet.drillers+available(fleet.source);
      for(const amount of [...new Set([Math.floor(fleet.drillers/2),total])]){
        if(amount===fleet.drillers||amount===0)continue;
        add('fleet',`resize:${fleet.id}`,[fleet.destination.id],[{action:{...launch(fleet.source,fleet.destination.id,amount),fleetId:fleet.id}}],55,
          [amount>fleet.drillers?'增加待发兵力，复核来源防守与预约占用':'减少待发兵力，比较留守收益与原目标战果']);
      }
    }
  }
  // Stable sorting preserves seed order for tied priorities (lexical IDs
  // would put e.g. attack-10 before attack-9 and undo that order).
  const sorted=candidates.sort((a,b)=>b.priority-a.priority);
  const logisticsTargets=new Set<string>();
  return sorted.filter(c=>{
    if(c.kind!=='logistics')return true;
    if(logisticsTargets.has(c.objective)||logisticsTargets.size>=2)return false;
    logisticsTargets.add(c.objective);return true;
  });
}
