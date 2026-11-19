import {prepareCommanderCleanup} from '../../../../contracts/src/index.js';
import {validateManualReview,pendingManualReceipts} from '../execution/manual-coordination.js';
import {object,keys} from '../execution/tool-validation.js';
import {patchNotebookEntry} from './notebook-patch.js';
import {isActiveNote} from './memory-records.js';
import {patchMemory} from './memory-patch.js';
import {fleetLabel} from '../presentation/fleet-labels.js';
import type {MemoryEvidence} from './memory-evidence.js';
import type {ToolContext} from '../execution/tools.js';
import {notebookCapacity} from './notebook-capacity.js';

/** Domain preparation reads the authorized snapshot, but never journals a write. */
export function prepareNotebook(a:Record<string,unknown>,c:ToolContext){
 keys(a,[],['set','remove','memory']);
 if(a.memory!==undefined)keys(object(a.memory),[],['strategy']);
 const set=a.set??[],rawRemove=a.remove??[];
 if(!Array.isArray(set)||set.length>32||!Array.isArray(rawRemove)||rawRemove.length>32)throw Error('Invalid notebook updates');
 if(rawRemove.some(id=>typeof id!=='string'||!id.trim()||id.length>80))throw Error('Invalid notebook removal');
 const remove=[...rawRemove] as string[],ids=new Set<string>(),notes:import('../contracts/types.js').NotebookEntry[]=[];
 const inheritedFields:{id:string;fields:string[]}[]=[],evidenceOutcomes:MemoryEvidence[]=[];
 for(const raw of set){
  const submitted=object(raw);keys(submitted,['id'],['priority','kind','text','expiresWorldDay']);
  const input={...submitted};
  if(Object.hasOwn(input,'expiresWorldDay')){
   const day=input.expiresWorldDay;delete input.expiresWorldDay;
   if(day===null)input.expiresAt=null;
   else{
    if(typeof day!=='number'||!Number.isFinite(day)||day<0)throw Error('笔记有效期须为未来绝对世界日或null');
    const seconds=day*600,rounded=Math.round(seconds),tolerance=Number.EPSILON*Math.max(1,Math.abs(seconds))*8;
    if(!Number.isSafeInteger(rounded)||Math.abs(seconds-rounded)>tolerance)throw Error('笔记有效期精度最多到1规则秒（1/600世界日）');
    input.expiresAt=rounded;
   }
  }
  if(typeof input.id!=='string'||!input.id.trim()||input.id.length>80||ids.has(input.id))throw Error('Invalid notebook ID');
  ids.add(input.id);
  // Only current active bodies are a patch basis. Archived content cannot be
  // restored implicitly by guessing its old ID or omitting its text.
  const previous=c.snapshot.notebook?.find(n=>n.id===input.id&&isActiveNote(n,c.now));
  const {note,inherited}=patchNotebookEntry(input,previous);
  if(!['fact','plan','agreement','note'].includes(String(note.kind))||typeof note.text!=='string'||!note.text.trim()||note.text.length>12000)throw Error('Invalid notebook entry');
  if(note.priority!==undefined&&!['high','medium','low'].includes(String(note.priority)))throw Error('笔记等级必须为high、medium或low');
  if(note.expiresAt!==undefined&&note.expiresAt!==null&&(!Number.isSafeInteger(note.expiresAt)||Number(note.expiresAt)<=c.now))throw Error('Invalid notebook expiry');
  const next:import('../contracts/types.js').NotebookEntry={id:input.id,kind:note.kind as import('../contracts/types.js').NotebookEntry['kind'],priority:(note.priority??'medium') as 'high'|'medium'|'low',text:note.text,updatedAt:previous?.text===note.text?previous.updatedAt:c.now,expiresAt:note.expiresAt==null?null:Number(note.expiresAt)};
  if(inherited.length)inheritedFields.push({id:next.id,fields:inherited.map(field=>field==='expiresAt'?'expiresWorldDay':field)});
  if(!previous||JSON.stringify(next)!==JSON.stringify(previous)||remove.includes(next.id))notes.push(next);
 }
 const active=new Map((c.snapshot.notebook??[]).filter(n=>isActiveNote(n,c.now)).map(n=>[n.id,n]));
 for(const id of remove)active.delete(id);
 for(const note of notes)active.set(note.id,note);
 const capacity=notebookCapacity(active.values(),c.now);
 for(const id of capacity.evicted){active.delete(id);if(!remove.includes(id))remove.push(id);}
 for(let i=notes.length-1;i>=0;i--)if(capacity.evicted.includes(notes[i]!.id))notes.splice(i,1);
 const memory=patchMemory(c.state.memory,a.memory,undefined);
 return {...(!Object.keys(a).length?{read:true}:{}),memory,memoryUpdated:a.memory!==undefined,set:notes,remove,
  ...(evidenceOutcomes.length?{evidenceOutcomes}:{}),...(inheritedFields.length?{inheritedFields,inheritanceMeaning:'Omitted fields preserve current active note values.'}:{}),active:[...active.values()],capacity};
}

