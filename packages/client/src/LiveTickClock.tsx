import React,{useEffect,useRef,useState} from 'react';
import type {TickTimeAnchor} from '../../contracts/src/index.js';
import type {ConsoleRequest} from './AgentConnectionWizard.js';

interface LobbyPhase {status:'waiting'|'starting';secondsRemaining?:number}
export function lobbyCountdownLabel(lobby:LobbyPhase,elapsedMs=0){if(lobby.status==='waiting')return '等待房主开局';const seconds=Math.max(0,Math.ceil((lobby.secondsRemaining??0)-Math.max(0,elapsedMs)/1000));return seconds===0?'等待服务器确认开局':`开局倒计时 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
interface TickPage {lobby?:LobbyPhase;available:boolean;roomId?:string;ended?:boolean;headElapsedMs:number|null;records:TickTimeAnchor[];nextCursor:number;hasMore:boolean}
export function liveTickLabel(anchor:TickTimeAnchor|null,elapsedMs:number|null,ended=false){
 if(!anchor)return 'Tick — · 已过 —';
 if(ended)return `Tick ${anchor.tick} · 对局结束`;
 const elapsed=anchor.kind==='observed'?NaN:elapsedMs??NaN;
 return `Tick ${anchor.tick} · 已过 ${Number.isFinite(elapsed)&&elapsed>=0?(elapsed/1000).toFixed(1)+' 秒':'—'}`;
}

/** The game's persisted tick boundary, independent of selected bot rounds and page load time. */
export function LiveTickClock({id,roomId,connected,request}:{id:string;roomId:string;connected:boolean;request:ConsoleRequest}){
 const [sample,setSample]=useState<{roomId:string;anchor:TickTimeAnchor|null;lobby?:LobbyPhase;ended?:boolean;elapsedMs?:number|null;receivedAt?:number;error:string}|null>(null),[now,setNow]=useState(()=>performance.now());
 const current=connected&&sample?.roomId===roomId?sample:null;
 const ended=current?.ended===true;
 const requestRef=useRef(request);requestRef.current=request;
 useEffect(()=>{
  if(ended)return;
  const timer=setInterval(()=>{if(!document.hidden)setNow(performance.now());},250);
  return()=>clearInterval(timer);
 },[ended]);
 useEffect(()=>{
  if(!connected||!roomId)return;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,loading=false,after=0,anchor:TickTimeAnchor|null=null,supported=true;
  const poll=async()=>{
   if(abort.signal.aborted||loading)return;
   if(document.hidden){timer=setTimeout(()=>void poll(),1000);return;}
   loading=true;
   try{
    let page:TickPage;
    do{
     page=await requestRef.current<TickPage>(`tick-times?seat=${encodeURIComponent(id)}&after=${after}`,undefined,abort.signal);
     if(abort.signal.aborted)return;
     if(!page.available){supported=false;setSample({roomId,anchor:null,error:'此连接未提供 tick 计时'});return;}
     if(page.roomId!==roomId)throw Error('对局已变化，等待同步');
     const latest=page.records.at(-1);if(latest)anchor=latest;
     if(page.hasMore&&page.nextCursor<=after)throw Error('tick 计时游标未推进');
     after=page.nextCursor;
    }while(page.hasMore&&!abort.signal.aborted);
    if(!abort.signal.aborted){const receivedAt=performance.now();setSample({roomId,anchor,...(page.lobby?{lobby:page.lobby}:{}),ended:page.ended===true,elapsedMs:page.headElapsedMs,receivedAt,error:''});setNow(receivedAt);}
   }catch(e){if(!abort.signal.aborted)setSample({roomId,anchor:null,error:e instanceof Error?e.message:'tick 计时读取失败'});}
   finally{loading=false;if(!abort.signal.aborted&&supported)timer=setTimeout(()=>void poll(),500);}
  };
  const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};
  document.addEventListener('visibilitychange',visible);void poll();
  return()=>{abort.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
 },[id,roomId,connected]);
 const elapsed=current?.elapsedMs==null?null:current.elapsedMs+Math.max(0,now-(current.receivedAt??now));
 return <span className="live-current-state" title={current?.error||(ended?'对局已结束，计时停止':current?.anchor?.kind==='observed'?'此 tick 的完整起点未记录':'服务器记录的本 tick 现实时间，包含等待和暂停')}>{current?.lobby?lobbyCountdownLabel(current.lobby,now-(current.receivedAt??now)):liveTickLabel(current?.anchor??null,elapsed,ended)}</span>;
}
