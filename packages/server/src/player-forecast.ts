import {dispatchDraftsAllowed} from '../../contracts/src/index.js';
import {dispatchGuard,DispatchSourceLocked,assertDispatchAllowed,recordDispatchOrder} from './dispatch-guard.js';
import {manualPredictionCoordination,coordinateHypotheticalManualOrder,assertManualCommandPriority,assertManualResourcesPreserved,isManualOrder,protectExecutedManualSchedule,type CommandSource} from './manual-commands.js';
import {fleetMatchOutcome,originalFutureActionKnown,prepareForecastKnowledge,buildForecastWorld,projectForecastResult,parseFleetOrder,submitFleetOrder,type FleetOrder} from '../../engine/src/index.js';
import {advanceRoom,type LabRoom} from './planning.js';
import {createForecastSonarCollector,enableForecastNotifications,disableForecastNotifications,readForecastNotifications,forecastEventMinutes,createForecastNotificationQueue} from '../../engine/src/index.js';
import {futureQueueEntries,reserveScheduledLaunch,launchSlot,type ScheduledOrder} from './scheduled-orders.js';
import {publicPlayerError} from './player-errors.js';
import {createRoomPreviewSession,samePreviewSource} from './room-preview-cache.js';

export interface KnownForecastOrder extends FleetOrder {issueTick:number;departureTick?:number}
/** Original tr: active self/team plans are known, opponents' plans are not.
 * Whitelist before copying. Never carry another player's history/reason/slot.
 */
export function prepareForecastAgenda(room:LabRoom,player:number):KnownForecastOrder[]{
 if(!Number.isInteger(player)||!room.state.economy.players[player])throw Error('Invalid forecast player');
 return futureQueueEntries(room).filter(({plan})=>plan.status==='pending'&&originalFutureActionKnown(
  room.state.economy.initial.teamSize,player,plan.player,room.state.economy.players[plan.player]?.active?1:4))
 .map(({plan})=>({...parseFleetOrder({id:plan.id,player:plan.player,action:plan.action}),issueTick:plan.issueTick,
  ...('departureTick'in plan&&typeof plan.departureTick==='number'?{departureTick:plan.departureTick}:{})}));
}

/** Orchestration behind the authenticated forecast route; never a real command.
 * The authoritative room supplies knowledge/agenda and time bounds only.
 * Draft execution must remain downstream of the restricted-world constructor.
 */
export function simulatePlayerFuture(room:LabRoom,player:number,targetTick:number,drafts:readonly KnownForecastOrder[]=[],enemyWaiting?:'defend',draftActor:CommandSource='agent'){
 return simulate(room,player,targetTick,drafts,enemyWaiting,true,draftActor);
}

/** Time-machine frames use the same restricted world and rules, without the
 * notification timeline's per-tick snapshots and sonar scans. */
export function simulatePlayerFrame(room:LabRoom,player:number,targetTick:number){
 const result=simulate(room,player,targetTick,[],undefined,false);
 return result.status==='unsupported'?result:{status:result.status,result:result.result,orders:result.orders};
}

function simulate(room:LabRoom,player:number,targetTick:number,drafts:readonly KnownForecastOrder[],enemyWaiting:'defend'|undefined,notificationsEnabled:boolean,draftActor:CommandSource='agent'){
 validateHorizon(room,targetTick);
 const prepared=prepareSimulation(room,player,targetTick,drafts,enemyWaiting,draftActor);
 if(prepared.status==='unsupported')return prepared;
 const {knowledge,predicted,immediate}=prepared;
 return finishSimulation(knowledge,predicted,immediate,player,targetTick,notificationsEnabled);
}

function validateHorizon(room:LabRoom,targetTick:number){
 if(!Number.isInteger(targetTick)||targetTick<room.state.economy.tick||targetTick-room.state.economy.tick>1440||targetTick===room.state.economy.tick&&(room.state.secondsSinceLastTick??0)>0)throw Error('Invalid forecast horizon');
}

