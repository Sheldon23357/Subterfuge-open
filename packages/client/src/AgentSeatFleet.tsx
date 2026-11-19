import React from 'react';
import {liveSeatPhase} from './live-seat-phase.js';
import {consoleSeatColor,consoleSeatName as seatName,type ConsoleSeat} from './agent-console-state.js';

/** The same seat switcher remains available throughout the console. */
export function AgentSeatFleet({seat,seats,connected,onSelect}:{seat:ConsoleSeat;seats:ConsoleSeat[];connected:boolean;onSelect:(id:string)=>void}){
 return <div className="live-fleet" aria-label="全部 bot 运行状态" style={{'--fleet-columns':Math.max(1,seats.length)} as React.CSSProperties}>{seats.map(s=>{
  const available=connected&&s.bound!==false&&s.enabled&&!s.stopping&&!s.error&&s.status!=='ended';
  const aiOn=available&&!!s.telemetry?.background?.active,programOn=available&&s.busy;
  const phase=liveSeatPhase(s,connected);
  const compactPhase=({'校验与执行':'复核执行','整理本轮材料':'整理材料','同步授权事实':'事实同步','AI 指导处理中':'引擎处理','AI 任务待调度':'等待调度'} as Record<string,string>)[phase]??phase;
  const engines=`AI引擎${aiOn?'运转中':'待命'} · 程序前台${programOn?'运转中':'待命'}`;
  return <button key={s.id} type="button" style={{'--seat-color':consoleSeatColor(s)} as React.CSSProperties} title={`${seatName(s)} · ${s.model??''} · ${phase} · ${engines} · ${s.calls.toLocaleString()} 次调用`} aria-label={`${seatName(s)} ${phase} · ${engines}`} aria-pressed={s.id===seat.id} className={'live-bot'+(aiOn||programOn?' is-running':'')+(s.error?' is-error':'')} onClick={()=>onSelect(s.id)}>
   <svg viewBox="0 0 72 36" className="live-bot-engines" aria-hidden="true">{[{kind:'ai',on:aiOn,color:'#b493ff'},{kind:'program',on:programOn,color:'#55bfff'}].map((engine,i)=><g key={engine.kind} data-engine={engine.kind} data-active={engine.on} transform={`translate(${i*36} 0)`} style={{color:engine.color,opacity:engine.on?1:.38}}>
    <circle cx="18" cy="18" r="13" fill="none" stroke="currentColor" strokeOpacity=".25"/>
    <g className={engine.on?'live-orbit':''} style={{transformOrigin:'18px 18px'}}><path d="M18 5a13 13 0 0 1 13 13M18 31A13 13 0 0 1 5 18" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="18" cy="5" r="2" fill="currentColor"/></g>
    <circle cx="18" cy="18" r="3" fill="currentColor" className={engine.on?'live-core-pulse':undefined}/>
   </g>)}</svg>
   <span><b style={{color:consoleSeatColor(s)}}>{seatName(s)}</b><small>{compactPhase}</small>{s.bound!==false&&<small className="live-bot-model" title={s.model}>{s.model??'未选择模型'}</small>}</span>
  </button>;
 })}</div>;
}
