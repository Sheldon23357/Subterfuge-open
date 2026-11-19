import {dispatchGuard} from './dispatch-guard.js';
import {manualCommandView} from './manual-commands.js';
import {createHash} from 'node:crypto';
import {projectPlayerView,projectPlayerActivity,projectGlobalBattleLosses,projectPlayerCommandHead,fleetPublicIntel,originalOutpostNames,projectDiplomacy,fleetDiplomacyWorld} from '../../engine/src/index.js';
import type {PlayerObservation} from '../../contracts/src/index.js';
import type {LabRoom} from './planning.js';
/** Elapsed display countdowns are not new decisions; keep discrete window changes.
 * All other projected fields remain in the revision, including visibility/capacity.
 */
function revisionView(view:PlayerObservation['view']){
 const fleets=view.fleets.map(f=>{
  const {launchRemainingSeconds,giftPendingSeconds,...stable}=f;
  return {...stable,
   ...(launchRemainingSeconds!==undefined?{launchWindowOpen:launchRemainingSeconds>0}:{}),
   ...(giftPendingSeconds!==undefined?{giftWindowOpen:giftPendingSeconds>0}:{})};
 });
 return {...view,fleets,outposts:view.outposts.map(o=>{
  const {mineRemainingSeconds,shieldDisableRemainingSeconds,...stable}=o;
  const windows={...(mineRemainingSeconds!==undefined?{mineWindowOpen:mineRemainingSeconds>0}:{}),...(shieldDisableRemainingSeconds!==undefined?{shieldDisableWindowOpen:shieldDisableRemainingSeconds>0}:{})};
  if(!('metrics'in o))return {...stable,...windows};
  const {nextMinutes,...metrics}=o.metrics;return{...stable,...windows,metrics};
 })};
}
export function observation(room:LabRoom,player:number,roomId:string,seconds=room.state.secondsSinceLastTick??0):PlayerObservation{
  const view=projectPlayerView({...room.state,secondsSinceLastTick:seconds},player);
  const teamSize=room.state.economy.initial.teamSize;
  const scheduled=[...room.scheduled,...(room.scheduledOrders??[])].filter(p=>p.player===player||teamSize>0&&Math.floor(p.player/teamSize)===Math.floor(player/teamSize)&&room.state.economy.players[p.player]!.active)
    .map(p=>({id:p.id,player:p.player,issueTick:p.issueTick,action:structuredClone(p.action),status:p.status,...(p.failed?{failed:true}:{}),...(p.reason?{reason:p.reason}:{})}));
    const names=originalOutpostNames(room.map?.seed??0,room.state.economy.outposts.length);
    const outpostNames=Object.fromEntries(room.state.economy.outposts.map((o,i)=>[o.id,names?.[i]??o.id]));
    const activity=projectPlayerActivity(room.state,player);
    const diplomacy=projectDiplomacy(room.state.diplomacy,fleetDiplomacyWorld(room.state),player);
    const result={roomId,diplomacy,battleLosses:projectGlobalBattleLosses(room.state),dispatchGuard:dispatchGuard(room,player),manualCommands:manualCommandView(room,player),view,outpostNames,activity,activityCursor:(activity.at(-1)?.id??-1)+1,intel:fleetPublicIntel({...room.state,secondsSinceLastTick:seconds}),scheduled,historyStartTick:room.state.initial.economy.initialTick,realtime:!!room.clock};
  // The journal is append-only with unique command IDs. Its latest own command
  // identifies the own-command prefix without hashing the entire match again.
  const ownCommandHead=projectPlayerCommandHead(room.state,player);
  return {...result,secondsSinceLastTick:seconds,revision:createHash('sha256').update(JSON.stringify({result:{...result,view:revisionView(view)},ownCommandHead})).digest('hex')};
}

/** One immutable world cut, with isolated seat/time projections. Hosts supply an
 * authoritative version; elapsed seconds are included so realtime transitions
 * and countdown displays never reuse a projection from a different instant. */
export class PlayerObservationReader {
 private cut:{roomId:string;revision:number;state:LabRoom['state']}|null=null;
 private seats=new Map<number,{seconds:number;value:PlayerObservation}>();
 constructor(private project=observation){}
 read(room:LabRoom,player:number,roomId:string,revision:number,seconds=room.state.secondsSinceLastTick??0){
  // Mutable/custom hosts may edit their room in place. Only a host-published
  // immutable cut is a cacheable identity, regardless of a supplied revision.
  if(!Object.isFrozen(room))return this.project(room,player,roomId,seconds);
  if(!this.cut||this.cut.roomId!==roomId||this.cut.revision!==revision||this.cut.state!==room.state){this.cut={roomId,revision,state:room.state};this.seats.clear();}
  const cached=this.seats.get(player);if(cached?.seconds===seconds)return cached.value;
  const value=this.project(room,player,roomId,seconds);this.seats.set(player,{seconds,value});return value;
 }
}
