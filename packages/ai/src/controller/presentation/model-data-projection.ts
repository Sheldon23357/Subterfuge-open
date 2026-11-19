import {commandObservationReceipt} from './command-receipt-presentation.js';
import {toolMetadata} from '../contracts/tool-metadata.js';
import {observationRuleSeconds,type PlayerActivityEvent} from '../../../../contracts/src/index.js';
import {projectRuleNotification} from './world-time-context.js';

type Row=Record<string,unknown>;
const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const own=(value:Row,key:string)=>Object.prototype.hasOwnProperty.call(value,key);
const opaque=new Set(['arguments','submittedArguments','drafts']);
const countdowns:Record<string,readonly (readonly [string,string,number])[]>={
 outposts:[['mineRemainingSeconds','mineRemainingWorldDays',600],['shieldDisableRemainingSeconds','shieldDisableRemainingWorldDays',600]],
 fleets:[['secondsUntilLaunch','secondsUntilLaunchWorldDays',600],['launchRemainingSeconds','launchRemainingSecondsWorldDays',600],['giftPendingSeconds','giftPendingSecondsWorldDays',600]],
};
const map=(value:unknown):value is Row=>row(value)&&Array.isArray(value.outposts)&&Array.isArray(value.fleets);
const observation=(value:unknown):value is Row=>row(value)&&map(value.view)&&typeof value.revision==='string';
const failed=(value:Row)=>'error'in value||value.accepted===false||value.success===false||value.saved===false||
 ['unknown','unconfirmed','indeterminate','rejected','failed','error','pending','partial','cancelled'].includes(String(value.status));
const timeConflict=(value:Row,rawFields:string[],displayField:string)=>{
 const conflict={rawFields,displayField,status:'unresolved'};
 const previous=value.timeProjectionConflicts;
 if(!own(value,'timeProjectionConflicts'))value.timeProjectionConflicts=[conflict];
 else if(Array.isArray(previous)&&!previous.some(item=>row(item)&&item.displayField===displayField&&JSON.stringify(item.rawFields)===JSON.stringify(rawFields)))value.timeProjectionConflicts=[...previous,conflict];
};
const conflicts=(source:Row,key:string,derived:unknown)=>own(source,key)&&source[key]!==derived;

/** Activity clocks already use the movement interval's start, unlike rule
 * notifications. Preserve raw anchors and any conflicting explicit clock. */
export function projectActivityEvents(events:readonly PlayerActivityEvent[]){
 return events.map(event=>{
  const value=event as unknown as Row;
  const derived=Number.isSafeInteger(event.tick)&&event.tick>=0&&Number.isInteger(event.seconds)&&event.seconds>=0&&event.seconds<=600?event.tick+event.seconds/600:null;
  if(conflicts(value,'eventWorldDay',derived)){
   const result={...value};timeConflict(result,['tick','seconds'],'eventWorldDay');return result;
  }
  return {...event,eventWorldDay:derived};
 });
}


export interface ModelDataProjectionOptions {
 /** Captured current observation, never a substitute for historical result basis. */
 currentRevision?:string;
 currentWorldDay?:number;
}

/** Normalize only recognized result envelopes. Arbitrary objects that happen to
 * contain a result/position/timestamp are not command receipts. Original archives
 * and exact submitted arguments remain untouched. */
