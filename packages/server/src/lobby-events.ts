import {lifecycleNotices} from '../../engine/src/index.js';
import type {WaitingLobby} from './waiting-lobby.js';
import type {StoredLobbyStart} from './lobby-start.js';
import type {LobbyRuntime} from './lobby-runtime.js';

export interface LobbyEvent {
 id:number;kind:'joined'|'left'|'cancelled'|'starting'|'started'|'ended';
 actorLobbySeat:number|null;atMs:number|null;seatsAvailable:number|null;
 priority:'normal'|'urgent';notify:boolean;text:string;basis:'original-handler'|'local-service';
}
/** Derived from committed immutable history, never request attempts or polling.
 * Cursor positions belong to the original credential's lobby seat, including
 * after compacting game seats. No command IDs, tokens, maps or seed are exposed.
 */
export function projectLobbyEvents(current:{lobby:WaitingLobby;start?:StoredLobbyStart;runtime?:LobbyRuntime},player:number):LobbyEvent[]{
 const {lobby,start,runtime}=current;
 if(!Number.isInteger(player)||player<0||player>=lobby.seats.length)throw Error('Invalid lobby viewer');
 const events:LobbyEvent[]=[];let occupied=0;
 const add=(event:Omit<LobbyEvent,'id'>)=>events.push({id:events.length,...event});
 for(const command of lobby.commands){
  if(command.kind==='cancel'){
   add({kind:'cancelled',actorLobbySeat:command.player,atMs:null,seatsAvailable:null,priority:'normal',notify:false,text:'房主已取消房间',basis:'local-service'});continue;
  }
  occupied+=command.kind==='join'?1:-1;
  const original=lifecycleNotices(command.kind,lobby.seats.length,occupied,command.player).find((n:{player:number})=>n.player===player);
  if(!original)continue;
  const seatsAvailable=lobby.seats.length-occupied,actor=player===command.player?'你':`玩家 ${command.player+1}`;
  add({kind:command.kind==='join'?'joined':'left',actorLobbySeat:command.player,atMs:null,seatsAvailable,
   priority:original.priority===1?'urgent':'normal',notify:original.notify,text:`${actor}${command.kind==='join'?'加入':'离开'}了房间，剩余 ${seatsAvailable} 个席位`,basis:'original-handler'});
 }
 const gameSeat=start?.prepared.seatMapping.find(s=>s.lobbySeat===player)?.gameSeat;
 if(start&&gameSeat!==undefined){
  const count=start.prepared.seatMapping.length;
  const starting=lifecycleNotices('starting',count,count,0,start.prepared.secondsUntilGameInProgress).find((n:{player:number})=>n.player===gameSeat);
  if(starting)add({kind:'starting',actorLobbySeat:null,atMs:start.startedAtMs,seatsAvailable:0,priority:starting.priority===1?'urgent':'normal',notify:starting.notify,text:'开局倒计时已开始',basis:'original-handler'});
  if(runtime&&runtime.status!=='starting'){
   const started=lifecycleNotices('started',count,count,0).find((n:{player:number})=>n.player===gameSeat);
   if(started)add({kind:'started',actorLobbySeat:null,atMs:start.startedAtMs+start.prepared.secondsUntilGameInProgress*1000,seatsAvailable:0,priority:started.priority===1?'urgent':'normal',notify:started.notify,text:'对局已开始',basis:'original-handler'});
   if(runtime.status==='ended')add({kind:'ended',actorLobbySeat:null,atMs:null,seatsAvailable:null,priority:'normal',notify:false,text:'对局已结束，可查看结算',basis:'local-service'});
  }
 }
 return events;
}
