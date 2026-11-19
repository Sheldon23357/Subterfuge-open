import {PROFILE_ID,ACTIVITY_RULES,type ActivityRules} from '../../rules/src/index.js';
import {resolveDrillerPhase} from './combat.js';
import {fleetSpeed} from './fleet-movement.js';
import {economicTotals} from './economic-scenario.js';
import {retirePlayer} from './lifecycle.js';

import {arriveAtUnknownOutpost} from './forecast-arrival.js';
import {initializeNotifications,inheritNotifications,appendCommandHead} from './notification-journal.js';
import {captureRuleNotification} from './notification-capture.js';
import {captureActivity} from './activity-capture.js';
import {tickInactivity,checkInPlayer,clearCommandWarning,recordCommandActivity,type PlayerActivity} from './inactivity.js';
import {commandTime} from './command-time.js';
import {canCancelFleetLaunch} from './launch-window.js';
import {commandSeconds} from './command-time.js';
import {nextFleetSlot,reserveFleetSlot} from './fleet-slots.js';
import {createEconomicScenario,submitEconomicCommand,beginOwnedEconomicTick,finishEconomicTick,
  type EconomicSetup,type EconomicScenario,type EconomicAction} from './economic-scenario.js';
import type {Point,WorldSize} from './geometry.js';
import {clientDistanceSquared,clientRouteCollisionFraction,unwrapClientPoint} from './client-geometry.js';
import {prepareFleetMovement,launchFleet,moveFleet,fleetMovementSegment,type FleetKinematics} from './fleet-movement.js';
import {orderMovementEvents,type MovementEvent} from './events.js';
import {neptuniumAfterMineLoss} from './economy.js';
import {detectEndCondition} from './lifecycle.js';
import {createDiplomacyState,parseDiplomacyAction,submitDiplomacy,advanceDiplomacy,recordDiplomacyBattle,type DiplomacyAction,type DiplomacyState,type DiplomacyWorld} from './diplomacy.js';


export interface FleetSetup {launchCancellationLockTick?:number;economy:EconomicSetup;size:WorldSize;positions:Record<string,Point>;match?:{mode:'mining'|'domination';neptuniumGoal:number;activityRules?:ActivityRules;realtimeTickMilliseconds?:number}}

export interface Fleet extends FleetKinematics {id:string;slot:number;used:boolean;owner:number;drillers:number;source:string|null;destination:string;returned?:boolean;gift:boolean;giftSeconds:number;trueDestination?:Point}

export type FleetAction=DiplomacyAction|{kind:'reserve-fleet';reservationId:string}|{kind:'release-fleet-reservation';reservationId:string}|EconomicAction|{kind:'resign'}|{kind:'check-in'}|{kind:'cancel-inactivity-warning'}|{kind:'launch';source:string;destination:string;drillers:number;delaySeconds?:number;fleetId?:string}|{kind:'cancel-launch';fleetId:string}|{kind:'recall-waiting-fleet';fleetId:string}|{kind:'return-fleet';fleetId:string};

export interface FleetOrder {id:string;player:number;action:FleetAction}
export interface FleetRecord extends FleetOrder {tick:number;seconds?:number;activityCheckin?:true}
/** Authority clock settlements interleaved with commands, including ticks without orders. */
export interface FleetPhaseSettlement {tick:number;seconds:number;afterCommand:number}
export interface FleetEvent {
  /** Original notification recipients captured at event time, not recomputed later. */
  audience?:number[];
  sequence:number;tick:number;fraction:number;kind:string;subject:string;
  details:Record<string,string|number|boolean|null>;
}
export interface FleetScenario {
 forecastPlayer?:number;forecastVictoryEnabled?:boolean;
 forecastTerminal?:{reasons:string[];firstCrossing?:{tick:number;triggeringSeat:number|null;triggeringTeam:number|null}};
 activity?:PlayerActivity[];forecastActivity?:{player:number;value:PlayerActivity};secondsSinceLastTick?:number;
 /** Events already settled before a day-internal command; movement baselines stay at the tick boundary. */
 settledMovement?:{tick:number;events:string[]};
 phaseSettlements?:FleetPhaseSettlement[];
 format:'fleet-scenario/6';profile:typeof PROFILE_ID;initial:FleetSetup;economy:EconomicScenario;diplomacy:DiplomacyState;
 fleetReservations:{id:string;player:number;slot:number}[];fleets:Fleet[];subCounters:number[];commands:FleetRecord[];events:FleetEvent[];
}

const clone=<T>(v:T):T=>{const next=structuredClone(v);inheritNotifications(v,next);return next;};
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw new TypeError('Expected object');return v as Record<string,unknown>;}
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new TypeError('Unexpected or missing fields');}
function id(v:unknown):asserts v is string{if(typeof v!=='string'||!v.length||v.length>128)throw new TypeError('Invalid identifier');}
function count(v:unknown,max=1e9):asserts v is number{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)throw new RangeError('Invalid count');}
function action(raw:unknown):FleetAction{
 const a=record(raw);switch(a.kind){
  case 'propose-agreement':case 'respond-agreement':return parseDiplomacyAction(a);
  case 'reserve-fleet':case 'release-fleet-reservation':exact(a,['kind','reservationId']);id(a.reservationId);return {kind:a.kind,reservationId:a.reservationId};
  case 'resign':case 'check-in':case 'cancel-inactivity-warning':exact(a,['kind']);return {kind:a.kind};
  case 'launch':{
   exact(a,['kind','source','destination','drillers',...(Object.hasOwn(a,'delaySeconds')?['delaySeconds']:[]),...(Object.hasOwn(a,'fleetId')?['fleetId']:[])]);id(a.source);id(a.destination);count(a.drillers);if(a.drillers===0)throw Error('A fleet requires positive drillers');
   if(a.delaySeconds!==undefined)count(a.delaySeconds,86400);if(a.fleetId!==undefined)id(a.fleetId);
   return {kind:a.kind,source:a.source,destination:a.destination,drillers:a.drillers,...a.delaySeconds!==undefined?{delaySeconds:a.delaySeconds as number}:{},...a.fleetId!==undefined?{fleetId:a.fleetId as string}:{}};
  }
  case 'cancel-launch':case 'recall-waiting-fleet':case 'return-fleet':exact(a,['kind','fleetId']);id(a.fleetId);return {kind:a.kind,fleetId:a.fleetId};
  case 'toggle-mine':exact(a,['kind','outpostId']);id(a.outpostId);return {kind:a.kind,outpostId:a.outpostId};
  case 'set-shields':exact(a,['kind','outpostId','enabled']);id(a.outpostId);if(typeof a.enabled!=='boolean')throw Error('Invalid enabled');return {kind:a.kind,outpostId:a.outpostId,enabled:a.enabled};
  case 'toggle-funding':exact(a,['kind','recipient']);count(a.recipient,9);return {kind:a.kind,recipient:a.recipient};
  default:throw Error('Unsupported fleet action');
 }
}



