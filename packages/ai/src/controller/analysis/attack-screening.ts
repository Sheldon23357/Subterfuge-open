import {scheduledCommitments} from './scheduled-commitments.js';
import {capacityPressure} from './capacity-pressure.js';
import {assertCurrentAttackRoutes} from './analysis-efficiency.js';
import {relatedAttackTargets} from './attack-screening-presentation.js';
import {attackTargetContext,type TargetRelatedContext} from './attack-target-context.js';
import {enemyWaitingSources} from './waiting-defense.js';
import {mineInvestmentValue} from './mine-value.js';
import {warOpportunities} from './war-opportunities.js';
import {createOutpostRiskAnalysis} from './outpost-risk.js';
import {loadOutpostRiskConfig,type OutpostRiskConfig} from './outpost-risk-config.js';
import {shieldRecoveryBounds} from '../../../../rules/src/index.js';
import {type Campaign} from '../storage/campaign-state.js';
import type {AttackRoutes,PlayerObservation,PlayerMapView} from '../../../../contracts/src/index.js';
import {type AttackScreeningConfig,DEFAULT_ATTACK_SCREENING,screeningConfigId} from './attack-screening-config.js';

type Post=PlayerMapView['outposts'][number];
const unit=(n:number)=>Math.max(0,Math.min(1,n));
const round=(n:number)=>Math.round(n*100)/100;

/** Ranking heuristic over player-visible facts. Estimates are labelled and never
 * presented as battle results. Each candidate independently reuses the sources. */
