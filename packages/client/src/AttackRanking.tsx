import {tickTime,worldMinutes} from './time.js';
import {Tip} from './Tip.js';
import React from 'react';
import {ChevronDown} from 'lucide-react';
import {OutpostLink,ChatMessageText} from './ChatMessageText.js';
export interface Campaign {id:string;target:string;stage:string;movement?:{waiting:number;moving:number};objective:string;holdPlan:string;cancelWhen:string;reviewAtTick:number;issues:string[]}
interface Rank {plan?:{kind:string;hub:string|null;gatherTicks:number};target:string;name:string;score:number;range:string;timing:{attackTicks:number};sourceForce:number;attackMargin:number;holdMargin:number;confidence:number;existingOperation?:boolean;assessment?:string;defense:{shieldAtArrival?:{minimum:number;maximum:number};shieldUsed?:number;productionUpperBound?:number;observedDrillers:number|null;observedShield:number|null;estimatedWithProductionAndShield:number;enemyBefore:number};thirdParties?:{estimatedForce:number}[];sources:{id:string;available:number;reserve:number;campaignReserved?:number;defense?:{shortfall:number;stationed:number;shield:number;threats:{id:string;ticks:number;force:number;estimated:boolean}[]}}[];reasons:string[];components:Record<string,number>}
interface AttackScreeningReport {observedTick:number;configId:string;ranked?:Rank[];candidates:Rank[];sourceReserves?:{id:string;reserve:number;available:number;defense?:{shortfall:number}}[];excluded?:{target:string}[];budget?:{proposals:{target:string;allocations:{source:string;drillers:number}[]}[]}}