export function parseFleetOrder(raw:unknown):FleetOrder{const o=record(raw);exact(o,['id','player','action']);id(o.id);count(o.player,9);return{id:o.id,player:o.player,action:action(o.action)};}
export function createFleetScenario(raw:FleetSetup):FleetScenario{
 const setup=record(raw);exact(setup,['economy','size','positions',...Object.hasOwn(setup,'launchCancellationLockTick')?['launchCancellationLockTick']:[],...Object.hasOwn(setup,'match')?['match']:[]]);
 if(raw.launchCancellationLockTick!==undefined)count(raw.launchCancellationLockTick,1e7);
 if(Object.hasOwn(setup,'match')&&!raw.match)throw Error('Invalid match configuration');
 if(raw.match){exact(record(raw.match),['mode','neptuniumGoal',...Object.hasOwn(raw.match,'activityRules')?['activityRules']:[],...Object.hasOwn(raw.match,'realtimeTickMilliseconds')?['realtimeTickMilliseconds']:[]]);if(!['mining','domination'].includes(raw.match.mode))throw Error('Invalid match mode');count(raw.match.neptuniumGoal);if(raw.match.neptuniumGoal===0)throw Error('Invalid victory goal');if(Object.hasOwn(raw.match,'activityRules')&&raw.match.activityRules!==ACTIVITY_RULES)throw Error('Invalid activity rules');if(raw.match.realtimeTickMilliseconds!==undefined&&(!Number.isInteger(raw.match.realtimeTickMilliseconds)||raw.match.realtimeTickMilliseconds<1000||raw.match.realtimeTickMilliseconds>3600000))throw Error('Invalid realtime tick duration');}
 const economy=createEconomicScenario(raw.economy);exact(record(raw.size),['width','height']);
 exact(record(raw.positions),economy.outposts.map(o=>o.id));for(const p of Object.values(raw.positions)){exact(record(p),['x','y']);clientDistanceSquared(p,p,raw.size);}
 const state:FleetScenario={format:'fleet-scenario/6',profile:PROFILE_ID,initial:clone(raw),economy,diplomacy:createDiplomacyState(economy.players.length,economy.tick),fleetReservations:[],fleets:[],subCounters:economy.players.map(()=>-1),commands:[],events:[]};
 if(raw.match)state.activity=economy.players.map(()=>({lastCheckinTime:economy.tick*600,inactivityWarningCount:0,autoResigned:false}));
 initializeNotifications(state);checkMatchEnd(state);return state;
}

function emit(s:FleetScenario,kind:string,subject:string,details:FleetEvent['details']={},fraction=(s.secondsSinceLastTick??0)/600,clockTick=s.economy.tick){
  if(kind!=='launch-cancelled'&&kind!=='outpost-captured'&&kind!=='departed')captureActivity(s,kind,subject,details,fraction);
  s.events.push({sequence:s.events.length,tick:clockTick,fraction,kind,subject,details});
  if(!['departed','battle','player-resigned'].includes(kind))captureRuleNotification(s,kind,subject,details,fraction);
}
/** Trigger is the original end-condition representative, not a complete medal ranking. */
export function fleetMatchOutcome(s:FleetScenario){
  const event=s.events.find(e=>e.kind==='game-ended');
  return event?{ended:true as const,tick:event.tick,triggeringSeat:event.details.player as number|null,triggeringTeam:event.details.team as number|null}:null;
}
/** A restricted crossing stops this branch, without claiming an authoritative outcome. */
export function fleetForecastStopped(s:FleetScenario){return !!(fleetMatchOutcome(s)||s.forecastTerminal?.firstCrossing);}
function checkMatchEnd(s:FleetScenario){
  const match=s.initial.match;if(!match||fleetForecastStopped(s))return;
  resolveAssetLoss(s);
  if(s.forecastPlayer!==undefined&&s.forecastVictoryEnabled!==true&&!s.forecastTerminal)return;
  const seats=s.economy.players.map((p,i)=>{
    const eligible=p.active||match.activityRules!==ACTIVITY_RULES;
    return {alive:p.active,neptunium:eligible?p.neptunium:0,outposts:eligible?s.economy.outposts.filter(o=>o.owner===i&&!o.destroyed&&o.type!=='mine').length:0};
  });
  const result=detectEndCondition(seats,s.economy.initial.teamSize,match.mode,match.neptuniumGoal);
  if(s.forecastTerminal){
    if(s.events.some(e=>e.kind==='future-unknown-arrival')&&!s.forecastTerminal.reasons.includes('arrival-outcome-unknown'))s.forecastTerminal.reasons.push('arrival-outcome-unknown');
    if(result.ended)s.forecastTerminal.firstCrossing={tick:s.economy.tick,triggeringSeat:result.triggeringSeat,triggeringTeam:result.triggeringTeam};
    return;
  }
  if(result.ended){if(s.activity)for(const a of s.activity)a.inactivityWarningCount=0;emit(s,'game-ended','match',{player:result.triggeringSeat,team:result.triggeringTeam,mode:match.mode});}
}
function outpost(s:FleetScenario,id:string){const o=s.economy.outposts.find(o=>o.id===id);if(!o)throw new Error('Unknown outpost');return o;}
function position(s:FleetScenario,id:string):Point{return s.initial.positions[id]!;}
function fleetTotals(s:FleetScenario){return s.economy.players.map((_,i)=>s.fleets.reduce((sum,f)=>sum+(f.used&&f.owner===i?f.drillers:0),0));}
export function fleetScenarioTotals(s:FleetScenario){return economicTotals(s.economy,fleetTotals(s),s.secondsSinceLastTick??0);}

