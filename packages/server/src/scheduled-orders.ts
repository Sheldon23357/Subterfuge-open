import {validateFutureScheduleAction,validateScheduledLaunchEdit} from './schedule-time.js';
import {createHash} from 'node:crypto';
import {submitFleetOrder,parseFleetOrder,fleetMatchOutcome,type FleetOrder} from '../../engine/src/index.js';
import type {LabRoom} from './planning.js';
export interface ScheduledOrder extends FleetOrder {
  launchSlot?:number;
  failed?:boolean;
  issueTick:number;status:'pending'|'executed'|'failed'|'cancelled';reason?:string;
}
export function reserveScheduledLaunch(room:LabRoom,order:FleetOrder,seconds=room.state.secondsSinceLastTick??0){
  if(order.action.kind!=='launch')return room.state;
  const action=order.action;
  if(action.fleetId){
    const planned=[...room.scheduled,...(room.scheduledOrders??[])].find(p=>p.id===action.fleetId&&p.player===order.player&&p.action.kind==='launch');
    const reservation=room.state.fleetReservations.find(r=>r.id===action.fleetId&&r.player===order.player);
    const fleet=room.state.fleets.find(f=>f.used&&f.id===action.fleetId&&f.owner===order.player);
    if(!reservation&&!fleet)throw Error('Future fleet or reservation is unavailable');
    const route=planned?.action.kind==='launch'?planned.action:fleet;
    if(!route||route.source!==action.source||route.destination!==action.destination)throw Error('Future fleet route mismatch');
    return room.state;
  }
  // The original time machine clones existing reservations and their cursors.
  // Re-reserving a known plan would shift its slot and same-tick event order.
  if(room.state.forecastPlayer!==undefined){
    const reservation=room.state.fleetReservations.find(r=>r.id===order.id);
    if(reservation){if(reservation.player!==order.player)throw Error('Reservation ownership required');return room.state;}
  }
  return submitFleetOrder(room.state,{id:'reserve-'+createHash('sha256').update(order.id).digest('hex'),player:order.player,action:{kind:'reserve-fleet',reservationId:order.id}},seconds).state;
}
export function launchIdentity(plan:{id:string;action:FleetOrder['action']}){return plan.action.kind==='launch'?plan.action.fleetId??plan.id:plan.id;}
export function launchSlot(room:LabRoom,plan:{id:string;action:FleetOrder['action'];launchSlot?:number}){
  const id=launchIdentity(plan);
  return plan.launchSlot??room.state.fleetReservations.find(r=>r.id===id)?.slot??room.state.fleets.find(f=>f.id===id)?.slot??-1;
}
/** Stable numeric slots are part of the original future-action identity, even
 * after a sub has sunk and its storage slot has subsequently been reused. */
export function futureQueueEntries(room:LabRoom){
  const order=scheduleIds(room);
  return [...room.scheduled,...(room.scheduledOrders??[])].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id)).map(plan=>({
    plan,uid:plan.id,playerIndex:plan.player,scheduledTick:plan.issueTick,canceled:plan.status==='cancelled',failed:plan.failed??plan.status==='failed',type:plan.action.kind==='launch'?2:0,
    launchSubData:plan.action.kind==='launch'?{srcOutpostIndex:plan.action.source,dstItemType:'outpost',dstItemIndex:plan.action.destination,subIndex:launchSlot(room,plan)}:null,
  }));
}
export function releaseScheduledLaunch(room:LabRoom,id:string,player:number,seconds=room.state.secondsSinceLastTick??0){
  if(!room.state.fleetReservations.some(r=>r.id===id))return room.state;
  return submitFleetOrder(room.state,{id:'unreserve-'+createHash('sha256').update(id).digest('hex'),player,action:{kind:'release-fleet-reservation',reservationId:id}},seconds).state;
}
export function scheduleIds(room:LabRoom){return room.agendaOrder??[...room.scheduled.map(p=>p.id),...(room.scheduledOrders??[]).map(p=>p.id)];}
/** Local queue resource budget, not a lifetime gameplay limit. */
export function pendingScheduleCount(room:LabRoom){return room.scheduled.filter(p=>p.status==='pending').length+(room.scheduledOrders??[]).filter(p=>p.status==='pending').length;}
/** Only syntax and issuer are checked here. Resources/targets are checked at execution.
 * Never inspect authoritative future state to decide whether a player may enqueue.
 */
