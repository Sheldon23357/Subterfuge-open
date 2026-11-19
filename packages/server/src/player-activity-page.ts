import {projectPlayerActivityPage} from '../../engine/src/index.js';
import type {FleetScenario} from '../../engine/src/index.js';
import {PLAYER_PROTOCOL_LIMITS} from '../../contracts/src/index.js';

/** Program fact channel. The caller pins `through` to its observation cut. */
export function playerActivityPage(state:FleetScenario,player:number,query:URLSearchParams){
 if([...query.keys()].some(k=>!['after','through','limit'].includes(k))||[...query.keys()].some(k=>query.getAll(k).length!==1))throw Error('Invalid activity query');
 const counter=(name:string,fallback?:string)=>{
  const text=query.get(name)??fallback;
  if(text===undefined||!/^(0|[1-9][0-9]*)$/.test(text)||!Number.isSafeInteger(Number(text)))throw Error('Invalid activity cursor');
  return Number(text);
 };
 const after=counter('after'),through=counter('through'),page=projectPlayerActivityPage(state,player,after,through,counter('limit','100'));
 const events:typeof page.events=[];let bytes=2048;
 for(const event of page.events){
  const size=Buffer.byteLength(JSON.stringify(event))+1;
  if(bytes+size>PLAYER_PROTOCOL_LIMITS.responsePageBytes)break;
  events.push(event);bytes+=size;
 }
 if(page.events.length&&!events.length)throw Error('Activity event exceeds response budget');
 const nextCursor=after+events.length;
 return {events,nextCursor,hasMore:nextCursor<through,through};
}