/** Authority-only adapter. Authorized projections are handled separately. */
export function fleetDiplomacyWorld(s:FleetScenario):DiplomacyWorld {
 const totals=fleetScenarioTotals(s);
 return {size:s.initial.size,players:s.economy.players.map((p,i)=>({active:p.active,neptunium:p.neptunium,drillers:totals[i]!.drillers})),
  outposts:s.economy.outposts.map(p=>({id:p.id,owner:p.owner,destroyed:!!p.destroyed,type:p.type,position:s.initial.positions[p.id]!})),ended:!!fleetMatchOutcome(s)};
}

export function canReturnFleet(f:Pick<Fleet,'used'|'returned'|'source'>){return f.used&&!f.returned&&f.source!==null;}

function ownedFleet(s:FleetScenario,id:string,player:number){const f=s.fleets.find(f=>f.id===id&&f.used);if(!f||f.owner!==player)throw new Error('Fleet not owned by issuer');return f;}
function mirrorEconomyEvents(s:FleetScenario,from:number){for(const e of s.economy.events.slice(from)){
  emit(s,e.kind,e.subject,{amount:e.amount});
  if(e.kind==='mine-created'){
    const event=s.events.at(-1)!,owner=outpost(s,e.subject).owner;
    event.details.owner=owner;event.audience=s.economy.players.flatMap((p,i)=>p.active&&i!==owner?[i]:[]);
  }
}}


















function unload(s:FleetScenario,f:Fleet,destination:string,fraction:number,recovery=true,clock?:{tick:number;fraction:number}){if(recovery)captureActivity(s,'fleet-recovered',f.id,{outpost:destination,drillers:f.drillers},clock?.fraction??fraction,clock?.tick);outpost(s,destination).drillers+=f.drillers;emit(s,'unloaded',f.id,{outpost:destination,drillers:f.drillers},fraction);f.drillers=0;}

export function fleetScenarioSpeed(s:FleetScenario,_f:Fleet){return fleetSpeed(s.economy.tick);}


const speedFor=fleetScenarioSpeed;
function targetFleet(s:FleetScenario,id:string){return s.fleets.find(f=>f.used&&f.id===id);}






function updateTrueDestination(s:FleetScenario,f:Fleet){const p=position(s,f.destination);f.trueDestination=unwrapClientPoint(p,f.position,s.initial.size);return p;}







/** Return a new state; stable command IDs are idempotent across all command kinds. */
export function submitFleetOrder(state:FleetScenario,raw:FleetOrder,seconds=state.secondsSinceLastTick??0):{state:FleetScenario;duplicate:boolean}{
  return applyFleetOrder(state,raw,seconds,true);
}
/** Scalar-only launch preview for route estimators. The private branch owns all
 * mutable live fields and append-only arrays, but can read the immutable setup
 * and existing journal entries without serializing them thousands of times.
 * No branch/state/reference escapes; validation and resource checks use
 * the exact normal command path. This is not a writable order entry point. */
