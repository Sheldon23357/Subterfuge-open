import React from 'react';

export interface BotDecisionSummaryData {
  observedTick:number;current:boolean;phase:string;kind:string;targets:string[];reasons:string[];
  coverage:{generated:number;evaluated:number;simulations:number;complete:boolean;stopReason:string};
  operations:number;unknowns:string[];assumptions:string[];
}
const phases:Record<string,string>={survival:'保障生存','deny-victory':'阻止对手获胜',finish:'完成胜利',economy:'发展经济',expansion:'扩张'};
const kinds:Record<string,string>={attack:'进攻',defense:'防守',economy:'经济建设',logistics:'运输增援',fleet:'舰队调整',scout:'有限侦察',hold:'维持已有行动',combined:'组合行动'};
const stops:Record<string,string>={'simulation-budget':'达到模拟次数上限','stage-budget':'达到阶段预算','time-budget':'达到时间预算',cancelled:'已取消',complete:'已完成当前搜索'};
const unknownLabels:Record<string,string>={'bounded-attack-with-unresolved-remote-arrival':'远处舰队抵达结果待确认', 'scout-target-outcome-unknown':'侦察目标的抵达结果待确认', 'asset-outcome-unknown':'部分资产结算结果待确认', 'arrival-outcome-unknown':'部分舰队抵达结果待确认'};
export function BotDecisionSummary({value:v,names={}}:{value:BotDecisionSummaryData;names?:Record<string,string>}){
  const unknowns=[...new Set(v.unknowns)].filter(text=>!['future-sonar-contacts-unknown','unobserved-outposts','unobserved-world-possible'].includes(text));
  const reasons=[...new Set(v.reasons)].filter(reason=>reason!=='维持已有行动作为比较基线');
  return <section className="decision-panel" aria-label="战术决策">
    <div className="section-heading"><h3>战术决策</h3><span className={'diagnostic-badge'+(v.current?'':' is-stale')}>{v.current?'对应当前观察':'历史判断，局势已变化'}</span></div>
    <div className="decision-title"><h4>{kinds[v.kind]??v.kind}</h4><span>第 {v.observedTick} 天 · {phases[v.phase]??v.phase}</span></div>
    {!!v.targets.length&&<p className="decision-targets">目标：{v.targets.map(id=>names[id]??id).join('、')}</p>}
    <dl className="diagnostic-metrics"><div><dt>计划操作</dt><dd>{v.operations}<small>项</small></dd></div><div><dt>生成候选</dt><dd>{v.coverage.generated}<small>项</small></dd></div><div><dt>完成评估（含基线）</dt><dd>{v.coverage.evaluated}<small>项</small></dd></div><div><dt>条件模拟</dt><dd>{v.coverage.simulations}<small>次</small></dd></div></dl>
    {reasons.length>0&&<ul className="decision-reasons">{reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>}
    {!v.coverage.complete&&<p className="diagnostic-caption">{stops[v.coverage.stopReason]??v.coverage.stopReason}</p>}
    {unknowns.length>0&&<details className="diagnostic-disclosure"><summary>待核实 <span>{unknowns.length}</span></summary><ul>{unknowns.map((text,i)=><li key={i}>{unknownLabels[text]??(text.startsWith('garrison:')?`驻军未知：${names[text.slice(9)]??text.slice(9)}`:text.startsWith('production:')?`产能未知：${names[text.slice(11)]??text.slice(11)}`:text)}</li>)}</ul></details>}
  </section>;
}
