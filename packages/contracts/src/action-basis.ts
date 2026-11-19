import type {PlayerObservation,PlayerMapView} from './index.js';
import {canonicalProtocolJson} from './player-protocol-wire.js';

/** Authorized execution dependencies, not a claim of global strategic equivalence. */
export function actionBasisMaterial(observation:PlayerObservation,action:Record<string,unknown>):string|null{
 if(!action||typeof action!=='object'||Array.isArray(action))return null;
 const v=observation.view,related=new Set<string>();
 if(action.kind==='launch'&&(action.delaySeconds===undefined||action.delaySeconds===0)&&typeof action.source==='string'&&typeof action.destination==='string'){
  related.add(action.source);related.add(action.destination);
 }else if(action.kind==='return-fleet'&&typeof action.fleetId==='string'){
  const fleet=v.fleets.find(f=>f.id===action.fleetId&&f.owner===v.player);
  if(!fleet?.source)return null;
  related.add(fleet.source);if(fleet.destination?.kind==='outpost')related.add(fleet.destination.id);
 }else return null;
 const outpost=(o:PlayerMapView['outposts'][number])=>{
  if(o.owner!==v.player&&!related.has(o.id))return {id:o.id,owner:o.owner,visibility:o.visibility,type:o.type,destroyed:o.destroyed,position:o.position};
  const {mineRemainingSeconds,shieldDisableRemainingSeconds,metrics,...stable}=o;
  return {...stable,...(mineRemainingSeconds===undefined?{}:{mineWindowOpen:mineRemainingSeconds>0}),...(shieldDisableRemainingSeconds===undefined?{}:{shieldWindowOpen:shieldDisableRemainingSeconds>0}),...(metrics?{metrics:(({nextMinutes,...rest})=>rest)(metrics)}:{})};
 };
 const fleets=v.fleets.filter(f=>f.owner===v.player||!f.destination||f.destination.kind!=='outpost'||related.has(f.destination.id)).map(f=>{
  const {launchRemainingSeconds,giftPendingSeconds,...stable}=f;
  return {...stable,...(launchRemainingSeconds===undefined?{}:{launchWindowOpen:launchRemainingSeconds>0}),...(giftPendingSeconds===undefined?{}:{giftWindowOpen:giftPendingSeconds>0})};
 }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const {activity,...self}=v.self;
 const projection={format:'action-basis/1',roomId:observation.roomId,player:v.player,tick:v.tick,profile:v.profile,size:v.size,teamSize:v.teamSize,playerCount:v.playerCount,launchCancellationLockTick:v.launchCancellationLockTick,match:v.match,self,
  action,outposts:v.outposts.map(outpost).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),fleets,
  scheduled:observation.scheduled,dispatchGuard:observation.dispatchGuard,manualCommands:observation.manualCommands,agreements:observation.diplomacy?.agreements};
 // JSON normalization matches wire omission of absent optional values.
 return canonicalProtocolJson(JSON.parse(JSON.stringify(projection)));
}