export function previewFleetLaunchSpeed(state:FleetScenario,command:FleetOrder,seconds=state.secondsSinceLastTick??0):{speed:number;secondsUntilLaunch:number}|null{
  if(command.action.kind!=='launch')throw Error('Launch preview requires a launch order');
  const {initial,commands,events,economy,...live}=state;
  const {initial:economicInitial,events:economicEvents,...economicLive}=economy;
  const copied=structuredClone({live,economicLive});
  const branch:FleetScenario={...copied.live,initial,commands:commands.slice(),events:events.slice(),
    economy:{...copied.economicLive,initial:economicInitial,events:economicEvents.slice()}};
  inheritNotifications(state,branch);
  const applied=applyFleetOrder(branch,command,seconds,false).state,a=command.action;
  const fleet=applied.fleets.find(f=>f.used&&f.owner===command.player&&f.source===a.source&&f.destination===a.destination);
  return fleet?{speed:fleetScenarioSpeed(applied,fleet),secondsUntilLaunch:fleet.secondsUntilLaunch}:null;
}
function applyFleetOrder(state:FleetScenario,raw:FleetOrder,seconds:number,copy:boolean,trustedLocalStorage=false,recordActivity=true):{state:FleetScenario;duplicate:boolean}{
 const command=parseFleetOrder(raw),prior=state.commands.find(c=>c.id===command.id);
 if(prior){if(prior.player!==command.player||JSON.stringify(prior.action)!==JSON.stringify(command.action))throw Error('Command id conflict');return {state,duplicate:true};}
 commandSeconds(seconds,state.secondsSinceLastTick??0);const s=copy?clone(state):state;
 if(seconds>0)settleMovementThrough(s,seconds/600);
 if(fleetForecastStopped(s)&&command.action.kind!=='release-fleet-reservation')throw Error('Game has ended');
 if(command.action.kind==='toggle-mine'&&s.initial.match?.mode==='domination')throw Error('Mining is disabled in domination mode');
 if(!s.economy.players[command.player]||!s.economy.players[command.player]!.active&&command.action.kind!=='release-fleet-reservation')throw Error('Inactive or unknown player');
 const a=command.action;if(seconds>0)s.secondsSinceLastTick=seconds;
 if(!recordActivity)clearCommandWarning(s,command.player,a.kind);
 if(a.kind==='propose-agreement'||a.kind==='respond-agreement'){
  const result=submitDiplomacy(s.diplomacy,fleetDiplomacyWorld(s),command.player,command.id,a,s.economy.tick+seconds/600);
  s.diplomacy=result.state;
  for(let i=0;i<s.economy.players.length;i++)s.economy.players[i]!.neptunium=result.world.players[i]!.neptunium;
 }
 else if(a.kind==='reserve-fleet')reserveFleetSlot(s,command.player,a.reservationId);
 else if(a.kind==='release-fleet-reservation'){const r=s.fleetReservations.find(r=>r.id===a.reservationId);if(!r||r.player!==command.player)throw Error('Reservation ownership required');s.fleetReservations=s.fleetReservations.filter(r=>r.id!==a.reservationId);}
 else if(a.kind==='check-in'||a.kind==='cancel-inactivity-warning')checkInPlayer(s,command.player,a.kind==='cancel-inactivity-warning');
 else if(a.kind==='resign'){if(!s.initial.match)throw Error('Resignation requires match lifecycle');retirePlayer(s.economy.players,s.economy.funding,command.player);emit(s,'player-resigned',String(command.player),{owner:command.player});}
 else if(a.kind==='launch'){
  const origin=outpost(s,a.source);outpost(s,a.destination);if(origin.owner!==command.player||a.source===a.destination)throw Error('Invalid source or destination');
  const identity=a.fleetId??command.id,route=(f:Fleet)=>f.used&&f.state==='waiting'&&f.source===a.source&&f.destination===a.destination;
  let f=a.fleetId?s.fleets.find(f=>f.used&&f.id===a.fleetId):s.fleets.find(route);const reservation=s.fleetReservations.find(r=>r.id===identity);
  if(a.fleetId&&f&&(f.owner!==command.player||!route(f)))throw Error('Requested fleet is not editable on this route');
  if(a.fleetId&&!f&&!reservation)throw Error('Requested fleet or reservation is unavailable');
  if(!trustedLocalStorage&&f&&commandTime.launchRemaining({state:f.state,secsUntilLaunch:f.secondsUntilLaunch},seconds)===0)throw Error('Departure can no longer be edited');
  if(a.drillers>origin.drillers+(f?.drillers??0))throw Error('Insufficient drillers');
  if(reservation&&reservation.player!==command.player)throw Error('Reservation ownership required');
  if(reservation&&f&&f.slot!==reservation.slot){origin.drillers+=f.drillers;f.drillers=0;f=undefined;}
  if(!f){const slot=reservation?.slot??nextFleetSlot(s,command.player);if(slot<0)throw Error('No fleet slot available');if(s.fleets.some(f=>f.used&&f.slot===slot))throw Error('Reserved fleet slot occupied');
   f={id:identity,slot,used:true,owner:command.player,drillers:0,source:a.source,destination:a.destination,position:clone(position(s,a.source)),previous:clone(position(s,a.source)),state:(a.delaySeconds??0)>0?'waiting':'moving',secondsUntilLaunch:(a.delaySeconds??0)+seconds,fractionMoved:0,gift:false,giftSeconds:0};
   s.fleets=s.fleets.filter(old=>old.slot!==slot);s.fleets.push(f);s.fleets.sort((a,b)=>a.slot-b.slot);
  }
  s.fleetReservations=s.fleetReservations.filter(r=>r.id!==identity);origin.drillers+=f.drillers-a.drillers;f.drillers=a.drillers;updateTrueDestination(s,f);
  if(f.state==='moving'){captureActivity(s,'departed',f.id,{},seconds/600,s.economy.tick);emit(s,'departed',f.id,{source:a.source,destination:a.destination,drillers:f.drillers},seconds/600,s.economy.tick+1);captureRuleNotification(s,'departed',f.id,{immediate:true});}
  else emit(s,'launch-ordered',f.id,{source:a.source,destination:a.destination,drillers:a.drillers});
 }else if(a.kind==='cancel-launch'||a.kind==='recall-waiting-fleet'){
  const f=ownedFleet(s,a.fleetId,command.player);if(a.kind==='recall-waiting-fleet'&&(s.economy.tick!==0||seconds!==0))throw Error('Lifecycle recall requires frozen waiting time');
  if(a.kind==='recall-waiting-fleet'&&f.returned)f.source=f.destination;
  if(a.kind==='cancel-launch'&&f.state!=='waiting'||f.source===null)throw Error('Fleet has departed');
  if(!trustedLocalStorage&&a.kind==='cancel-launch'&&!canCancelFleetLaunch(f,seconds,s.economy.tick>=(s.initial.launchCancellationLockTick??0)))throw Error('Departure can no longer be cancelled');
  captureActivity(s,'launch-cancelled',f.id);recallFleet(s,f);emit(s,'launch-cancelled',f.id);
 }else if(a.kind==='return-fleet'){
  const f=ownedFleet(s,a.fleetId,command.player);if(!canReturnFleet(f))throw Error('Fleet cannot return');
  const destination=f.source!,source=f.destination;
  if(f.state==='moving'&&seconds>Math.max(0,f.secondsUntilLaunch))moveFleet(f,updateTrueDestination(s,f),s.initial.size,speedFor(s,f),(seconds-Math.max(0,f.secondsUntilLaunch))/600);
  const before=f.drillers;f.drillers=Math.floor(before/2);f.returned=true;f.source=source;f.destination=destination;f.state='moving';f.secondsUntilLaunch=seconds;f.fractionMoved=0;f.previous=clone(f.position);f.gift=false;f.giftSeconds=0;updateTrueDestination(s,f);
  emit(s,'fleet-recalled',f.id,{destination,drillers:f.drillers,lost:before-f.drillers});
 }else{const cursor=s.economy.events.length;s.economy=submitEconomicCommand(s.economy,{...command,action:a},seconds).state;mirrorEconomyEvents(s,cursor);}
 const activityCheckin=recordActivity&&!!(s.activity||s.forecastActivity)&&a.kind!=='check-in'&&a.kind!=='cancel-inactivity-warning';
 if(activityCheckin)recordCommandActivity(s,command.player,a.kind);
 s.commands.push({...command,tick:s.economy.tick,...seconds>0?{seconds}:{},...activityCheckin?{activityCheckin:true as const}:{}});appendCommandHead(s,{...command,tick:s.economy.tick});checkMatchEnd(s);
 if(s.forecastPlayer===undefined)advanceDiplomacy(s.diplomacy,fleetDiplomacyWorld(s),s.economy.tick+seconds/600);
 return {state:s,duplicate:false};
}

/** Research API reports validation without changing state. Not yet a fog-filtered service API. */
export function validateFleetOrder(s:FleetScenario,o:FleetOrder):{valid:true}|{valid:false;reason:string}{
  try{submitFleetOrder(s,o);return{valid:true};}catch(e){return{valid:false,reason:e instanceof Error?e.message:'Invalid command'};}
}


function destroyFleet(_s:FleetScenario,f:Fleet,_clock?:{tick:number;fraction:number}){f.used=false;}

/** Remove a fleet only inside an isolated prediction world. */
export function destroyForecastFleet(s:FleetScenario,id:string){
  if(s.forecastPlayer===undefined)throw Error('Forecast perspective required');
  const f=targetFleet(s,id);if(!f)throw Error('Forecast fleet is unavailable');
  destroyFleet(s,f);
}
function recallFleet(s:FleetScenario,f:Fleet){if(f.source===null)throw Error('Recall requires source outpost');unload(s,f,f.source,0);destroyFleet(s,f);}