function prepareSimulation(room:LabRoom,player:number,targetTick:number,drafts:readonly KnownForecastOrder[],enemyWaiting?:'defend',draftActor:CommandSource='agent'){
 const knowledge=prepareForecastKnowledge(room.state,player),agenda=prepareForecastAgenda(room,player);
 // Hypothetical commands enter only the isolated knowledge world. Never
 // validate them against authoritative future resources or hidden entities.
 if(!Array.isArray(drafts)||drafts.length>32)throw Error('Invalid forecast drafts');
 const ids=new Set(agenda.map(p=>p.id)),draftIds=new Set(drafts.map(p=>p.id));
 for(const draft of drafts){
  const order=parseFleetOrder({id:draft.id,player:draft.player,action:draft.action});
  if(order.player!==player||ids.has(order.id)||!Number.isInteger(draft.issueTick)||draft.issueTick<room.state.economy.tick||draft.issueTick>targetTick||
   ['reserve-fleet','release-fleet-reservation','recall-waiting-fleet','toggle-funding','resign'].includes(order.action.kind))throw Error('Invalid forecast draft');
  ids.add(order.id);agenda.push({...order,issueTick:draft.issueTick});
 }
 if(!dispatchDraftsAllowed({view:knowledge.view,dispatchGuard:dispatchGuard(room,player)},drafts))throw new DispatchSourceLocked('');
 if(enemyWaiting!==undefined&&enemyWaiting!=='defend')throw Error('Invalid enemy waiting assumption');
 if(drafts.length&&draftActor==='manual')knowledge.assumptions=[...knowledge.assumptions,'New drafts are hypothetical owner choices that may supersede existing manual scopes; no real command or manual fact is created'];
 const built=buildForecastWorld(knowledge);
 if(built.status==='unsupported')return built;
 // Apply the original cancellation operation only to observed, cancellable
 // waiting fleets inside the isolated world. Restore troops;
 // never add troops arithmetically or inspect hidden fleet identities.
 let forecastState=built.state;
 if(enemyWaiting==='defend'){
   for(const f of built.state.fleets.filter(f=>f.used&&f.owner!==player&&f.state==='waiting'&&f.source!==null&&built.state.economy.players[f.owner]?.active&&built.state.economy.outposts.some(p=>p.id===f.source&&p.owner===f.owner))){
     forecastState=submitFleetOrder(forecastState,{id:`forecast-recall-${f.id}`,player:f.owner,action:{kind:'cancel-launch',fleetId:f.id}},0).state;
   }
   knowledge.assumptions=[...knowledge.assumptions,'Enemy visible cancellable waiting fleets are recalled to defend their sources; already departed fleets keep their current course'];
 }
 let predicted:LabRoom={state:forecastState,scheduled:[],scheduledOrders:[],agendaOrder:[],dispatchLocks:{tick:room.state.economy.tick,locks:dispatchGuard(room,player).lockedSources.map(source=>({player,source}))}};
 const coordination=manualPredictionCoordination(room,player,predicted);if(coordination)predicted.manualCoordination=coordination;
 const immediate:ScheduledOrder[]=[];
 for(const order of agenda){
  if(order.issueTick===knowledge.view.tick){
   const plan:ScheduledOrder={...structuredClone(order),status:'pending'};
   try{
    const ownerDraft=draftIds.has(order.id)&&draftActor==='manual',before=predicted;
    if(draftIds.has(order.id))assertDispatchAllowed(before,order);
    if(!ownerDraft&&!isManualOrder(before,order))assertManualCommandPriority(before,order);
    let next={...before,state:submitFleetOrder(before.state,{id:order.id,player:order.player,action:order.action},knowledge.observedSeconds).state};
    if(ownerDraft)next=coordinateHypotheticalManualOrder(before,next,order,'order');
    else if(isManualOrder(before,order))next=protectExecutedManualSchedule(before,next,order);
    else assertManualResourcesPreserved(before,next,order.player);
    predicted=recordDispatchOrder(before,next,order);plan.status='executed';
   }catch(e){plan.status='failed';plan.reason=e instanceof Error?e.message:'Forecast command failed';}
   immediate.push(plan);
   continue;
  }
  try{
   if(draftIds.has(order.id))assertDispatchAllowed(predicted,order);
   const before=predicted,state=reserveScheduledLaunch(predicted,order,predicted.state.secondsSinceLastTick??0);
   const plan:ScheduledOrder={...structuredClone(order),issueTick:order.issueTick,status:'pending',
    ...(order.action.kind==='launch'?{launchSlot:launchSlot({...predicted,state},order)}:{})};
   const next={...predicted,state,scheduledOrders:[...predicted.scheduledOrders!,plan],agendaOrder:[...predicted.agendaOrder!,plan.id]};
   predicted=draftIds.has(order.id)&&draftActor==='manual'?coordinateHypotheticalManualOrder(predicted,next,order,'schedule'):next;
   if(draftIds.has(order.id))predicted=recordDispatchOrder(before,predicted,order,true);
  }catch(error){if(error instanceof DispatchSourceLocked)throw error;return{status:'unsupported' as const,reasons:['known-schedule-reservation-unresolved']};}
 }
 return {status:'conditional' as const,knowledge,predicted,immediate};
}

type PreparedSimulation=Extract<ReturnType<typeof prepareSimulation>,{status:'conditional'}>;

