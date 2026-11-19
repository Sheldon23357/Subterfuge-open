import type {PlayerObservation,PlayerMapView,PlayerForecastResult} from '../../../../contracts/src/index.js';
import {RULES,TICKS_PER_DAY} from '../../../../rules/src/index.js';
import {scheduledCommitments} from './scheduled-commitments.js';
import {createOutpostRiskAnalysis,riskObservation,type OutpostRiskAnalysis} from './outpost-risk.js';

type Frame=PlayerMapView|PlayerForecastResult;
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
/** Exact rule arithmetic at a supplied balance, never a future loss prediction. */
export function mineLossCost(balance:number){return balance-Math.round(balance*(1-RULES.GameParams.NeptuniumPercentLostWithMine));}

export const MINE_STRATEGY_GUIDE='矿点策略：开矿消耗须除以当前己方总兵力（含在途兵力）比较；占比越高，越应先积累兵力和扩产，避免早期开矿抽空军队。新增矿场的持有信用按剩余兵力比例的平方折减后比较完成时间价值；实际收入与已支付的建设不重复折减。矿数应与矿区局部兵力、补兵航程和持续产能匹配，无须先取得全局兵力第一。拿矿同时承担守备责任；比较直接开矿/抢矿、先扩产或集兵后拿矿、补防已有矿与等待。库存越高，失矿扣款越大；同矿失守后夺回不返还，再失守再次扣款。检查全过程失矿与增援时序，不只看终点归属；同一预备队不可重复担保多座矿。拿矿后的新增收入须覆盖投资、原设施损失、守备牵制和反夺风险；领先且现有矿可冲线时重视保矿，对手即将冲线时仍可承担必要风险。压力估算不是敌方命令或胜率，未知不当作零；用compare/decisionSupport验证明确操作，长期持有是条件判断，暂缓须记具体障碍和复查条件。';

/** Local pressure is a bounded search heuristic, not combat, timing or a
 * probability model. No hypothetical ally/third-party coordination is assumed.
 * Reserves are reported ONCE, never credited to each mine without transport. */
export function mineHoldingAssessment(o:PlayerObservation,frame:Frame=o.view,risks?:OutpostRiskAnalysis){
 if(o.view.match?.mode!=='mining')return null;
 risks??=createOutpostRiskAnalysis(riskObservation(o,frame));
 const analysis=risks;
 const player=o.view.player,own=frame.outposts.filter(p=>p.owner===player&&!p.destroyed);
 const commitments=new Map(frame===o.view?scheduledCommitments(o).map(c=>[c.source,c]):[]);
 const available=(p:typeof own[number])=>p.drillers===undefined||commitments.get(p.id)?.unknownSchedules.length?null:Math.max(0,p.drillers-(commitments.get(p.id)?.drillers??0));
 const pressure=(p:typeof own[number])=>{
  const risk=analysis.get(p.id);
  return {estimate:Math.max(risk.enemy,risk.arrivalShortfall>0?risk.defense+risk.arrivalShortfall:0),incoming:risk.hostileIncoming,unknown:risk.unknowns};
 };
 const mines=own.filter(p=>p.type==='mine').map(p=>{
  const threat=pressure(p),drillers=available(p),known=drillers!==null&&p.shield!==undefined;
  const risk=analysis.get(p.id),defense=known?risk.defense:null;
  const shortfall=defense===null?null:Math.max(0,threat.estimate-defense);
  // Credit is a valuation haircut, NOT a survival probability. Unseen nearby
  // forces cap long-term credit; no unknown garrison is invented or simulated.
  const localCredit=defense===null?0:threat.estimate>0?clamp(defense/threat.estimate):1;
  const uncertain=threat.unknown.length>0||('unknownArrivals'in frame&&frame.unknownArrivals.some(a=>a.outpostId===p.id));
  return {id:p.id,drillers:p.drillers??null,availableAfterCommitments:drillers,shield:p.shield??null,pressureEstimate:threat.estimate,incomingDrillers:threat.incoming,
   shortfall,unknownNearbySources:threat.unknown,uncertain,
   holdingCredit:Math.min(localCredit,uncertain?0.5:1),exposureSeverity:1-localCredit};
 });
 const sharedReserve=own.filter(p=>p.type!=='mine').reduce((n,p)=>{
  const troops=available(p);if(troops===null||p.shield===undefined)return n;
  return n+Math.max(0,troops-analysis.get(p.id).requiredGarrison);
 },0);
 // Fractional exposure is only a scoring severity. Sequential rule costs
 // bound several vulnerable mines by the whole inventory; no expected-value
 // or risk probability claim, and no already-settled path loss is re-deducted.
 let balance=frame.self.neptunium,inventoryExposure=0;
 for(const mine of [...mines].sort((a,b)=>b.exposureSeverity-a.exposureSeverity)){
  const cost=mineLossCost(balance);inventoryExposure+=cost*mine.exposureSeverity;balance-=cost;
 }
 const factories=own.filter(p=>p.type==='factory');
 const factoryOutput= factories.some(p=>!p.metrics||p.metrics.cycleMinutes===null)?null:
  factories.reduce((n,p)=>n+(p.metrics!.active&&p.metrics!.cycleMinutes!>0?p.metrics!.output*10/p.metrics!.cycleMinutes!:0),0);
 const income=mines.length*own.length/TICKS_PER_DAY,afterLossIncome=Math.max(0,mines.length-1)*Math.max(0,own.length-1)/TICKS_PER_DAY;
 const oneLoss=mineLossCost(frame.self.neptunium),goal=o.view.match?.neptuniumGoal;
 return {basis:frame===o.view?'current-authorized-observation':'conditional-endpoint',balance:frame.self.neptunium,
  oneLossCost:oneLoss,mineCount:mines.length,mines,
  factoryNominalOutputPerWorldDay:factoryOutput,sharedReserveDrillers:sharedReserve,
  totalLocalShortfall:mines.some(p=>p.shortfall===null)?null:mines.reduce((n,p)=>n+p.shortfall!,0),
  staticMineIncomePerWorldDay:income,staticIncomeAfterOneMineLossPerWorldDay:afterLossIncome,
  staticRecoveryWorldDaysAfterOneLoss:afterLossIncome>0?oneLoss/afterLossIncome:null,
  staticVictoryWorldDays:goal!==undefined&&income>0?Math.max(0,goal-frame.self.neptunium)/income:null,
  staticVictoryWorldDaysAfterOneLoss:goal!==undefined&&afterLossIncome>0?Math.max(0,goal-frame.self.neptunium+oneLoss)/afterLossIncome:null,
  holdingCredits:mines.reduce((n,p)=>n+p.holdingCredit,0),inventoryExposure,
  interpretation:'pressureEstimate/shortfall/holdingCredit/inventoryExposure为可见资产启发式，非战果、意图、失守概率或额外实际扣款。static时间仅假设当前设施持续持有，失矿例子减一座矿和一据点，null为该假设下无收入或目标未知，不表示永远不能获胜。sharedReserveDrillers只计一次，未分配或验证航程/支付，不能逐矿重复使用；工厂名义产能仍受容量及未来局势影响。'};
}