function battle(s:FleetScenario,f:Fleet,other:Fleet|string,fraction:number){
 const isOutpost=typeof other==='string',defender=isOutpost?outpost(s,other):other;
 const shield=isOutpost?outpost(s,other).shield:0,attackerOwner=f.owner,defenderOwner=defender.owner,attackerBefore=f.drillers,defenderBefore=defender.drillers;
 const result=resolveDrillerPhase({attackerDrillers:attackerBefore,defenderDrillers:defenderBefore,shield,isOutpost});
 if(s.forecastPlayer===undefined&&defenderOwner!==null)recordDiplomacyBattle(s.diplomacy,fleetDiplomacyWorld(s),{
  id:'battle:'+s.events.length,time:s.economy.tick-1+fraction,attacker:attackerOwner,defender:defenderOwner,
  attackerLoss:result.attackerLoss,defenderLoss:result.defenderLoss,outpost:isOutpost?other:null,
  captured:isOutpost&&result.winner==='attacker',mine:isOutpost&&outpost(s,other).type==='mine',
 });
 f.drillers=result.attacker;defender.drillers=result.defender;
 emit(s,'battle',f.id,{target:isOutpost?other:other.id,attackerOwner,defenderOwner,attackerBefore,defenderBefore,shieldBefore:shield,winner:result.winner,attacker:f.drillers,defender:defender.drillers,shield:result.shield},fraction);
 captureRuleNotification(s,'battle',f.id,{outpost:isOutpost,target:isOutpost?other:other.id,winner:result.winner},fraction,undefined,{attacker:{player:attackerOwner,before:attackerBefore,after:f.drillers},defender:{player:defenderOwner,before:defenderBefore,after:defender.drillers},shield:{before:shield,after:result.shield},outcome:result.winner});
 if(isOutpost){const o=outpost(s,other);o.shield=result.shield;if(result.winner==='attacker'){
  if(!o.destroyed&&o.type==='mine'&&o.owner!==null){const p=s.economy.players[o.owner]!,before=p.neptunium;p.neptunium=neptuniumAfterMineLoss(before);emit(s,'mine-loss',o.id,{owner:o.owner,before,after:p.neptunium},fraction);}
  const before=o.owner;captureActivity(s,'outpost-captured',o.id,{before,owner:f.owner},fraction);o.owner=f.owner;o.shieldDisablePending=false;o.minePending=false;o.shieldProgress=0;o.shieldsEnabled=true;emit(s,'outpost-captured',o.id,{before,owner:f.owner},fraction);
  if(o.type==='mine')captureRuleNotification(s,'mine-captured',o.id,{before,owner:f.owner},fraction);
 }}
}

function arrival(s:FleetScenario,f:Fleet,fraction:number){
 const o=outpost(s,f.destination);if(o.futureUnknown){arriveAtUnknownOutpost(s,f,fraction,()=>destroyFleet(s,f));return;}
 if(o.owner===null)f.gift=false;
 if(o.owner===null&&o.drillers===0&&o.shield===0){captureActivity(s,'outpost-captured',o.id,{before:null,owner:f.owner},fraction);o.owner=f.owner;o.shieldDisablePending=false;o.shieldProgress=0;o.shieldsEnabled=true;emit(s,'outpost-captured',o.id,{before:null,owner:f.owner},fraction);captureRuleNotification(s,'dormant-arrival',f.id,{outpost:o.id},fraction);}
 else if(o.owner!==f.owner){for(const other of s.fleets)if(other.used&&other.source===o.id&&(other.state==='waiting'||other.state==='launching'))unload(s,other,o.id,fraction);battle(s,f,o.id,fraction);}
 const delivered=f.drillers;unload(s,f,o.id,fraction,false);captureActivity(s,'fleet-arrived',f.id,{outpost:o.id,drillers:delivered,outcome:o.owner===f.owner?'delivered':'defeated'},fraction);
}


type MovementStart={state:string;seconds:number};
const movementStart=(f:MovementStart)=>f.state==='moving'?Math.max(0,Math.min(1,f.seconds/600)):0;
function arrivalFraction(f:Fleet,start:MovementStart){const offset=movementStart(start);return offset+(1-offset)*f.fractionMoved;}
function absoluteMovementSegment(segment:{a:Point;b:Point},offset:number){
 if(offset<=0||offset>=1)return segment;
 return {a:{x:segment.a.x-(segment.b.x-segment.a.x)*offset/(1-offset),y:segment.a.y-(segment.b.y-segment.a.y)*offset/(1-offset)},b:segment.b};
}
function prepareMovementEvents(s:FleetScenario){
 const world=s.initial.size,speed=fleetSpeed(s.economy.tick);
 const starts=new Map(s.fleets.map(f=>[f.id,{state:f.state,seconds:f.secondsUntilLaunch}]));
 for(const f of s.fleets)if(f.used){f.previous=clone(f.position);prepareFleetMovement(f,updateTrueDestination(s,f),world,speed);}
 const events:MovementEvent[]=[];
 for(const f of s.fleets)if(f.used&&f.drillers>0){const destination:MovementEvent['destination']={type:'outpost',index:s.economy.outposts.findIndex(o=>o.id===f.destination)};
  if(f.state==='arriving'||f.state==='launching')events.push({type:f.state==='arriving'?'arrival':'launch',subIndex:f.slot,destination,timeFraction:f.state==='arriving'?arrivalFraction(f,starts.get(f.id)!):1-f.fractionMoved});
  if(f.source!==null)for(const reversed of [true,false])for(const other of s.fleets){
   if(!other.used||other.owner===f.owner||other.source!==(reversed?f.destination:f.source)||other.destination!==(reversed?f.source:f.destination))continue;
   const a=absoluteMovementSegment(fleetMovementSegment(f,position(s,f.destination),f.position,world,speed),movementStart(starts.get(f.id)!)),b=absoluteMovementSegment(fleetMovementSegment(other,position(s,other.destination),f.position,world,speed),movementStart(starts.get(other.id)!));
   if(![a.a,a.b,b.a,b.b].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)))continue;
   const fraction=clientRouteCollisionFraction(a,b);if(fraction!==null&&fraction>=Math.max(movementStart(starts.get(f.id)!),movementStart(starts.get(other.id)!)))events.push({type:'collision',subIndex:f.slot,otherSubIndex:other.slot,destination,timeFraction:fraction});
  }
 }
 return orderMovementEvents(events);
}
function processMovementEvent(s:FleetScenario,event:MovementEvent,silentLaunch=false){
 const world=s.initial.size,speed=fleetSpeed(s.economy.tick);
 const f=s.fleets.find(f=>f.slot===event.subIndex);if(!f?.used||f.drillers===0)return;
  if(event.type==='launch'){if(f.state==='launching'){if(!silentLaunch){captureActivity(s,'departed',f.id,{},event.timeFraction,s.economy.tick-1);emit(s,'departed',f.id,{drillers:f.drillers},event.timeFraction);}launchFleet(f,updateTrueDestination(s,f),world,speed,()=>{if(!silentLaunch)captureRuleNotification(s,'departed',f.id,{},event.timeFraction);});}}
  else if(f.destination===s.economy.outposts[event.destination.index]?.id){
   if(event.type==='arrival')arrival(s,f,event.timeFraction);
   else{const other=s.fleets.find(f=>f.slot===event.otherSubIndex);if(other?.used&&other.drillers>0&&other.slot>=f.slot&&other.owner!==f.owner)battle(s,f,other,event.timeFraction);}
  }

}

