import type {IntentTask,SituationBrief} from './contracts.js';
import {intentSchemaFor,intentDefaults,DEFAULT_INTENT_PRIORITY} from './intent-schema.js';
export interface IntentNormalization {path:string;rule:'move-priority'|'move-fulfilment'|'bind-conversation-peer'|'drop-avoid-priority'|'inherit-priority'|'default-field'|'coerce-scalar'|'drop-extra-field';value:unknown}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const priority=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
const taskProperties=new Map<string,Record<string,any>>(intentSchemaFor('commander',[],[],['fleet']).properties.tasks.properties.upsert.items.properties.task.anyOf.map((s:any)=>[s.properties.kind.enum[0],s.properties]));
/** Normalize model syntax once, then run the same semantic and publication guards.
 * Targets, time limits and quantities are never inferred from prose. */
export function normalizeIntentResult(raw:unknown,existing:readonly IntentTask[],kind:SituationBrief['kind'],now:number,current:readonly IntentTask[]=existing,serverContracts=false){
 const value=structuredClone(raw),changes:IntentNormalization[]=[];
 const defaults=(v:unknown,fields:Record<string,unknown>,path:string)=>{
  if(!object(v))return;
  for(const [key,fallback] of Object.entries(fields))if(!Object.hasOwn(v,key)){
   v[key]=structuredClone(fallback);changes.push({path:path+'.'+key,rule:'default-field',value:structuredClone(fallback)});
  }
 };
 const discard=(v:Record<string,any>,key:string,path:string,rule:IntentNormalization['rule']='drop-extra-field')=>{
  const ignored=v[key];delete v[key];changes.push({path:path+'.'+key,rule,value:ignored});
 };
 const scalar=(v:Record<string,any>,key:string,path:string)=>{
  if(typeof v[key]!=='string')return;
  const text=v[key].trim();let converted:unknown;
  if(['maintain','forbidAttack'].includes(key)){if(text==='true'||text==='false')converted=text==='true';}
  else if(/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)&&Number.isFinite(Number(text)))converted=Number(text);
  if(converted!==undefined){v[key]=converted;changes.push({path:path+'.'+key,rule:'coerce-scalar',value:converted});}
 };
 if(!object(value))return {value,changes};
 defaults(value,intentDefaults.result,'$');defaults(value.tasks,intentDefaults.edits,'tasks');
 if(kind==='diplomacy'){
  if(serverContracts&&object(value.agreement))for(const key of Object.keys(intentDefaults.agreement))if(!['summary','internalIntent'].includes(key)&&Object.hasOwn(value.agreement,key))discard(value.agreement,key,'agreement');
  defaults(value,{message:null,agreement:intentDefaults.agreement},'$');
  defaults(value.agreement,intentDefaults.agreement,'agreement');
  if(object(value.agreement))scalar(value.agreement,'forbidAttack','agreement');
 }
 if(kind==='commander'){
  defaults(value.constraints,intentDefaults.constraints,'constraints');
 }
 if(!object(value.tasks)||!Array.isArray(value.tasks.upsert))return {value,changes};
 value.tasks.upsert.forEach((edit:unknown,i:number)=>{
  if(!object(edit)||!object(edit.task))return;
  const t=edit.task,path=`tasks.upsert[${i}]`;
  if(typeof edit.reason==='string')discard(edit,'reason',path);
  defaults(edit,intentDefaults.edit,path);defaults(t,intentDefaults.task,path+'.task');
  if(t.kind==='configure')defaults(t,intentDefaults.configuration,path+'.task');
  for(const key of ['priority','until','drillers','minDrillers','maxDrillers','maxDrillersPerPlan','maintain'])scalar(t,key,path+'.task');
  scalar(edit,'priority',path);
  const fields=taskProperties.get(t.kind);
  if(fields)for(const key of Object.keys(t))if(!Object.hasOwn(fields,key)){
   discard(t,key,path+'.task',t.kind==='avoid'&&key==='priority'?'drop-avoid-priority':'drop-extra-field');
  }
  if(['capture','configure','transfer'].includes(t.kind)&&!Object.hasOwn(t,'priority')&&priority(edit.priority)){
   t.priority=edit.priority;delete edit.priority;changes.push({path:path+'.task.priority',rule:'move-priority',value:t.priority});
  }
  if(!['capture','configure','transfer'].includes(t.kind)||Object.hasOwn(t,'priority'))return;
  if(edit.id===null){defaults(t,{priority:DEFAULT_INTENT_PRIORITY},path+'.task');return;}
  if(typeof edit.id!=='string')return;
  const old=existing.find(t=>t.id===edit.id),live=current.find(t=>t.id===edit.id);
  if(!old||!live||old.version!==live.version||old.authority!==live.authority||old.authority==='commander'&&kind!=='commander')return;
  if([old,live].some(t=>['completed','cancelled','expired'].includes(t.status)||t.spec.until<=now))return;
  if(old.spec.kind!==t.kind||live.spec.kind!==t.kind||!('priority' in old.spec)||!('priority' in live.spec)||old.spec.priority!==live.spec.priority||!priority(old.spec.priority))return;
  if(!('target' in old.spec)||!('target' in live.spec)||old.spec.target!==t.target||live.spec.target!==t.target)return;
  if(t.kind==='transfer'&&(!('source'in old.spec)||!('source'in live.spec)||old.spec.source!==t.source||live.spec.source!==t.source))return;
  t.priority=old.spec.priority;changes.push({path:path+'.task.priority',rule:'inherit-priority',value:t.priority});
 });
 return {value,changes};
}