/** Marginal public-economy arithmetic for several captured mines belonging
 * to one opponent. Compound deductions once per capture; no hidden income or
 * future inventory is fabricated, and the deduction is not our income. */
export function mineCaptureImpact(o:PlayerObservation,targets:readonly string[]){
 const rows=[];
 for(const intel of o.intel.filter(p=>o.view.match?.mode==='mining'&&p.player!==o.view.player&&p.active)){
  const ids=[...new Set(targets)].filter(id=>o.view.outposts.some(p=>p.id===id&&p.owner===intel.player&&p.type==='mine'&&!p.destroyed));
  if(!ids.length)continue;
  let retained=intel.neptunium;for(const _ of ids)retained-=mineLossCost(retained);
  const incomeAfter=Math.max(0,intel.outposts.mine-ids.length)*Math.max(0,intel.numOutposts-ids.length);
  const goal=o.view.match?.neptuniumGoal;
  const beforeEta=goal!==undefined&&intel.npPerDay>0?Math.max(0,goal-intel.neptunium)*TICKS_PER_DAY/intel.npPerDay:null;
  const afterEta=goal!==undefined&&incomeAfter>0?Math.max(0,goal-retained)*TICKS_PER_DAY/incomeAfter:null;
  rows.push({player:intel.player,targets:ids,currentBalance:intel.neptunium,balanceAfterLossesAtCurrentBalance:retained,
   deductionAtCurrentBalance:intel.neptunium-retained,currentIncomePerEconomicDay:intel.npPerDay,
   incomeAfterAtCurrentHoldings:incomeAfter,staticVictoryDelayWorldDays:beforeEta===null||afterEta===null?null:Math.max(0,afterEta-beforeEta),
   allCurrentMinesRemoved:incomeAfter===0});
 }
 return {basis:'conditional-capture-with-current-public-economy',opponents:rows,
  interpretation:'按当前公开库存和领土示例，非抵达时敌方库存或胜利时刻预测；扣款不归攻占者，夺回也不返还。收入归零只代表当前矿场已移除，不代表对方不能新建或夺回。'};
}
