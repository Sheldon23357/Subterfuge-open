import React from 'react';
import {hybridTacticLabel,type HybridSummaryData} from './HybridSummary.js';
import {hybridInstructionRows} from './hybrid-instructions.js';
import {notebookReadableText} from './notebook-display.js';
import {ServerAgreements} from './ServerAgreements.js';
import {playerNames} from './theme.js';
import {MemoryFields} from './NotebookMemory.js';

export function notebookCurrentAgreements(value:HybridSummaryData['diplomacy']){
 return value?.agreements.filter(a=>a.status==='active'||a.status==='proposed');
}

export function NotebookIntentCards({value,names}:{value:HybridSummaryData|undefined;names:Record<string,string>}){
 if(!value)return <p className="notebook-empty">作战意图数据未核实</p>;
 const rows=hybridInstructionRows(value),display=(text:string)=>notebookReadableText(text,names);
 if(!rows.length)return <p className="notebook-empty">{value.guidance?'当前没有额外作战意图或约束':'当前观察不可用，生效情况待核实'}</p>;
 return <>{rows.map(row=>{
  const kind=({protected:'保护来源',reserve:'最低留守',joint:'联合进攻','avoid-player':'禁攻玩家'} as Record<string,string>)[row.kind]??hybridTacticLabel(row.kind,names);
  const target=row.kind==='avoid-player'?playerNames[Number(row.target)]??`玩家 ${Number(row.target)+1}`:display(names[row.target]??row.target)||'全局';
  const reasons=[...new Set((value.state?.intents??[]).filter(t=>(t.id===row.key||t.spec.kind===row.kind&&t.spec.target===row.target)&&!['completed','cancelled','expired'].includes(t.status)&&(!value.guidance||t.spec.until>value.guidance.worldDay)).map(t=>t.spec.reason).filter((reason):reason is string=>!!reason&&reason!==row.reason))];
  return <article className="notebook-card notebook-intent-card" key={row.key} aria-label={`${kind} · ${target}`}>
   <header className="notebook-reader-heading"><h3>{kind} · {target}</h3><span className="notebook-intent-status" data-blocked={row.status==='受阻'}>{row.status}</span></header>
   {row.detail&&<p className="notebook-prose">{display(row.detail)}</p>}
   {!!reasons.length&&<section className="notebook-diplomacy-section"><h4>意图理由</h4><p className="notebook-prose">{display(reasons.join('\n'))}</p></section>}
   {row.reason&&<section className="notebook-diplomacy-section"><h4>原因与执行反馈</h4><p className="notebook-prose">{display(row.reason)}</p></section>}
   <p className="notebook-source">{row.sources.join('、')}{row.until!==undefined?` · 截止第 ${row.until} 世界日`:''}</p>
  </article>;
 })}</>;
}

export function NotebookAgreementCards({value,names}:{value:HybridSummaryData['diplomacy'];names:Record<string,string>}){
 const agreements=notebookCurrentAgreements(value);
 if(!value||!agreements)return <p className="notebook-empty">当前协议数据未核实</p>;
 return <div className="notebook-agreements"><ServerAgreements value={{...value,agreements,receipts:[]}} names={names}/></div>;
}

export function NotebookSettlementCards({value,names}:{value:HybridSummaryData['diplomacy'];names:Record<string,string>}){
 if(!value)return <p className="notebook-empty">协议结算与关系资料未核实</p>;
 return <><div className="notebook-agreements"><ServerAgreements value={value} names={names} historyExpanded historyOnly/></div>
  <h3 className="notebook-memory-heading">双向关系与累计记录 <small>{value.relations.length}</small></h3>
  {value.relations.map(r=><article className="notebook-card" key={`${r.from}:${r.to}`}><h3>{playerNames[r.from]??`玩家 ${r.from+1}`} → {playerNames[r.to]??`玩家 ${r.to+1}`}</h3><MemoryFields value={{trust:r.trust,history:r.history,borderPressure:r.borderPressure,competitionPressure:r.competitionPressure}} names={names}/><p className="notebook-source">服务器关系结算 · 第 {value.time} tick</p></article>)}
 </>;
}