export function scheduleOrder(room:LabRoom,input:{order:FleetOrder;issueTick:number},seconds=room.state.secondsSinceLastTick??0,options:{simulation?:boolean}={}):LabRoom{
  const order=parseFleetOrder(input.order),tick=input.issueTick;
  const prior=(room.scheduledOrders??[]).find(p=>p.id===order.id);
  if(prior){if(prior.player!==order.player||prior.issueTick!==tick||JSON.stringify(prior.action)!==JSON.stringify(order.action))throw Error('Schedule id conflict');return room;}
  if(!options.simulation){validateFutureScheduleAction(order.action,tick);validateScheduledLaunchEdit(room,order,tick);}
  if(!Number.isInteger(tick)||tick<=room.state.economy.tick||tick>room.state.economy.tick+1440)throw Error('Invalid scheduled tick');
  if(!room.state.economy.players[order.player]?.active||fleetMatchOutcome(room.state))throw Error('Player cannot schedule');
  if(room.scheduled.some(p=>p.id===order.id)||room.state.commands.some(p=>p.id===order.id))throw Error('Schedule id conflict');
  if(pendingScheduleCount(room)>=1000)throw Error('Schedule limit');
  const state=reserveScheduledLaunch(room,order,seconds),slot=order.action.kind==='launch'?launchSlot({...room,state},order):undefined;
  return {...room,state,scheduledOrders:[...(room.scheduledOrders??[]),{...order,...(slot!==undefined?{launchSlot:slot}:{}),issueTick:tick,status:'pending'}],agendaOrder:[...scheduleIds(room),order.id]};
}
export function validateScheduledOrders(raw:unknown,room:LabRoom,options:{trustedLocalStorage?:boolean}={}):ScheduledOrder[]{
  if(!Array.isArray(raw)||!options.trustedLocalStorage&&raw.length+room.scheduled.length>1000)throw Error('Invalid scheduled orders');
  const ids=new Set(room.scheduled.map(p=>p.id));
  const result=raw.map(p=>{
    if(!p||typeof p!=='object')throw Error('Invalid scheduled order');
    const order=parseFleetOrder({id:p.id,player:p.player,action:p.action});
    if(ids.has(order.id)||!room.state.economy.players[order.player]||!Number.isInteger(p.issueTick)||p.issueTick<room.state.initial.economy.initialTick||p.issueTick>1e7||
      !['pending','executed','failed','cancelled'].includes(p.status)||p.status==='pending'&&p.issueTick<=room.state.economy.tick||p.reason!==undefined&&typeof p.reason!=='string')throw Error('Invalid scheduled order');
    if(p.launchSlot!==undefined&&(order.action.kind!=='launch'||!Number.isInteger(p.launchSlot)||p.launchSlot<0||p.launchSlot>=room.state.economy.players.length*128))throw Error('Invalid scheduled fleet slot');
    if(p.failed!==undefined&&typeof p.failed!=='boolean')throw Error('Invalid scheduled failure flag');
    ids.add(order.id);return {...order,...(p.failed!==undefined?{failed:p.failed}:{}),...(p.launchSlot!==undefined?{launchSlot:p.launchSlot}:{}),issueTick:p.issueTick,status:p.status,...(p.reason!==undefined?{reason:p.reason}:{})};
  });
  if(pendingScheduleCount({...room,scheduledOrders:result})>1000)throw Error('Schedule limit');
  return result;
}
