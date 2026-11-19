import {DISPATCH_LOCK_MESSAGE} from '../../contracts/src/index.js';
import type {FleetOrder} from '../../engine/src/index.js';
import type {LabRoom} from './planning.js';

/** Authoritative input-time rule. It is not a controller lease or a forecast. */
export interface DispatchLocks {tick:number;locks:{player:number;source:string}[]}
export class DispatchSourceLocked extends Error {
 readonly code='DISPATCH_SOURCE_LOCKED';
 constructor(readonly source:string){super(DISPATCH_LOCK_MESSAGE);}
}
export function dispatchGuard(room:LabRoom,player:number){
 return {tick:room.state.economy.tick,lockedSources:room.dispatchLocks?.tick===room.state.economy.tick?room.dispatchLocks.locks.filter(p=>p.player===player).map(p=>p.source):[]};
}
export function assertDispatchAllowed(room:LabRoom,order:FleetOrder){
 if(order.action.kind==='launch'&&dispatchGuard(room,order.player).lockedSources.includes(order.action.source))throw new DispatchSourceLocked(order.action.source);
}
function lockSources(room:LabRoom,player:number,sources:string[]):LabRoom{
 if(!sources.length)return room;
 const tick=room.state.economy.tick,locks=room.dispatchLocks?.tick===tick?[...room.dispatchLocks.locks]:[];
 for(const source of sources)if(!locks.some(p=>p.player===player&&p.source===source))locks.push({player,source});
 return {...room,dispatchLocks:{tick,locks}};
}
const plans=(room:LabRoom)=>[...room.scheduled,...(room.scheduledOrders??[])];

/** Called only after a successful isolated engine transition, never on an attempt.
 * launch may edit a waiting fleet implicitly by route, without a fleetId. */
export function recordDispatchOrder(before:LabRoom,next:LabRoom,order:FleetOrder,scheduled=false):LabRoom{
 const a=order.action;
 if(a.kind==='cancel-launch'||a.kind==='recall-waiting-fleet'){
  const old=before.state.fleets.find(f=>f.used&&f.id===a.fleetId&&f.owner===order.player&&f.state==='waiting');
  return old?.source?lockSources(next,order.player,[old.source]):next;
 }
 if(a.kind!=='launch')return next;
 const old=before.state.fleets.find(f=>f.used&&f.owner===order.player&&f.state==='waiting'&&f.source===a.source&&f.destination===a.destination&&(!a.fleetId||f.id===a.fleetId));
 if(scheduled){
  // A new independent future launch is not a revision. An explicit edit of an
  // existing fleet/reserved launch is, even though its effect will occur later.
  const prior=a.fleetId&&plans(before).some(p=>p.id===a.fleetId&&p.player===order.player&&p.status==='pending'&&p.action.kind==='launch');
  return a.fleetId&&(old||prior)?lockSources(next,order.player,[a.source]):next;
 }
 // A fresh command reasserting the same loadout still emits a launch event
 // and changes readiness. Only an exact command-ID replay is idempotent.
 return old?lockSources(next,order.player,[a.source]):next;
}
export function recordDispatchCancellation(before:LabRoom,next:LabRoom,player:number):LabRoom{
 const cancelled=new Set(plans(next).filter(p=>p.player===player&&p.status==='cancelled').map(p=>p.id));
 const sources=plans(before).filter(p=>p.player===player&&p.status!=='cancelled'&&cancelled.has(p.id)&&p.action.kind==='launch').map(p=>(p.action as Extract<FleetOrder['action'],{kind:'launch'}>).source);
 return lockSources(next,player,sources);
}
/** Old ticks are inert; retain at most one tick's finite seat/source set. */
export function reconcileDispatchLocks<T extends LabRoom>(room:T):T{
 if(room.dispatchLocks&&room.dispatchLocks.tick<room.state.economy.tick){const next={...room};delete next.dispatchLocks;return next;}
 return room;
}
export function validateDispatchLocks(raw:unknown,room:LabRoom):DispatchLocks{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid dispatch locks');
 const data=raw as DispatchLocks;
 if(Object.keys(data).sort().join(',')!=='locks,tick'||!Number.isSafeInteger(data.tick)||data.tick<room.state.initial.economy.initialTick||data.tick>room.state.economy.tick||!Array.isArray(data.locks)||data.locks.length>room.state.economy.players.length*room.state.economy.outposts.length)throw Error('Invalid dispatch locks');
 const seen=new Set<string>();
 for(const lock of data.locks){
  if(!lock||typeof lock!=='object'||Array.isArray(lock)||Object.keys(lock).sort().join(',')!=='player,source'||!Number.isInteger(lock.player)||!room.state.economy.players[lock.player]||typeof lock.source!=='string'||!room.state.economy.outposts.some(o=>o.id===lock.source)||seen.has(JSON.stringify([lock.player,lock.source])))throw Error('Invalid dispatch lock');
  seen.add(JSON.stringify([lock.player,lock.source]));
 }
 return structuredClone(data);
}
