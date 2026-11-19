import {parseRoomTiming,type RoomTiming} from '../../contracts/src/index.js';
import {assertDispatchAllowed,recordDispatchOrder,reconcileDispatchLocks,validateDispatchLocks,type DispatchLocks} from './dispatch-guard.js';
import {coordinateHypotheticalManualOrder,recordCoordinatedCommand,isManualOrder,type CommandSource,type HypotheticalManualCoordination,protectExecutedManualSchedule,reconcileManualProtections,assertManualResourcesPreserved,assertManualCommandPriority,commandSource,validateManualCoordination,type ManualCoordination} from './manual-commands.js';
import {validateScheduledLaunchEdit} from './schedule-time.js';
import { advanceLabBranch, fleetCountdowns } from '../../prediction/src/index.js';
export { fleetCountdowns };
export function advanceRoom(room: LabRoom, target:number, simulatedFuture=false):LabRoom {
 return reconcileDispatchLocks(reconcileManualProtections(advanceLabBranch(room,target,simulatedFuture,{
  // Already admitted schedules execute normally; a current input lock cannot cancel them.
  beforeScheduledOrder:(current,order)=>{if(!isManualOrder(current,order))assertManualCommandPriority(current,order);},
  afterScheduledOrder:(before,after,order)=>{
   if(!isManualOrder(before,order))assertManualResourcesPreserved(before,after,order.player);
   const guarded=recordDispatchOrder(before,after,order);
   return isManualOrder(before,order)?protectExecutedManualSchedule(before,guarded,order):guarded;
  },
 })));
}
import {validateClock,type RealtimeClock} from './realtime.js';
import {reserveScheduledLaunch,releaseScheduledLaunch,scheduleIds,validateScheduledOrders,launchSlot,futureQueueEntries,pendingScheduleCount,type ScheduledOrder} from './scheduled-orders.js';
import {
  fleetMatchOutcome,
  applyOriginalFutureQueue,
  originalCancelFutureAction,
  advanceFleetScenario,
  submitFleetOrder,
  restoreFleetSnapshot,
  saveFleetSnapshot,
  type FleetScenario,
  parseFleetOrder,
  type FleetOrder,
  type FleetStorageOptions,
} from "../../engine/src/index.js";
import type {
  ScheduledLaunch,
  MapInitialization,
  GameScenarioInfo,
} from "../../contracts/src/index.js";
export interface LabRoom {
  dispatchLocks?:DispatchLocks;
  manualCoordination?:ManualCoordination;
  /** Isolated readonly draft actors/guards; saveRoom rejects this transient state. */
  hypotheticalManualCoordination?:HypotheticalManualCoordination;
  clock?:RealtimeClock;
  timing?:RoomTiming;
  playerRoomId?:string;
  scheduledOrders?:ScheduledOrder[];
  agendaOrder?:string[];
  map?: MapInitialization;
  scenario?: GameScenarioInfo;
  state: FleetScenario;
  scheduled: ScheduledLaunch[];
}
export function scheduleLaunch(
  room: LabRoom,
  input: { order: FleetOrder; departureTick: number },
  seconds=room.state.secondsSinceLastTick??0,
  options:{simulation?:boolean;source?:CommandSource;hypotheticalOwner?:boolean}={},
): LabRoom {
  const { departureTick } = input;
  let { order } = input;
  if (
    !order ||
    order.action?.kind !== "launch" ||
    !Number.isFinite(departureTick) ||
    Math.abs(departureTick * 600 - Math.round(departureTick * 600)) > 0.000001
  )
    throw Error("无效派遣计划");
  if (
    departureTick <= room.state.economy.tick + seconds / 600 ||
    departureTick > room.state.economy.tick + 144
  )
    throw Error("请选择未来144世界天以内的出发时间");
  const issueTick = Math.floor(departureTick + 1e-9);
  const delaySeconds = Math.round((departureTick - issueTick) * 600);
  order = { ...order, action: { ...order.action, delaySeconds } } as FleetOrder;
  if (order.action.kind !== "launch") throw Error("无效派遣计划");
  if((room.scheduledOrders??[]).some(p=>p.id===order.id))throw Error('预约编号冲突');
  const prior = room.scheduled.find((p) => p.id === order.id);
  if (prior) {
    if (
      prior.player !== order.player ||
      prior.departureTick !== departureTick ||
      JSON.stringify(prior.action) !== JSON.stringify(order.action)
    )
      throw Error("预约编号冲突");
    return room;
  }
  if(!options.simulation&&!Number.isSafeInteger(departureTick))throw Error("未来预约出发必须为整数世界天，不会自动取整");
  if(!options.simulation){assertDispatchAllowed(room,order);validateScheduledLaunchEdit(room,order,issueTick);}
  if(room.state.commands.some(p=>p.id===order.id))throw Error('预约编号冲突');
  if (pendingScheduleCount(room) >= 1000) throw Error("待执行预约已达上限");
  const projected = advanceRoom(room, issueTick, true);
  // Validate against future resources and earlier accepted plans, without reserving present units.
  submitFleetOrder(projected.state, {...order,action:{...order.action,delaySeconds:delaySeconds-(issueTick===room.state.economy.tick?seconds:0)}},issueTick===room.state.economy.tick?seconds:0);
  const reservedState=reserveScheduledLaunch(room,order,seconds);
  let next: LabRoom = {
    ...room,
    state: reservedState,
    agendaOrder:[...scheduleIds(room),order.id],
    scheduled: [
      ...room.scheduled,
      {
        id: order.id,
        launchSlot:launchSlot({...room,state:reservedState},order),
        player: order.player,
        action: structuredClone(order.action),
        issueTick,
        departureTick,
        status: "pending",
      },
    ],
  };
  if(options.source)next=recordCoordinatedCommand(room,next,{source:options.source,player:order.player,kind:'schedule',order,seconds});
  else if(options.hypotheticalOwner)next=coordinateHypotheticalManualOrder(room,next,order,'schedule');
  const result=advanceRoom(next, room.state.economy.tick);
  return options.simulation?result:recordDispatchOrder(room,result,order,issueTick>room.state.economy.tick);
}
export function cancelSchedule(
  room: LabRoom,
  id: string,
  player: number,
  seconds=room.state.secondsSinceLastTick??0,
): LabRoom {
  const entries=futureQueueEntries(room),target=entries.find(e=>e.uid===id);
  if(!target||target.playerIndex!==player||target.canceled||target.scheduledTick<room.state.economy.tick)throw Error('只能取消己方未执行的预约');
  const released=new Set<number>();
  const accepted=originalCancelFutureAction({tickCount:room.state.economy.tick,world:{subs:{get:(slot:number)=>({get reserved(){return room.state.fleetReservations.some(r=>r.slot===slot);},set reserved(value:boolean){if(!value)released.add(slot);}})}}},entries,player,id);
  if(!accepted)throw Error('只能取消己方未执行的预约');
  let state=room.state;
  for(const slot of released){const reservation=state.fleetReservations.find(r=>r.slot===slot);if(reservation)state=releaseScheduledLaunch({...room,state},reservation.id,player,seconds);}
  const canceled=new Set(entries.filter(e=>e.canceled).map(e=>e.uid));
  return {...room,state,scheduled:room.scheduled.map(p=>canceled.has(p.id)?{...p,status:'cancelled'}:p),...(room.scheduledOrders?{scheduledOrders:room.scheduledOrders.map(p=>canceled.has(p.id)?{...p,status:'cancelled'}:p)}:{})};
}
export function saveRoom(room: LabRoom,options:{trustedLocalStorage?:boolean}={}) {
  if(room.hypotheticalManualCoordination)throw Error('Hypothetical manual drafts cannot be saved as authoritative state');
  if(!options.trustedLocalStorage&&room.scheduled.length+(room.scheduledOrders?.length??0)>1000)throw Error('Portable room schedule limit; use local database backup');
  return JSON.stringify({
    format: "lab-room/1",
    ...(room.dispatchLocks?{dispatchLocks:room.dispatchLocks}:{}),
    ...(room.manualCoordination?{manualCoordination:room.manualCoordination}:{}),
    ...(room.clock?{clock:room.clock}:{}),
    ...(room.timing?{timing:room.timing}:{}),
    ...(room.playerRoomId?{playerRoomId:room.playerRoomId}:{}),
    ...(room.map ? { map: room.map } : {}),
    ...(room.scenario ? { scenario: room.scenario } : {}),
    snapshot: saveFleetSnapshot(room.state,options),
    scheduled: room.scheduled,
    ...(room.scheduledOrders?{scheduledOrders:room.scheduledOrders}:{}),
    ...(room.agendaOrder?{agendaOrder:room.agendaOrder}:{}),
  });
}
export function restoreRoom(text: string,options:FleetStorageOptions={}): LabRoom {
  const raw = JSON.parse(text);
  if (raw.format !== "lab-room/1")
    return { state: restoreFleetSnapshot(text,options), scheduled: [] };
  const state = restoreFleetSnapshot(raw.snapshot,options);
  if (!Array.isArray(raw.scheduled) || !options.trustedLocalStorage&&raw.scheduled.length > 1000)
    throw Error("无效预约记录");
  const ids = new Set<string>();
  for (const p of raw.scheduled) {
    if (
      !p ||
      typeof p.id !== "string" ||
      !p.id ||
      ids.has(p.id) ||
      !Number.isInteger(p.player) ||
      p.player < 0 ||
      p.player >= state.economy.players.length ||
      !Number.isInteger(p.issueTick) ||
      (p.action?.delaySeconds === undefined
        ? p.departureTick !== p.issueTick
        : !Number.isInteger(p.action.delaySeconds) ||
          p.action.delaySeconds < 0 ||
          p.action.delaySeconds > 86400 ||
          !Number.isFinite(p.departureTick) ||
          Math.abs(
            p.departureTick - p.issueTick - p.action.delaySeconds / 600,
          ) > 1e-9) ||
      !["pending", "executed", "failed", "cancelled"].includes(p.status) ||
      p.action?.kind !== "launch" ||
      (p.launchSlot!==undefined&&(!Number.isInteger(p.launchSlot)||p.launchSlot<0||p.launchSlot>=state.economy.players.length*128)) ||
      (p.failed!==undefined&&typeof p.failed!=='boolean') ||
      (p.status === "pending" && p.issueTick < state.economy.tick)
    )
      throw Error("无效预约记录");
    ids.add(p.id);
    if (
      typeof p.action.source !== "string" ||
      typeof p.action.destination !== "string" ||
      !Number.isInteger(p.action.drillers) ||
      p.action.drillers < 1 ||
      p.issueTick < 0 ||
      p.issueTick > 1e7
    )
      throw Error("无效预约动作");
    parseFleetOrder({id:p.id,player:p.player,action:p.action});
  }
  if (raw.map) {
    const m = raw.map;
    if (
      !["apk12075-rules4300", "quantity-priority-v1"].includes(m.algorithm) ||
      (m.composition!==undefined&&m.composition!=='generator-45-v1') ||
      m.players !== state.economy.players.length ||
      !Number.isInteger(m.seed) ||
      !Number.isInteger(m.requestedSeed) ||
      m.requestedSeed < 0 || m.requestedSeed > 0xffffffff - 499 ||
      m.seed < m.requestedSeed ||
      m.seed >= m.requestedSeed + 500 ||
      !Number.isInteger(m.score) ||
      m.score < 0 ||
      m.score > 3 ||
      !Array.isArray(m.startingOrigins) ||
      m.startingOrigins.length !== m.players ||
      new Set(m.startingOrigins.map((q: any) => q.owner)).size !== m.players ||
      m.startingOrigins.some(
        (q: any) =>
          !Number.isInteger(q.owner) ||
          q.owner < 0 ||
          q.owner >= m.players ||
          !state.initial.economy.outposts.some(
            (o) => o.id === q.outpostId && o.owner === q.owner,
          ),
      )
    )
      throw Error("无效地图元数据");
    if (m.algorithm === 'quantity-priority-v1' || m.selection !== undefined) {
      const s=m.selection;
      if (!s || !Array.isArray(s.territoryCounts) || s.territoryCounts.length!==m.players ||
        s.territoryCounts.some((v:unknown)=>!Number.isInteger(v)||Number(v)<5||Number(v)>m.players*10) ||
        s.territoryCounts.reduce((a:number,b:number)=>a+b,0)!==m.players*10 ||
        Math.max(...s.territoryCounts)-Math.min(...s.territoryCounts)!==m.score ||
        !Number.isFinite(s.geometryScore)||s.geometryScore<0)throw Error('无效地图筛选摘要');
    }
  }
  if(raw.playerRoomId!==undefined&&(typeof raw.playerRoomId!=='string'||!raw.playerRoomId||raw.playerRoomId.length>128))throw Error('Invalid player room scope');
  if(raw.scenario!==undefined){
    const s=raw.scenario;
    if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).sort().join(',')!=='description,id,startTick,title'||typeof s.id!=='string'||!s.id||s.id.length>80||typeof s.title!=='string'||!s.title||s.title.length>120||typeof s.description!=='string'||!s.description||s.description.length>500||!Number.isSafeInteger(s.startTick)||Number(s.startTick)<1)throw Error('Invalid scenario metadata');
  }
  const restored:LabRoom={...(raw.playerRoomId?{playerRoomId:raw.playerRoomId}:{}),state,scheduled:raw.scheduled,...(raw.map?{map:raw.map}:{}),...(raw.scenario?{scenario:raw.scenario as GameScenarioInfo}:{})};
  if(raw.timing!==undefined)restored.timing=parseRoomTiming(raw.timing);
  if(raw.clock!==undefined)restored.clock=validateClock(raw.clock,state.economy.tick);
  if(raw.scheduledOrders!==undefined)restored.scheduledOrders=validateScheduledOrders(raw.scheduledOrders,restored,options);
  if(pendingScheduleCount(restored)>1000)throw Error('Schedule limit');
  if(raw.agendaOrder!==undefined){
    const ids=scheduleIds(restored);
    if(!Array.isArray(raw.agendaOrder)||raw.agendaOrder.length!==ids.length||new Set(raw.agendaOrder).size!==ids.length||raw.agendaOrder.some((id:unknown)=>typeof id!=='string'||!ids.includes(id)))throw Error('Invalid agenda order');
    restored.agendaOrder=raw.agendaOrder;
  }
  if(raw.manualCoordination!==undefined)restored.manualCoordination=validateManualCoordination(raw.manualCoordination,restored);
  if(raw.dispatchLocks!==undefined)restored.dispatchLocks=validateDispatchLocks(raw.dispatchLocks,restored);
  return restored;
}
/** Full-map estimate by running the same rules; null means no arrival observed within 288 world days (288 ticks). */
/** Simulate a draft on an isolated room; never save or reserve its units. */
export function previewLaunch(
  room: LabRoom,
  input: Parameters<typeof scheduleLaunch>[1],
) {
  assertDispatchAllowed(room,input.order);
  let projected = scheduleLaunch(structuredClone(room), input,room.state.secondsSinceLastTick??0,{simulation:true,hypotheticalOwner:true});
  const start = room.state.economy.tick;
  const destination =
    input.order.action.kind === "launch" ? input.order.action.destination : "";
  const end = Math.min(
    Math.ceil(input.departureTick) + 288,
    Math.min(1e7,room.state.economy.tick + 10000),
  );
  for (let tick = start + 1; tick <= end; tick++) {
    const first = projected.state.events.length;
    const defender = projected.state.economy.outposts.find(o => o.id === destination)?.owner;
    projected = advanceRoom(projected, tick, true);
    const arrival = projected.state.events
      .slice(first)
      .find(
        (event) =>
          event.subject === input.order.id &&
          ((event.kind === "unloaded" &&
            event.details.outpost === destination) ||
            (event.kind === "battle" && event.details.target === destination)),
      );
    if (arrival)
      return {
        arrivalTick: tick,
        target:
          projected.state.economy.outposts.find((o) => o.id === destination) ??
          null,
        outcome:
          arrival.kind === "unloaded" && defender === input.order.player
            ? "reinforced"
            : projected.state.economy.outposts.find((o) => o.id === destination)
                  ?.owner === input.order.player
              ? "won"
              : "lost",
      };
    const plan = projected.scheduled.find((p) => p.id === input.order.id);
    if (plan?.status === "failed") throw Error(plan.reason ?? "无法执行派遣");
    if (
      fleetMatchOutcome(projected.state) ||
      (plan?.status === "executed" &&
        !projected.state.fleets.some((f) => f.id === input.order.id && f.used))
    )
      break;
  }
  return { arrivalTick: null, target: null, outcome: "unresolved" };
}

