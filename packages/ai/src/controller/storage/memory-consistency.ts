import {manualEntities,manualProtectionEntities} from '../execution/manual-coordination.js';
import {notebookAfterChanges,notebookDependencies} from './notebook-dependencies.js';
import {isActiveNote} from './memory-records.js';
import {createHash} from 'node:crypto';
import type {AiMemory,AiSnapshot,NotebookEntry} from '../contracts/types.js';
import {fleetLabel,shortFleetReferences} from '../presentation/fleet-labels.js';
import {activeCampaign} from './campaign-state.js';

export interface ReviewReceipt {id:string;fingerprint:string;seconds:number;reason:string}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,24);
/** Only the player's projection is an authority for current facts. Text is never
 * parsed as a proven action or a battle result, including old predictions. */
export function memoryConsistency(memory:AiMemory,snapshot:AiSnapshot,receipts:ReviewReceipt[]=[]){
  const o=snapshot.observation,now=o.view.tick*600+o.secondsSinceLastTick;
  const docs=[
    ...Object.entries(memory).filter(([,text])=>text.trim()).map(([id,text])=>({id:`memory:${id}`,text,entities:[] as string[],semantic:undefined})),
    ...(snapshot.notebook??[]).filter(n=>isActiveNote(n,now)).map(n=>({id:`note:${n.id}`,text:n.text,entities:n.record?.entities??[],semantic:{basis:n.basis,basisTick:n.basisTick,manualIntent:n.manualIntent}})),
    ...(snapshot.campaigns??[]).filter(activeCampaign).map(p=>({id:`campaign:${p.id}`,text:[p.objective,p.holdPlan,p.cancelWhen].join('\n'),entities:[p.target,...p.allocations.map(a=>a.source)],semantic:{target:p.target,allocations:[...p.allocations].sort((a,b)=>a.source.localeCompare(b.source)),reviewAtTick:p.reviewAtTick,defenseOverrides:[...(p.defenseOverrides??[])].sort((a,b)=>a.source.localeCompare(b.source)),comparison:p.comparison,comparisonInvalidated:p.comparisonInvalidated??false,committedOrders:[...(p.committedOrders??[])].sort()}})),
  ];
  const available=new Map<string,Record<string,unknown>>();
  for(const p of o.view.outposts)available.set(p.id,{kind:'outpost',owner:p.owner,drillers:p.drillers,shield:p.shield,destroyed:p.destroyed});
  for(const f of o.view.fleets)available.set(fleetLabel(f.id),{kind:'fleet',owner:f.owner,state:f.state,source:f.source,destination:f.destination,drillers:f.drillers});
  const facts:Record<string,Record<string,unknown>>={},previous=new Map(receipts.map(r=>[r.id,r]));
  const bases=docs.map(d=>{
    const text=fleetLabel(d.text),ids=new Set(d.entities.map(fleetLabel));
    for(const id of available.keys())if(text.includes(id))ids.add(id);
    for(const [id,name] of Object.entries(o.outpostNames??{}))if(name&&text.includes(name))ids.add(id);
    for(const match of text.matchAll(/\bF\d+-[A-F0-9]{8}\b/gi))ids.add(match[0].toUpperCase());
    for(const id of ids)facts[id]=available.get(id)??{kind:'unknown',status:'not-currently-observed',instruction:'不代表抵达、死亡或归属变化'};
    const note=snapshot.notebook?.find(n=>`note:${n.id}`===d.id);
    const referencedManual=new Set([...(note?.manualIntent?.receiptIds??[]),...(note?.record?.evidence??[]).filter(ref=>ref.startsWith('manual:')).map(ref=>ref.slice(7))]);
    const relatedManual=(o.manualCommands?.receipts??[]).filter(r=>referencedManual.has(r.id)||manualEntities(r,o.manualCommands).some(id=>ids.has(fleetLabel(id))));
    // Natural guard expiry need not create another human-command version. Bind
    // review to only this record's entities/evidence, never unrelated guards.
    const activeProtections=(o.manualCommands?.protections??[]).filter(p=>referencedManual.has(p.receiptId)||manualProtectionEntities(p).some(id=>ids.has(fleetLabel(id))))
      .map(p=>({receiptId:p.receiptId,kind:p.kind,scope:[...p.scope].sort(),...(p.expiresAtTick===undefined?{}:{expiresAtTick:p.expiresAtTick})})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const manualAuthority=relatedManual.length?{actor:'human' as const,receiptIds:relatedManual.map(r=>r.id),version:Math.max(...relatedManual.map(r=>r.version)),activeProtectionBasis:hash(activeProtections),activeProtectionCount:activeProtections.length}:undefined;
    const sorted=[...ids].sort(),fingerprint=hash({text,semantic:d.semantic,record:shortFleetReferences(snapshot.notebook?.find(n=>`note:${n.id}`===d.id)?.record),facts:sorted.map(id=>[id,facts[id]]),...(manualAuthority?{manualAuthority}:{})});
    return {id:d.id,fingerprint,entities:sorted,...(manualAuthority?{manualAuthority}:{})};
  });
  const resolver=notebookDependencies(snapshot);
  const items=bases.map(item=>{
    const visited=new Set<string>(),dependencies:{id:string;fingerprint:string}[]=[];
    const follow=(id:string)=>{
      if(visited.has(id))return;visited.add(id);
      const note=snapshot.notebook?.find(n=>`note:${n.id}`===id);
      for(const link of note?.record?.links??[]){
        const resolved=resolver.resolve(link),target=bases.find(b=>b.id===resolved?.id);
        dependencies.push({id:resolved?.id??link,fingerprint:target?.fingerprint??resolved?.summary?.version??'unresolved; retrieve history before assuming completion'});
        if(target)follow(target.id);
      }
    };
    follow(item.id);
    const fingerprint=dependencies.length?hash({base:item.fingerprint,dependencies:dependencies.sort((a,b)=>a.id.localeCompare(b.id))}):item.fingerprint;
    const terminal=!o.view.self.active||!!o.view.match?.ended;
    const old=previous.get(item.id),reviewNeeded=!terminal&&(!old||old.fingerprint!==fingerprint||(now-old.seconds<0||now-old.seconds>=21600));
    return {...item,fingerprint,reviewNeeded,reason:terminal?'seat-ended-history':!old?'not-reviewed':old.fingerprint!==fingerprint?'record-or-observation-changed':(now-old.seconds<0||now-old.seconds>=21600)?'review-window':'reviewed'};
  });
  const valid=items.filter(i=>!i.reviewNeeded).flatMap(i=>{const r=previous.get(i.id);return r&&r.fingerprint===i.fingerprint&&r.seconds<=now&&now-r.seconds<21600?[r.seconds+21600]:[];});
  const factsCoverage={complete:items.every(i=>!i.reviewNeeded),pending:items.filter(i=>i.reviewNeeded).length,validUntil:valid.length?Math.min(...valid):null};
  return {observedTick:o.view.tick,revision:o.revision,factsCoverage,
    authority:'facts来自本人当前受限观察；笔记、四项记忆和战役正文均是历史事实/当时意图/条件预测，不是当前状态。未知不代表已抵达或死亡。',facts,items};
}
export type MemoryConsistency=ReturnType<typeof memoryConsistency>;

export function validateReviewed(raw:unknown,consistency:MemoryConsistency|undefined):{id:string;fingerprint:string;reason:string}[]{
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>80)throw Error('Invalid reviewed records');
  const seen=new Set<string>();
  return raw.map(r=>{
    if(!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='fingerprint,id,reason'||typeof r.id!=='string'||seen.has(r.id)||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>300)throw Error('Invalid review receipt');
    seen.add(r.id);
    if(!consistency?.items.some(i=>i.id===r.id&&i.fingerprint===r.fingerprint))throw Error('Stale or unknown review fingerprint; inspect current memoryConsistency');
    return {id:r.id,fingerprint:r.fingerprint,reason:r.reason};
  });
}
/** Explicit acknowledgement of the submitted final contents against the shown
 * observation. The runner's existing private-state CAS still owns commit. */
