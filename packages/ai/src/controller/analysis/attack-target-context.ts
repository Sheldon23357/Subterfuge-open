import {enemyWaitingSources} from './waiting-defense.js';
import {activeCampaign,type Campaign} from '../storage/campaign-state.js';
import {isActiveNote} from '../storage/memory-records.js';
import type {NotebookEntry} from '../contracts/types.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {AttackScreeningReport} from './attack-screening.js';

type Ranking=Pick<AttackScreeningReport,'ranked'>&Partial<Pick<AttackScreeningReport,'sourceReserves'|'cooperation'|'candidates'>>;

/** Compact discovery facts from the same screening result, never extra simulation. */
export function attackDiscoveryContext(report:Ranking){
  const detailed=new Set(report.ranked.slice(0,5).map(p=>p.target));
  const special=(report.candidates??[]).filter(p=>['leading-opponent','reconnaissance'].includes(p.selection)&&!detailed.has(p.target));
  return {
    ...(report.sourceReserves?{sourceSafety:report.sourceReserves.map(s=>({source:s.id,available:s.available,retain:s.reserve,shortfall:s.defense.shortfall,uncertain:s.defense.uncertain,
      status:s.defense.status,forecastRequired:s.defense.forecastRequired,forecastReasons:s.defense.forecastReasons,
      ...(s.defense.threats.some(t=>!t.estimated)?{incoming:s.defense.threats.filter(t=>!t.estimated).map(t=>({id:t.id,ticks:t.ticks,force:t.force,estimated:t.estimated,unknown:t.unknown}))}:{}),
      ...(s.defense.threats.some(t=>t.estimated)?{potentialSorties:s.defense.threats.filter(t=>t.estimated).map(t=>({id:t.id,ticks:t.ticks,force:t.force,estimated:t.estimated,unknown:t.unknown}))}:{})}))}:{}),
    ...(report.cooperation?{cooperationAlert:{opponents:report.cooperation.opportunities.map(p=>({opponent:p.opponent,partners:p.partners.map(q=>q.player),incoming:p.incoming.length,purposes:p.purposes})),details:'attackCandidates {all:true}'}}:{}),
    ...(special.length?{specialTargets:special.map(p=>({target:p.target,rank:report.ranked.some(r=>r.target===p.target)?report.ranked.findIndex(r=>r.target===p.target)+1:null,reason:p.selection,tags:p.tags,score:p.score,observedDrillers:p.defense.observedDrillers,observedShield:p.defense.observedShield,details:`attackCandidates {target:"${p.target}"}`}))}:{}),
  };
}
export interface TargetRelatedContext {task?:{entities:string[]};campaigns?:Campaign[];notebook?:NotebookEntry[]}
/** Presentation over existing results and authorized observations; no new planning. */
export function attackTargetContext(report:Ranking,o?:PlayerObservation,related:TargetRelatedContext={}){
  const v=o?.view,waiting=v?enemyWaitingSources(v):new Map<string,string>(),top=report.ranked.slice(0,5);
  const name=(id:string)=>o?.outpostNames?.[id]?`${o.outpostNames[id]}（${id}）`:id;
  const node=(id:string)=>v?.outposts.find(p=>p.id===id);
  const distance=(from:string,to:string)=>{
    const a=node(from),b=node(to);if(!v||!a||!b)return '未知';
    const wrap=(n:number,size:number)=>{const d=((n%size)+size)%size;return Math.min(d,size-d);};
    return `${Math.round(Math.hypot(wrap(a.position.x-b.position.x,v.size.width),wrap(a.position.y-b.position.y,v.size.height))*100)/100}地图单位`;
  };
  const minutes=(ticks:number|null|undefined)=>ticks==null?'未知':`${ticks}世界天`;
  const recalled=(id:string)=>v?.fleets.filter(f=>waiting.get(f.id)===id).reduce((n,f)=>n+f.drillers,0)??0;
  const bounded=<T>(rows:T[],render:(row:T)=>string,limit=4)=>rows.slice(0,limit).map(render).join('；')+(rows.length>limit?`；另${rows.length-limit}项见完整详情`:'');
  const kinds:Record<string,string>={factory:'工厂',generator:'发电站',mine:'矿场',unknown:'种类未知'};
  const targets=top.map((p,index)=>{
    const post=node(p.target),owner=post?.owner===undefined?(o?'归属未知':p.owner===null?'中立或归属未知':`玩家${p.owner}`):post.owner===null?'中立':`玩家${post.owner}`;
    const reasons=[...(p.components.value!>0?[`据点价值分项${p.components.value}`]:[]),...(p.valueBreakdown?.mineInvestment?['现成矿场投资价值']:[]),...(p.tags.includes('leading-opponent')?['领先对手']:[]),p.assessment==='potential-force-advantage'?'初筛兵力占优':p.contested?'他方争夺':'需补兵',...(p.existingOperation?['己方已有攻击在途']:[]),...(p.tags.includes('reconnaissance')?['防守数据不全']:[])];
    const sources=p.sources.map(s=>{
      const shared=top.flatMap((other,i)=>i!==index&&other.sources.some(t=>t.id===s.id)?[i+1]:[]);
      const travel=p.plan?.kind==='gather'?`运至集结点${minutes(s.transferTicks)}，按集结方案抵达目标${minutes(s.ticks)}`:p.plan?.kind==='direct'?`普通航速直达${minutes(s.ticks)}`:`原初筛航程估计${minutes(s.ticks)}（方案类型未知）`;
      return `${name(s.id)}：可调${s.available}兵/驻兵${s.defense?.stationed??node(s.id)?.drillers??'未知'}，防守留兵${s.reserve??'未知'}、战役预留${s.campaignReserved??'未知'}，护盾${node(s.id)?.shield??'未知'}，距目标${distance(s.id,p.target)}，${travel}${s.defense?.shortfall?`，防守缺口${s.defense.shortfall}`:''}${shared.length?`，与候选${shared.join('/')}共用此来源`:''}`;
    }).join('；')||'无';
    const support=bounded([...p.support].sort((a,b)=>a.ticks-b.ticks||a.id.localeCompare(b.id)),s=>`${name(s.id)}：已知驻兵${node(s.id)?.drillers??'未知'}${recalled(s.id)?`+待发可撤${recalled(s.id)}`:''}，距目标${distance(s.id,p.target)}，普通航速${minutes(s.ticks)}，初筛动员估值${s.estimatedForce}`)||'未列出';
    const third=bounded([...p.thirdParties].sort((a,b)=>a.ticks-b.ticks||a.id.localeCompare(b.id)),s=>`${name(s.id)}（玩家${s.owner}）：驻兵${node(s.id)?.drillers??'未知'}，距目标${distance(s.id,p.target)}，普通航速${minutes(s.ticks)}`,3);
    const incoming=bounded([...p.incoming].sort((a,b)=>Number(b.owner===v?.player)-Number(a.owner===v?.player)||(a.ticks??Infinity)-(b.ticks??Infinity)),f=>{
      const seen=v?.fleets.find(x=>x.id===f.id);
      const side=v&&f.owner===v.player?'己方':f.owner===p.owner?'守方':'他方';
      return `${f.id}（${side}/玩家${f.owner}）：${f.drillers}兵，${seen?.state??'状态未知'}，${seen?.source?name(seen.source):'来源未知'}→${name(p.target)}，现航线预计${minutes(f.ticks)}抵达`;
    });
    const schedules=o?.scheduled.filter(s=>s.status==='pending'&&s.action.kind==='launch'&&s.action.destination===p.target)??[];
    const scheduled=bounded(schedules,s=>s.action.kind==='launch'?`${s.id}：${name(String(s.action.source))}→${name(p.target)} ${s.action.drillers}兵，执行tick${s.issueTick}`:'');
    const campaigns=related.campaigns?.filter(c=>activeCampaign(c)&&(c.target===p.target||c.allocations.some(a=>p.sources.some(s=>s.id===a.source))));
    const campaignText=campaigns?.length?bounded(campaigns,c=>`${c.id}（${c.stage}，目标${name(c.target)}，复查tick${c.reviewAtTick}；关联来源预留${c.allocations.filter(a=>p.sources.some(s=>s.id===a.source)).map(a=>`${name(a.source)} ${a.drillers}兵`).join('、')||'无'}）`,3):'';
    const agreements=o?related.notebook?.filter(n=>n.record?.type==='agreement'&&isActiveNote(n,v!.tick*600+o.secondsSinceLastTick)&&(n.record.entities.includes(p.target)||n.record.entities.some(id=>p.sources.some(s=>s.id===id))||p.owner!==null&&n.record.players.includes(p.owner))):undefined;
    const agreementText=agreements?.length?bounded(agreements,n=>`${n.id}（${n.record!.status}；正文见notebook）`,3):'';
    const plan=p.plan?.kind==='gather'?`先向${name(p.plan.hub!)}集结${minutes(p.plan.gatherTicks)}，再按当前航程估计合兵出击`:p.plan?.kind==='direct'?'多路同步直攻，较近来源延后出航':'方案类型未知';
    const d=p.defense,shield=d.shieldAtArrival?`；抵达护盾估计${d.shieldAtArrival.minimum}–${d.shieldAtArrival.maximum}`:'';
    const force=`方案${plan}；预计从观察起${minutes(p.timing.attackTicks)}抵达（tick${p.timing.arrivalTick??'未知'}），守备评估终点tick${o?o.view.tick+p.timing.holdTicks:'未知'}；初筛计入己方${p.sourceForce}兵（含赶得上的既有攻击），后续来源可调${p.followupForce}；防守含产兵/护盾成本估计${d.estimatedWithProductionAndShield}，预计产兵上界${d.productionUpperBound}${shield}；守方援军抵达时累计估值${d.enemyBefore}、守备窗口累计${d.enemyThroughHold}；进攻差额${p.attackMargin}、守备差额${p.holdMargin}，补兵估值${p.additionalForceEstimate}`;
    return `${index+1}. ${o?name(p.target):p.name===p.target?p.target:`${p.name}（${p.target}）`}；${kinds[p.type]??p.type}，${owner}；价值评分${p.score}，理由：${reasons.join('、')}。\n目标：护盾${d.observedShield??'未知'}，驻兵${d.observedDrillers??'未知'}${d.recallableWaitingDrillers?`；另有待发可撤兵${d.recallableWaitingDrillers}`:''}。\n己方关联节点：${sources}。\n敌方可能增援节点：${support}。${third?`第三方节点（不自动协防）：${third}。`:''}\n${force}。${incoming?`\n现有驶向目标舰队：${incoming}。`:''}${scheduled?`\n己方待执行预约：${scheduled}。`:''}${campaignText?`\n相关战役：${campaignText}。`:''}${agreementText?`\n相关协议记录：${agreementText}。`:''}`;
  });
  return {targets,...attackDiscoveryContext(report),note:'来源available/retain为provisional预算，非安全保证；forecastRequired时复用同方案forecast核实来源归属与损失，未知不当安全；potentialSorties仅潜在邻居，不是实际来袭，当前航线预测不覆盖其未来新发舰。评分为排序参考，不是胜率；各目标独立复用来源，不能叠加承诺。距离为环面直线地图单位；航程为普通航速估计。敌方动员/补兵/差额为初筛估值，已知驻兵不等于可出兵；下令前用deploy/campaignCompare核对。'};
}
