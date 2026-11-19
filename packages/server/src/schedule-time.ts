import type {FleetOrder} from '../../engine/src/index.js';
import type {LabRoom} from './planning.js';
const error=()=>Error('未来预约必须在整数世界天执行；请选择明确的整天时刻，不会自动取整');
export function validateFutureScheduleAction(action:FleetOrder['action'],issueTick:number){
 if(action.kind==='propose-agreement'||action.kind==='respond-agreement')throw Error('外交协议只能立即发起或响应，不支持预约签署');
 if(!Number.isSafeInteger(issueTick))throw error();
 if(action.kind==='launch'&&action.delaySeconds!==undefined&&action.delaySeconds!==0&&(issueTick*600+action.delaySeconds)%600!==0)throw error();
}
/** Immediate commands retain the engine's immediate departure behavior. An explicit
 * delayed launch is a reservation of an absolute departure, not a day duration. */
export function validateImmediateLaunchTime(room:LabRoom,order:FleetOrder,phase=room.state.secondsSinceLastTick??0){
 const prior=room.state.commands.find(c=>c.id===order.id);
 if(prior&&prior.player===order.player&&JSON.stringify(prior.action)===JSON.stringify(order.action))return;
 const action=order.action;if(action.kind!=='launch')return;
 if(action.delaySeconds!==undefined&&action.delaySeconds!==0&&(room.state.economy.tick*600+phase+action.delaySeconds)%600!==0)throw error();
 // Editing a waiting fleet keeps its original departure in the engine. Never
 // imply that a new delay retimes it, or accept a fractional scheduled edit.
 const fleet=room.state.fleets.find(f=>f.used&&f.owner===order.player&&f.state==='waiting'&&(action.fleetId?f.id===action.fleetId:f.source===action.source&&f.destination===action.destination));
 const original=fleet?room.state.commands.find(c=>c.id===fleet.id):undefined;
 const reserved=fleet&&(action.delaySeconds!==undefined||original?.action.kind==='launch'&&original.action.delaySeconds!==undefined||[...room.scheduled,...(room.scheduledOrders??[])].some(p=>p.id===fleet.id||p.action.kind==='launch'&&p.action.fleetId===fleet.id));
 if(fleet&&reserved&&(room.state.economy.tick*600+fleet.secondsUntilLaunch)%600!==0)throw error();
}

/** A future launch edit cannot retime a waiting sub: original launchSub retains
 * its countdown. Check the actual deadline, not just the requested delay. */
export function validateScheduledLaunchEdit(room:LabRoom,order:FleetOrder,issueTick:number){
 const action=order.action;if(action.kind!=='launch'||!action.fleetId)return;
 // Without fleetId a formal future launch reserves a new slot; the engine
 // replaces a same-route waiting sub and adopts the new whole-day delay.
 // Only explicit identity reuse keeps the old countdown.
 const fleet=room.state.fleets.find(f=>f.used&&f.owner===order.player&&f.state==='waiting'&&(action.fleetId?f.id===action.fleetId:f.source===action.source&&f.destination===action.destination));
 if(fleet){
   const deadline=room.state.economy.tick*600+fleet.secondsUntilLaunch;
   if(deadline>issueTick*600&&deadline%600!==0)throw error();
 }
 if(action.fleetId){
   const plan=[...room.scheduled,...(room.scheduledOrders??[])].find(p=>p.status==='pending'&&p.player===order.player&&p.id===action.fleetId);
   if(plan?.action.kind==='launch'){
     const deadline='departureTick'in plan&&typeof plan.departureTick==='number'?plan.departureTick*600:plan.issueTick*600+(plan.action.delaySeconds??0);
     if(deadline>issueTick*600&&deadline%600!==0)throw error();
   }
 }
}