function movementEventKey(s:FleetScenario,event:MovementEvent){
 const f=s.fleets.find(f=>f.slot===event.subIndex),other=s.fleets.find(f=>f.slot===event.otherSubIndex);
 return JSON.stringify([event.type,f?.id,f?.source,f?.destination,other?.id,event.timeFraction]);
}
function kinematics(f:Fleet){return {position:clone(f.position),previous:clone(f.previous),state:f.state,secondsUntilLaunch:f.secondsUntilLaunch,fractionMoved:f.fractionMoved};}
/** Settle actual due events before accepting a command. The private planner may
 * inspect a full interval, but future movement and events never enter authority.
 * Surviving fleets retain their boundary baseline; the whole tick later applies
 * movement once and skips already-settled battles/arrivals. */
function settleMovementThrough(s:FleetScenario,fraction:number){
 if(s.forecastPlayer!==undefined||!s.fleets.some(f=>f.used&&f.drillers>0))return;
 const projected={...s,economy:{...s.economy,tick:s.economy.tick+1},fleets:structuredClone(s.fleets)};
 const events=prepareMovementEvents(projected).filter(e=>e.timeFraction<=fraction);
 for(const event of events){
  const key=movementEventKey(projected,event);
  if(s.settledMovement?.tick===s.economy.tick&&s.settledMovement.events.includes(key))continue;
  const originals=new Map<Fleet,ReturnType<typeof kinematics>>();
  for(const slot of [event.subIndex,event.otherSubIndex]){const actual=s.fleets.find(f=>f.slot===slot),prepared=projected.fleets.find(f=>f.slot===slot);if(actual&&prepared){originals.set(actual,kinematics(actual));Object.assign(actual,kinematics(prepared));}}
  const tick=s.economy.tick,seconds=s.secondsSinceLastTick;s.economy.tick++;delete s.secondsSinceLastTick;
  processMovementEvent(s,event);
  s.economy.tick=tick;if(seconds!==undefined)s.secondsSinceLastTick=seconds;
  for(const [fleet,original]of originals)Object.assign(fleet,original);
  (s.settledMovement??={tick,events:[]}).events.push(key);
  // Ownership changes interrupt continuous protected-border credit immediately.
  if(s.initial.match)resolveAssetLoss(s);
  advanceDiplomacy(s.diplomacy,fleetDiplomacyWorld(s),tick+event.timeFraction);
 }
}

function tick(s:FleetScenario,simulatedFuture=false){
 delete s.secondsSinceLastTick;let cursor=s.economy.events.length;s.economy=beginOwnedEconomicTick(s.economy,fleetTotals(s));mirrorEconomyEvents(s,cursor);
 for(const event of prepareMovementEvents(s)){
  const settled=s.settledMovement?.tick===s.economy.tick-1&&s.settledMovement.events.includes(movementEventKey(s,event));
  if(!settled||event.type==='launch')processMovementEvent(s,event,!!settled);
  if(!settled&&s.forecastPlayer===undefined){if(s.initial.match)resolveAssetLoss(s);advanceDiplomacy(s.diplomacy,fleetDiplomacyWorld(s),s.economy.tick-1+event.timeFraction);}
 }
 delete s.settledMovement;
 for(const f of s.fleets)if(f.used&&f.drillers===0){if(!s.events.some(e=>e.tick===s.economy.tick&&e.subject===f.id&&e.kind==='unloaded'))captureActivity(s,'fleet-removed',f.id,{},0);destroyFleet(s,f);emit(s,'fleet-removed',f.id);}
 cursor=s.economy.events.length;finishEconomicTick(s.economy);mirrorEconomyEvents(s,cursor);tickInactivity(s,simulatedFuture);checkMatchEnd(s);
 if(s.forecastPlayer===undefined)advanceDiplomacy(s.diplomacy,fleetDiplomacyWorld(s),s.economy.tick);
}

/** Settle an authoritative day-internal boundary without synthesizing a player command. */
export function settleFleetScenarioPhase(state:FleetScenario,seconds:number):FleetScenario{
 return settleScenarioPhase(state,seconds,true);
}
function settleScenarioPhase(state:FleetScenario,seconds:number,recordPhase:boolean):FleetScenario{
 commandSeconds(seconds,state.secondsSinceLastTick??0);
 if(state.forecastPlayer!==undefined)throw Error('Authority phase required');
 const next=clone(state);settleMovementThrough(next,seconds/600);
 next.secondsSinceLastTick=seconds;checkMatchEnd(next);
 advanceDiplomacy(next.diplomacy,fleetDiplomacyWorld(next),next.economy.tick+seconds/600);
 if(recordPhase)(next.phaseSettlements??=[]).push({tick:state.economy.tick,seconds,afterCommand:state.commands.length});
 return next;
}

/** Immutable public entry point; sibling branches retain their original state. */
export function advanceFleetScenario(state:FleetScenario,targetTick:number,simulatedFuture=false):FleetScenario{
  return advanceOwnedFleetScenario(clone(state),targetTick,simulatedFuture);
}
export function advanceOwnedFleetScenario(state:FleetScenario,targetTick:number,simulatedFuture=false):FleetScenario{
 if(!simulatedFuture&&(state.forecastPlayer!==undefined||state.forecastVictoryEnabled!==undefined||state.forecastTerminal!==undefined||state.forecastActivity!==undefined||state.economy.outposts.some(o=>o.futureUnknown)))throw Error('Prediction state requires simulated future');
 count(targetTick,1e7);if(targetTick<state.economy.tick||targetTick-state.economy.tick>10000)throw Error('Invalid scenario horizon');while(state.economy.tick<targetTick&&!fleetForecastStopped(state))tick(state,simulatedFuture);return state;
}

