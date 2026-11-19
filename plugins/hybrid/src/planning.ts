import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import {attackRoutes} from '@subterfuge/bot-sdk/prediction';
import {screenAttacks,screeningClass} from '@subterfuge/bot-sdk/analysis/attack-screening';
import {loadAttackScreeningConfig} from '@subterfuge/bot-sdk/analysis/attack-screening-config';

/** Decision consequences only; scoring coefficients remain in program diagnostics. */
function decisionReasons(p:ReturnType<typeof screenAttacks>['ranked'][number],self:number){
 const mine=p.valueBreakdown.mineInvestment;
 return [
  p.plan.kind==='gather'?`先向${p.plan.hub}集结${p.plan.gatherTicks}世界天再出击，仅计当前可调兵；集结点与来源安全仍需组合推演`:'多路按最晚抵达同步，近来源需延后出航，先到舰不会等待',
  `当前可计入兵力${p.sourceForce}，预计防御成本${p.defense.estimatedWithProductionAndShield}，另有抵达前增援估算${p.defense.enemyBefore}；抵达护盾范围${p.defense.shieldAtArrival.minimum}–${p.defense.shieldAtArrival.maximum}`,
  ...(mine?[`现成矿场节省自建${mine.replacementCost}兵；假设占领并持续守住，航程后${mine.remainingTicks}世界天预计新增矿产${Math.round(mine.estimatedOwnIncome*100)/100}，对手按当前库存失矿损失${mine.estimatedEnemyBalanceLoss??'未知'}，非保证收益`]:[]),
  ...(p.contested?['其他阵营舰队可能先占领，抵达归属与成本仍需复核']:[]),
  ...(p.existingOperation?['已有己方攻击或占领舰队在途，复核既有行动，避免重复出兵']:[]),
  ...(p.tags.includes('reconnaissance')?['目标兵力或护盾未知，使用配置估值，需侦察']:[]),
  ...(p.thirdParties.some(s=>s.estimatedForce>0)||p.incoming.some(f=>f.owner!==self&&f.owner!==p.owner&&!f.gift)?['第三方力量不自动视为目标援军']:[]),
 ];
}

/** Shared, bounded program advice. These estimates never replace admission or combat forecasts. */
export function hybridPlanning(o:PlayerObservation,required:readonly string[]=[],opponents:readonly number[]=[]){
 const report=screenAttacks(o,attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24}),loadAttackScreeningConfig(),[],required);
 const related=new Set(required),rivals=new Set(opponents);
 const ranked=[...new Map([...report.ranked.filter(p=>related.has(p.target)),...report.ranked.filter(p=>rivals.has(p.owner!)).slice(0,5),...report.ranked.slice(0,5)].map(p=>[p.target,p])).values()];
 return {
  basisRevision:o.revision,worldDay:o.view.tick+o.secondsSinceLastTick/600,
  estimates:{forceSources:{columns:['source','stationed','reserveEstimate','availableEstimate','unknownSchedules'],rows:report.sourceReserves.map(s=>[s.id,o.view.outposts.find(p=>p.id===s.id)?.drillers??null,s.reserve,s.available,s.pendingUnknown]),coverage:{listed:report.sourceReserves.length,total:report.sourceReserves.length}}},
  candidates:ranked.map(p=>({target:p.target,owner:p.owner,classification:screeningClass(p),score:p.score,attackWorldDays:p.timing.attackTicks,additionalForceEstimate:p.additionalForceEstimate,
   assessment:{conclusion:p.existingOperation?'已有己方进攻在途，需复核既有行动':screeningClass(p)==='action'?'通过进攻初筛，仍需前台战术验证':'进攻条件尚需满足或验证',reasons:[
    ...(p.attackMargin<=0?['当前估算进攻兵力不足']:[]),...(p.holdMargin<=0?['占领后的守备条件不足']:[]),
    ...(p.confidence<1?['目标或周边防守信息不完整']:[]),...(p.contested?['存在其他阵营争夺']:[]),
    ...(p.sources.some(s=>s.pendingUnknown)?['来源存在未知预约占用']:[]),
    ...(p.sources.some(s=>s.defense.forecastRequired)?['抽兵后的来源安全仍需战术验证']:[]),
    ...(p.plan.kind==='gather'?['需要先集结兵力']:[]),
   ]},
   newForceForScreenedAttackEstimate:Math.max(0,Math.ceil(p.defense.estimatedWithProductionAndShield+p.defense.enemyBefore-(p.sourceForce-p.sources.reduce((n,s)=>n+s.available,0))+1)),
   launchSources:p.sources.map(s=>({source:s.id,availableEstimate:s.available,travelWorldDays:s.ticks})),reasons:decisionReasons(p,o.view.player)})),
  excluded:report.excluded.filter(p=>related.has(p.target)),
  coverage:{ranked:report.ranked.length,listed:ranked.length,opponentCandidates:report.ranked.filter(p=>rivals.has(p.owner!)).length},
  interpretation:'候选、可调兵量、投入与航程是程序估算和建议，尚未完成联合推演；未知不补零，无候选不等于无法进攻。AI选择少量目标，程序继续验证来源安全、资源与交付。',
 };
}