export function prepareReminders(input:Record<string,unknown>,c:ToolContext){
 // Resolved IDs belong to the candidate, not to submitted arguments.
 const a=structuredClone(input);
 if(Array.isArray(a.set))for(const raw of a.set){
  const r=object(raw);
  if('atWorldDay'in r){
   if('atSeconds'in r||!Number.isSafeInteger(r.atWorldDay))throw Error('提醒必须使用整数世界日，且不能混用时间字段');
   r.atSeconds=Number(r.atWorldDay)*600;delete r.atWorldDay;
  }
 }
      keys(a,[],['set','cancel','complete']);const set=a.set??[],cancel=a.cancel??[],complete=a.complete??[];
      if(!Array.isArray(complete)||complete.length>16||new Set(complete).size!==complete.length||complete.some(id=>typeof id!=='string'))throw Error('complete must contain at most 16 unique reminder IDs');
      const completionIssues=complete.flatMap((id,index)=>{
        const reminder=c.snapshot.reminders?.find(r=>r.id===id);
        return reminder&&reminder.atSeconds<=c.now?[]:[{path:'$.complete['+index+']',id,currentWorldDay:c.now/600,...(reminder?{dueWorldDay:reminder.atSeconds/600}:{}),message:reminder?'Only due reminders can be completed; already handled early or obsolete: move this ID to cancel':'Unknown reminder ID; remove it from complete and use a current reminder ID'}];
      });
      if(completionIssues.length)throw Error(JSON.stringify({code:'REMINDER_COMPLETION_INVALID',issues:completionIssues,correction:'Correct the listed IDs; no writes were saved'}));
      if(!Array.isArray(set)||!Array.isArray(cancel)||set.length>16||cancel.length>16)throw Error('Invalid reminders');
      const ids=new Set<string>(),historicalFleets=new Set<string>();
      for(const raw of set){const r=object(raw);keys(r,['id','atSeconds','note'],['category','entities']);
        if(typeof r.id!=='string'||!r.id.trim()||r.id.length>80||ids.has(r.id)||!Number.isSafeInteger(r.atSeconds)||Number(r.atSeconds)<=c.now||Number(r.atSeconds)>c.now+604800||typeof r.note!=='string'||!r.note.trim()||r.note.length>500)throw Error('Invalid reminder');
        if(Number(r.atSeconds)%600!==0)throw Error('提醒必须在整数世界天唤醒，atSeconds须为600的整数倍');
        if(r.category!==undefined&&!['plan','military','strategy'].includes(String(r.category)))throw Error('Invalid reminder category');
        if(Array.isArray(r.entities))r.entities=r.entities.map(id=>{
          if(typeof id!=='string')return id;
          const view=c.snapshot.observation.view,short=/^F\d+-[A-F0-9]{8}$/i.test(id);
          if(!short&&(view.outposts.some(o=>o.id===id)||view.fleets.some(f=>f.id===id)))return id;
          const matches=[...new Set([...view.fleets.filter(f=>short?fleetLabel(f.id).toUpperCase()===id.toUpperCase():f.id===id).map(f=>f.id),...(c.readObservedFleetIds?.(id)??[])])];
          if(matches.length!==1)throw Error(`Invalid reminder entities: Unknown or ambiguous reminder fleet ${id}`);
          const resolved=matches[0]!;
          if(!view.fleets.some(f=>f.id===resolved))historicalFleets.add(resolved);
          return resolved;
        });
        if(r.entities!==undefined&&(!Array.isArray(r.entities)||r.entities.length>16||new Set(r.entities).size!==r.entities.length||r.entities.some(id=>typeof id!=='string'||!c.snapshot.observation.view.outposts.some(o=>o.id===id)&&!c.snapshot.observation.view.fleets.some(f=>f.id===id)&&!historicalFleets.has(String(id)))))throw Error('Invalid reminder entities');
        ids.add(r.id);
      }
      if(cancel.some(id=>typeof id!=='string'||!id.trim()||id.length>80)||new Set(cancel).size!==cancel.length)throw Error('Invalid reminder cancellation');
      const active=new Map((c.snapshot.reminders??[]).map(r=>[r.id,r]));
      for(const id of [...cancel,...complete])active.delete(id);for(const raw of set)active.set(raw.id,raw);
      if(active.size>16)throw Error('At most 16 active reminders');
      const changed=set.filter(raw=>{
        const old=c.snapshot.reminders?.find(r=>r.id===raw.id);
        return !old||cancel.includes(raw.id)||complete.includes(raw.id)||old.atSeconds!==raw.atSeconds||old.note!==raw.note||(old.category??'plan')!==(raw.category??'plan')||JSON.stringify([...(old.entities??[])].sort())!==JSON.stringify([...(raw.entities??[])].sort());
      });
      return {set:changed as import('../contracts/types.js').AiReminder[],cancel:cancel as string[],complete:complete as string[],active:[...active.values()],historicalFleetReferences:[...historicalFleets].map(id=>({id,status:'not-currently-observed'}))};
}