export interface FleetReplay {format:'fleet-replay/6';profile:typeof PROFILE_ID;initial:FleetSetup;commands:FleetRecord[];targetTick:number;targetSeconds?:number;phaseSettlements?:FleetPhaseSettlement[]}
export function exportFleetReplay(s:FleetScenario):FleetReplay{if(s.forecastPlayer!==undefined||s.forecastVictoryEnabled!==undefined||s.forecastTerminal!==undefined||s.forecastActivity!==undefined||s.economy.outposts.some(o=>o.futureUnknown))throw Error('Prediction state cannot be exported');return {format:'fleet-replay/6',profile:PROFILE_ID,initial:clone(s.initial),commands:clone(s.commands),...(s.phaseSettlements?{phaseSettlements:clone(s.phaseSettlements)}:{}),targetTick:s.economy.tick,...(s.secondsSinceLastTick!==undefined?{targetSeconds:s.secondsSinceLastTick}:{})};}

function advanceReplayTo(s:FleetScenario,target:number,beforeTick?:()=>void):FleetScenario{
  // All targets are validated by the replay reader; only this private world is
  // mutated. Avoid cloning the entire accumulated history before every tick.
  while(s.economy.tick<target&&!fleetMatchOutcome(s)){beforeTick?.();tick(s);}return s;
}
/** Only the local persistence/history path may bypass portable import budgets. */
export interface FleetStorageOptions {
  trustedLocalStorage?:boolean;
  /** Private persistence cache, populated only after strict snapshot verification.
   * The initial setup and complete command prefix must still match; the newly
   * replayed state is compared to the full saved expected state as usual. */
  verifiedReplayBase?:FleetScenario;
}
function parsePhaseSettlements(raw:unknown,commands:readonly unknown[],targetTick:number):FleetPhaseSettlement[]{
 if(raw===undefined)return [];
 if(!Array.isArray(raw)||raw.length>1000000)throw Error('Invalid phase settlements');
 let cursor=0,tick=0,seconds=0;
 return raw.map(value=>{const r=record(value);exact(r,['tick','seconds','afterCommand']);count(r.tick,targetTick);count(r.afterCommand,commands.length);const phase=commandSeconds(r.seconds as number);
  if((r.afterCommand as number)<cursor||(r.tick as number)<tick||r.tick===tick&&phase<seconds)throw Error('Phase settlements must be chronological');
  cursor=r.afterCommand as number;tick=r.tick as number;seconds=phase;
  const before=cursor?record(commands[cursor-1]):undefined,after=cursor<commands.length?record(commands[cursor]):undefined;
  if(before&&((before.tick as number)>tick||before.tick===tick&&Number(before.seconds??0)>seconds)||after&&((after.tick as number)<tick||after.tick===tick&&Number(after.seconds??0)<seconds))throw Error('Phase settlements must be chronological with commands');
  return {tick,seconds,afterCommand:cursor};
 });
}
/** Optional observer sees each tick before phase-positive commands or clock settlements. */
export function replayFleetScenario(input:unknown,options:FleetStorageOptions={},observeTick?:(state:FleetScenario)=>void):FleetScenario{
  const r=record(input);exact(r,['format','profile','initial','commands','targetTick',...(Object.hasOwn(r,'targetSeconds')?['targetSeconds']:[]),...(Object.hasOwn(r,'phaseSettlements')?['phaseSettlements']:[])]);
  if(r.format!=='fleet-replay/6'||r.profile!==PROFILE_ID)throw new Error('Unsupported replay version or profile');
  count(r.targetTick,1e7);
  if(!Array.isArray(r.commands)||!options.trustedLocalStorage&&r.commands.length>10000)throw new RangeError('Invalid command history');
  const commands=r.commands;
  const phases=parsePhaseSettlements(r.phaseSettlements,commands,r.targetTick as number);
  const base=options.trustedLocalStorage&&!observeTick?options.verifiedReplayBase:undefined;
  const resume=base&&base.profile===r.profile&&base.economy.tick<=r.targetTick&&
    JSON.stringify(base.initial)===JSON.stringify(r.initial)&&base.commands.length<=commands.length&&
    base.commands.every((command,index)=>JSON.stringify(command)===JSON.stringify(commands[index]))&&
    (base.phaseSettlements??[]).every((phase,index)=>JSON.stringify(phase)===JSON.stringify(phases[index]))&&
    phases.slice(base.phaseSettlements?.length??0).every(phase=>phase.tick>=base.economy.tick&&phase.afterCommand>=base.commands.length);
  let s=resume?clone(base):createFleetScenario(r.initial as FleetSetup);
  if(r.targetTick<s.economy.tick)throw new RangeError('Invalid replay horizon');
  let observedTick=-1;
  const observe=()=>{if(observeTick&&observedTick!==s.economy.tick){observeTick(s);observedTick=s.economy.tick;}};
  let phaseCursor=resume?(base.phaseSettlements?.length??0):0;
  const settleBefore=(cursor:number)=>{while(phaseCursor<phases.length&&phases[phaseCursor]!.afterCommand===cursor){
    const phase=phases[phaseCursor++]!;
    if(phase.tick<s.economy.tick)throw Error('Phase settlements must be chronological');
    s=advanceReplayTo(s,phase.tick,observe);if(phase.seconds>0)observe();s=settleFleetScenarioPhase(s,phase.seconds);
  }};
  for(let index=resume?base.commands.length:0;index<commands.length;index++){settleBefore(index);const raw=commands[index];const c=record(raw);exact(c,['id','player','action','tick',...(Object.hasOwn(c,'seconds')?['seconds']:[]),...(Object.hasOwn(c,'activityCheckin')?['activityCheckin']:[])]);if(Object.hasOwn(c,'activityCheckin')&&c.activityCheckin!==true)throw Error('Invalid action check-in record');count(c.tick,r.targetTick);
    if(c.tick<s.economy.tick)throw new Error('Commands must be chronological');
    const command=parseFleetOrder({id:c.id,player:c.player,action:c.action});s=advanceReplayTo(s,c.tick,observe);
    const phase=c.seconds===undefined?0:commandSeconds(c.seconds as number);
    if(phase>0)observe();
    const result=applyFleetOrder(s,command,phase,false,options.trustedLocalStorage,c.activityCheckin===true);if(result.duplicate)throw new Error('Duplicate command in replay');s=result.state;
  }
  settleBefore(commands.length);
  s=advanceReplayTo(s,r.targetTick,observe);observe();if(r.targetSeconds!==undefined){const phase=commandSeconds(r.targetSeconds as number,s.secondsSinceLastTick??0);if(s.secondsSinceLastTick===undefined||phase>s.secondsSinceLastTick)s=settleScenarioPhase(s,phase,false);}return s;
}
/** Resumable private history branches. Checkpoints retain the exact command
 * cursor and transient journals; no state from a running game is accepted. */
