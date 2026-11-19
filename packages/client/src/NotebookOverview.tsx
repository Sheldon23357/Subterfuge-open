import {notebookReadableText as notebookDisplayText} from './notebook-display.js';
import React from 'react';
import {DetailTip} from './DetailTip.js';

export interface AttackScreeningNotebookData {
 basisRevision:number;observedTick:number;current:boolean;
 ranked:{target:string;name:string;owner:number|null;type:string;score:number;confidence:number;assessment:string;selection:string;tags:string[];reasons:string[];attackMargin:number;additionalForceEstimate:number;components:Record<string,number|null>;valueBreakdown:{base:number;mineInvestment:number;total:number};timing:{attackTicks:number}}[];
 excluded:{target:string;reason:string}[];
}
const attackAssessments:Record<string,string>={'potential-force-advantage':'初筛兵力占优','needs-more-force':'需补充兵力','ownership-may-change-before-arrival':'抵达前归属可能变化'};
const attackTags:Record<string,string>={'leading-opponent':'领先对手',reconnaissance:'防守数据不全'};
const attackReasons:Record<string,string>={'no-uncommitted-source-within-time-window':'时间窗口内没有未预留的可用出兵点'};
const attackOwner=(owner:number|null)=>owner===null?'中立':`席位 ${owner+1}`;
export function AttackScreeningNotebook({value,names={}}:{value:AttackScreeningNotebookData;names?:Record<string,string>}){
 const format=(v:number)=>v.toLocaleString('zh-CN',{maximumFractionDigits:2});
 return <section className="decision-panel assessment-panel" aria-label="据点进攻评分判断">
  <div className="section-heading"><h3>据点进攻初筛</h3><span className={'diagnostic-badge'+(value.current?'':' is-stale')}>{value.current?'对应当前观察':'历史评分，局势已变化'}</span></div>
  <p className="diagnostic-caption">第 {value.observedTick} 天</p>
  {!value.ranked.length?<p className="diagnostic-caption">暂无可评分目标</p>:<div className="diagnostic-table assessment-table"><table><thead><tr><th scope="col">据点</th><th scope="col" className="number">初筛评分</th><th scope="col">初筛判断</th><th scope="col" className="number">预计抵达（天）</th><th scope="col" className="number">兵力差</th><th scope="col">依据</th></tr></thead><tbody>{value.ranked.map((item,index)=><tr key={item.target}>
   <th scope="row">{names[item.target]??item.name}<small>#{index+1} · {attackOwner(item.owner)}</small></th>
   <td className="number">{format(item.score)}</td><td>{attackAssessments[item.assessment]??item.assessment}</td><td className="number">{format(item.timing.attackTicks)}</td><td className="number">{item.attackMargin>0?'+':''}{format(item.attackMargin)}</td>
   <td><DetailTip label={(names[item.target]??item.name)+' · 进攻明细'}><dl className="assessment-tip-key-metrics"><div><dt>补充兵力估算</dt><dd>{format(item.additionalForceEstimate)}<small>兵</small></dd></div></dl>{!!item.tags.length&&<div className="assessment-tip-tags">{item.tags.map(tag=><span className="assessment-tip-tag" key={tag}>{attackTags[tag]??tag}</span>)}</div>}{!!item.reasons.length&&<><h4>初筛依据</h4><ul>{item.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul></>}</DetailTip></td>
  </tr>)}</tbody></table></div>}
  {!!value.excluded.length&&<details className="diagnostic-disclosure"><summary>未列入评分 <span>{value.excluded.length} 处</span></summary><ul>{value.excluded.map(item=><li key={item.target}>{names[item.target]??item.target}：{attackReasons[item.reason]??item.reason}</li>)}</ul></details>}
 </section>;
}

export interface NotebookOverviewData {
 commanderDirectives?:{version:number;text:string};
 memory:{strategy:string;relations?:string;agreements?:string;deceptions?:string};
 capacity?:{characters:number;entries:number;characterLimit:number;entryLimit:number;strategyCharacters:number;strategyLimit:number}|null;
 roundMaterials?:{status:'none'|'unavailable'|'active';id?:string;characters?:number;reads?:number;protected?:number;entries?:{id:string;tool:string;releasable:boolean;characters:number}[]};
 relations?:{id:string;text:string;record?:{type:string;status:string;summary:string;players:number[];scores?:{trust:number|null;hostility:number|null;threat:number|null;cooperation:number|null;confidence:number}}}[];
}
function MemoryCard({title,text,empty,hint}:{title:string;text:string;empty?:string;hint?:string|undefined}){
 return <details className="notebook-memory-card"><summary><b>{title}</b><span className="note-card-preview">{text||empty}</span><span className="note-card-action">查看全文</span></summary><p className={text?'note-body':'muted'}>{text||empty}</p>{hint&&<small>{hint}</small>}</details>;
}

export function NotebookOverview({value,names={},mode='hybrid',showStrategy=true}:{value:NotebookOverviewData;names?:Record<string,string>;mode?:'hybrid';showStrategy?:boolean}){
 const display=(v:string)=>notebookDisplayText(v,names);
 const capacity=value.capacity;
 return <div className="notebook-overview">
  <div className="notebook-memory-grid">
  {(value.commanderDirectives?.text)&&<MemoryCard title="指挥官指令" text={display(value.commanderDirectives?.text??'')} empty="暂无已确认的指挥官指令"/>}
  {showStrategy&&(value.memory.strategy)&&<MemoryCard title="总体战略" text={display(value.memory.strategy)} empty="暂无已保存的总体战略" hint={capacity?`${capacity.strategyCharacters} / ${capacity.strategyLimit} 字符`:undefined}/>}
  </div>
  {<details className="diagnostic-disclosure notebook-storage"><summary>上下文与存储 <span>{capacity?`${capacity.entries} / ${capacity.entryLimit} 条笔记 · ${capacity.characters.toLocaleString()} / ${capacity.characterLimit.toLocaleString()} 字符`:'容量未核实'}</span></summary><div className="notebook-storage-grid">
  <section className="notebook-memory-card" aria-label="有效笔记容量">
   <b>有效笔记容量</b>
   {capacity?<p>{capacity.characters} / {capacity.characterLimit} 字符 · {capacity.entries} / {capacity.entryLimit} 条</p>:<p className="muted">尚无当前局势，容量未核实</p>}
   <small>正文全文提供给 AI；超限先淘汰最低等级中正文最早的笔记。仅改等级不刷新正文时间。</small>
  </section>
  <section className="notebook-memory-card round-materials" aria-label="同轮工作资料">
   <b>同轮工作资料</b>
   {value.roundMaterials?.status==='active'?<><p>{value.roundMaterials.protected} 项受保护回执</p><p>回执存储字符：{value.roundMaterials.characters}</p><details><summary>查看保留项目</summary><ul>{value.roundMaterials.entries?.map(r=><li key={r.id}>{r.tool} · {r.characters} 字符<small> · {r.id}</small></li>)}</ul></details></>:<p className="muted">{value.roundMaterials?.status==='none'?'当前没有待续接的整轮资料':'尚未核实当前整轮资料'}</p>}
  </section>
  </div></details>}
 </div>;
}