export function projectModelData(value:unknown,options:ModelDataProjectionOptions={}):unknown{
 const project=(input:unknown,tool?:string,resultBody=false):unknown=>{
  if(Array.isArray(input))return input.map(item=>project(item,tool,resultBody));
  if(!row(input))return input;
  const ownTool=typeof input.tool==='string'&&toolMetadata(input.tool)?input.tool:undefined;
  const activeTool=ownTool??tool;
  let source=input;
  // A restored write may put the authoritative accepted observation under
  // originalResult. Keep the outer unresolved/recovered state independently.
  if(resultBody&&activeTool&&['order'].includes(activeTool)&&observation(source)&&!failed(source)){
   const view=source.view as Row;
   source={...commandObservationReceipt(source),
    source:'accepted command receipt; not proof of arrival or completion'};
   if(number(view.tick)&&number(input.secondsSinceLastTick)){
    const derived=observationRuleSeconds({view:{tick:view.tick},secondsSinceLastTick:input.secondsSinceLastTick})/600;
    if(conflicts(input,'observedWorldDay',derived)){
     // Preserve the exact clock anchors without repeating the full map.
     source.view={tick:view.tick};timeConflict(source,['view.tick','secondsSinceLastTick'],'observedWorldDay');
    }else{source.observedWorldDay=derived;delete source.secondsSinceLastTick;}
   }
  }
  const result:Row={};
  for(const [key,child]of Object.entries(source)){
   if(opaque.has(key)){
    result[key]=key==='drafts'&&Array.isArray(child)?child.map(d=>row(d)&&row(d.action)?{...structuredClone(d),action:project(d.action)}:structuredClone(d)):structuredClone(child);
    continue;
   }
   const isBody=(key==='result'||key==='originalResult')&&!!activeTool;
   let normalized=child;
   if(['notifications','ruleNotifications'].includes(key)&&Array.isArray(child))normalized=child.map(item=>projectRuleNotification(item));
   else if(key==='notificationTimeline'&&Array.isArray(child))normalized=child.map(item=>row(item)&&item.source==='rule'?{...item,notification:projectRuleNotification(item.notification)}:item);
   else if(key==='lossReports'&&row(child)&&Array.isArray(child.events))normalized={...child,events:child.events.map(item=>projectRuleNotification(item,child.eventSource==='rule-notification'))};
   else if(key==='activity'&&Array.isArray(child)&&child.every(item=>row(item)&&typeof item.id==='number'&&typeof item.subject==='string'&&'actor'in item))normalized=projectActivityEvents(child as PlayerActivityEvent[]);
   result[key]=project(normalized,isBody?activeTool:undefined,isBody);
  }
  if(['order','schedule','cancel-schedule'].includes(String(source.kind))&&typeof source.id==='string'&&number(source.player)&&number(source.version)&&typeof source.outcome==='string'&&'action'in source&&number(source.tick)&&number(source.seconds)){
   const derived=source.tick+source.seconds/600;
   if(conflicts(source,'eventWorldDay',derived))timeConflict(result,['tick','seconds'],'eventWorldDay');else result.eventWorldDay=derived;
  }
  if(observation(source)){
   const view=source.view as Row;
   if(number(view.tick)&&number(source.secondsSinceLastTick)){
    const derived=observationRuleSeconds({view:{tick:view.tick},secondsSinceLastTick:source.secondsSinceLastTick})/600;
    if(conflicts(source,'observedWorldDay',derived))timeConflict(result,['view.tick','secondsSinceLastTick'],'observedWorldDay');
    else{result.observedWorldDay=derived;delete result.secondsSinceLastTick;}
   }
   delete result.roomId;
  }
  if(observation(source.observation)){
   delete result.chatCursor;delete result.notificationCursor;
  }
  // roomId is routing metadata only in these typed tool result bodies. Never
  // remove id/revision/fingerprint or a similarly named field in authored data.
  if(resultBody&&activeTool&&(typeof source.revision==='string'||typeof source.basisRevision==='string'))delete result.roomId;
  if(typeof source.id==='string'&&number(source.from)&&(source.to===null||number(source.to)||Array.isArray(source.to))&&
   typeof source.text==='string'&&number(source.tick)&&number(source.sentAt)){
   const utc=new Date(source.sentAt);if(Number.isFinite(utc.getTime())){
    const derived=utc.toISOString();
    if(conflicts(source,'sentAtUtc',derived))timeConflict(result,['sentAt'],'sentAtUtc');
    else{result.sentAtUtc=derived;delete result.sentAt;}
   }
  }
  // These records have an explicit domain contract, unlike arbitrary same-name
  // fields elsewhere (which retain the older lossless time projection).
  const fleet=typeof source.id==='string'&&typeof source.state==='string'&&'drillers'in source&&'destination'in source;
  const production=('cycleMinutes'in source||'nextMinutes'in source)&&('output'in source||'active'in source||'paused'in source);
  const reminder=typeof source.id==='string'&&typeof source.note==='string'&&'atSeconds'in source;
  const notebook=typeof source.id==='string'&&typeof source.text==='string'&&['fact','plan','agreement','note'].includes(String(source.kind));
  const timing=number(source.observedSeconds)&&Array.isArray(source.waitingDepartures);
  const convert=(raw:string,display:string,divisor:number)=>{
   if(number(source[raw])||source[raw]===null){
    const derived=source[raw]===null?null:Number(source[raw])/divisor;
    // Never overwrite contradictory/future explicit data.
    if(!own(source,display)||source[display]===derived){result[display]=derived;delete result[raw];}
    else timeConflict(result,[raw],display);
   }
  };
  const domain=typeof source.id==='string'&&number(source.visibility)?'outposts':undefined;
  if(domain)for(const [raw,display,unit] of countdowns[domain]!)convert(raw,display,unit);
  if(source.event==='changed'&&typeof source.kind==='string'&&Object.hasOwn(countdowns,source.kind)&&row(source.fields)&&row(result.fields)){
   for(const [raw,display,unit] of countdowns[source.kind]!){
    const value=source.fields[raw];
    const known=(v:unknown)=>number(v)||v===null||row(v)&&v.known===false;
    if(!row(value)||!own(value,'before')||!own(value,'after')||!known(value.before)||!known(value.after))continue;
    const derived={...value,before:number(value.before)?value.before/unit:structuredClone(value.before),after:number(value.after)?value.after/unit:structuredClone(value.after)};
    if(!own(source.fields,display)||JSON.stringify(source.fields[display])===JSON.stringify(derived)){
     result.fields[display]=derived;delete result.fields[raw];
    }else timeConflict(result.fields,[raw],display);
   }
  }
  if(source.kind==='launch'&&typeof source.source==='string'&&typeof source.destination==='string')convert('delaySeconds','delayWorldDays',600);
  if(fleet)for(const [raw,display,unit]of [
   ['departureMinutes','departureWorldDays',10],['arrivalMinutes','arrivalWorldDays',10],
   ['secondsUntilLaunch','secondsUntilLaunchWorldDays',600],['launchRemainingSeconds','launchRemainingSecondsWorldDays',600],['giftPendingSeconds','giftPendingSecondsWorldDays',600],
  ] as const)convert(raw,display,unit);
  if(source.status==='conditional'&&'arrivalTick'in source&&'target'in source&&['unknown','reinforced','won','lost','unresolved'].includes(String(source.outcome))){
   convert('arrivalSeconds','arrivalWorldDay',600);convert('arrivalMinutes','arrivalWorldDays',10);
  }
  if(production){convert('cycleMinutes','cycleWorldDays',10);convert('nextMinutes','nextWorldDays',10);}
  if(reminder)convert('atSeconds','atWorldDay',600);
  if(source.owner==='system'&&typeof source.commandId==='string'&&row(source.predicate))convert('deadlineSeconds','deadlineWorldDay',600);
  if(notebook){convert('updatedAt','updatedWorldDay',600);convert('expiresAt','expiresWorldDay',600);}
  if(timing){
   convert('observedSeconds','observedWorldDay',600);
   if(conflicts(source,'observedWorldDay',Number(source.observedSeconds)/600))timeConflict(result,['observedSeconds'],'observedWorldDay');
   result.waitingDepartures=(result.waitingDepartures as unknown[]).map(item=>{
    if(!row(item)||!number(item.secondsRemaining))return item;
    if(conflicts(item,'remainingWorldDays',item.secondsRemaining/600)){
     timeConflict(item,['secondsRemaining'],'remainingWorldDays');return item;
    }
    const {secondsRemaining,...rest}=item;return {...rest,remainingWorldDays:secondsRemaining/600};
   });
  }
  if(['observation','notification','chat','reminder','runtime','user'].includes(String(source.kind))&&number(source.observedSeconds)){
   convert('observedSeconds','observedWorldDay',600);
   if(conflicts(source,'observedWorldDay',source.observedSeconds/600))timeConflict(result,['observedSeconds'],'observedWorldDay');
  }
  if(map(source)&&!own(source,'spatialRelations')){
   const relations=mapSpatialRelations(source);
   result.spatialRelations=relations??{status:'unknown',scope:'No valid spatial basis; original geometry retained. Use program tools for routes.'};
   if(relations){
    delete result.size;delete result.sonar;
    for(const key of ['outposts','fleets'])result[key]=(result[key] as unknown[]).map(item=>row(item)?Object.fromEntries(Object.entries(item).filter(([field])=>field!=='position')):item);
   }
  }
  return result;
 };
 return project(value);
}

