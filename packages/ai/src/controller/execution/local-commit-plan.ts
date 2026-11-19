import type {LocalEventPayloads} from '../storage/journal-events.js';
export type {LocalEventPayloads} from '../storage/journal-events.js';
import type {AiMemory,AiSnapshot} from '../contracts/types.js';
import type {ToolExecution} from './tool-results.js';
import {shortFleetReferences} from '../presentation/fleet-labels.js';

export type LocalJournalEvent={ [K in keyof LocalEventPayloads]:{kind:K;details:LocalEventPayloads[K]} }[keyof LocalEventPayloads];
export interface LocalCommitPlan {memory:AiMemory;events:LocalJournalEvent[]}
/** Pure event planning only. The runner still owns authorization, receipt and CAS commit. */
export function planLocalCommit(execution:ToolExecution,current:AiMemory,snapshot:AiSnapshot):LocalCommitPlan{
 const events:LocalJournalEvent[]=[],seconds=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
 let memory=current;
 const maintain=(candidate:AiMemory,reason:'finish'|'notebook')=>{
  memory=shortFleetReferences(candidate);
  if(JSON.stringify(memory)!==JSON.stringify(current))events.push({kind:'memory-archived',details:{memory:current,seconds,reason}});
  events.push({kind:'memory-maintained',details:{seconds}});
 };
 switch(execution.kind){
  case 'finish':{
   const updates=execution.result;
   if(updates.commanderCleanup)events.push({kind:'commander-cleanup-requested',details:updates.commanderCleanup});
   if(updates.manualReview)events.push({kind:'manual-intent-reconciled',details:updates.manualReview});
   if(updates.memoryUpdated)maintain(updates.memory,'finish');
   for(const id of updates.notebook.remove)events.push({kind:'notebook-removed',details:{id}});
   for(const note of updates.notebook.set)events.push({kind:'notebook-set',details:shortFleetReferences(note)});
   for(const id of updates.reminders.cancel)events.push({kind:'reminder-cancelled',details:{id}});
   for(const id of updates.reminders.complete)events.push({kind:'reminder-fired',details:{id}});
   for(const reminder of updates.reminders.set)events.push({kind:'reminder-set',details:reminder});
   break;
  }
  case 'notebook':{
   const updates=execution.result;
   if('memory' in updates&&updates.memory&&updates.memoryUpdated)maintain(updates.memory,'notebook');
   if('remove' in updates)for(const id of updates.remove??[])events.push({kind:'notebook-removed',details:{id}});
   if('set' in updates)for(const note of updates.set??[])events.push({kind:'notebook-set',details:shortFleetReferences(note)});
   break;
  }
  case 'reminders':{
   const updates=execution.result;
   for(const id of updates.complete)events.push({kind:'reminder-fired',details:{id}});
   for(const id of updates.cancel)events.push({kind:'reminder-cancelled',details:{id}});
   for(const reminder of updates.set)events.push({kind:'reminder-set',details:reminder});
   break;
  }
 }
 return {memory,events};
}
