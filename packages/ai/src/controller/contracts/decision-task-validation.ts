import {campaignReminderId} from '../storage/state-ownership.js';
import type {AiReminder,DecisionSignal,DecisionTask,DecisionTriggerKind} from './types.js';

const triggerKinds:readonly DecisionTriggerKind[]=['opening','resume','recovery','diplomacy-message','reminder-due','campaign-review','activity-warning','mining-phase-change','construction-change','investment-opportunity','player-eliminated','outpost-control-change','battle-notice','fleet-state-change','arrival-check','threat-change','attack-premise-change','execution-failure','manual-command-change','memory-review','unknown'];
const categories=['strategy','diplomacy','military','plan'];
const fail=(path:string):never=>{throw Error(`Invalid saved decision context: ${path}`);};
const object=(value:unknown,path:string):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail(path);
const keys=(value:Record<string,unknown>,allowed:readonly string[],path:string)=>{if(Object.keys(value).some(key=>!allowed.includes(key)))fail(`${path}.fields`);};
const string=(value:unknown,path:string)=>{if(typeof value!=='string'||!value.trim())fail(path);};
const strings=(value:unknown,path:string)=>{if(!Array.isArray(value))fail(path);for(const item of value as unknown[])string(item,path);};
const optionalBoolean=(value:unknown,path:string)=>{if(value!==undefined&&typeof value!=='boolean')fail(path);};
const review=(value:unknown,path:string)=>{const fields=object(value,path);keys(fields,['factsNeeded','strategicReview','cleanupNeeded'],path);for(const key of ['factsNeeded','strategicReview','cleanupNeeded'])if(typeof fields[key]!=='boolean')fail(`${path}.${key}`);};

/** Strict new-field validation at recovery. Missing old typing stays explicitly
 * unknown: neither a key nor natural-language reason is a semantic classifier. */
export function restoreDecisionSignal(value:unknown,path='signal'):DecisionSignal{
 const signal=object(value,path);
 keys(signal,['key','category','reason','urgent','entities','scope','kind','sources','role','relatedCampaignIds','reviewRequirements','requiresFullContext','notebookReview'],path);
 string(signal.key,`${path}.key`);string(signal.reason,`${path}.reason`);strings(signal.entities,`${path}.entities`);
 if(!categories.includes(signal.category as string)||typeof signal.urgent!=='boolean')fail(path);
 if(signal.scope!==undefined&&!['local','global'].includes(signal.scope as string))fail(`${path}.scope`);
 if(signal.kind!==undefined&&!triggerKinds.includes(signal.kind as DecisionTriggerKind))fail(`${path}.kind`);
 if(signal.role!==undefined&&!['new-trigger','inherited-trigger'].includes(signal.role as string))fail(`${path}.role`);
 if(signal.relatedCampaignIds!==undefined)strings(signal.relatedCampaignIds,`${path}.relatedCampaignIds`);
 if(signal.reviewRequirements!==undefined)review(signal.reviewRequirements,`${path}.reviewRequirements`);
 optionalBoolean(signal.requiresFullContext,`${path}.requiresFullContext`);optionalBoolean(signal.notebookReview,`${path}.notebookReview`);
 if(signal.sources!==undefined){
  if(!Array.isArray(signal.sources))fail(`${path}.sources`);
  for(const sourceValue of signal.sources as unknown[]){const source=object(sourceValue,`${path}.sources`);keys(source,['kind','id','observedSeconds'],`${path}.sources`);
   if(!['observation','notification','chat','reminder','runtime','user'].includes(source.kind as string))fail(`${path}.sources.kind`);
   string(source.id,`${path}.sources.id`);
   if(source.observedSeconds!==undefined&&(typeof source.observedSeconds!=='number'||!Number.isFinite(source.observedSeconds)||source.observedSeconds<0))fail(`${path}.sources.observedSeconds`);
  }
 }
 return {...structuredClone(signal) as unknown as DecisionSignal,kind:signal.kind as DecisionTriggerKind??'unknown'};
}

export function restoreDecisionTask(value:unknown,path='task'):DecisionTask{
 const task=object(value,path);
 keys(task,['triggers','scope','timing','category','weight','reasons','entities','deferred','fullContext','notebookReview','memoryReview'],path);
 if(!categories.includes(task.category as string)||!['light','medium','heavy'].includes(task.weight as string))fail(path);
 if(task.scope!==undefined&&!['local','global'].includes(task.scope as string))fail(`${path}.scope`);
 strings(task.reasons,`${path}.reasons`);strings(task.entities,`${path}.entities`);
 optionalBoolean(task.fullContext,`${path}.fullContext`);optionalBoolean(task.notebookReview,`${path}.notebookReview`);
 if(task.memoryReview!==undefined)review(task.memoryReview,`${path}.memoryReview`);
 if(!Array.isArray(task.deferred))fail(`${path}.deferred`);
 for(const raw of task.deferred as unknown[]){const event=object(raw,`${path}.deferred`);keys(event,['key','summary','count','firstSeconds','lastSeconds'],`${path}.deferred`);string(event.key,`${path}.deferred.key`);string(event.summary,`${path}.deferred.summary`);
  if(!Number.isSafeInteger(event.count)||Number(event.count)<1)fail(`${path}.deferred.count`);
  for(const key of ['firstSeconds','lastSeconds'])if(typeof event[key]!=='number'||!Number.isFinite(event[key])||Number(event[key])<0)fail(`${path}.deferred.${key}`);
 }
 if(task.timing!==undefined){const timing=object(task.timing,`${path}.timing`);keys(timing,['observedSeconds','waitingDepartures','dueReminders'],`${path}.timing`);
  if(typeof timing.observedSeconds!=='number'||!Number.isFinite(timing.observedSeconds)||timing.observedSeconds<0||!Array.isArray(timing.waitingDepartures))fail(`${path}.timing`);
  strings(timing.dueReminders,`${path}.timing.dueReminders`);
  for(const raw of timing.waitingDepartures as unknown[]){const fleet=object(raw,`${path}.timing.waitingDepartures`);keys(fleet,['id','secondsRemaining'],`${path}.timing.waitingDepartures`);string(fleet.id,`${path}.timing.waitingDepartures.id`);if(typeof fleet.secondsRemaining!=='number'||!Number.isFinite(fleet.secondsRemaining)||fleet.secondsRemaining<0)fail(`${path}.timing.waitingDepartures.secondsRemaining`);}
 }
 if(task.triggers!==undefined&&!Array.isArray(task.triggers))fail(`${path}.triggers`);
 const restored=structuredClone(task) as unknown as DecisionTask;
 restored.triggers=task.triggers===undefined?(restored.reasons.length?restored.reasons:['恢复的任务未保存结构化触发范围']).map((reason,index)=>({key:`legacy-task:${index}`,kind:'unknown',category:restored.category,reason,entities:[...restored.entities],urgent:false,role:'inherited-trigger'})):(task.triggers as unknown[]).map((trigger,index)=>restoreDecisionSignal(trigger,`${path}.triggers[${index}]`));
 return restored;
}

/** The optional provenance is server-owned and cannot contradict its canonical
 * reminder identity. Legacy reminders without it remain unchanged. */
export function validateReminderSource(reminder:AiReminder):void{
 if(reminder.source===undefined)return;
 const source=object(reminder.source,'reminder.source');keys(source,['kind','campaignId'],'reminder.source');
 string(source.campaignId,'reminder.source.campaignId');
 if(source.kind!=='campaign'||reminder.id!==campaignReminderId(String(source.campaignId)))fail('reminder.source');
}