/** Pure geometry on the supplied authorized rows. This is deliberately NOT an
 * ETA/battle calculator and makes no claim about omitted entities or safety. */
export function mapSpatialRelations(value:Row):Row|undefined {
 if(!map(value)||!row(value.size)||!number(value.size.width)||!number(value.size.height)||value.size.width<=0||value.size.height<=0)return undefined;
 const width=value.size.width,height=value.size.height;
 const point=(p:unknown):p is {x:number;y:number}=>row(p)&&number(p.x)&&number(p.y);
 const posts=(value.outposts as unknown[]).filter((p):p is Row=>row(p)&&typeof p.id==='string'&&point(p.position));
 const fleets=(value.fleets as unknown[]).filter((fleet):fleet is Row=>row(fleet)&&typeof fleet.id==='string'&&point(fleet.position));
 if(posts.length!==(value.outposts as unknown[]).length||fleets.length!==(value.fleets as unknown[]).length||!posts.length&&fleets.length)return undefined;
 const distance=(a:Row,b:Row)=>{
  const p=a.position as {x:number;y:number},q=b.position as {x:number;y:number};
  const delta=(n:number,size:number)=>{const d=((n%size)+size)%size;return Math.min(d,size-d);};
  return Math.hypot(delta(p.x-q.x,width),delta(p.y-q.y,height));
 };
 const nearest=(source:Row,count:number)=>posts.filter(target=>target!==source).map(target=>({target:target.id,distance:distance(source,target)}))
  .sort((a,b)=>a.distance-b.distance||String(a.target).localeCompare(String(b.target))).slice(0,count).map(n=>({...n,distance:Number(n.distance.toFixed(3))}));
 return {topology:'toroidal',scope:'supplied entities only; three nearest outposts per source and one per fleet; not route time or safety',distancePrecision:'rounded to 0.001 map units',
  nearest:posts.map(source=>({source:source.id,neighbors:nearest(source,3)})),
  fleetPositions:fleets.map(fleet=>{
   const destination=row(fleet.destination)?fleet.destination:undefined;
   const target=destination?.kind==='outpost'?posts.find(p=>p.id===destination.id):destination?.kind==='fleet'?fleets.find(f=>f.id===destination.id):undefined;
   return {fleetId:fleet.id,nearestOutpost:nearest(fleet,1),distanceToDestination:target?Number(distance(fleet,target).toFixed(3)):null,
    destinationPositionStatus:target?'supplied':'unknown-or-not-supplied'};
  })};
}
