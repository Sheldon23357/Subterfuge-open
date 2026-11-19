import {createHash} from 'node:crypto';
import {economicMineCreationCost,fleetMatchOutcome,projectPlayerView,parseFleetOrder,type FleetOrder} from '../../engine/src/index.js';
import type {QueuedOrderView,ManualCommandReceipt,ManualCommandProtection,ManualCommandView} from '../../contracts/src/index.js';
import type {LabRoom} from './planning.js';
export type CommandSource='manual'|'agent';
interface Protection extends ManualCommandProtection {player:number;eventCursor:number;fleetId?:string;scheduleId?:string;outpostId?:string;actionKind?:string;source?:string;destination?:string;drillers?:number;destinationOwner?:number|null;retainSetting?:boolean;recipient?:number;}
export interface HypotheticalManualCoordination {actors:Record<string,number>;protections:Protection[];}
export interface ManualCoordination {receipts:ManualCommandReceipt[];protections:Protection[];provenance:Record<string,CommandSource>;}
export class ManualCommandConflict extends Error {
 readonly code='MANUAL_COMMAND_CONFLICT';
 constructor(message='This action conflicts with an active manual commander choice',readonly cancelledScheduleIds?:string[],readonly cancellationToken?:string,readonly cancelledSchedules?:QueuedOrderView[]){super(message);}
}
const protectionsFor=(room:LabRoom)=>[...(room.manualCoordination?.protections??[]),...(room.hypotheticalManualCoordination?.protections??[])];
/** Read-only legacy fact: never restore authority that an archived snapshot already removed. */
function receiptReleased(room:LabRoom,id:string){return room.manualCoordination?.receipts.some(r=>r.kind==='release-protection'&&r.releasedReceiptIds?.includes(id))??false;}
export function isManualOrder(room:LabRoom,order:FleetOrder){const receipt=room.manualCoordination?.receipts.find(r=>r.orderId===order.id);return commandSource(room,order.id)==='manual'&&!!receipt&&!receiptReleased(room,receipt.id)||room.hypotheticalManualCoordination?.actors[order.id]===order.player;}
const plans=(room:LabRoom)=>[...room.scheduled,...(room.scheduledOrders??[])];
export function manualCommandVersion(room:LabRoom,player:number){return room.manualCoordination?.receipts.filter(r=>r.player===player).at(-1)?.version??0;}
export function commandSource(room:LabRoom,id:string){const provenance=room.manualCoordination?.provenance;return provenance&&Object.hasOwn(provenance,id)?provenance[id]:undefined;}
const route=(source:string,destination:string)=>[`source:${source}`,`destination:outpost:${destination}`];
/** Re-open a cancelled route only on observed tactical change, never a forecast or production tick. */
function changedRouteSituation(room:LabRoom,p:Protection,event:LabRoom['state']['events'][number]){
 if(p.kind!=='route'||event.kind!=='battle')return false;
 const target=event.details.target;
 return typeof target==='string'&&!room.state.fleets.some(f=>f.id===target)&&(target===p.source||target===p.destination);
}
function active(room:LabRoom,p:Protection){
 const later=room.state.events.slice(p.eventCursor);
 if(later.some(e=>changedRouteSituation(room,p,e)||p.kind==='fleet'&&e.subject===p.fleetId&&['fleet-removed','unloaded','launch-cancelled','fleet-recalled'].includes(e.kind)||p.kind==='route'&&(e.kind==='outpost-captured'&&(e.subject===p.source||e.subject===p.destination))||p.kind==='outpost'&&e.kind==='outpost-captured'&&e.subject===p.outpostId))return false;
 if(fleetMatchOutcome(room.state)||!room.state.economy.players[p.player]?.active)return false;
 const expiresAtTick=p.expiresAtTick;if(expiresAtTick!==undefined&&room.state.economy.tick>=expiresAtTick)return false;
 if(p.scheduleId&&plans(room).some(s=>s.id===p.scheduleId&&s.status==='pending'))return true;
 if(p.kind==='schedule'||p.kind==='resources')return false;
 if(p.kind==='fleet')return !!room.state.fleets.find(f=>f.id===p.fleetId&&f.used&&f.owner===p.player);
 if(p.kind==='funding')return !!room.state.economy.players[p.recipient!]?.active;


 if(p.kind==='outpost'){
  const outpost=room.state.economy.outposts.find(o=>o.id===p.outpostId&&o.owner===p.player&&!o.destroyed);
  return !!outpost&&(p.actionKind!=='toggle-mine'||outpost.minePending||p.retainSetting===true&&outpost.type!=='mine');
 }
 if(p.kind==='route'){
  if(!room.state.economy.outposts.some(o=>o.id===p.source&&o.owner===p.player&&!o.destroyed))return false;
  return room.state.economy.outposts.some(o=>o.id===p.destination&&!o.destroyed&&o.owner===p.destinationOwner);
 }
 return true;
}
export function manualCommandView(room:LabRoom,player:number):ManualCommandView{
 const protections=(room.manualCoordination?.protections??[]).filter(p=>p.player===player&&active(room,p));
 const all=(room.manualCoordination?.receipts??[]).filter(r=>r.player===player),ids=new Set(protections.map(p=>p.receiptId));
 for(const recent of all.slice(-100))for(const id of recent.releasedReceiptIds??[])ids.add(id);
 const receipts=all.filter((r,i)=>i>=all.length-100||ids.has(r.id));
 return {version:all.at(-1)?.version??0,receipts:structuredClone(receipts),protections:protections.map(p=>{const {receiptId,kind,scope}=p,expiresAtTick=p.expiresAtTick;return {receiptId,kind,scope:[...scope],...(expiresAtTick===undefined?{}:{expiresAtTick})};}),receiptsFromVersion:receipts[0]?.version??0,hasEarlierReceipts:receipts.length<all.length};
}
export function manualReceiptPage(room:LabRoom,player:number,query:URLSearchParams){
 if([...query.keys()].some(k=>!['after','limit','id'].includes(k))||[...query.keys()].some(k=>query.getAll(k).length!==1))throw Error('Invalid manual command query');
 const all=(room.manualCoordination?.receipts??[]).filter(r=>r.player===player),version=manualCommandVersion(room,player),id=query.get('id');
 if(id!==null){if(query.size!==1)throw Error('Invalid manual command query');return {version,receipts:structuredClone(all.filter(r=>r.id===id)),nextCursor:version,hasMore:false};}
 const a=query.get('after')??'0',l=query.get('limit')??'100';if(!/^\d+$/.test(a)||!/^\d+$/.test(l))throw Error('Invalid manual command cursor');
 const after=Number(a),limit=Number(l);if(!Number.isSafeInteger(after)||after>version||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('Invalid manual command cursor');
 const receipts=all.filter(r=>r.version>after).slice(0,limit);return {version,receipts:structuredClone(receipts),nextCursor:receipts.at(-1)?.version??after,hasMore:(receipts.at(-1)?.version??after)<version};
}

function impactedFleetIds(room:LabRoom,order:FleetOrder){
 const a=order.action;if('fleetId'in a&&a.fleetId)return[a.fleetId];
 if(a.kind==='launch')return room.state.fleets.filter(f=>f.used&&f.owner===order.player&&f.state==='waiting'&&f.source===a.source&&f.destination===a.destination).map(f=>f.id);
 return[];
}
/** Policy is separate from, and never relaxes, the original engine's legality. */
export function assertManualCommandPriority(room:LabRoom,order:FleetOrder){
 const a=order.action,protections=protectionsFor(room).filter(p=>p.player===order.player&&active(room,p)),fleets=impactedFleetIds(room,order);
 for(const p of protections){
  if(p.kind==='funding'&&a.kind==='toggle-funding'&&a.recipient===p.recipient)throw new ManualCommandConflict('This funding choice is protected by the commander');

  if(p.kind==='fleet'&&p.fleetId&&fleets.includes(p.fleetId))throw new ManualCommandConflict();
  if(p.kind==='route'&&a.kind==='launch'&&a.source===p.source&&a.destination===p.destination)throw new ManualCommandConflict('The cancelled route remains protected while the relevant tactical situation is unchanged; reassess after a battle, target lifecycle or ownership change');
  if(p.kind==='resources'&&a.kind==='launch'&&a.source===p.source&&p.scope.includes(`destination:outpost:${a.destination}`))throw new ManualCommandConflict('This route is reserved by a pending manual schedule');
  if(p.kind==='schedule'&&a.kind==='launch'&&a.fleetId===p.fleetId)throw new ManualCommandConflict();

  if(p.kind==='outpost'&&'outpostId'in a&&a.outpostId===p.outpostId&&a.kind===p.actionKind)throw new ManualCommandConflict();
 }


 if(a.kind==='launch'){
  const resources=protections.filter(p=>p.kind==='resources');

  const reserved=resources.filter(p=>p.source===a.source).reduce((n,p)=>n+(p.drillers??0),0);
  const available=room.state.economy.outposts.find(o=>o.id===a.source)?.drillers??0;
  const returned=room.state.fleets.filter(f=>fleets.includes(f.id)).reduce((n,f)=>n+f.drillers,0);
  if(reserved>0&&a.drillers>Math.max(0,available-reserved)+returned)throw new ManualCommandConflict('Drillers are reserved by a pending manual schedule');
 }
}
export function assertCancellationPriority(room:LabRoom,next:LabRoom,id:string,player:number,source:CommandSource,confirmed:unknown=undefined,confirmationToken:unknown=undefined){
 const changed=plans(next).filter(p=>p.player===player&&p.status==='cancelled'&&plans(room).some(o=>o.id===p.id&&o.status!=='cancelled')).map(p=>p.id);
 const token=createHash('sha256').update(JSON.stringify({id,player,tick:room.state.economy.tick,version:manualCommandVersion(room,player),plans:plans(room).filter(p=>changed.includes(p.id))})).digest('hex');
 const protectedIds=protectionsFor(room).filter(p=>p.player===player&&active(room,p)).flatMap(p=>[...(p.scheduleId?[p.scheduleId]:[]),...plans(room).filter(plan=>p.fleetId&&plan.action.kind==='launch'&&(plan.action.fleetId??plan.id)===p.fleetId).map(plan=>plan.id)]);
 const manual=changed.filter(key=>protectedIds.includes(key));
 if(source==='agent'&&manual.length)throw new ManualCommandConflict('Cancelling this schedule would also cancel a manual commander schedule',changed);
 const collateral=manual.filter(key=>key!==id);
 if(source==='manual'&&collateral.length&&(confirmationToken!==token||!Array.isArray(confirmed)||confirmed.some(v=>typeof v!=='string')||new Set(confirmed).size!==confirmed.length||[...confirmed].sort().join('\0')!==[...collateral].sort().join('\0')))throw new ManualCommandConflict('This cancellation also affects other manual schedules; explicitly confirm those schedule IDs',collateral,token,structuredClone(plans(room).filter(p=>collateral.includes(p.id))));
}
function tombstone(room:LabRoom,p:Protection,action:FleetOrder['action']){
 if(action.kind!=='launch')return;
 p.kind='route';p.source=action.source;p.destination=action.destination;p.scope=route(action.source,action.destination);p.destinationOwner=room.state.economy.outposts.find(o=>o.id===action.destination)?.owner??null;
}
/** Call only after engine validation produced a successful isolated next room; save it atomically with the world. */
export function recordCoordinatedCommand(before:LabRoom,next:LabRoom,input:{source:CommandSource;player:number;kind:'order'|'schedule'|'cancel-schedule';order?:FleetOrder;scheduleId?:string;seconds?:number}):LabRoom{
 const {source,player,kind,order,scheduleId}=input,id=order?.id??scheduleId!,existing=before.manualCoordination;
 if(order&&(before.state.commands.some(c=>c.id===id)||plans(before).some(p=>p.id===id)))return next;
 if(kind==='cancel-schedule'&&plans(before).find(p=>p.id===id)?.status==='cancelled')return next;
 // Presence housekeeping is an ordinary engine command, not a tactical commander intervention.
 if(order&&(order.action.kind==='check-in'||order.action.kind==='cancel-inactivity-warning'))return next;
 const data:ManualCoordination=structuredClone(existing??{receipts:[],protections:[],provenance:{}});
 data.protections=data.protections.filter(p=>active(before,p));
 if(order)Object.defineProperty(data.provenance,id,{value:source,enumerable:true,writable:true,configurable:true});
 if(source==='agent')return {...next,manualCoordination:data};
 const version=manualCommandVersion(before,player)+1,receiptId=`manual:${player}:${version}`,action=order?.action;
 const changedFleets=next.state.fleets.filter(f=>f.owner===player&&f.used&&JSON.stringify(f)!==JSON.stringify(before.state.fleets.find(old=>old.id===f.id))).map(f=>f.id);
 const cancelled=plans(next).filter(p=>p.player===player&&p.status==='cancelled'&&plans(before).some(o=>o.id===p.id&&o.status!=='cancelled')).map(p=>p.id);
 const receipt:ManualCommandReceipt={id:receiptId,version,player,tick:before.state.economy.tick,seconds:input.seconds??before.state.secondsSinceLastTick??0,kind,...(order?{orderId:order.id,action:structuredClone(order.action)}:{}),...(kind==='schedule'?{scheduleId:id}:kind==='cancel-schedule'?{scheduleId}:{}),outcome:kind==='schedule'?'scheduled':kind==='cancel-schedule'?'cancelled':'applied',affectedFleetIds:changedFleets,cancelledScheduleIds:cancelled};
 data.receipts.push(receipt);
 applyManualProtections(before,next,data,player,kind,order,scheduleId,receiptId);
 return {...next,manualCoordination:data};
}
/** Shared scope resolution; it creates guards only, never an action receipt. */
function applyManualProtections(before:LabRoom,next:LabRoom,data:Pick<ManualCoordination,'protections'>,player:number,kind:'order'|'schedule'|'cancel-schedule',order:FleetOrder|undefined,scheduleId:string|undefined,receiptId:string){
 const id=order?.id??scheduleId!,action=order?.action;
 const changedFleets=next.state.fleets.filter(f=>f.owner===player&&f.used&&JSON.stringify(f)!==JSON.stringify(before.state.fleets.find(old=>old.id===f.id))).map(f=>f.id);
 const cancelled=plans(next).filter(p=>p.player===player&&p.status==='cancelled'&&plans(before).some(o=>o.id===p.id&&o.status!=='cancelled')).map(p=>p.id);
 if(action?.kind==='toggle-funding')data.protections=data.protections.filter(p=>!(p.player===player&&p.kind==='funding'&&p.recipient===action.recipient));

 if(action?.kind==='launch')data.protections=data.protections.filter(p=>!(p.player===player&&p.kind==='route'&&p.source===action.source&&p.destination===action.destination));
 const add=(p:Omit<Protection,'receiptId'|'player'|'eventCursor'>)=>data.protections.push({receiptId,player,eventCursor:next.state.events.length,...p});
 // Keep historical facts, but replace the authority for a human-modified scope.
 const fleetIds=new Set([...changedFleets,...(order?impactedFleetIds(before,order):[])]);
 data.protections=data.protections.filter(p=>!(p.player===player&&(p.fleetId&&fleetIds.has(p.fleetId)||p.outpostId&&action&&'outpostId'in action&&p.outpostId===action.outpostId&&p.actionKind===action.kind)));
 for(const fleetId of changedFleets)add({kind:'fleet',fleetId,scope:[`fleet:${fleetId}`]});
 if(kind==='schedule'&&order){
  const identity=action!.kind==='launch'?(action!.fleetId??order.id):undefined;
  add({kind:'schedule',scheduleId:id,...(identity?{fleetId:identity}:{}),scope:[`schedule:${id}`]});
  if(action?.kind==='toggle-mine'&&!before.state.economy.outposts.find(o=>o.id===action.outpostId)?.minePending)add({kind:'resources',scheduleId:id,source:action.outpostId,drillers:economicMineCreationCost(before.state.economy,player),scope:[`source:${action.outpostId}`,'action:toggle-mine']});
  if(action?.kind==='launch'){
   add({kind:'resources',scheduleId:id,source:action.source,drillers:action.drillers,scope:[...route(action.source,action.destination),`drillers:${action.drillers}`]});
   add({kind:'fleet',scheduleId:id,fleetId:identity!,scope:[`fleet:${identity}`]});
  }
 }
 if(action?.kind==='cancel-launch'){
  const old=before.state.fleets.find(f=>f.id===action.fleetId);
  if(old?.source){const p:Protection={receiptId,player,eventCursor:next.state.events.length,kind:'route',scope:[]};tombstone(before,p,{kind:'launch',source:old.source,destination:old.destination,drillers:old.drillers});data.protections.push(p);}
 }
 for(const cancelledId of cancelled){const old=plans(before).find(p=>p.id===cancelledId)!;if(old.action.kind==='launch'){const p:Protection={receiptId,player,eventCursor:next.state.events.length,kind:'route',scope:[]};tombstone(before,p,old.action);data.protections.push(p);}}
 if(action?.kind==='toggle-funding')add({kind:'funding',recipient:action.recipient,scope:[`funding:${action.recipient}`]});

 for(const cancelledId of cancelled){const old=plans(before).find(p=>p.id===cancelledId)!.action;if('outpostId'in old)add({kind:'outpost',outpostId:old.outpostId,actionKind:old.kind,retainSetting:true,scope:[`outpost:${old.outpostId}`,`action:${old.kind}`]});if(old.kind==='toggle-funding')add({kind:'funding',recipient:old.recipient,scope:[`funding:${old.recipient}`]});if('fleetId'in old&&old.fleetId&&old.kind!=='launch')add({kind:'fleet',fleetId:old.fleetId,scope:[`fleet:${old.fleetId}`]});}
 if(action&&'outpostId'in action)add({kind:'outpost',outpostId:action.outpostId,actionKind:action.kind,...(action.kind==='toggle-mine'&&!next.state.economy.outposts.find(o=>o.id===action.outpostId)?.minePending?{retainSetting:true}:{}),scope:[`outpost:${action.outpostId}`,`action:${action.kind}`]});

}
/** Trusted owner draft in an isolated prediction only. No receipts, versions or persisted provenance are invented. */
export function coordinateHypotheticalManualOrder(before:LabRoom,next:LabRoom,order:FleetOrder,kind:'order'|'schedule'):LabRoom{
 const data={protections:structuredClone(protectionsFor(before).filter(p=>active(before,p)))};
 applyManualProtections(before,next,data,order.player,kind,order,undefined,`hypothetical:${order.id}`);
 const actors={...(before.hypotheticalManualCoordination?.actors??{})};Object.defineProperty(actors,order.id,{value:order.player,enumerable:true,writable:true,configurable:true});
 return {...next,...(before.manualCoordination?{manualCoordination:{...before.manualCoordination,protections:data.protections.filter(p=>!p.receiptId.startsWith('hypothetical:'))}}:{}),hypotheticalManualCoordination:{actors,protections:data.protections.filter(p=>p.receiptId.startsWith('hypothetical:'))}};
}
/** Expired authority is removed only in the same successful world transition, never by a read. */
export function reconcileManualProtections<T extends LabRoom>(room:T):T{
 let next=room;
 if(room.manualCoordination){const protections=room.manualCoordination.protections.filter(p=>active(room,p));if(protections.length!==room.manualCoordination.protections.length)next={...next,manualCoordination:{...room.manualCoordination,protections}};}
 if(room.hypotheticalManualCoordination){const protections=room.hypotheticalManualCoordination.protections.filter(p=>active(room,p));if(protections.length!==room.hypotheticalManualCoordination.protections.length)next={...next,hypotheticalManualCoordination:{...room.hypotheticalManualCoordination,protections}};}
 return next;
}
export function validateManualCoordination(raw:unknown,room:LabRoom):ManualCoordination{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid manual coordination');
 const data=raw as ManualCoordination;if(Object.keys(data).sort().join(',')!=='protections,provenance,receipts'||!Array.isArray(data.receipts)||!Array.isArray(data.protections)||!data.provenance||typeof data.provenance!=='object'||Array.isArray(data.provenance))throw Error('Invalid manual coordination');
 const versions=new Map<number,number>(),ids=new Set<string>(),text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256;
 const all=plans(room),commands=room.state.commands;
 for(const r of data.receipts){
  if(!r||r.id!==`manual:${r.player}:${r.version}`||ids.has(r.id)||!Number.isSafeInteger(r.player)||!room.state.economy.players[r.player]||r.version!==(versions.get(r.player)??0)+1||!Number.isSafeInteger(r.tick)||r.tick<0||r.tick>room.state.economy.tick||!Number.isFinite(r.seconds)||r.seconds<0||r.seconds>=600||!['order','schedule','cancel-schedule','release-protection'].includes(r.kind)||r.outcome!==(r.kind==='order'?'applied':r.kind==='schedule'?'scheduled':r.kind==='release-protection'?'released':'cancelled')||!Array.isArray(r.affectedFleetIds)||r.affectedFleetIds.some(v=>!text(v))||!Array.isArray(r.cancelledScheduleIds)||r.cancelledScheduleIds.some(v=>!text(v)))throw Error('Invalid manual command receipt');
  if(r.kind==='release-protection'){
   if(!text(r.operationId)||!r.operationId.trim()||r.operationId.length>200||r.action!==undefined||r.orderId!==undefined||r.scheduleId!==undefined||r.affectedFleetIds.length||r.cancelledScheduleIds.length||!Array.isArray(r.releasedReceiptIds)||!r.releasedReceiptIds.length||r.releasedReceiptIds.length>100||new Set(r.releasedReceiptIds).size!==r.releasedReceiptIds.length||r.releasedReceiptIds.some(id=>!ids.has(id)||!data.receipts.some(old=>old.id===id&&old.player===r.player&&old.kind!=='release-protection'))||!Array.isArray(r.releasedScopes)||!r.releasedScopes.length||r.releasedScopes.some(scope=>!text(scope))||new Set(r.releasedScopes).size!==r.releasedScopes.length||data.receipts.some(other=>other!==r&&other.player===r.player&&other.kind==='release-protection'&&(other.operationId===r.operationId||other.releasedReceiptIds?.some(id=>r.releasedReceiptIds!.includes(id)))))throw Error('Invalid manual release receipt');
  }else if(r.operationId!==undefined||r.releasedReceiptIds!==undefined||r.releasedScopes!==undefined)throw Error('Unexpected manual release fields');
  else if(r.kind==='cancel-schedule'){if(r.action!==undefined||r.orderId!==undefined||!text(r.scheduleId)||!all.some(p=>p.id===r.scheduleId&&p.player===r.player)||r.cancelledScheduleIds.some(id=>!all.some(p=>p.id===id&&p.player===r.player)))throw Error('Invalid manual cancellation receipt');}
  else{
   if(!text(r.orderId)||!r.action)throw Error('Invalid manual order receipt');
   const parsed=parseFleetOrder({id:r.orderId,player:r.player,action:r.action}),prior=r.kind==='schedule'?all.find(p=>p.id===r.orderId&&p.player===r.player):commands.find(c=>c.id===r.orderId&&c.player===r.player);
   if(!prior||JSON.stringify(parsed.action)!==JSON.stringify(parseFleetOrder({id:r.orderId,player:r.player,action:prior.action}).action)||r.kind==='schedule'&&r.scheduleId!==r.orderId||r.kind==='order'&&r.scheduleId!==undefined||data.provenance[r.orderId]!=='manual')throw Error('Invalid manual command reference');
  }
  ids.add(r.id);versions.set(r.player,r.version);
 }
 for(const p of data.protections){
  if(!p||!ids.has(p.receiptId)||data.receipts.some(r=>r.kind==='release-protection'&&(r.id===p.receiptId||r.releasedReceiptIds?.includes(p.receiptId)))||!Number.isSafeInteger(p.player)||!room.state.economy.players[p.player]||!data.receipts.some(r=>r.id===p.receiptId&&r.player===p.player)||!Number.isSafeInteger(p.eventCursor)||p.eventCursor<0||p.eventCursor>room.state.events.length||!['fleet','schedule','route','outpost','resources','funding'].includes(p.kind)||!Array.isArray(p.scope)||p.scope.some(s=>!text(s))||p.expiresAtTick!==undefined&&(!Number.isFinite(p.expiresAtTick)||p.expiresAtTick<0))throw Error('Invalid manual protection');
  if(p.kind==='funding'&&(!Number.isSafeInteger(p.recipient)||p.recipient===p.player||!room.state.economy.players[p.recipient!]||!p.scope.includes(`funding:${p.recipient}`)))throw Error('Invalid manual funding protection');
  if(p.retainSetting!==undefined&&typeof p.retainSetting!=='boolean')throw Error('Invalid manual setting protection');
  const fact=data.receipts.find(r=>r.id===p.receiptId)!;

  const cited=[...(fact.orderId?commands.filter(c=>c.id===fact.orderId):[]),...all.filter(plan=>plan.id===fact.scheduleId||fact.cancelledScheduleIds.includes(plan.id))];
  if(p.kind==='fleet'&&!fact.affectedFleetIds.includes(p.fleetId!)&&!cited.some(c=>'fleetId'in c.action&&c.action.fleetId===p.fleetId||c.action.kind==='launch'&&(c.action.fleetId??c.id)===p.fleetId))throw Error('Invalid manual fleet protection reference');

  if(p.kind==='outpost'&&!cited.some(c=>'outpostId'in c.action&&c.action.outpostId===p.outpostId&&c.action.kind===p.actionKind))throw Error('Invalid manual outpost protection reference');
  if(p.kind==='funding'&&!cited.some(c=>c.action.kind==='toggle-funding'&&c.action.recipient===p.recipient))throw Error('Invalid manual funding protection reference');
  if(p.kind==='resources'){const plan=all.find(plan=>plan.id===p.scheduleId);if(fact.scheduleId!==p.scheduleId||!plan||!(plan.action.kind==='launch'&&p.source===plan.action.source&&p.drillers===plan.action.drillers||plan.action.kind==='toggle-mine'&&p.source===plan.action.outpostId&&p.drillers!>0))throw Error('Invalid manual resource protection reference');}
  const knownSchedule=p.scheduleId===undefined||text(p.scheduleId)&&all.some(plan=>plan.id===p.scheduleId&&plan.player===p.player);
  if(!knownSchedule||p.kind==='fleet'&&(!text(p.fleetId)||!p.scope.includes(`fleet:${p.fleetId}`))||p.kind==='schedule'&&(!text(p.scheduleId)||!p.scope.includes(`schedule:${p.scheduleId}`))||p.kind==='outpost'&&(!text(p.outpostId)||!['toggle-mine','set-shields'].includes(p.actionKind??'')||!p.scope.includes(`outpost:${p.outpostId}`)))throw Error('Invalid manual protection target');
  if(p.kind==='route'&&(!text(p.source)||!text(p.destination)||p.destinationOwner!==null&&(!Number.isSafeInteger(p.destinationOwner)||!room.state.economy.players[p.destinationOwner!])||!route(p.source,p.destination).every(key=>p.scope.includes(key))))throw Error('Invalid manual route protection');
  if(p.kind==='resources'&&(!text(p.scheduleId)||!text(p.source)||!Number.isSafeInteger(p.drillers)||p.drillers!<0||!p.scope.includes(`source:${p.source}`)))throw Error('Invalid manual resource protection');
 }
 for(const [id,origin]of Object.entries(data.provenance))if(!text(id)||origin!=='manual'&&origin!=='agent'||!commands.some(c=>c.id===id)&&!all.some(p=>p.id===id)||origin==='manual'&&!data.receipts.some(r=>r.orderId===id))throw Error('Invalid command provenance');
 return structuredClone(data);
}

export function assertManualResourcesPreserved(before:LabRoom,after:LabRoom,player:number){
 const protections=protectionsFor(before).filter(p=>p.player===player&&active(before,p)),resources=protections.filter(p=>p.kind==='resources');
 for(const p of protections){
  if(p.kind==='fleet'&&p.fleetId){const old=before.state.fleets.find(f=>f.id===p.fleetId&&f.used),now=after.state.fleets.find(f=>f.id===p.fleetId&&f.used);if(old&&(JSON.stringify(old)!==JSON.stringify(now)))throw new ManualCommandConflict('This action would implicitly alter a protected manual fleet');}

  if(p.kind==='outpost'&&p.actionKind==='toggle-mine'&&before.state.economy.outposts.find(o=>o.id===p.outpostId)?.minePending&&!after.state.economy.outposts.find(o=>o.id===p.outpostId)?.minePending)throw new ManualCommandConflict('This action would implicitly finish a protected manual mine construction');
 }
 if(resources.some(p=>p.scope.includes('action:toggle-mine'))&&economicMineCreationCost(after.state.economy,player)>economicMineCreationCost(before.state.economy,player))throw new ManualCommandConflict('This action increases the resource cost of a pending manual mine schedule');
 for(const source of new Set(resources.map(p=>p.source))){
  const reserved=resources.filter(p=>p.source===source).reduce((n,p)=>n+(p.drillers??0),0),was=before.state.economy.outposts.find(o=>o.id===source)?.drillers??0,now=after.state.economy.outposts.find(o=>o.id===source)?.drillers??0;
  if(now<was&&now<reserved)throw new ManualCommandConflict('Drillers are reserved by a pending manual schedule');
 }
}

/** A scheduled receipt remains scheduled: actual effects extend its protections, not a fictitious new human action. */
export function protectExecutedManualSchedule(before:LabRoom,next:LabRoom,order:FleetOrder):LabRoom{
 if(before.hypotheticalManualCoordination?.actors[order.id]===order.player)return coordinateHypotheticalManualOrder(before,next,order,'order');
 const receipt=before.manualCoordination?.receipts.find(r=>r.kind==='schedule'&&r.orderId===order.id);
 if(!receipt||!before.manualCoordination||receiptReleased(before,receipt.id))return next;
 const data=structuredClone(before.manualCoordination),action=order.action;
 const add=(p:Omit<Protection,'receiptId'|'player'|'eventCursor'>)=>{if(!data.protections.some(old=>old.receiptId===receipt.id&&old.kind===p.kind&&JSON.stringify(old.scope)===JSON.stringify(p.scope)))data.protections.push({receiptId:receipt.id,player:order.player,eventCursor:next.state.events.length,...p});};
 for(const fleet of next.state.fleets.filter(f=>f.used&&f.owner===order.player&&JSON.stringify(f)!==JSON.stringify(before.state.fleets.find(old=>old.id===f.id))))add({kind:'fleet',fleetId:fleet.id,scope:[`fleet:${fleet.id}`]});
 if(action.kind==='cancel-launch'){const old=before.state.fleets.find(f=>f.id===action.fleetId);if(old?.source){const p:Protection={receiptId:receipt.id,player:order.player,eventCursor:next.state.events.length,kind:'route',scope:[]};tombstone(before,p,{kind:'launch',source:old.source,destination:old.destination,drillers:old.drillers});data.protections.push(p);}}
 if(action.kind==='toggle-funding')add({kind:'funding',recipient:action.recipient,scope:[`funding:${action.recipient}`]});

 if('outpostId'in action)add({kind:'outpost',outpostId:action.outpostId,actionKind:action.kind,...(action.kind==='toggle-mine'&&!next.state.economy.outposts.find(o=>o.id===action.outpostId)?.minePending?{retainSetting:true}:{}),scope:[`outpost:${action.outpostId}`,`action:${action.kind}`]});

 return {...next,manualCoordination:data};
}

/** Carry only this seat's already-authorized facts/guards into its isolated prediction world. */
export function manualPredictionCoordination(room:LabRoom,player:number,predicted:LabRoom):ManualCoordination|undefined{
 if(!room.manualCoordination)return undefined;
 const protections=room.manualCoordination.protections.filter(p=>p.player===player&&active(room,p)).map(p=>({...structuredClone(p),eventCursor:predicted.state.events.length}));
 return {receipts:structuredClone(room.manualCoordination.receipts.filter(r=>r.player===player)),protections,provenance:Object.fromEntries(Object.entries(room.manualCoordination.provenance).filter(([id])=>plans(room).some(p=>p.id===id&&p.player===player)))};
}