function finishSimulation(knowledge:PreparedSimulation['knowledge'],predicted:LabRoom,immediate:ScheduledOrder[],player:number,targetTick:number,notificationsEnabled:boolean){
 const sonar=notificationsEnabled?createForecastSonarCollector(predicted.state,player,knowledge.observedSeconds):null;
 if(sonar)enableForecastNotifications(predicted.state);
 const horizon=sonar?Math.min(targetTick,sonar.horizonTick):knowledge.view.tick,queue=createForecastNotificationQueue();
 let notificationHorizonTick=knowledge.view.tick,sonarCount=0;
 let future=predicted;
 for(let tick=knowledge.view.tick+1;tick<=horizon;tick++){
  // Original Pc scans the terminal tick, then stops before another update.
  if(fleetMatchOutcome(future.state))break;
  future=advanceRoom(future,tick,true);notificationHorizonTick=tick;
  for(const event of readForecastNotifications(future.state,player)){
   const minutesBeforeSending=forecastEventMinutes(knowledge.view.tick,knowledge.observedSeconds,event.tick);
   if(minutesBeforeSending!==null)queue.rule({...event,minutesBeforeSending});
  }
  // Pc tests its full event buffer after tick/actions and before sonar scan.
  if(queue.full())break;
  sonar!.sample(future.state);
  const contacts=sonar!.result();for(const notice of contacts.slice(sonarCount))queue.sonar(notice);sonarCount=contacts.length;
  if(queue.full())break;
  enableForecastNotifications(future.state); // next tick owns a fresh capture head
 }
 const notificationTimeline=queue.result();
 const ruleNotifications=notificationTimeline.flatMap(e=>e.source==='rule'?[e.notification]:[]);
 const notifications=notificationTimeline.flatMap(e=>e.source==='sonar'?[e.notification]:[]);
 disableForecastNotifications(future.state);
 if(future.state.economy.tick<targetTick)future=advanceRoom(future,targetTick,true);
 const projected=projectSimulation(knowledge,future,immediate,player);
 if(projected.status==='unsupported')return projected;
 return {...projected,
  notificationHorizonTick,notificationLimitReached:queue.full(),notificationTimeline,notifications,ruleNotifications};
}

function projectSimulation(knowledge:PreparedSimulation['knowledge'],future:LabRoom,immediate:ScheduledOrder[],player:number){
 const results=[...immediate,...future.scheduledOrders!];
 // A draw we cannot know is not a failed real order. Do not publish a later
 // timeline calculated as though that unresolved action had simply vanished.
 if(results.some(p=>p.reason==='Unknown forecast activity'))return{status:'unsupported' as const,reasons:['scheduled-activity-unknown']};
 return{status:'conditional' as const,result:projectForecastResult(knowledge,future.state),
  orders:results.filter(p=>p.player===player).map(p=>{
   const failure=p.status==='failed'?publicPlayerError(new Error(p.reason??'Forecast command failed')):null;
   return {id:p.id,issueTick:p.issueTick,status:p.status,certainty:'conditional' as const,
    ...(failure?{code:failure.code,reason:failure.message}:{})};
  })};
}

/** Private checkpoints retain the initial knowledge boundary. Advancing a
 * checkpoint must never rebuild knowledge from the hypothetical future. */
export function createPlayerFrameSession(room:LabRoom,player:number){
 const prepared=prepareSimulation(room,player,room.state.economy.tick,[]);
 const advance=prepared.status==='conditional'?createRoomPreviewSession(prepared.predicted):null;
 return (targetTick:number)=>{
  validateHorizon(room,targetTick);
  if(prepared.status==='unsupported')return prepared;
  const future=advance!(targetTick);
  const result=projectSimulation(prepared.knowledge,future,prepared.immediate,player);
  return result;
 };
}

/** Scope by immutable live state and agenda identity, player AND exact phase.
 * Host instances own the cache; revisions alone omit retained hidden runtime. */
export function createPlayerFrameCache(){
 let source:LabRoom|undefined;
 const sessions=new Map<string,ReturnType<typeof createPlayerFrameSession>>();
 return (room:LabRoom,player:number,targetTick:number,seconds=room.state.secondsSinceLastTick??0)=>{
  if(!samePreviewSource(source,room)){
   sessions.clear();source={...room};
  }
  validateHorizon({...room,state:{...room.state,secondsSinceLastTick:seconds}},targetTick);
  const key=`${player}:${seconds}`;
  let session=sessions.get(key);
  if(!session){
   session=createPlayerFrameSession({...room,state:{...room.state,secondsSinceLastTick:seconds}},player);
   sessions.set(key,session);
   if(sessions.size>10)sessions.delete(sessions.keys().next().value!);
  }
  return session(targetTick);
 };
}
