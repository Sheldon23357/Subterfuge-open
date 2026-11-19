import React from 'react';
import {ArrowRight,ChevronDown,Users} from 'lucide-react';
import {ENDED_ROOM_LIMIT} from '../../contracts/src/index.js';
import type {HubRoomSummary} from '../../contracts/src/index.js';
export function splitHallRooms(rooms:HubRoomSummary[]){return {
 active:rooms.filter(r=>r.status!=='ended'&&r.status!=='cancelled'),
 ended:rooms.filter(r=>r.status==='ended').sort((a,b)=>(b.endedAt??0)-(a.endedAt??0)||b.createdAt-a.createdAt||b.code.localeCompare(a.code)).slice(0,ENDED_ROOM_LIMIT),
};}
export function HallRoomList({rooms,busy,joining,returning,enter}:{rooms:HubRoomSummary[];busy:boolean;joining:string|null;returning:(code:string)=>boolean;enter:(code:string)=>void}){
 return <div className="hall-room-list">{rooms.map((room,index)=>{
  const mine=returning(room.code),unavailable=room.status==='recovering'||room.status==='unavailable';
  const state={waiting:'等待集结',starting:'开局倒计时','in-progress':'对局进行中',ended:'已结束',cancelled:'已关闭',recovering:'正在恢复',unavailable:'恢复失败'}[room.status];
  const label=unavailable?state:joining===room.code?'连接中…':mine?'进入':room.status==='ended'?'已结束':room.status!=='waiting'?'已开始':room.players>=room.capacity?'已满员':'加入';
  return <article key={room.code} className="hall-room"><div className="hall-room-number">{String(index+1).padStart(2,'0')}</div><div className="hall-room-name"><h3>{room.name}</h3><span>{state}{room.timing&&(room.timing.mode==='turn-based'?' · 回合':` · 实时 ${room.timing.tickSeconds} 秒/tick`)}</span></div><span className="hall-occupancy">{!unavailable&&<><Users size={16}/>{room.players}<small>/ {room.capacity}</small></>}</span><button className="hall-quiet" disabled={busy||unavailable||!mine&&(room.status!=='waiting'||room.players>=room.capacity)} onClick={()=>enter(room.code)}>{label}<ArrowRight size={16}/></button></article>;
 })}</div>;
}
export function EndedHallRooms(props:React.ComponentProps<typeof HallRoomList>){
 if(!props.rooms.length)return null;
 return <details className="hall-ended"><summary>已结束对局 <small>{props.rooms.length}</small><ChevronDown size={16}/></summary><HallRoomList {...props}/></details>;
}