export function createFleetReplaySession(input:FleetReplay,options:FleetStorageOptions={}){
  const replay=clone(input),start=replay.initial.economy.initialTick;
  count(replay.targetTick,1e7);
  if(replay.targetTick<start||!Array.isArray(replay.commands)||!options.trustedLocalStorage&&replay.commands.length>10000)throw Error('Invalid command history');
  const {targetSeconds:trailingPhase,...boundaryReplay}=replay;
  const initial=replayFleetScenario({...boundaryReplay,commands:[],phaseSettlements:undefined,targetTick:start},options);
  let previous=start;
  const commands=replay.commands.map(raw=>{
    const c=record(raw);exact(c,['id','player','action','tick',...(Object.hasOwn(c,'seconds')?['seconds']:[]),...(Object.hasOwn(c,'activityCheckin')?['activityCheckin']:[])]);if(Object.hasOwn(c,'activityCheckin')&&c.activityCheckin!==true)throw Error('Invalid action check-in record');count(c.tick,replay.targetTick);
    if(c.tick<previous)throw Error('Commands must be chronological');previous=c.tick;
    return {order:parseFleetOrder({id:c.id,player:c.player,action:c.action}),tick:c.tick as number,seconds:c.seconds===undefined?0:commandSeconds(c.seconds as number),activityCheckin:c.activityCheckin===true};
  });
  const phases=parsePhaseSettlements(replay.phaseSettlements,replay.commands,replay.targetTick);
  type Checkpoint={state:FleetScenario;cursor:number;phaseCursor:number;anchor:boolean};
  const checkpoints=new Map<number,Checkpoint>([[start,{state:initial,cursor:0,phaseCursor:0,anchor:true}]]);
  const interval=Math.max(32,Math.ceil((replay.targetTick-start)/16));
  let working=clone(initial),cursor=0,phaseCursor=0,target=start,advancedTicks=0,commandsApplied=0;
  function remember(){
    checkpoints.delete(working.economy.tick);
    checkpoints.set(working.economy.tick,{state:clone(working),cursor,phaseCursor,anchor:(working.economy.tick-start)%interval===0});
    if(checkpoints.size>24){
      const oldest=[...checkpoints].find(([at,point])=>at!==start&&!point.anchor)?.[0]??[...checkpoints.keys()].find(at=>at!==start);
      if(oldest!==undefined)checkpoints.delete(oldest);
    }
  }
  return {
    begin(at:number){
      if(!Number.isInteger(at)||at<start||at>replay.targetTick)throw Error('Invalid history horizon');
      let best=checkpoints.get(start)!;
      for(const [tick,point]of checkpoints)if(tick<=at&&tick>best.state.economy.tick)best=point;
      if(working.economy.tick<=at&&working.economy.tick>best.state.economy.tick)best={state:working,cursor,phaseCursor,anchor:false};
      working=clone(best.state);cursor=best.cursor;phaseCursor=best.phaseCursor;target=at;
    },
    step(budget=8){
      if(!Number.isInteger(budget)||budget<1)throw Error('Invalid history step budget');
      const stop=Math.min(target,working.economy.tick+budget);
      while(true){
        while(true){
          const phase=phases[phaseCursor];
          if(phase&&phase.afterCommand===cursor&&phase.tick===working.economy.tick){working=settleFleetScenarioPhase(working,phase.seconds);phaseCursor++;continue;}
          if(cursor>=commands.length||commands[cursor]!.tick!==working.economy.tick)break;
          const c=commands[cursor]!;
          const result=applyFleetOrder(working,c.order,c.seconds,false,false,c.activityCheckin);if(result.duplicate)throw Error('Duplicate command in replay');
          working=result.state;cursor++;commandsApplied++;
        }
        if(working.economy.tick===target||fleetMatchOutcome(working)){remember();return true;}
        if((working.economy.tick-start)%interval===0)remember();
        if(working.economy.tick>=stop){remember();return false;}
        tick(working);advancedTicks++;
      }
    },
    snapshot:()=>clone(working),
    stats:()=>({advancedTicks,commandsApplied,checkpoints:checkpoints.size,workingTick:working.economy.tick}),
  };
}
export function saveFleetSnapshot(s:FleetScenario,options:FleetStorageOptions={}):string{
  if(!options.trustedLocalStorage&&s.commands.length>10000)throw new RangeError('Portable snapshot command limit; use local database backup');
  const text=JSON.stringify({format:'fleet-snapshot/6',replay:exportFleetReplay(s),expected:s});
  if(!options.trustedLocalStorage&&text.length>20_000_000)throw new RangeError('Snapshot too large');return text;
}
export function restoreFleetSnapshot(text:string,options:FleetStorageOptions={}):FleetScenario{if(!options.trustedLocalStorage&&text.length>20_000_000)throw Error('Snapshot too large');const r=record(JSON.parse(text));exact(r,['format','replay','expected']);if(r.format!=='fleet-snapshot/6')throw Error('Unsupported snapshot version');const s=replayFleetScenario(r.replay,options);if(JSON.stringify(s)!==JSON.stringify(r.expected))throw Error('Snapshot and replay disagree');return s;}




/** No hidden enemy assets are inferred absent in a restricted forecast. */
function resolveAssetLoss(s:FleetScenario){
 for(let owner=0;owner<s.economy.players.length;owner++){
  if(!s.economy.players[owner]!.active)continue;
  if(s.forecastPlayer!==undefined&&owner!==s.forecastPlayer&&s.forecastTerminal?.reasons.length!==0)continue;
  if(s.economy.outposts.some(o=>!o.destroyed&&o.owner===owner)||s.fleets.some(f=>f.used&&f.owner===owner&&f.drillers>0))continue;
  if(s.forecastPlayer!==undefined&&s.events.some(e=>e.kind==='future-unknown-arrival'&&e.details.owner===owner))continue;
  retirePlayer(s.economy.players,s.economy.funding,owner);emit(s,'player-eliminated',String(owner),{owner,reason:'assets-lost'});
 }
}