export function screenAttacks(o:PlayerObservation,routes:AttackRoutes,c:AttackScreeningConfig=DEFAULT_ATTACK_SCREENING,campaigns:Campaign[]=[],requiredTargets:readonly string[]=[],riskConfig:OutpostRiskConfig=loadOutpostRiskConfig()){
  assertCurrentAttackRoutes(o,routes);
  const v=o.view,own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed),others=v.outposts.filter(p=>p.owner!==v.player&&!p.destroyed);
  const eta=(from:string,to:string)=>routes.postTicks[from]?.[to]??null;
  const known=(p:Post)=>p.drillers!==undefined&&p.shield!==undefined;
  const waitingSources=enemyWaitingSources(v);
  const recalled=(p:Post)=>v.fleets.filter(f=>waitingSources.get(f.id)===p.id).reduce((n,f)=>n+f.drillers,0);
  const troops=(p:Post)=>(p.drillers??c.force.unknownDrillers)+recalled(p);
  const commitments=new Map(scheduledCommitments(o).map(s=>[s.source,s]));
  const leaders=[...o.intel].filter(p=>p.active&&p.player!==v.player).sort((a,b)=>b.neptunium-a.neptunium||b.drillerRate-a.drillerRate||b.numOutposts-a.numOutposts||a.player-b.player);
  const leader=leaders[0]?.player;
  const ownMines=own.filter(p=>p.type==='mine').length;
  const pressure=capacityPressure(o);
  const risks=createOutpostRiskAnalysis(o,riskConfig,routes),attackTargets=risks.targets(requiredTargets);
  // Upper bound assumes production is not capacity-blocked; this is not a
  // second economic simulator and ignores undocumented/hidden modifiers.
  const production=(p:Post,ticks:number)=>{
    const m=p.metrics;
    if(p.type!=='factory'||!m||!m.active||m.paused||m.nextMinutes===null||m.cycleMinutes===null||m.cycleMinutes<=0)return 0;
    return ticks*10<m.nextMinutes?0:m.output*(1+Math.floor((ticks*10-m.nextMinutes)/m.cycleMinutes));
  };
  const reserved:Record<string,number>={};
  const sources=own.map(p=>{
    // Evaluate cumulative attack waves. Potential sorties are a conservative
    // visible-force scenario, not a prediction that every neighbour will attack.
    const waves=[
      ...v.fleets.filter(f=>!waitingSources.has(f.id)&&f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===p.id)
        .map(f=>({id:f.id,ticks:routes.fleetTicks[f.id]??null,force:f.drillers,estimated:false,unknown:false,})),
      ...others.filter(e=>e.owner!==null).flatMap(e=>{
        const ticks=eta(e.id,p.id);
        return ticks!==null&&ticks<=c.limits.localTicks?[{id:e.id,ticks,force:troops(e),estimated:true,unknown:e.owner===undefined||!known(e),}]:[];
      }),
    ].filter(w=>!w.estimated||w.force>0||w.unknown).sort((a,b)=>(a.ticks??Infinity)-(b.ticks??Infinity));
    let cumulative=0,required=0;
    const shield=p.shield??0;
    const threats=waves.map(w=>{
      cumulative+=w.force;
      // Do not reuse a replenished shield for each separate wave, or promise
      // factory output that might be capacity-blocked. Current shield only.
      // Zero troops do not acquire invented combat strength.
      // Unknown outcomes require the shared forecast.
      const ordinaryRequired=cumulative>0?Math.max(0,cumulative-shield+1):0;
      required=Math.max(required,ordinaryRequired);
      return {...w,cumulative,required:ordinaryRequired};
    });
    const risk=risks.get(p.id);
    const reserve=Math.ceil(Math.max(c.force.minimumReserve,risk.requiredGarrison));
    const stationed=p.drillers??0;
    const forecastReasons=[
      ...(threats.some(t=>!t.estimated&&(t.force>0))?['observed-incoming']:[]),
      ...(threats.some(t=>t.unknown||t.ticks===null)||!known(p)||risk.unknowns.length?['unknown-information']:[]),
    ];
    const pending=commitments.get(p.id),pendingReserved=pending?.drillers??0,pendingUnknown=!!pending?.unknownSchedules.length;
    return {id:p.id,reserve,campaignReserved:0,available:pendingUnknown?0:Math.max(0,stationed-reserve-pendingReserved),pendingCommitment:!!pending,pendingReserved,pendingUnknown,pendingSchedules:pending?.scheduleIds??[],
      defense:{horizonTicks:c.limits.localTicks,stationed,shield,required:reserve,shortfall:Math.max(0,reserve-stationed),threats,risk,
        status:'provisional' as const,forecastRequired:forecastReasons.length>0,forecastReasons,
        uncertain:threats.some(t=>t.estimated||t.unknown||t.ticks===null)||!known(p)||risk.unknowns.length>0,basis:'support-window-static-pressure'}};
  });
  const excluded:{target:string;reason:string}[]=[];
  const ranked=others.flatMap(target=>{
    if(!attackTargets.has(target.id))return [];
    const waitingRoute=(source:string,destination:string)=>v.fleets.some(f=>f.owner===v.player&&f.state==='waiting'&&f.source===source&&f.destination?.id===destination);
    const possible=sources.flatMap(s=>{
      const ticks=eta(s.id,target.id);
      return ticks!==null&&ticks<=c.limits.attackTicks&&s.available>0&&!waitingRoute(s.id,target.id)?[{...s,ticks,transferTicks:0}]:[];
    }).sort((a,b)=>a.ticks-b.ticks||b.available-a.available||a.id.localeCompare(b.id));
    type Source=typeof possible[number];
    const plans:{kind:'direct'|'gather';hub:string|null;gatherTicks:number;sources:Source[]}[]=[];
    // Compare force-rich arrival windows, rather than always taking the first
    // three nearest posts. Earlier fleets must delay launch to arrive together.
    for(const anchor of possible){
      const selected=possible.filter(s=>s.ticks>=anchor.ticks&&s.ticks<=anchor.ticks+c.limits.assemblySpreadTicks)
        .sort((a,b)=>b.available-a.available||a.ticks-b.ticks||a.id.localeCompare(b.id)).slice(0,c.limits.maxSources);
      plans.push({kind:'direct',hub:null,gatherTicks:0,sources:selected});
    }
    for(const hub of sources.filter(s=>!s.pendingUnknown&&!s.defense.shortfall&&!waitingRoute(s.id,target.id))){
      const onward=eta(hub.id,target.id);
      if(onward===null)continue;
      const donors=sources.flatMap(s=>{
        const transfer=s.id===hub.id?0:eta(s.id,hub.id);
        return s.available>0&&transfer!==null&&transfer+onward+1<=c.limits.attackTicks&&!waitingRoute(s.id,hub.id)?[{...s,ticks:transfer+onward,transferTicks:transfer}]:[];
      });
      for(const end of [...new Set(donors.map(s=>s.transferTicks))].filter(t=>t>0)){
        const selected=donors.filter(s=>s.transferTicks<=end).sort((a,b)=>b.available-a.available||a.transferTicks-b.transferTicks||a.id.localeCompare(b.id)).slice(0,c.limits.maxSources);
        if(selected.length<2||!selected.some(s=>s.transferTicks>0))continue;
        const gatherTicks=Math.max(...selected.map(s=>s.transferTicks))+1;
        plans.push({kind:'gather',hub:hub.id,gatherTicks,sources:selected.map(s=>({...s,ticks:gatherTicks+onward}))});
      }
    }
    if(!plans.length){excluded.push({target:target.id,reason:'no-uncommitted-source-within-time-window'});return [];}
    const seenPlans=new Set<string>();
    const evaluated=plans.filter(plan=>{const key=JSON.stringify([plan.kind,plan.hub,plan.sources.map(s=>s.id).sort()]);if(seenPlans.has(key))return false;seenPlans.add(key);return true;}).map(plan=>{
    const selected=plan.sources;
    const attackTicks=Math.max(...selected.map(s=>s.ticks)),holdTicks=Math.min(routes.maxTicks,attackTicks+c.limits.holdTicks);
    const support=others.filter(p=>p.id!==target.id&&p.owner===target.owner&&target.owner!==null&&target.owner!==undefined).flatMap(p=>{
      const ticks=eta(p.id,target.id);return ticks!==null&&ticks<=holdTicks?[{id:p.id,ticks,known:known(p),estimatedForce:round((troops(p)+production(p,ticks))*c.force.enemyMobilization)}]:[];
    });
    const thirdParties=others.filter(p=>p.owner!==null&&p.owner!==undefined&&p.owner!==target.owner).flatMap(p=>{
      const ticks=eta(p.id,target.id);return ticks!==null&&ticks<=holdTicks?[{id:p.id,owner:p.owner,ticks,known:known(p),estimatedForce:round(troops(p)*c.force.thirdPartyMobilization)}]:[];
    });
    const incoming=v.fleets.filter(f=>!waitingSources.has(f.id)&&f.destination?.kind==='outpost'&&f.destination.id===target.id).map(f=>({id:f.id,owner:f.owner,drillers:f.drillers,gift:f.gift,ticks:routes.fleetTicks[f.id]??null}));
    const inTime=(f:typeof incoming[number],end:number)=>f.ticks!==null&&f.ticks<=end;
    const friendlyIncoming=incoming.filter(f=>f.owner===v.player&&!f.gift&&inTime(f,attackTicks)).reduce((n,f)=>n+f.drillers,0);
    const defenderIncoming=(end:number)=>incoming.filter(f=>(f.owner===target.owner||f.gift)&&inTime(f,end)).reduce((n,f)=>n+f.drillers,0);
    const friendly=selected.reduce((n,s)=>n+s.available,0)+friendlyIncoming;
    const shield=target.shield??c.force.unknownShield;
    const shieldRecovery=target.shield===undefined?{minimum:shield,maximum:shield,basis:'unknown-config-estimate'}:
      target.owner===null||target.shieldsEnabled===false?{minimum:shield,maximum:shield,basis:'no-recharge'}:
      target.shieldMax===undefined?{minimum:shield,maximum:shield,basis:'capacity-unknown-current-only'}:
      {...shieldRecoveryBounds(shield,target.shieldMax,v.tick,attackTicks),basis:'shared-rule-unknown-progress'};
    const shieldUpper=shieldRecovery.maximum;
    const defense=troops(target)+shieldUpper+production(target,attackTicks);
    const before=support.filter(s=>s.ticks<=attackTicks).reduce((n,s)=>n+s.estimatedForce,0)+defenderIncoming(attackTicks);
    const after=support.reduce((n,s)=>n+s.estimatedForce,0)+defenderIncoming(holdTicks);
    const followup=possible.filter(s=>!selected.some(x=>x.id===s.id)&&s.ticks<=holdTicks).reduce((n,s)=>n+s.available,0);
    const thirdForce=thirdParties.reduce((n,p)=>n+p.estimatedForce,0)+incoming.filter(f=>f.owner!==target.owner&&f.owner!==v.player&&!f.gift&&inTime(f,holdTicks)).reduce((n,f)=>n+f.drillers,0);
    const unknownSupport=support.filter(s=>!s.known).length;
    const confidence=Math.max(c.confidence.minimum,(known(target)?1:c.confidence.unknownTarget)-unknownSupport*c.confidence.unknownSupportPenalty);
    const isLeader=target.owner!==null&&target.owner!==undefined&&target.owner===leader;
    const typeValue=target.type==='factory'?c.value.factory:target.type==='generator'?c.value.generator:target.type==='mine'?c.value.mine:c.value.unknown;
    const mineInvestment=mineInvestmentValue(o,target,attackTicks,c);
    const baseValue=c.value.territory+typeValue+ownMines*c.value.existingMineExpansion+(isLeader?c.value.leader:0)+(target.type==='generator'&&v.self.drillers>=v.self.capacity?c.value.capacityBottleneck:0);
    const value=baseValue+(mineInvestment?.total??0);
    const targetRisk=risks.get(target.id);
    const features={value:unit(value/c.value.scale),attackBalance:unit(friendly/(friendly+Math.max(defense+before,targetRisk.defense)||1)),holdBalance:unit((friendly+followup)/(friendly+followup+defense+after||1)),speed:unit(1-attackTicks/c.limits.attackTicks),confidence,lowExposure:unit(1-thirdForce/(friendly+followup+thirdForce||1))};
    const rawComponents=Object.fromEntries(Object.entries(features).map(([k,n])=>[k,n*c.weights[k as keyof typeof features]]));
    const components=Object.fromEntries(Object.entries(rawComponents).map(([k,n])=>[k,round(n)]));
    const existingOperation=incoming.some(f=>f.owner===v.player&&!f.gift);
    const contested=incoming.some(f=>f.owner!==v.player&&f.owner!==target.owner&&!f.gift&&(f.ticks===null||f.ticks<=attackTicks));
    // Scores compare priorities within a review class, never success probability.
    // Existing orders and contested ownership require review, not value discounts.
    // Urgency never promotes a deficit, existing attack or contested ownership
    // to a safer review class; source reservations and defense checks still apply.
    const pressureBonus=!existingOperation&&!contested&&friendly>defense+before&&friendly+followup>defense+after?
      round(c.capacityPressure.maximumBonus*pressure.strength*confidence/(1+attackTicks/c.limits.nearTicks)):0;
    const score=round(Math.min(100,100*Object.values(rawComponents).reduce((a,b)=>a+b,0)/Object.values(c.weights).reduce((a,b)=>a+b,0)+pressureBonus));
    return {target:target.id,name:o.outpostNames?.[target.id]??target.id,owner:target.owner??null,type:target.type??'unknown',score,pressureBonus,components,valueBreakdown:{base:baseValue,mineInvestment,total:value},confidence:round(confidence),tags:[...(isLeader?['leading-opponent']:[]),...(!known(target)?['reconnaissance']:[])],
      range:attackTicks<=c.limits.nearTicks?'near':'preparation',timing:{attackTicks,holdTicks,arrivalTick:v.tick+attackTicks},sources:selected,plan:{kind:plan.kind,hub:plan.hub,gatherTicks:plan.gatherTicks},sourceForce:friendly,followupForce:followup,existingOperation,contested,
      assessment:contested?'ownership-may-change-before-arrival':friendly>defense+before?'potential-force-advantage':'needs-more-force',additionalForceEstimate:Math.max(0,Math.ceil(defense+before-friendly+1)),
      defense:{observedDrillers:target.drillers??null,recallableWaitingDrillers:recalled(target),observedShield:target.shield??null,shieldAtArrival:shieldRecovery,shieldUsed:shieldUpper,estimatedWithProductionAndShield:defense,productionUpperBound:production(target,attackTicks),enemyBefore:round(before),enemyThroughHold:round(after)},
      support,thirdParties,incoming,risk:targetRisk,attackMargin:round(friendly-defense-before),holdMargin:round(friendly+followup-defense-after),
      reasons:[plan.kind==='gather'?`先向${plan.hub}集结${plan.gatherTicks}世界天，再合兵出击；仅计当前可调兵，集结点及来源防守需组合推演`:'多路直攻按最晚抵达同步；较近来源需延后出航，不能假设先到舰会等待',`抵达护盾估计${shieldRecovery.minimum}–${shieldRecovery.maximum}，初筛采用${shieldUpper}；防御成本=${troops(target)}防守兵力（含${recalled(target)}待发可撤兵力）+${production(target,attackTicks)}预计产兵+${shieldUpper}护盾`, `价值${round(value)}；${selected.length}路及既有在途可计入兵力${friendly}，普通航速${attackTicks}世界天`,...(mineInvestment?[`现成矿场投资加分${round(mineInvestment.total)}：节省自建${mineInvestment.replacementCost}兵折算${round(mineInvestment.replacement)}，新增采矿收益约${round(mineInvestment.estimatedOwnIncome)}折算${round(mineInvestment.income)}，对手失矿及减产折算${round(mineInvestment.denial)}；从现在起${mineInvestment.horizonTicks}世界天窗口，扣航程后${mineInvestment.remainingTicks}世界天，假设占领后持续守住，非保证收益`]:[]),...(contested?['其他阵营舰队可能先占领，当前归属、成本与兵力差不代表抵达局面，必须复核推演']:[]),...(existingOperation?['已有己方攻击/占领舰队在途，归入既有行动复核，不降低目标价值分；避免重复出兵']:[]),...(!known(target)?['目标兵力/护盾未知，使用配置估值，需侦察']:[]),...(thirdForce>0?['第三方力量独立列出，不假定会协防目标']:[])]};
    });
    evaluated.sort((a,b)=>screeningClassOrder(a)-screeningClassOrder(b)||b.score-a.score||a.timing.attackTicks-b.timing.attackTicks);
    const best=evaluated[0]!;
    return [{...best,alternatives:evaluated.filter(p=>p!==best).slice(0,3).map(p=>({plan:p.plan,sourceForce:p.sourceForce,timing:p.timing,attackMargin:p.attackMargin,score:p.score}))}];
  }).sort((a,b)=>screeningClassOrder(a)-screeningClassOrder(b)||b.score-a.score||a.target.localeCompare(b.target));
  const candidates=ranked.slice(0,c.limits.candidates).map(p=>({...p,selection:'score'}));
  for(const tag of ['leading-opponent','reconnaissance'].slice(0,c.limits.diversitySlots)){
    if(candidates.some(p=>p.tags.includes(tag)))continue;
    const alternative=ranked.find(p=>p.tags.includes(tag)&&!candidates.some(s=>s.target===p.target));
    if(alternative)candidates.push({...alternative,selection:tag});
  }
  // A shared, non-binding allocation proposal. Unlike independent ranking,
  // no source soldier appears in two proposed campaigns.
  const remaining=Object.fromEntries(sources.map(s=>[s.id,s.available]));
  const allocations=ranked.filter(p=>!p.existingOperation&&!p.contested).flatMap(p=>{
    let needed=Math.max(1,Math.ceil(p.defense.estimatedWithProductionAndShield+p.defense.enemyThroughHold+1-p.incoming.filter(f=>f.owner===v.player&&!f.gift&&f.ticks!==null&&f.ticks<=p.timing.attackTicks).reduce((n,f)=>n+f.drillers,0)));
    const draft=p.sources.map(s=>{const drillers=Math.min(remaining[s.id]??0,needed);needed-=drillers;return {source:s.id,drillers};}).filter(a=>a.drillers>0);
    if(needed>0||!draft.length)return [];
    for(const a of draft)remaining[a.source]!-=a.drillers;
    return [{target:p.target,range:p.range,plan:p.plan,allocations:draft,drafts:screeningDrafts(p,v.tick,draft),requiresForecast:true}];
  });
  const sourceOptions=others.map(target=>({target:target.id,sources:sources.flatMap(s=>{
    const ticks=eta(s.id,target.id);
    return ticks!==null&&s.available>0?[{source:s.id,ticks,available:s.available,retain:s.reserve,campaignReserved:s.campaignReserved,pendingCommitment:s.pendingCommitment,uncertain:s.defense.uncertain,forecastRequired:s.defense.forecastRequired}]:[];
  }).sort((a,b)=>a.ticks-b.ticks||a.source.localeCompare(b.source)).slice(0,3)}));
  return {sourceOptions,budget:{reserved,remaining,proposals:allocations},status:'screened'  as const,basisRevision:o.revision,observedTick:v.tick,configId:screeningConfigId(c),configVersion:c.version,candidates,ranked,excluded,sourceReserves:sources,
    cooperation:{opportunities:warOpportunities(o,routes,{attackTicks:c.limits.attackTicks,leader}),basis:'public-route-outreach-only',instruction:'候选仅表示普通航程可达，不代表友好、愿意合作或有可用兵力。单打不足或防守留兵阻塞时，结合利益和协议主动争取夹击、牵制或防御反击；不能把盟友承诺加入本人预算，不假设多阵营舰队会合兵。'},
    limitations:['来源留兵及available均为provisional初筛预算，采用支援时间分层的局部压力、当前护盾和真实来袭时序估算，非安全保证；邻点援兵按权重折减，未知不伪造兵数。forecastRequired表示需用同方案共享forecast核实抽兵后的来源归属与损失；潜在邻居并非已发舰，当前航线推演不自动覆盖其未来新命令；未知、远期威胁及外交需模型复核，未计未来产兵；潜在援军折算不等于已承诺救援。集结仅计当前兵，第二段航程按当前时刻估计，必须组合推演。','分数仅用于同组独立方案比较，已有行动单独复核、不打价值折扣；budget.proposals共享剩余预算且不重复占兵，采用前须推演。仅已登记且待执行的预约计入占用，未预约笔记计划不锁兵。','航程为共用引擎的普通航速估计，未计未来命令；出兵前用deploy、forecast或compare核对。','兵力+护盾仅作成本代理，生产为可见参数上界；未知兵力使用配置估值，不读取隐藏状态。','外交承诺由AI结合记忆判断；第三方不自动视为敌方盟友。','敌方准备中舰队按可撤回计入来源防守和来源可调援军，不再重复计入原目的地；已出发舰队按当前目的地计入，未假设可以改航；没有可用来源的目标列在excluded，AI可另查。']};
}
export type AttackScreeningReport=ReturnType<typeof screenAttacks>;
export function screeningClass(p:{existingOperation:boolean;contested:boolean;attackMargin:number;holdMargin:number;confidence:number;sources?:{pendingUnknown:boolean;defense:{forecastRequired:boolean}}[]}){
  return p.existingOperation?'review':p.contested||p.attackMargin<=0||p.holdMargin<=0||p.confidence<1||p.sources?.some(s=>s.pendingUnknown||s.defense.forecastRequired)?'conditional':'action';
}
function screeningClassOrder(p:Parameters<typeof screeningClass>[0]){return {action:0,conditional:1,review:2}[screeningClass(p)];}
export function screeningSummary(report:AttackScreeningReport,o?:PlayerObservation,related:TargetRelatedContext={}){
  const {ranked,excluded,...summary}=report;
  const relatedTargets=relatedAttackTargets(o,related.task?.entities);
  // Keep ordinary opportunities, conditional opportunities and existing actions
  // represented independently; a class cannot crowd every other class out.
  const groups=['action','conditional','review'] as const;
  const selected=groups.flatMap(group=>report.ranked.filter(p=>screeningClass(p)===group).slice(0,1));
  for(const p of report.ranked)if(selected.length<5&&!selected.some(s=>s.target===p.target))selected.push(p);
  const modelRanking=report.ranked.filter(p=>selected.some(s=>s.target===p.target));
  return {...summary,modelRanking,relatedRanking:report.ranked.filter(p=>relatedTargets.has(p.target)),modelSummary:attackTargetContext(report,o,related),scanned:ranked.length+excluded.length,excludedCount:excluded.length};
}
export type AttackScreeningSummary=ReturnType<typeof screeningSummary>;

/** Reviewable conditional command plan. Same-tick arrivals are not spendable. */
export function screeningDrafts(p:{target:string;plan:{kind:string;hub:string|null;gatherTicks:number};timing:{attackTicks:number};sources:{id:string;available:number;ticks:number}[]},tick:number,allocations=p.sources.map(s=>({source:s.id,drillers:s.available}))){
  const launch=(source:string,destination:string,drillers:number,issueTick:number)=>({issueTick,action:{kind:'launch' as const,source,destination,drillers}});
  if(p.plan.kind==='direct')return allocations.map(a=>launch(a.source,p.target,a.drillers,tick+p.timing.attackTicks-p.sources.find(s=>s.id===a.source)!.ticks));
  const hub=p.plan.hub!;
  return [...allocations.filter(a=>a.source!==hub).map(a=>launch(a.source,hub,a.drillers,tick)),
    launch(hub,p.target,allocations.reduce((n,a)=>n+a.drillers,0),tick+p.plan.gatherTicks)];
}