export interface RankingSnapshot {report:AttackScreeningReport}
const duration=(ticks:number)=>worldMinutes(ticks*10);
export function AttackRanking({screening,campaigns}:{screening:RankingSnapshot|null|undefined;campaigns?:{plans:Campaign[]}|null|undefined}){
  const r=screening?.report;
  if(!r)return <p className="hint">尚无进攻评估记录。AI 下次进入战略、军事或计划分析时生成。</p>;
  return <section className="ai-attack-ranking" aria-label="进攻目标排名评估">
    <div className="ai-ranking-intro"><b>进攻目标评估</b><span>游戏 {tickTime(r.observedTick)}</span><Tip label="进攻目标评估">按综合得分排序，展开目标可查看评估依据。查看列表不会重新分析。</Tip></div>
    {(r.ranked??r.candidates).map((p,i)=><details className="ai-ranking-card" key={p.target}>
      <summary>
        <div className="ai-ranking-title"><span className="ai-ranking-number">{String(i+1).padStart(2,'0')}</span><div className="ai-ranking-target"><b><OutpostLink id={p.target} label={p.name}/></b><small>{p.target} · {p.range==='near'?'近期候选':'集结准备'}</small></div><span className="ai-ranking-score">{p.score}<small>综合评分</small></span><ChevronDown className="ai-ranking-chevron" size={14}/></div>
        <div className="ai-ranking-overview"><span>航程 <b>{duration(p.timing.attackTicks)}</b></span><span>可计兵力 <b>{p.sourceForce}</b></span><span>攻占余量 <b className={p.attackMargin<0?'is-shortfall':''}>{p.attackMargin}</b></span></div>
        <div className="ai-ranking-assessment">{p.existingOperation?'已有行动':p.assessment==='potential-force-advantage'?'可进一步推演':p.assessment==='ownership-may-change-before-arrival'?'争夺中，需复核':'需增兵或复核'}</div>
      </summary>
      <div className="ai-ranking-detail">
        {p.plan&&<p className="hint">{p.plan.kind==='gather'?<>先向 <OutpostLink id={p.plan.hub!}/> 集结，{duration(p.plan.gatherTicks)}后合兵出击</>:'多路同步直攻，较近来源延后出航'} · 兵力仅计当前可调兵，采用前须组合推演</p>}
        <dl className="ai-ranking-stats">{[
          ['目标驻兵',p.defense.observedDrillers??'未知'],['当前护盾',p.defense.observedShield??'未知'],['抵达护盾',p.defense.shieldAtArrival?`${p.defense.shieldAtArrival.minimum}–${p.defense.shieldAtArrival.maximum}`:'未记录'],['预计产兵',p.defense.productionUpperBound??'未记录'],['防御估算',p.defense.estimatedWithProductionAndShield],['及时支援',p.defense.enemyBefore],['第三方兵力',Math.round((p.thirdParties??[]).reduce((n,s)=>n+s.estimatedForce,0))],['守备余量',p.holdMargin],['情报可信度',`${Math.round(p.confidence*100)}%`],
        ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <h4>兵力来源</h4><div className="ai-ranking-sources"><div className="ai-ranking-source-head"><span>据点</span><span>可调</span><span>防守</span><span>战役</span></div>{p.sources.map(s=><div key={s.id}><b><OutpostLink id={s.id}/></b><span>{s.available}</span><span>{s.reserve}</span><span>{s.campaignReserved??0}</span></div>)}</div>
        {p.sources.map(s=>s.defense&&<p className="hint" key={s.id}><OutpostLink id={s.id}/>：驻兵{s.defense.stationed}，护盾{s.defense.shield}；建议留兵{s.reserve}{s.defense.shortfall>0&&`，现有驻兵仍缺${s.defense.shortfall}`}。{s.defense.threats.length?s.defense.threats.map(t=>`${t.id} ${t.force}兵/${duration(t.ticks)}${t.estimated?'（可能出击）':'（在途）'}`).join('；'):'近期未发现可达威胁'}。此为威胁估算，非安全保证。</p>)}
        <h4>评估依据</h4><ul className="ai-ranking-reasons">{p.reasons.map((text,j)=><li key={j}><ChatMessageText text={text}/></li>)}</ul>
        <h4>评分分项</h4><dl className="ai-ranking-components">{Object.entries(p.components).map(([key,n])=><div key={key}><dt>{({value:'目标价值',attackBalance:'进攻兵力',holdBalance:'占领守备',speed:'航程',confidence:'情报',lowExposure:'第三方风险'} as Record<string,string>)[key]??key}</dt><dd>{n}</dd></div>)}</dl>
      </div>
    </details>)}
    {!(r.ranked??r.candidates).length&&<p className="hint">当前范围内没有可用出兵来源的目标。</p>}
    {!!r.sourceReserves?.some(s=>(s.defense?.shortfall??0)>0)&&<details><summary>来源防守存在缺口</summary>{r.sourceReserves.filter(s=>(s.defense?.shortfall??0)>0).map(s=><p className="hint" key={s.id}><OutpostLink id={s.id}/>：威胁情景建议留兵{s.reserve}，当前驻兵仍缺{s.defense!.shortfall}；需评估增援、外交或放弃防守，不能视作安全来源。</p>)}</details>}
    {!!r.budget?.proposals.length&&<details><summary>共享预算下的可组合建议</summary>{r.budget.proposals.map(p=><p className="hint" key={p.target}><OutpostLink id={p.target}/> ← {p.allocations.map((a,i)=><React.Fragment key={a.source}>{i>0?'、':''}<OutpostLink id={a.source}/> {a.drillers}</React.Fragment>)}（采用前需推演）</p>)}</details>}
    {!!campaigns?.plans.filter(p=>!['completed','cancelled'].includes(p.stage)).length&&<details><summary>进行中的战役</summary>{campaigns.plans.filter(p=>!['completed','cancelled'].includes(p.stage)).map(p=><div className="ai-history-entry" key={p.id}><b>{p.id} → <OutpostLink id={p.target}/></b><p className="ai-entry-summary">{p.objective}</p><p className="hint">{({assembling:'集结',waiting:'已派遣待发',underway:'实际航行',holding:'守备',review:'待复查'} as Record<string,string>)[p.stage]} {p.movement&&`· 待发 ${p.movement.waiting} / 航行 ${p.movement.moving}`} · 复查 {tickTime(p.reviewAtTick)}<br/>{p.holdPlan}<br/>调整条件：{p.cancelWhen}<br/>{p.issues.join('；')}</p></div>)}</details>}
    {!!r.excluded?.length&&<details><summary>未进入排名 · {r.excluded.length} 个</summary>{r.excluded.map(p=><p className="hint" key={p.target}><OutpostLink id={p.target}/>：没有航程范围内且未被占用的出兵来源</p>)}</details>}
    <p className="ai-ranking-footnote">分数用于方案比较，不是胜率。配置 {r.configId} · 查看列表不会重新分析。</p>
  </section>;
}