export function validateFinalReview(raw:unknown,snapshot:AiSnapshot,final:MemoryConsistency,submittedNotes:NotebookEntry[]=[]){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid reviewFinal');
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!=='basisRevision,items'||value.basisRevision!==snapshot.observation.revision)
    throw Error('Stale or invalid reviewFinal basisRevision; use the current observation revision');
  if(!Array.isArray(value.items)||value.items.length>80)throw Error('Invalid reviewFinal items');
  const now=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
  const closed=new Map(submittedNotes.filter(n=>!isActiveNote(n,now)).map(n=>[`note:${n.id}`,n]));
  const archived:{id:string;reason:string;outcome:'archived';status:string}[]=[],seen=new Set<string>();
  const receipts=value.items.flatMap(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='id,reason')throw Error('Invalid reviewFinal item: supply id and reason');
    if(typeof item.id!=='string'||seen.has(item.id)||typeof item.reason!=='string'||!item.reason.trim()||item.reason.length>300)throw Error('Invalid reviewFinal item: duplicate id or invalid reason');
    seen.add(item.id);
    const candidate=final.items.find(i=>i.id===item.id);
    if(!candidate){
      const note=closed.get(item.id);
      if(note){archived.push({id:item.id,reason:item.reason,outcome:'archived',status:note.expiresAt!==null&&note.expiresAt<=now?'expired':note.record!.status});return [];}
      throw Error(JSON.stringify({code:'FINISH_REVIEW_UNKNOWN',path:'$.reviewFinal.items',id:item.id,message:'Unknown or removed reviewFinal item; confirm active final records or notes explicitly archived by this submission',correction:'Check this exact id against the final active directory and submitted notebook.set; nothing saved'}));
    }
    return [{id:item.id,fingerprint:candidate.fingerprint,reason:item.reason}];
  });
  return {reviewed:validateReviewed(receipts,final),archived};
}
/** Read-only final transaction check; only actually shown global context can finish strategy. */
export function finalizeMemoryReview(snapshot:AiSnapshot,memory:AiMemory,changes:{set:import('../contracts/types.js').NotebookEntry[];remove:string[]},reviewed:{id:string;fingerprint:string;reason:string}[],previous:ReviewReceipt[],globalContext:boolean,strategic:unknown){
  let reason:string|undefined;
  if(strategic!==undefined){
    if(!strategic||typeof strategic!=='object'||Object.keys(strategic).join(',')!=='reason'||typeof (strategic as {reason:unknown}).reason!=='string')throw Error('Invalid strategicReview: supply reason');
    reason=(strategic as {reason:string}).reason;
    if(!reason.trim()||reason.length>600)throw Error('Invalid strategicReview reason');
    if(!globalContext)throw Error('Strategic review requires actual full strategic context; observe {scope:"full"} first');
  }
  const final=notebookAfterChanges(snapshot,shortFleetReferences(changes.set),changes.remove),now=snapshot.observation.view.tick*600+snapshot.observation.secondsSinceLastTick;
  const current=memoryConsistency(shortFleetReferences(memory),final),byId=new Map(reviewed.map(r=>[r.id,r]));
  const stale=reviewed.filter(r=>current.items.some(i=>i.id===r.id&&i.fingerprint!==r.fingerprint));
  if(stale.length){
    const after=memoryConsistency(shortFleetReferences(memory),final,previous);
    throw Error(JSON.stringify({code:'FINISH_REVIEW_CHANGED',path:'$.reviewed',items:stale.map(r=>r.id),
      oldPending:snapshot.memoryConsistency?.items.filter(i=>i.reviewNeeded).map(i=>i.id)??null,
      newPending:after.items.filter(i=>i.reviewNeeded).map(i=>({id:i.id,fingerprint:i.fingerprint,reason:i.reason})),
      changed:stale.map(r=>({id:r.id,submittedFingerprint:r.fingerprint,finalFingerprint:current.items.find(i=>i.id===r.id)!.fingerprint})),
      correction:'The submitted old fingerprint cannot review a changed or linked record. Explicitly confirm final contents with reviewFinal against the current basisRevision in the same finish, or preview and inspect that exact version; nothing saved.'}));
  }
  const receipts:ReviewReceipt[]=current.items.flatMap(item=>{const r=byId.get(item.id);return r?.fingerprint===item.fingerprint?[{...r,seconds:now}]:[];});
  const coverage=memoryConsistency(shortFleetReferences(memory),final,[...previous,...receipts]).factsCoverage;
  if(reason!==undefined&&!coverage.complete){
    const before=snapshot.memoryConsistency;
    const after=memoryConsistency(shortFleetReferences(memory),final,[...previous,...receipts]);
    throw Error(JSON.stringify({code:'FINISH_REVIEW_PENDING',path:'$.strategicReview',message:'Strategic review requires complete current factual coverage',oldPending:before?.items.filter(i=>i.reviewNeeded).map(i=>i.id)??null,newPending:after.items.filter(i=>i.reviewNeeded).map(i=>({id:i.id,fingerprint:i.fingerprint,reason:i.reason})),correction:'Use finish preview:true with these writes; review its final candidate, then submit identical writes with previewRef and explicit reviewed receipts. No writes were saved.'}));
  }
  return {receipts,strategicReview:reason!==undefined,reason,coverage};
}
export const CONSISTENCY_POLICY=`snapshot.memoryConsistency是当前事实与逐条复核目录。动态兵力、舰队状态以facts/当前观察为准，旧正文保留为带时间依据的历史或条件预测，不重复复制为当前事实。reviewNeeded条目须核对；新事实使旧计划失效时更新/关闭对应记录及关联战役，不只新增另一份矛盾笔记。不得把看不见的舰队推定已到达或死亡。正常单步收尾优先用reviewFinal确认提交后的最终内容（见下方写入复核约定），程序生成版本指纹；不改内容或明确采用预览流程时，finish仍可带reviewed:[{id:"目录ID",fingerprint:"目录指纹",reason:"已核对的依据、修正内容或保留为历史的理由"}]；只有真正核对的条目才回执，局部修改不算全面复核。有效逐条回执可跨轮累计，最早回执到期不会因后续回执续命。factsCoverage.validUntil是绝对规则秒；factsCoverage只表示事实覆盖，不表示战略复盘完成。task.memoryReview分别给出factsNeeded、strategicReview、cleanupNeeded。战略复盘须查看全局上下文、检查胜利路径/优先级/跨记录冲突后，用finish strategicReview:{reason:"全局复盘结论"}单独确认；仅在最终事实覆盖完整且本次拿到全局上下文时生效。清理须实际缩短过长四项记忆，回执不能代替清理。全面整理须逐条核对目录；紧急行动可先收尾，未复核项保留待办，下次正常思考继续，不新增固定周期唤醒。`;

