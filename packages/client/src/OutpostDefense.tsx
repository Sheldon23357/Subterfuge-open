import React from 'react';
import {DetailTip} from './DetailTip.js';

export interface OutpostDefenseData {
 observedTick:number;current:boolean;
 parameters:{horizonTicks:number;firstSupportWeight:number;secondSupportWeight:number;outerEnemyWeight:number};
 outposts:{id:string;available:number;defense:number;enemy:number;pressureRatio:number;priority:number;importance:number;shortfall:number;requiredGarrison:number;friendlyIncoming:number;hostileIncoming:number;arrivalShortfall:number;earliestDeficitTicks:number|null;unknowns:string[];support:{id:string;ticks:number;available:number;weighted:number}[]}[];
}
const number=(v:number)=>v.toLocaleString('zh-CN',{maximumFractionDigits:2});
export function OutpostDefense({value:v,names={}}:{value:OutpostDefenseData;names?:Record<string,string>}){
 const name=(id:string)=>names[id]??id;
 const unknown=(text:string)=>{const [kind,...parts]=text.split(':');const id=parts.join(':');return ({garrison:'驻军或归属未知',shield:'护盾未知',commitment:'预约占用未知',arrival:'抵达时间未知'}[kind!]??kind)+'：'+name(id);};
 const rows=[...v.outposts].sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
 return <section className="decision-panel assessment-panel" aria-label="己方据点防守压力">
  <div className="section-heading"><h3>己方据点防守压力</h3><span className={'diagnostic-badge'+(v.current?'':' is-stale')}>{v.current?'对应当前观察':'历史评分，局势已变化'}</span></div>
  <p className="diagnostic-caption">第 {v.observedTick} 天 · {v.parameters.horizonTicks} 天估算窗口</p>
  {rows.length?<div className="diagnostic-table assessment-table"><table><thead><tr><th scope="col">据点</th><th scope="col" className="number">压力比</th><th scope="col" className="number">加权优先分</th><th scope="col" className="number">估算守备</th><th scope="col" className="number">潜在敌军</th><th scope="col" className="number">留守缺口</th><th scope="col">依据</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><th scope="row">{name(r.id)}</th><td className="number">{number(r.pressureRatio)}</td><td className="number">{number(r.priority)}</td><td className="number">{number(r.defense)}</td><td className="number">{number(r.enemy)}</td><td className="number">{number(r.shortfall)}</td><td><DetailTip label={name(r.id)+' · 防守明细'}><dl className="assessment-tip-key-metrics"><div><dt>本点可用兵力</dt><dd>{number(r.available)}</dd></div><div><dt>估算所需留守</dt><dd>{number(r.requiredGarrison)}</dd></div></dl><dl className="assessment-tip-facts"><div><dt>重要性系数</dt><dd>{number(r.importance)}</dd></div><div><dt>计入己方在途</dt><dd>{number(r.friendlyIncoming)}</dd></div><div><dt>已观察敌方在途</dt><dd>{number(r.hostileIncoming)}</dd></div><div><dt>抵达序列缺口</dt><dd>{number(r.arrivalShortfall)}</dd></div><div><dt>最早缺口距观察</dt><dd>{r.earliestDeficitTicks===null?'未检出':number(r.earliestDeficitTicks)+' 天'}</dd></div></dl><h4>支援来源</h4>{r.support.length?<ul className="assessment-tip-support">{r.support.map(s=><li key={s.id}><b>{name(s.id)}</b><span>{number(s.ticks)} 天，可用 {number(s.available)}，计入 {number(s.weighted)}</span></li>)}</ul>:<p>窗口内无可用支援点</p>}{r.unknowns.length>0&&<><h4>未知事项</h4><ul>{r.unknowns.map(u=><li key={u}>{unknown(u)}</li>)}</ul></>}</DetailTip></td></tr>)}</tbody></table></div>:<p className="diagnostic-caption">本次观察没有己方据点评分。</p>}
  <details className="diagnostic-disclosure"><summary>评分口径</summary><p>压力比 = 潜在敌军 / max(估算守备, 1)。加权优先分结合压力比、抵达序列缺口与据点重要性，分值越高越优先处理。</p><p>两处支援依次计入可用兵力的 {number(v.parameters.firstSupportWeight*100)}% 和 {number(v.parameters.secondSupportWeight*100)}%；较晚敌军计入 {number(v.parameters.outerEnemyWeight*100)}%。估算守备包含本点可用兵力、护盾、窗口内己方在途及加权支援。</p></details>
 </section>;
}
