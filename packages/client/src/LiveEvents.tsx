import {tickTime} from './time.js';
import React,{useEffect,useRef,useState} from 'react';
import {Radio,ChevronDown,ChevronUp} from 'lucide-react';
import type {PlayerActivityEvent} from '../../contracts/src/index.js';
import {colors,playerNames} from './theme.js';
import {ChatMessageText} from './ChatMessageText.js';
import './live-events.css';
import {activityText} from './live-event-text.js';

const stamp=(tick:number,seconds:number)=>tickTime(Number((tick+seconds/600).toFixed(1)));
export function LiveEvents({events,scope,tick,seconds,name}:{events:PlayerActivityEvent[];scope:string;tick:number;seconds:number;name:(id:string)=>string}){
  const [collapsed,setCollapsed]=useState(false);
  const list=useRef<HTMLOListElement>(null);
  const latest=events.at(-1)?.id;
  useEffect(()=>{if(list.current)list.current.scrollTop=0;},[scope,latest]);
  return <aside className={`live-events${collapsed?' is-collapsed':''}`} aria-label="实时事件播报">
    <header><span><Radio size={13}/><b>实时播报</b><small>{stamp(tick,seconds)}</small></span><button type="button" onClick={()=>setCollapsed(v=>!v)} aria-expanded={!collapsed} aria-label={collapsed?'展开实时播报':'收起实时播报'}>{collapsed?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</button></header>
    {!collapsed&&<ol ref={list} role="log" aria-live="polite" aria-relevant="additions" aria-label="最新10条可知事件">
      {!events.length&&<li className="live-events-empty">暂无视野内的新事件</li>}
      {events.slice(-10).reverse().map(event=><li key={`${scope}-${event.id}`}>
        <time style={{color:event.actor===null?undefined:colors[event.actor]}}>{stamp(event.tick,event.seconds)}</time>
        <p><span style={{color:event.actor===null?undefined:colors[event.actor]}}>{event.actor===null?'中立':playerNames[event.actor]??`玩家 ${event.actor+1}`}</span> · <ChatMessageText text={activityText(event,name)}/></p>
      </li>)}
    </ol>}
  </aside>;
}