/** A preview is bound to the complete authorized source and normalized candidate.
 * Persisted preview receipts prove which candidate was actually shown; no implicit review. */
export function finishPreviewToken(state:{memory:AiMemory;commanderDirectives?:unknown},snapshot:AiSnapshot,candidate:unknown){
 return createHash('sha256').update(JSON.stringify({memory:state.memory,commander:state.commanderDirectives??null,
   observation:snapshot.observation,notebook:snapshot.notebook??[],dependencies:snapshot.notebookDependencies??[],
   reminders:snapshot.reminders??[],campaigns:snapshot.campaigns??[],candidate})).digest('hex');
}
export const WRITE_REVIEW_POLICY=`正常收尾优先单次finish提交写入与reviewFinal:{basisRevision:"当前observation.revision原值",items:[{id:"note:ID、memory:strategy或campaign:ID等最终活跃记录ID",reason:"针对提交后的最终内容及其依赖的实际复核理由"}]}。无需预览或计算指纹；程序先生成最终候选，再为明确列出的条目计算指纹并原子保存。新增、同ID修改及其受影响的关联条目都须逐项明确确认；不自动确认未列出项，本次notebook.set明确关闭或过期的条目可确认归档结果，回执reviewFinalOutcomes标明archived及实际状态，不生成活跃复核指纹；历史归档未提交、已移除或未知ID仍拒绝。reviewFinal不与reviewed或previewRef混用；省略preview或设false，任一校验失败则无写入。strategicReview仍要求全局上下文和最终事实覆盖完整。只有需要查看规范化结果时才用可选预览。finish.preview:true 是只读预检：返回完整规范化 candidate、写后 memoryConsistency、旧/新 pending、previewRef 和 token，不保存、不处理提醒、不结束本轮。按最终内容逐条核实后，按submission重提原始写入（candidate为只读最终展示，不把updatedAt等显示字段复制为入参），加previewRef 和 reviewed 中预览的精确指纹提交；无需自己计算 hash。状态、原记录、写入内容、提醒或已确认司令版本变化时必须重新预览。旧 reviewed 不能升级同 ID 的新版本，关联记录变化也须核对。预览不代替实际复核；仍需明确 strategicReview.reason 才算战略完成，不通过撤声明或延期来完成本轮任务。格式 null 仅对约定可选项表示省略，缺证据、未知字段和过期指纹必须修正。`;
