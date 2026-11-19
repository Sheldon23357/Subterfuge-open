import type {ManualCommandReceipt,ManualCommandView,ManualCommandProtection,PlayerObservation} from '../../../../contracts/src/index.js';
import type {AiSnapshot} from '../contracts/types.js';
import type {MemoryEvidence} from '../storage/memory-evidence.js';

export interface ManualIntent {actor:'ai';version:number;receiptIds:string[];confidence:'low'|'medium'|'high'}
export interface ManualReview {version:number;receiptIds:string[];reason:string}
export const manualVersion=(o:PlayerObservation)=>o.manualCommands?.version??0;
export const isTacticalManual=(r:ManualCommandReceipt)=>!['check-in','cancel-inactivity-warning'].includes(r.action?.kind??'');
/** Scheduled human launches may gain a fleet only later, without rewriting the
 * immutable acceptance receipt. Current fleet protections carry that identity. */
export function manualFleetIds(o:PlayerObservation):Set<string>{
 return new Set([...(o.manualCommands?.receipts.flatMap(r=>r.affectedFleetIds)??[]),
  ...(o.manualCommands?.protections.filter(p=>p.kind==='fleet').flatMap(p=>p.scope.filter(s=>s.startsWith('fleet:')).map(s=>s.slice(6)))??[])]);
}
const scopeEntities=(scopes:string[])=>scopes.flatMap(scope=>{
 if(scope.startsWith('destination:'))return [scope.split(':').slice(2).join(':')];
 if(/^(source|outpost|fleet|schedule):/.test(scope))return [scope.slice(scope.indexOf(':')+1)];
 return /^funding:/.test(scope)?[scope]:[];
});
export const manualProtectionEntities=(protection:ManualCommandProtection)=>scopeEntities(protection.scope);
export function manualEntities(r:ManualCommandReceipt,view?:ManualCommandView,seen=new Set<string>()):string[]{
 if(seen.has(r.id))return [];seen.add(r.id);
 const action:Record<string,unknown>=r.action??{};
 return [...new Set([...scopeEntities((view?.protections??[]).filter(p=>p.receiptId===r.id).flatMap(p=>p.scope)),
  ...scopeEntities(r.releasedScopes??[]),...(r.releasedReceiptIds??[]).flatMap(id=>{const original=view?.receipts.find(item=>item.id===id);return original?manualEntities(original,view,seen):[];}),
  ...r.affectedFleetIds,...r.cancelledScheduleIds,...(r.scheduleId?[r.scheduleId]:[]),...(action.kind==='toggle-funding'&&Number.isSafeInteger(action.recipient)?[`funding:${action.recipient}`]:[]),
  ...['source','destination','fleetId','outpostId'].flatMap(k=>typeof action[k]==='string'?[String(action[k])]:[])])];
}
/** Read-only compatibility: retain evidence linked by historical release receipts. */
function includeReleaseSources(view:ManualCommandView,selected:Set<string>){
 for(const receipt of view.receipts)if(selected.has(receipt.id))for(const id of receipt.releasedReceiptIds??[])if(view.receipts.some(r=>r.id===id))selected.add(id);
}
/** Discussion cannot query history. Keep all active guard evidence plus at most
 * eight additional facts, linked entities first; omission never implies absence. */
export function commanderManualObservation(o:PlayerObservation,entities:ReadonlySet<string>=new Set()){
 const view=o.manualCommands;if(!view)return o;
 const selected=new Set(view.protections.map(p=>p.receiptId));
 const recent=[...view.receipts].sort((a,b)=>b.version-a.version);
 const ordered=[...recent.filter(r=>manualEntities(r,view).some(id=>entities.has(id))),...recent];
 let extra=0;for(const receipt of ordered){if(selected.has(receipt.id))continue;if(extra===8)break;selected.add(receipt.id);extra++;}
 includeReleaseSources(view,selected);
 const receipts=view.receipts.filter(r=>selected.has(r.id));
 return {...o,manualCommands:{...view,receipts,...historicalManualNotice(receipts),omittedReceiptCount:view.receipts.length-receipts.length,
  contextCoverage:'active-protection-evidence-and-up-to-8-linked-or-recent-facts',
  historyNotice:'Omitted older facts are not evidence that an action never happened. Discussion cannot execute or acknowledge those unseen facts.'}};
}
/** Historical facts remain readable without advertising a removed control flow. */
const historicalManualNotice=(receipts:ManualCommandReceipt[])=>receipts.some(r=>r.kind==='release-protection')?{
 historicalOutcomeNotice:'released is a read-only historical protection change, not cancellation or execution of game orders. No current protection-management operation is available or required; coordinate automatically on compatible legal work.'
}:{};
/** Read genuine human-command facts, never manufacture an AI tool acceptance. */
export function manualMemoryEvidence(reference:string,receipt:ManualCommandReceipt|undefined):MemoryEvidence|undefined{
 if(!receipt||reference!==`manual:${receipt.id}`)return undefined;
 return {reference,kind:'manual-command',actor:'human',outcome:receipt.outcome,version:receipt.version};
}
export function pendingManualReceipts(s:AiSnapshot){return (s.observation.manualCommands?.receipts??[]).filter(r=>isTacticalManual(r)&&!(s.manualReviewedReceiptIds??[]).includes(r.id));}
export function validateManualReview(raw:unknown,s:AiSnapshot,known:(id:string)=>ManualCommandReceipt|undefined):ManualReview|undefined{
 if(raw===undefined)return undefined;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid manualReview');
 const r=raw as Record<string,unknown>;
 if(Object.keys(r).sort().join(',')!=='reason,receiptIds,version'||r.version!==manualVersion(s.observation)||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>500||
  !Array.isArray(r.receiptIds)||r.receiptIds.length>200||new Set(r.receiptIds).size!==r.receiptIds.length||r.receiptIds.some(id=>typeof id!=='string'||!known(id)))
  throw Error('Invalid or stale manualReview: acknowledge genuine manual receipt IDs at the current manual version, not inferred execution');
 // A bounded tail cannot prove the omitted interval was reviewed. Resolve the
 // current facts and disclose the gap; never pretend every old action was read.
 return structuredClone(r) as unknown as ManualReview;
}
export const MANUAL_COMMAND_POLICY=`玩家手动行动是服务器记录的具体操作事实，当前protections是硬约束。相同范围内的新手动行动优先于旧计划，无关的有效指令继续遵守；不得重复、撤销或耗尽受保护资源。
scheduled只表示已登记预约，applied不表示抵达或获胜，cancelled只取消对应预约。程序提供当前状态与结算，舰队消失不能确认抵达；未知执行由程序核实，不重发。
手动配合自动进行，不要求玩家管理保护或反复切换控制；局部冲突不阻止其他兼容行动。不要把操作推测成已确认的战略指令，必要推断、条件和后续计划只写笔记正文。普通决策可在finish同时保存笔记、战略、提醒及manualReview；后者只确认本次已提供且核对的原始ID，是事实处理自报，不证明战略理解、实际执行或玩家授权。没有提供的历史不声称已读；旧提醒不能恢复已取消动作。指挥官讨论遵守当前专用输出协议，不执行游戏操作；暂停的AI不因记录新事实而启动。`;
