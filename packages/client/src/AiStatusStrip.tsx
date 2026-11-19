import React,{useEffect,useState} from 'react';
import {colors,playerNames} from './theme.js';
import './ai-status-strip.css';
import {aiHeaderSummary} from './header-state.js';

export interface SeatStatus {seat:number;enabled:boolean;status:string;error:string|null;recovering?:boolean}
export interface AiMapStatus {seats:SeatStatus[];unavailable:boolean}
const labels:Record<string,string>={thinking:'思考中',waiting:'闲置中',paused:'已暂停',error:'运行异常',ended:'已结束',unconfigured:'未启用',loading:'读取中'};
export function AiStatusStrip({select,onChange,playerCount=0}:{playerCount?:number;select:(seat:number)=>void;onChange?:(status:AiMapStatus)=>void}){
  const [loaded,setLoaded]=useState(false);
  const [seats,setSeats]=useState<SeatStatus[]>([]),[unavailable,setUnavailable]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    async function poll(){
      try{const response=await fetch('/api/ai',{signal:controller.signal});if(!response.ok)throw Error();const data=await response.json();if(!controller.signal.aborted){setSeats(data.seats);setLoaded(true);setUnavailable(false);onChange?.({seats:data.seats,unavailable:false});}}
      catch{if(!controller.signal.aborted){setUnavailable(true);onChange?.({seats:[],unavailable:true});}}
      finally{if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2000);}
    }
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[onChange]);
  const summary=aiHeaderSummary(seats,unavailable,loaded);
  const visibleSeats=playerCount ? Array.from({length:playerCount},(_,seat)=>seats.find(s=>s.seat===seat)??{seat,enabled:false,status:loaded?'unconfigured':'loading',error:null}) : seats;
  const buttons=(compact=false)=>visibleSeats.map(s=>{
    const thinking=!unavailable&&s.enabled&&s.status==='thinking';
    const label=unavailable?'暂不可用':s.recovering?'等待恢复':labels[s.status]??'状态未知';
    const attention=!unavailable&&(s.status==='error'||s.recovering||!!s.error);
    return <button key={s.seat} type="button" className={`ai-status-seat${thinking?' is-thinking':''}${unavailable?' is-unavailable':''}${attention?' needs-attention':''}`} style={{'--ai-seat-color':colors[s.seat]} as React.CSSProperties} title={`${playerNames[s.seat]} · ${label}${s.error?`：${s.error}`:''} · 点击切换到此席位`} aria-label={`${playerNames[s.seat]} AI：${label}，切换控制视野`} onClick={event=>{select(s.seat);const menu=event.currentTarget.closest("details");if(menu){menu.open=false;menu.querySelector("summary")?.focus();}}}><i aria-hidden="true"/>{!compact&&<><span>{playerNames[s.seat]}</span><small>{label}</small></>}</button>;
  });
  return <div className="ai-status-shell">
    <div className="ai-desktop-status" role="group" aria-label="AI实时状态与日志">
      <div className="ai-desktop-seats" title={summary.detail}>{buttons(true)}</div>
    </div>
    <details className="ai-status-menu" onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
      <summary aria-label={`AI 实时状态与日志：${summary.detail}`} title={summary.detail}><span>AI 状态</span><b>{summary.label}</b></summary>
      <div className="ai-status-strip" role="group" aria-label="AI实时状态">
      <p className="ai-status-hint">{!seats.length&&loaded&&!unavailable?'本局尚未配置 AI 席位':'选择席位切换控制视野'}</p>
        {buttons()}
      </div>
    </details>
  </div>;
}