/** Prepare a complete local transaction. The runner owns CAS and persistence;
 * this function neither executes game actions nor manufactures review receipts. */
export async function prepareFinish(a:Record<string,unknown>,c:ToolContext){
 keys(a,[],['memory','notebook','reminders','commanderCleanup','manualReview']);
 const cleanup=a.commanderCleanup===undefined?undefined:prepareCommanderCleanup(c.state.commanderDirectives??{version:0,text:''},a.commanderCleanup).cleanup;
 if(cleanup){
  if(cleanup.basisRevision!==c.snapshot.observation.revision)throw Error('Commander cleanup observation changed');
  for(const item of cleanup.completed)for(const ref of item.evidence){
   if(ref==='observation:'+cleanup.basisRevision)continue;
   if(ref.startsWith('result:')&&c.readToolResult?.(ref.slice(7))!==undefined)continue;
   throw Error('Unknown commander cleanup evidence: '+ref);
  }
 }
 const notePreparation=prepareCandidate('$.notebook',()=>{
  const notebook=a.notebook===undefined?{}:object(a.notebook);keys(notebook,[],['set','remove']);
  return prepareNotebook(notebook,c);
 });
 const reminderPreparation=prepareCandidate('$.reminders',()=>prepareReminders(a.reminders===undefined?{}:object(a.reminders),c));
 const memoryPreparation=prepareCandidate('$.memory',()=>{
  if(a.memory!==undefined)keys(object(a.memory),[],['strategy']);
  return patchMemory(c.state.memory,a.memory,undefined);
 });
 const issues=[...notePreparation.issues,...reminderPreparation.issues,...memoryPreparation.issues];
 if(!notePreparation.ok||!reminderPreparation.ok||!memoryPreparation.ok)throw Error(JSON.stringify({code:'FINISH_PREFLIGHT_INVALID',issues,correction:'Correct every listed field; no writes were saved'}));
 const notes=notePreparation.candidate,reminders=reminderPreparation.candidate;
 const manualReview=validateManualReview(a.manualReview,c.snapshot,id=>c.snapshot.observation.manualCommands?.receipts.find(r=>r.id===id));
 const warnings=pendingManualReceipts(c.snapshot).some(r=>!manualReview?.receiptIds.includes(r.id))?[{code:'MANUAL_REVIEW_PENDING',path:'$.manualReview',message:'Unacknowledged manual facts stay pending; finishing does not claim they were understood or executed',ignored:null}]:[];
 const unresolved=reminders.active.filter(r=>r.atSeconds<=c.now);
 if(unresolved.length)throw Error('Unresolved due reminders: '+unresolved.map(r=>r.id).join(', ')+'; explicitly complete, cancel or reschedule each before finish');
 return {...(cleanup?{commanderCleanup:{requestId:c.id,cleanup}}:{}),...(manualReview?{manualReview}:{}),manualBasisVersion:c.snapshot.observation.manualCommands?.version??0,warnings,
  memory:memoryPreparation.candidate,memoryUpdated:a.memory!==undefined,notebook:{set:notes.set,remove:notes.remove},
  reminders:{set:reminders.set,cancel:reminders.cancel,complete:reminders.complete}};
}

export interface PreparationIssue {path:string;message:string;detail?:unknown}
export type PreparedCandidate<T>={ok:true;candidate:T;issues:[]}|{ok:false;issues:PreparationIssue[]};
/** Aggregate independent whole-domain failures without validating fragments out of context. */
export function prepareCandidate<T>(path:string,prepare:()=>T):PreparedCandidate<T>{
 try{return {ok:true,candidate:prepare(),issues:[]};}
 catch(error){const message=error instanceof Error?error.message:'Rejected';let detail:unknown;try{detail=JSON.parse(message);}catch{}
  const nested=detail&&typeof detail==='object'&&Array.isArray((detail as {issues?:unknown}).issues)?(detail as {issues:PreparationIssue[]}).issues:undefined;
  return {ok:false,issues:nested?nested.map(issue=>({...issue,path:path+issue.path.slice(1)})):[{path,message,...(detail?{detail}:{})}]};}
}
