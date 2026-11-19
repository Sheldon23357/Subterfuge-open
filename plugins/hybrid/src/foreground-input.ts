import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {HybridState,OperationState} from './contracts.js';
import {operationGuidance} from './operations.js';

const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['reason','summary','version','rotation'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,ordered(v)])):value;
/** Compare executable semantics, not model wording, audit versions or basis. */
export function foregroundInputKey(saved:HybridState,o:PlayerObservation,operations:OperationState[]=[],deadlineBasis?:HybridState){
 const now=o.view.tick+o.secondsSinceLastTick/600;
 return JSON.stringify(ordered({
  commanderVersion:saved.commanderVersion,
  contractCommands:saved.contractCommands?.filter(c=>['pending','unknown'].includes(c.status)).map(c=>[c.id,c.status,c.ceasefireReview?.withdrawalStatus]),
  interpretedCommanderVersion:saved.directive?.commanderVersion??null,
  guidance:operationGuidance(o,saved.directive,operations,0,saved)??null,
  tasks:(saved.intents??[]).filter(t=>!['completed','cancelled','expired'].includes(t.status)&&t.spec.until>now).map(t=>{
   const previous=deadlineBasis?.intents?.find(p=>p.id===t.id&&!['completed','cancelled','expired'].includes(p.status)&&p.spec.until>now);
   const spec=previous&&t.spec.until>=previous.spec.until?{...t.spec,until:previous.spec.until}:t.spec;
   return {id:t.id,authority:t.authority,commanderVersion:t.commanderVersion,status:t.status==='blocked'?'blocked':'active',spec};
  }),
 }));
}
export const foregroundNeedsUpdate=(before:HybridState,after:HybridState,o:PlayerObservation)=>
 foregroundInputKey(before,o)!==foregroundInputKey(after,o,[],before);
