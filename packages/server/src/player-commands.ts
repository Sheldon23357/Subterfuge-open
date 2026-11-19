import {assertDispatchAllowed,recordDispatchOrder,recordDispatchCancellation} from './dispatch-guard.js';
import {assertManualResourcesPreserved,assertManualCommandPriority,assertCancellationPriority,recordCoordinatedCommand,type CommandSource} from './manual-commands.js';
import {createHash} from 'node:crypto';
import {parseFleetOrder,projectPlayerView,submitFleetOrder,type FleetOrder} from '../../engine/src/index.js';
import {protocolFields,protocolObject,type ProtocolCommandRequest} from '../../contracts/src/index.js';
import {cancelSchedule,type LabRoom} from './planning.js';
import {scheduleOrder,scheduleIds} from './scheduled-orders.js';
import {validateFutureScheduleAction,validateImmediateLaunchTime} from './schedule-time.js';
import type {ProtocolWorldEffect} from './player-protocol-store.js';
const object=protocolObject;
const keys=protocolFields;
export const playerCommandId=(player:number,id:string)=>`p${player}-`+createHash('sha256').update(id).digest('hex');
export function playerOrder(input:unknown,player:number,room:LabRoom,seconds=room.state.secondsSinceLastTick??0):FleetOrder{
  const value=object(input);keys(value,['id','action']);
  const order=parseFleetOrder({...value,player});
  if(order.action.kind==='reserve-fleet'||order.action.kind==='release-fleet-reservation'||order.action.kind==='recall-waiting-fleet')throw Error('Internal action');
  // Local command IDs cannot collide with another seat's command IDs or reservations.
  order.id=playerCommandId(player,order.id);
  const planned=[...room.scheduled,...(room.scheduledOrders??[])].find(p=>p.id===order.id);
  if(planned){if(planned.player!==player||JSON.stringify(planned.action)!==JSON.stringify(order.action))throw Error('Command id conflict');return order;}
  const prior=room.state.commands.find(c=>c.id===order.id);
  if(prior){if(prior.player!==player||JSON.stringify(prior.action)!==JSON.stringify(order.action))throw Error('Command id conflict');return order;}
  const action=order.action,visible=projectPlayerView({...room.state,secondsSinceLastTick:seconds},player);
  if('fleetId' in action&&!visible.fleets.some(f=>f.id===action.fleetId)&&!(action.kind==='launch'&&[...room.scheduled,...(room.scheduledOrders??[])].some(p=>p.id===action.fleetId&&p.player===player&&p.action.kind==='launch'&&p.status==='pending')))throw Error('Unknown fleet');

  return order;
}

/** Shared rules adapter; it computes a new room but performs no storage or transport effects. */
export function applyProtocolGameCommand(room:LabRoom,player:number,request:ProtocolCommandRequest,seconds=room.state.secondsSinceLastTick??0,source:CommandSource='agent'):{room:LabRoom;effect:ProtocolWorldEffect}{
 const payload=request.payload;
 if(request.kind==='cancel-schedule'){
  keys(payload,['id'],['confirmCancelledScheduleIds','confirmCancellationToken']);if(typeof payload.id!=='string')throw Error('Invalid schedule identifier');
  return{room:applyCoordinatedCancellation(room,payload.id,player,source,seconds,payload.confirmCancelledScheduleIds,payload.confirmCancellationToken),effect:{state:'cancelled',effects:{scheduleId:payload.id}}};
 }
 keys(payload,request.kind==='schedule'?['action','issueTick']:['action']);
 const order=playerOrder({id:request.clientCommandId,action:payload.action},player,room,seconds);
 if(request.kind==='schedule'){
  validateFutureScheduleAction(order.action,payload.issueTick as number);
  return{room:applyCoordinatedOrder(room,order,source,seconds,payload.issueTick as number),effect:{state:'scheduled',effects:{orderId:order.id,scheduleId:order.id},scheduleOutcome:'pending'}};
 }
 validateImmediateLaunchTime(room,order,seconds);if(scheduleIds(room).includes(order.id))throw Error('Schedule identifier conflict');
 const next=applyCoordinatedOrder(room,order,source,seconds);
 const agreementId=order.action.kind==='propose-agreement'?order.id:order.action.kind==='respond-agreement'?order.action.agreementId:null;
 const agreement=agreementId?next.state.diplomacy.agreements.find(a=>a.id===agreementId):null;
 return{room:next,effect:{state:'applied',effects:{orderId:order.id,...(agreement?{agreementId:agreement.id,agreementStatus:agreement.status}:{})}}};
}

export function applyCoordinatedOrder(room:LabRoom,order:FleetOrder,source:CommandSource,seconds=room.state.secondsSinceLastTick??0,issueTick?:number):LabRoom{
 if(issueTick===undefined&&[...room.scheduled,...(room.scheduledOrders??[])].some(p=>p.id===order.id))throw Error('Schedule id conflict');
 const duplicate=room.state.commands.some(c=>c.id===order.id)||[...room.scheduled,...(room.scheduledOrders??[])].some(p=>p.id===order.id);
 if(!duplicate)assertDispatchAllowed(room,order);
 if(source==='agent'&&!duplicate)assertManualCommandPriority(room,order);
 const next=issueTick===undefined?{...room,state:submitFleetOrder(room.state,order,seconds).state}:scheduleOrder(room,{order,issueTick},seconds);
 if(source==='agent'&&issueTick===undefined&&!duplicate)assertManualResourcesPreserved(room,next,order.player);
 const guarded=duplicate?next:recordDispatchOrder(room,next,order,issueTick!==undefined);
 return recordCoordinatedCommand(room,guarded,{source,player:order.player,kind:issueTick===undefined?'order':'schedule',order,seconds});
}
export function applyCoordinatedCancellation(room:LabRoom,id:string,player:number,source:CommandSource,seconds=room.state.secondsSinceLastTick??0,confirmed:unknown=undefined,confirmationToken:unknown=undefined):LabRoom{
 const prior=[...room.scheduled,...(room.scheduledOrders??[])].find(p=>p.id===id&&p.player===player);
 if(prior?.status==='cancelled')return room;
 const next=cancelSchedule(room,id,player,seconds);
 assertCancellationPriority(room,next,id,player,source,confirmed,confirmationToken);
 return recordCoordinatedCommand(room,recordDispatchCancellation(room,next,player),{source,player,kind:'cancel-schedule',scheduleId:id,seconds});
}
