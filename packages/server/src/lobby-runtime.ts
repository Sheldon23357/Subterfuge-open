import {originalLobbyCountdown,fleetMatchOutcome,type FleetStorageOptions} from '../../engine/src/index.js';
import type {StoredLobbyStart} from './lobby-start.js';
import {saveRoom,restoreRoom,type LabRoom} from './planning.js';
import {startRealtime,catchUpRealtime,tickMilliseconds} from './realtime.js';

export interface LobbyRuntime {
 format:'lobby-runtime/1';status:'starting'|'in-progress'|'ended';
 syncedAtMs:number;secondsRemaining:number;room:LabRoom;
}
function openingTime(start:StoredLobbyStart){
 const delay=start.prepared.secondsUntilGameInProgress;
 const time=start.startedAtMs+delay*1000;
 if(!Number.isSafeInteger(delay)||delay<1||delay>86400||!Number.isSafeInteger(time))throw Error('Invalid lobby opening time');
 return time;
}
export function createLobbyRuntime(start:StoredLobbyStart):LobbyRuntime{
 openingTime(start);
 return{format:'lobby-runtime/1',status:'starting',syncedAtMs:start.startedAtMs,secondsRemaining:start.prepared.secondsUntilGameInProgress,room:restoreRoom(saveRoom(start.prepared.room,{trustedLocalStorage:true}),{trustedLocalStorage:true})};
}
/** Fixed one-second authority cadence, independent of request/poll frequency.
 * Countdown deltas are integers <= 86400, so one bounded original call is
 * numerically identical to the same number of original 1-second calls at x1.
 * Split exactly at opening: the original Starting call must never also advance
 * game ticks. Later elapsed seconds are handled by the running clock.
 */
export async function advanceLobbyRuntime(start:StoredLobbyStart,current:LobbyRuntime,now:number):Promise<LobbyRuntime>{
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid wall time');
 if(current.status==='ended'||current.status==='in-progress'&&current.room.timing?.mode==='turn-based')return current;
 const syncedAtMs=Math.max(current.syncedAtMs,start.startedAtMs+Math.floor((now-start.startedAtMs)/1000)*1000);
 if(syncedAtMs===current.syncedAtMs)return current;
 const opening=openingTime(start);let room=current.room;let status:LobbyRuntime['status']=current.status;let secondsRemaining=current.secondsRemaining;
 if(status==='starting'){
  const state={status:2,secondsSinceCreation:(current.syncedAtMs-start.startedAtMs)/1000,secondsSinceStarting:(current.syncedAtMs-start.startedAtMs)/1000,timeFactor:1,secondsUntilGameInProgress:secondsRemaining,listener:{handleGameStarted:()=>{}}};
  originalLobbyCountdown(state,(Math.min(syncedAtMs,opening)-current.syncedAtMs)/1000);
  secondsRemaining=state.secondsUntilGameInProgress;
  if(state.status===3){status='in-progress';if(room.timing?.mode!=='turn-based')room=startRealtime(room,opening);}
 }
 if(status!=='starting'&&room.timing?.mode!=='turn-based'){
  room=await catchUpRealtime(room,syncedAtMs);
  status=fleetMatchOutcome(room.state)?'ended':'in-progress';
 }
 if(status!=='starting'&&fleetMatchOutcome(room.state))status='ended';
 return{format:'lobby-runtime/1',status,syncedAtMs,secondsRemaining,room};
}
export function saveLobbyRuntime(runtime:LobbyRuntime,verifiedRoom?:RuntimeReadOptions['verifiedRoom']){
 const payload=verifiedRoom?.room===runtime.room&&Object.isFrozen(runtime.room)?verifiedRoom.payload:saveRoom(runtime.room,{trustedLocalStorage:true});
 return JSON.stringify({...runtime,room:payload});
}
interface RuntimeReadOptions extends FleetStorageOptions {
 /** Private verified room text and immutable identity, scoped to the same start. */
 verifiedRoom?:{payload:string;room:LabRoom};
}
export function restoreLobbyRuntime(text:string,start:StoredLobbyStart,options:RuntimeReadOptions={}):LobbyRuntime{
 const raw=JSON.parse(text);
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==5||!['format','status','syncedAtMs','secondsRemaining','room'].every(k=>Object.hasOwn(raw,k))||raw.format!=='lobby-runtime/1'||!['starting','in-progress','ended'].includes(raw.status)||!Number.isSafeInteger(raw.syncedAtMs)||raw.syncedAtMs<start.startedAtMs||(raw.syncedAtMs-start.startedAtMs)%1000!==0||typeof raw.room!=='string')throw Error('Invalid lobby runtime');
 const cached=options.verifiedRoom;
 const room=cached&&Object.isFrozen(cached.room)&&cached.payload===raw.room?cached.room:restoreRoom(raw.room,{...options,trustedLocalStorage:true});
 const opening=openingTime(start),remaining=Math.max(0,(opening-raw.syncedAtMs)/1000);
 if(raw.secondsRemaining!==remaining||JSON.stringify(room.state.initial)!==JSON.stringify(start.prepared.room.state.initial)||room.playerRoomId!==start.prepared.access.roomId||JSON.stringify(room.map)!==JSON.stringify(start.prepared.room.map)||JSON.stringify(room.timing)!==JSON.stringify(start.prepared.room.timing))throw Error('Lobby runtime identity mismatch');
 if(remaining>0){
  if(raw.status!=='starting'||room.clock||room.state.economy.tick!==0||(room.state.secondsSinceLastTick??0)!==0)throw Error('Waiting world advanced before opening');
  const original=start.prepared.room.state.commands;
  if(room.state.commands.length<original.length||original.some((c,i)=>JSON.stringify(c)!==JSON.stringify(room.state.commands[i])))throw Error('Starting command history changed');
 }else{
  if(room.timing?.mode==='turn-based'){if(room.clock||raw.status!==(fleetMatchOutcome(room.state)?'ended':'in-progress'))throw Error('Invalid turn-based runtime');}
  else{
  if(!room.clock||room.clock.anchorMs!==opening||room.clock.anchorTick!==0||raw.status!==(fleetMatchOutcome(room.state)?'ended':'in-progress'))throw Error('Invalid running lobby clock');
  if(room.timing?.mode==='realtime'&&tickMilliseconds(room)!==room.timing.tickSeconds*1000)throw Error('Runtime tick duration mismatch');
  const target=Math.floor((raw.syncedAtMs-opening)/tickMilliseconds(room));
  if(room.state.economy.tick>target||raw.status==='in-progress'&&room.state.economy.tick!==target)throw Error('Lobby runtime not caught up');
  }
 }
 return{format:'lobby-runtime/1',status:raw.status,syncedAtMs:raw.syncedAtMs,secondsRemaining:raw.secondsRemaining,room};
}
