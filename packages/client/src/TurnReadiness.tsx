import React,{useEffect,useState} from 'react';
import type {TurnStatus} from '../../contracts/src/index.js';
import type {PlayerConnection} from './player-connection.js';
export function TurnReadiness({connection,currentTick,disabled=false}:{connection:PlayerConnection;currentTick:number;disabled?:boolean}){
 const [state,setState]=useState<TurnStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();let running=false;const poll=async()=>{if(running)return;running=true;try{const next=await connection.request<TurnStatus>('/lobby/v2/turn',undefined,abort.signal);if(!abort.signal.aborted)setState(next);}catch{}finally{running=false;}};void poll();const timer=setInterval(()=>void poll(),1000);return()=>{abort.abort();clearInterval(timer);};},[connection]);
 const own=state?.players.find(p=>p.player===state.self);
 return <span className="player-turn-ready"><span>{state?`Tick ${state.tick} · ${state.players.filter(p=>p.ready).length}/${state.players.length} 已就绪`:'读取回合…'}</span><button disabled={disabled||busy||!own||own.automated||state?.tick!==currentTick} onClick={async()=>{if(!state||!own||state.tick!==currentTick)return;setBusy(true);setError('');try{setState(await connection.request<TurnStatus>('/lobby/v2/turn',{tick:state.tick,ready:!own.ready}));}catch(e){setError(e instanceof Error?e.message:'就绪失败');}finally{setBusy(false);}}}>{own?.automated?'由 AI 就绪':own?.ready?'取消就绪':'本回合就绪'}</button>{error&&<span role="alert">{error}</span>}</span>;
}
