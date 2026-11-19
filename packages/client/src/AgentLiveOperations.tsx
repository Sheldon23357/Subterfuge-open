import {mergeSearchNetwork,type SearchNetworkFrame} from './live-search-network.js';
import {NeuralSearchSurface} from './NeuralSearchBackdrop.js';
import {AgentPlanInstructions} from './AgentPlanInstructions.js';
import {LiveTickClock} from './LiveTickClock.js';
import React,{useEffect,useId,useRef,useState} from 'react';
import type {BotLiveSnapshot,BotSearchProgress} from '../../contracts/src/index.js';
import type {ConsoleSeat} from './agent-console-state.js';
import {diagnosticViewKey,consoleShowsStart} from './agent-console-state.js';
import {LiveSeatCache} from './live-seat-cache.js';
import {liveSeatPhase} from './live-seat-phase.js';
import {AgentSeatFleet} from './AgentSeatFleet.js';
import {AgentConsoleStart} from './AgentConsoleStart.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';

import {LivePipeline,GuidanceGraphic,ProtocolGraphic,SearchNetwork,PlanGraphic,liveColors as colors,liveNumber as num,liveKinds as kinds} from './AgentLiveGraphics.js';
export {LivePipeline} from './AgentLiveGraphics.js';
const stages:Record<string,string>={discovery:'候选发现',refinement:'兵力细化',combination:'组合搜索',continuation:'补充搜索',stress:'对手反应测试'};
interface LiveView {data:BotLiveSnapshot|null;error:string;updated:number|null;calls:Record<string,number|null>|null}
const emptyView:LiveView={data:null,error:'',updated:null,calls:null};
export function liveEngineCounts(seats:ConsoleSeat[],connected:boolean){
 const bound=seats.filter(s=>s.bound!==false);
 const available=bound.filter(s=>connected&&s.enabled&&!s.starting&&!s.stopping&&!s.error&&!['ended','error'].includes(s.status));
 return {total:bound.length,ai:available.filter(s=>(s.telemetry?.background.active??0)>0||s.telemetry?.phase==='model').length,
  search:available.filter(s=>s.busy).length};
}
export {liveSeatPhase} from './live-seat-phase.js';
function PaintRate(){
 const output=useRef<HTMLSpanElement>(null);
 useEffect(()=>{let frame=0,frames=0,start=performance.now();const paint=(now:number)=>{if(document.hidden){frames=0;start=now;}else{frames++;if(now-start>=1000){if(output.current)output.current.textContent=`${Math.round(frames*1000/(now-start))} FPS`;start=now;frames=0;}}frame=requestAnimationFrame(paint);};frame=requestAnimationFrame(paint);return()=>cancelAnimationFrame(frame);},[]);
 return <span ref={output} title="浏览器实际绘制回调频率；数据独立刷新">— FPS</span>;
}
export function AgentLiveOperations({seat,seats,connected,request,onSelect,start}:{seat:ConsoleSeat;seats:ConsoleSeat[];connected:boolean;request:ConsoleRequest;onSelect:(id:string)=>void;start?:Omit<React.ComponentProps<typeof AgentConsoleStart>,'bound'|'connected'>}){
 const cache=useRef(new LiveSeatCache<LiveView>()),[,refreshView]=useState(0);
 const callScope=diagnosticViewKey(seat,'live');
 for(const s of seats)cache.current.read(s.id,diagnosticViewKey(s,'live'));
 const view=cache.current.read(seat.id,callScope)??emptyView;
 const {data,error,updated}=view;
 const updateView=(target:ConsoleSeat,change:(old:LiveView)=>LiveView)=>{
  const scope=diagnosticViewKey(target,'live');
  const next=change(cache.current.peek(target.id,scope)??emptyView);
  if(cache.current.write(target.id,scope,next))refreshView(n=>n+1);
 };
 const requestRef=useRef(request);requestRef.current=request;
 const bindingsScope=JSON.stringify(seats.filter(s=>s.bound!==false).map(s=>diagnosticViewKey(s,'live')));
 useEffect(()=>{
  if(!connected)return;
  const abort=new AbortController(),pending=seats.filter(s=>s.bound!==false&&s.id!==seat.id&&!cache.current.peek(s.id,diagnosticViewKey(s,'live'))?.data);
  const warm=async()=>{for(let target=pending.shift();target&&!abort.signal.aborted;target=pending.shift()){
   try{const next=await requestRef.current<BotLiveSnapshot>(`debug/live?seat=${encodeURIComponent(target.id)}`,undefined,abort.signal);
    if(!abort.signal.aborted&&(!target.diagnosticGeneration||next.generation===target.diagnosticGeneration))updateView(target,old=>old.data?old:{...old,data:next,updated:Date.now()});
   }catch{if(abort.signal.aborted)return;}
  }};
  void warm();void warm();return()=>abort.abort();
 },[bindingsScope,connected]);
 useEffect(()=>{
  if(seat.bound===false||!connected)return;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let loading=false;
  const poll=async()=>{if(abort.signal.aborted||loading)return;if(document.hidden){timer=setTimeout(()=>void poll(),1500);return;}loading=true;
   try{const next=await requestRef.current<BotLiveSnapshot>(`debug/live?seat=${encodeURIComponent(seat.id)}`,undefined,abort.signal);if(!abort.signal.aborted){if(seat.diagnosticGeneration&&next.generation!==seat.diagnosticGeneration)throw Error('席位绑定已变化，等待同步');updateView(seat,old=>({...old,data:JSON.stringify(old.data)===JSON.stringify(next)?old.data:next,updated:Date.now(),error:''}));}}
   catch(e){if(!abort.signal.aborted)updateView(seat,old=>({...old,error:e instanceof Error?e.message:'运行数据读取失败'}));}
   finally{loading=false;if(!abort.signal.aborted)timer=setTimeout(()=>void poll(),500);}
  };
  const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};document.addEventListener('visibilitychange',visible);void poll();
  return()=>{abort.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[callScope,seat.bound,connected]);
 const valid=!!data&&data.generation===seat.diagnosticGeneration||!!data&&!seat.diagnosticGeneration;
 const current=valid?data:null,healthy=connected&&!error,active=healthy&&seat.enabled&&seat.busy&&!seat.stopping&&!seat.error;
 const telemetry=seat.telemetry,searching=active&&telemetry?.phase==='local'&&telemetry.search?.sequence===telemetry.round;
 const progress=searching?telemetry?.search?.progress:undefined;
 const decision=current?.decision,coverage=progress??decision?.coverage;
 const networkRef=useRef(new LiveSeatCache<SearchNetworkFrame>());
 const network=mergeSearchNetwork(networkRef.current.read(seat.id,callScope),callScope,progress&&telemetry?.search?telemetry.search:undefined,decision,!!searching);networkRef.current.write(seat.id,callScope,network);
 const branches=network.branches;
 const modelActive=healthy&&seat.enabled&&(!!telemetry?.background?.active||telemetry?.phase==='model');
 const executing=active&&telemetry?.phase==='tool';
 const maximum=progress?.maximum??decision?.parameters.maxSimulations,horizon=progress?.horizon??decision?.parameters.horizonTicks;
 const stage=progress?.stage??(searching?'战术搜索':liveSeatPhase(seat,healthy));
 const names=current?.names??{};
 const pipelineProps={active,searchActive:!!searching,modelActive,executing,phase:stage,planningSync:telemetry?.foreground==='planning-sync',hasDirective:!!current?.directive,hasDecision:!!decision,enabled:healthy&&seat.enabled&&!seat.stopping&&!seat.error,tasks:current?.tasks??[],backgroundQueued:telemetry?.background?.queued??0,programTool:telemetry?.tool??null,hasReceipts:!!current?.operations.some(o=>['accepted','underway','completed'].includes(o.status))};
 const strategyTip=useId();
 const engines=liveEngineCounts(seats,connected);
 const tickSeat=seats.find(s=>s.bound!==false&&s.roomId===seat.roomId)??seat;
 if(start&&consoleShowsStart(seat,current))return <div className="live-operations is-start"><header className="live-header"><span><i className="live-indicator"/>尚未开始运行</span><span>{seat.bound===false?'未绑定游戏':'席位已暂停'}</span></header><AgentSeatFleet seat={seat} seats={seats} connected={connected} onSelect={onSelect}/><AgentConsoleStart {...start} bound={seat.bound!==false} connected={connected}/></div>;
 return <div className={'live-operations'+(!healthy?' is-offline':'')}>
  <header className="live-header"><span className="live-engine-counts"><span data-engine="ai" style={{color:colors[1]}}><i className="live-indicator" data-active={engines.ai>0}/>AI引擎 {engines.ai}/{engines.total}</span><span data-engine="search" style={{color:colors[0]}}><i className="live-indicator" data-active={engines.search>0}/>搜索网络 {engines.search}/{engines.total}</span></span><LiveTickClock id={tickSeat.id} roomId={seat.roomId} connected={connected&&seat.bound!==false} request={request}/><span className="live-refresh"><PaintRate/><i/>{updated?'500 ms':'同步中'}</span></header>
  <AgentSeatFleet seat={seat} seats={seats} connected={connected} onSelect={onSelect}/>
  {current?.strategyDetails!=null&&<section className="live-module"><h3>策略状态</h3><pre>{JSON.stringify(current.strategyDetails,null,2)}</pre></section>}
  <div className="live-board">
   <div className="live-left-stack">
    <section data-active={modelActive} className="live-module live-guidance"><div className="live-panel-heading"><h3>AI引擎</h3></div><LivePipeline {...pipelineProps} lane="ai"/><GuidanceGraphic data={current} active={modelActive} calls={view.calls}/><div className="live-strategy-summary" tabIndex={current?.directive?.summary?0:undefined} aria-describedby={current?.directive?.summary?strategyTip:undefined}><p className="live-glance">{current?.directive?.summary||'—'}</p>{current?.directive?.summary&&<aside id={strategyTip} role="tooltip" className="live-strategy-tooltip">{current.directive.summary}</aside>}</div></section>
    <section data-active={executing||modelActive} className="live-module live-protocol"><div className="live-panel-heading"><h3>协议与约束</h3><span>{executing?'校验中':''}</span></div><ProtocolGraphic data={current} active={executing||modelActive}/></section>
   </div>
   <NeuralSearchSurface active={!!searching}><div className="live-panel-heading"><h3>搜索网络</h3><span title="条件搜索结果，不代表实际战果">{progress?stages[progress.stage]??progress.stage:network.sequence>=0?`R${network.sequence} · D${network.observedTick??'—'}`:'—'}</span></div><LivePipeline {...pipelineProps} lane="program"/><SearchNetwork embedded key={network.scope+':'+network.sequence} branches={branches} selected={network.selected} names={names} active={!!searching} stage={progress?stages[progress.stage]??progress.stage:network.settled?'':network.sequence>=0?'等待结果':'等待'}/><div className="live-stage-counts">{Object.entries(stages).map(([key,title],i)=><div key={key} title={title} className={progress?.stage===key?'is-current':''} style={{color:colors[i]}}><svg viewBox="0 0 36 12" aria-hidden="true"><path d="M0 6H36" stroke="currentColor" strokeOpacity=".2"/><path d="M0 6H36" stroke="currentColor" strokeDasharray={`${Math.min(36,(coverage?.stages?.[key]??0)/Math.max(1,coverage?.simulations??1)*36)} 36`}/></svg><span>{title}</span><b>{num(coverage?.stages?.[key])}</b></div>)}</div></NeuralSearchSurface>
   <section data-active={executing} className="live-module live-plan"><div className="live-panel-heading"><h3>方案与执行</h3><span>{decision?`R${decision.sequence} · ${decision.finalized?'已选':'待复核'}`:'—'}</span></div><PlanGraphic data={current} active={executing}/><AgentPlanInstructions id={seat.id} generation={seat.diagnosticGeneration} scope={callScope} connected={healthy&&seat.bound!==false} enabled={seat.enabled} request={request} onCalls={calls=>updateView(seat,old=>JSON.stringify(old.calls)===JSON.stringify(calls)?old:{...old,calls})}/></section>
  </div>
  <footer className="live-instruments">{[
   {title:'候选',value:coverage?.generated,color:colors[0]!},
   {title:'评估',value:coverage?.evaluated,color:colors[2]!,hint:'包含维持基线'},
   {title:'模拟',value:coverage?.simulations,color:colors[3]!,suffix:maximum?`/${maximum}`:''},
   {title:'Token',value:seat.tokens,color:colors[1]!},
   {title:'调用',value:seat.calls,color:colors[4]!},
  ].map(m=><div key={m.title} title={m.hint} style={{color:m.color}}><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l12 12-12 12L2 14Z" fill="none" stroke="currentColor" strokeOpacity=".35"/><path d="M14 8l6 6-6 6-6-6Z" fill="currentColor" fillOpacity=".16" stroke="currentColor"/></svg><span>{m.title}</span><strong>{num(m.value)}<small>{m.suffix}</small></strong></div>)}<div className="live-budgets"><span title="条件推演窗口">窗口 <b>{num(horizon)}d</b></span><span title="每轮搜索时间预算">预算 <b>{num(progress?.timeLimitMs??decision?.parameters.maxElapsedMs)}ms</b></span><span title="当前待处理触发数量">唤醒 <b>{num(telemetry?.pendingSignals)}</b></span></div></footer>
  {(!healthy||seat.error)&&<p className="live-warning" role="alert">{seat.error||error||'连接中断'}{current?' · 上次数据':''}</p>}
 </div>;
}
