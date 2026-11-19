import {createHash} from 'node:crypto';
import {toolMetadata} from '../contracts/tool-metadata.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {ReceiptEvidenceReader} from '../storage/store-interfaces.js';

/** These are system-owned factual predicates, never authored reminder text. */
export type ReceiptPredicate =
 | {kind:'command-recorded';commandId:string}
 | {kind:'fleet-state';fleetId:string;from:'waiting';to:'moving';source:string|null;destination:{kind:string;id:string}|null}
 | {kind:'activity';commandId:string;minimumCheckinTime:number;clearWarnings:boolean};
export interface ReceiptObservation {
 id:string;owner:'system';roomId:string;player:number;commandId:string;predicate:ReceiptPredicate;
 state:'pendingReceipt'|'acceptedKnown'|'awaitingVisibleTransition'|'confirmedFact'|'contradiction'|'unknown'|'expired';
 deadlineSeconds:number;onMismatch:'wake';acceptedRef?:string;lastRevision?:string;observedFrom?:boolean;
 fact?:'command-accepted'|'visible-moving'|'activity-current'|undefined;reason?:string|undefined;
}
interface Intent {id:string;tool:'order';action:Record<string,unknown>;player?:number;seconds?:number}
export interface ReceiptObservationState {format:'receipt-observation/1';roomId:string;intents:Intent[];records:ReceiptObservation[];pendingWrites:string[];resolutions?:import('./write-reconciliation.js').WriteResolution[];recoveredBatches?:{id:string;result:unknown}[];providedEvidence?:Record<string,string>}
export const receiptObservationKind='receipt-observation-state';
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const seconds=(o:PlayerObservation)=>o.view.tick*600+o.secondsSinceLastTick;
export function serverOrderId(id:string,player:number){return `p${player}-`+createHash('sha256').update(id).digest('hex');}
function isObservation(value:unknown,roomId:string):value is PlayerObservation{
 return object(value)&&value.roomId===roomId&&typeof value.revision==='string'&&object(value.view)&&value.view.format==='player-observation/2'&&Number.isSafeInteger(value.view.player)&&Array.isArray(value.view.fleets)&&Array.isArray(value.scheduled);
}
export function emptyReceiptObservations(roomId:string):ReceiptObservationState{return {format:'receipt-observation/1',roomId,intents:[],records:[],pendingWrites:[]};}
/** Keep the current recovery projection small while original command and
 * receipt events remain in the append-only journal for audit/history. Confirmed
 * facts stay only while a pending write or unfinished round still needs their
 * exact acceptance identity. All other unresolved records remain as evidence. */
export function compactReceiptObservations(state:ReceiptObservationState,requiredReceipts:ReadonlySet<string>=new Set()):ReceiptObservationState{
 const pending=new Set(state.pendingWrites);
 const records=state.records.filter(record=>record.state!=='confirmedFact'||pending.has(record.commandId)||requiredReceipts.has(record.commandId));
 const requiredCommands=new Set([...state.pendingWrites,...records.map(record=>record.commandId)]);
 const intents=state.intents.filter(intent=>requiredCommands.has(intent.id));
 if(records.length===state.records.length&&intents.length===state.intents.length)return state;
 return {...state,records,intents};
}
function validateRecord(r:ReceiptObservation,roomId:string){
 if(!r||r.owner!=='system'||r.roomId!==roomId||!Number.isSafeInteger(r.player)||r.player<0||typeof r.id!=='string'||!r.id||typeof r.commandId!=='string'||!r.commandId||!Number.isFinite(r.deadlineSeconds)||r.deadlineSeconds<0||r.onMismatch!=='wake'||!['pendingReceipt','acceptedKnown','awaitingVisibleTransition','confirmedFact','contradiction','unknown','expired'].includes(r.state))throw Error('Invalid system receipt observer');
 const p=r.predicate;if(!p||!['command-recorded','fleet-state','activity'].includes(p.kind))throw Error('Invalid receipt predicate');
 if(p.kind==='command-recorded'&&p.commandId!==r.commandId||p.kind==='activity'&&(p.commandId!==r.commandId||!Number.isFinite(p.minimumCheckinTime)||p.minimumCheckinTime<0||typeof p.clearWarnings!=='boolean')||p.kind==='fleet-state'&&(!p.fleetId||p.from!=='waiting'||p.to!=='moving'))throw Error('Invalid receipt predicate fields');
}
export function registerReceiptObserver(state:ReceiptObservationState,record:ReceiptObservation):ReceiptObservationState{
 validateRecord(record,state.roomId);const old=state.records.find(r=>r.id===record.id);
 if(old){if(JSON.stringify(old.predicate)!==JSON.stringify(record.predicate)||old.commandId!==record.commandId||old.player!==record.player)throw Error('Receipt observer identity conflict');return state;}
 return {...state,records:[...state.records,structuredClone(record)]};
}
function accept(state:ReceiptObservationState,id:string,ref:string,observation?:PlayerObservation,revision?:string,authority?:Record<string,unknown>):ReceiptObservationState{
 const intent=state.intents.find(i=>i.id===id),player=observation?.view.player??intent?.player;
 if(player===undefined)return state;
 const now=observation?seconds(observation):intent?.seconds??0;
 const envelope=authority??observation as unknown as Record<string,unknown>|undefined,rawReceipt=envelope?.protocolReceipt;
 const expectedKey=createHash('sha256').update(JSON.stringify([intent?.tool,id])).digest('hex');
 if(rawReceipt!==undefined&&(!object(rawReceipt)||rawReceipt.effectCommitted!==true||!object(rawReceipt.scope)||rawReceipt.scope.roomId!==state.roomId||envelope?.protocolReceiptPlayer!==player||intent&&rawReceipt.idempotencyKey!==expectedKey))throw Error('Receipt effect identity mismatch');
 const effects=object(rawReceipt)&&object(rawReceipt.effects)?rawReceipt.effects:undefined;
 let next=registerReceiptObserver(state,{id:`receipt:${id}`,owner:'system',roomId:state.roomId,player,commandId:id,predicate:{kind:'command-recorded',commandId:id},state:'acceptedKnown',deadlineSeconds:now+600,onMismatch:'wake',acceptedRef:ref,...(revision?{lastRevision:revision}:{})});
 next={...next,pendingWrites:next.pendingWrites.filter(pending=>pending!==id),records:next.records.map(r=>r.commandId===id&&!r.acceptedRef?{...r,acceptedRef:ref,state:'acceptedKnown' as const}:r)};
 // Only exact protocol identities are linked. Never identify a delivered fleet
 // by disappearance, a matching total, or the only route that looks plausible.
 if(intent?.action.kind==='launch'&&observation){
  const fleetId=typeof intent.action.fleetId==='string'?intent.action.fleetId:typeof effects?.orderId==='string'?effects.orderId:serverOrderId(id,player);
  const fleet=observation.view.fleets.find(f=>f.id===fleetId&&f.owner===player&&f.state==='waiting');
  if(fleet)next=registerReceiptObserver(next,{id:`fleet:${id}`,owner:'system',roomId:state.roomId,player,commandId:id,predicate:{kind:'fleet-state',fleetId,from:'waiting',to:'moving',source:fleet.source??null,destination:fleet.destination},state:'acceptedKnown',deadlineSeconds:now+Math.max(0,fleet.launchRemainingSeconds??fleet.secondsUntilLaunch??600)+1200,onMismatch:'wake',acceptedRef:ref,observedFrom:true});
 }
 return observation?observeReceipts(next,observation):next;
}
/** Replay original durable receipts, including accepted batch children. A
 * rejected or unknown child cannot inherit a sibling's accepted status. */
export function reduceReceiptJournal(state:ReceiptObservationState,kind:string,payload:unknown,basis?:PlayerObservation):ReceiptObservationState{
 if(!object(payload))return state;
 let next=state;
 if(kind==='execution-evidence-provided'&&Array.isArray(payload.references)){
  const providedEvidence={...state.providedEvidence};
  for(const reference of payload.references){
   if(!object(reference)||typeof reference.id!=='string'||typeof reference.digest!=='string'||! /^[a-f0-9]{64}$/.test(reference.digest))throw Error('Invalid delivered execution evidence');
   providedEvidence[reference.id]=reference.digest;
  }
  return {...state,providedEvidence};
 }
 if(kind==='batch-recovered'&&typeof payload.id==='string'&&object(payload.result)&&Array.isArray(payload.result.results)){
  const unresolved=payload.result.results.some(child=>!object(child)||['pending','unknown'].includes(String(child.status)));
  return {...state,recoveredBatches:[...(state.recoveredBatches??[]).filter(r=>r.id!==payload.id),{id:payload.id,result:structuredClone(payload.result)}],pendingWrites:unresolved?state.pendingWrites:state.pendingWrites.filter(id=>id!==payload.id)};
 }
 if(kind==='write-reconciled'){
  const resolution=payload as unknown as import('./write-reconciliation.js').WriteResolution;
  if(typeof resolution.id!=='string'||!state.pendingWrites.includes(resolution.id)||!['committed','rejected','not-executed','unknown'].includes(resolution.status))return state;
  next={...state,resolutions:[...(state.resolutions??[]).filter(r=>r.id!==resolution.id),structuredClone(resolution)]};
  if(resolution.status==='committed'){
   if(!basis||resolution.protocolReceiptPlayer!==basis.view.player)throw Error('Reconciled receipt requires current player authority');
   next=accept(next,resolution.id,`write-reconciled:${resolution.id}`,basis,basis.revision,payload);
  }
  if(resolution.status!=='unknown')next={...next,pendingWrites:next.pendingWrites.filter(id=>id!==resolution.id)};
  return next;
 }
 if(typeof payload.id==='string'&&typeof payload.tool==='string'&&(kind==='tool-intent'||kind==='batch-item-intent')&&payload.invalidArguments!==true&&toolMetadata(payload.tool)?.commit==='remote'&&!state.pendingWrites.includes(payload.id))next={...next,pendingWrites:[...next.pendingWrites,payload.id]};
 if(typeof payload.id==='string'&&(kind==='tool-result'||kind==='tool-rejected'||kind==='batch-item-result'))next={...next,pendingWrites:next.pendingWrites.filter(id=>id!==payload.id)};
 if(kind==='tool-intent'||kind==='batch-item-intent'){
  const args=object(payload.arguments)?payload.arguments:null;
  if(typeof payload.id==='string'&&payload.tool==='order'&&args&&object(args.action)&&typeof args.action.kind==='string'){
   const intent:Intent={id:payload.id,tool:payload.tool,action:structuredClone(args.action),...(basis?{player:basis.view.player,seconds:seconds(basis)}:{})};
   const old=state.intents.find(i=>i.id===intent.id);
   if(old&&JSON.stringify([old.tool,old.action])!==JSON.stringify([intent.tool,intent.action]))throw Error('Receipt command identity conflict');
   if(!old)next={...next,intents:[...next.intents,intent]};
  }
 }
 if(kind==='receipt-observation-set')return registerReceiptObserver(next,payload as unknown as ReceiptObservation);
 if(kind==='batch-item-result'&&payload.status==='accepted'&&typeof payload.id==='string')next=accept(next,payload.id,`batch-item-result:${payload.id}`,undefined,typeof payload.revision==='string'?payload.revision:undefined,payload);
 if(kind==='tool-result'&&typeof payload.id==='string'){
  if(payload.tool==='order'&&isObservation(payload.result,state.roomId))next=accept(next,payload.id,`tool-result:${payload.id}`,payload.result,payload.result.revision);
  if(payload.tool==='batch'&&object(payload.result)&&isObservation(payload.result.observation,state.roomId)&&Array.isArray(payload.result.results)){
   for(const child of payload.result.results)if(object(child)&&child.status==='accepted'&&typeof child.id==='string')next=accept(next,child.id,`batch-item-result:${child.id}`,payload.result.observation,typeof child.revision==='string'?child.revision:undefined,child);
  }
 }
 if(kind==='batch-item-unknown'&&typeof payload.id==='string')next={...next,records:next.records.map(r=>r.commandId===payload.id&&r.state!=='confirmedFact'?{...r,state:'unknown',reason:'Command outcome is unknown; do not resubmit'}:r)};
 if(kind==='observation-baseline'&&isObservation(payload,state.roomId))next=observeReceipts(next,payload);
 if(kind==='wake-state'&&isObservation(payload.observed,state.roomId))next=observeReceipts(next,payload.observed);
 return next;
}
/** Missing visibility is explicitly unknown, not a battle/arrival result. */
export function observeReceipts(state:ReceiptObservationState,observation:PlayerObservation):ReceiptObservationState{
 if(observation.roomId!==state.roomId)return state;
 const now=seconds(observation);
 const records=state.records.map(record=>{
  if(record.player!==observation.view.player||record.state==='confirmedFact')return record;
  const r={...record,lastRevision:observation.revision},p=r.predicate;
  const finish=(fact:ReceiptObservation['fact'])=>({...r,state:'confirmedFact' as const,fact,reason:undefined});
  const missing=(reason:string)=>({...r,state:now>r.deadlineSeconds?'expired' as const:'unknown' as const,reason});
  if(!r.acceptedRef)return now>r.deadlineSeconds?{...r,state:'expired' as const,reason:'No authoritative acceptance receipt before observer deadline'}:record;
  if(p.kind==='command-recorded')return finish('command-accepted');
  const waiting=()=>now>r.deadlineSeconds?{...r,state:'expired' as const,reason:'Expected visible transition was not established before game-time deadline'}:{...r,state:'awaitingVisibleTransition' as const,observedFrom:true,reason:undefined};
  if(p.kind==='activity'){
   const a=observation.view.self.activity;
   if(!a)return missing('Current activity fields unavailable');
   if(!observation.view.self.active||a.autoResigned)return {...r,state:'contradiction' as const,reason:'Seat is inactive; maintenance cannot reactivate it'};
   if(a.lastCheckinTime>=p.minimumCheckinTime&&(!p.clearWarnings||a.inactivityWarningCount===0))return finish('activity-current');
   return {...r,state:'contradiction' as const,reason:'Accepted command did not establish the expected activity fields'};
  }
  const fleet=observation.view.fleets.find(f=>f.id===p.fleetId);
  if(!fleet)return missing('Fleet is not currently visible; disappearance proves no outcome');
  if(fleet.owner!==r.player||JSON.stringify(fleet.destination)!==JSON.stringify(p.destination)||(fleet.source??null)!==p.source)return {...r,state:'contradiction' as const,reason:'Fleet identity, owner, source, or destination changed'};
  if(fleet.state==='moving'&&r.observedFrom)return finish('visible-moving');
  if(fleet.state==='waiting')return waiting();
  return missing(`Uncovered visible fleet state: ${fleet.state}`);
 });
 return JSON.stringify(records)===JSON.stringify(state.records)?state:{...state,records};
}
/** Replays all rows after the newest complete system checkpoint. On first use,
 * original journal pages are replayed in order, not only the last 50 rows. */
export function restoreReceiptObservations(store:Pick<ReceiptEvidenceReader,'historyPage'>&Partial<Pick<ReceiptEvidenceReader,'queryResult'|'pendingWriteEvidence'>>,roomId:string,seat:number,requiredReceipts:ReadonlySet<string>=new Set(),requiredPlayer?:number):ReceiptObservationState{
 const rows:{kind:string;payload:unknown}[]=[];let before:number|undefined,state=emptyReceiptObservations(roomId),found=false;
 do{const page=store.historyPage(roomId,seat,before);for(const row of page.entries){
   if(row.kind===receiptObservationKind){const saved=row.payload as ReceiptObservationState;
    if(saved?.format!=='receipt-observation/1'||saved.roomId!==roomId||!Array.isArray(saved.records)||!Array.isArray(saved.intents)||!Array.isArray(saved.pendingWrites))throw Error('Invalid durable receipt observer state');
    for(const r of saved.records)validateRecord(r,roomId);state=structuredClone(saved);found=true;break;
   }rows.push(row);
  }if(found||page.nextCursor===null)break;before=page.nextCursor;
 }while(true);
 let basis:PlayerObservation|undefined;
 for(const row of rows.reverse()){
  const p=row.payload;if(isObservation(p,roomId))basis=p;else if(object(p)&&isObservation(p.observed,roomId))basis=p.observed;
  state=reduceReceiptJournal(state,row.kind,row.payload,basis);
 }
 // A previous version may already have compacted a needed confirmation. Read
 // only exact current-round IDs from original durable receipts, then keep just
 // their acceptance facts, never old observations or unrelated historical work.
 const hasAcceptance=(id:string)=>state.records.some(r=>r.commandId===id&&r.predicate.kind==='command-recorded'&&!!r.acceptedRef&&r.fact==='command-accepted'&&['acceptedKnown','confirmedFact'].includes(r.state));
 const terminalResolution=(id:string)=>state.resolutions?.some(r=>r.id===id&&r.status!=='unknown');
 const missing=()=>[...requiredReceipts].filter(id=>!hasAcceptance(id)&&!terminalResolution(id));
 const retain=(recovered:ReceiptObservationState)=>{
   const records=recovered.records.filter(r=>requiredReceipts.has(r.commandId)&&r.predicate.kind==='command-recorded'&&!!r.acceptedRef&&(requiredPlayer===undefined||r.player===requiredPlayer)&&!hasAcceptance(r.commandId)&&!terminalResolution(r.commandId));
   if(!records.length)return;
   for(const record of records){const old=state.records.find(r=>r.id===record.id);if(old&&(old.commandId!==record.commandId||old.player!==record.player||JSON.stringify(old.predicate)!==JSON.stringify(record.predicate)))throw Error('Receipt observer identity conflict');}
   const commands=new Set(records.map(r=>r.commandId));
   state={...state,records:[...state.records.filter(old=>!records.some(r=>r.id===old.id)),...records],pendingWrites:state.pendingWrites.filter(id=>!commands.has(id)),intents:[...state.intents,...recovered.intents.filter(i=>commands.has(i.id)&&!state.intents.some(old=>old.id===i.id))]};
 };
 for(const id of missing()){
   const receipt=store.queryResult?.(roomId,seat,id);
   if(!object(receipt)||receipt.id!==id)continue;
   let recovered=reduceReceiptJournal(emptyReceiptObservations(roomId),'tool-intent',receipt);
   recovered=reduceReceiptJournal(recovered,'tool-result',receipt);
   retain(recovered);
 }
 const unresolved=missing();
 for(const evidence of unresolved.length?store.pendingWriteEvidence?.(roomId,seat,unresolved)??[]:[]){
   const receipt='result' in evidence.evidence?evidence.evidence.result:undefined;
   if(evidence.evidence.kind!=='batch-item-result'||!object(receipt)||receipt.id!==evidence.id||receipt.status!=='accepted'||!object(receipt.protocolReceipt)||!Number.isSafeInteger(receipt.protocolReceiptPlayer))continue;
   // A child can commit before its parent batch receipt. Its original protocol
   // identity supplies the player; accept() still checks scope and command key.
   let recovered=reduceReceiptJournal(emptyReceiptObservations(roomId),'batch-item-intent',{id:evidence.id,tool:evidence.tool,arguments:evidence.arguments});
   recovered={...recovered,intents:recovered.intents.map(intent=>({...intent,player:Number(receipt.protocolReceiptPlayer)}))};
   retain(reduceReceiptJournal(recovered,'batch-item-result',receipt));
 }
 return state;
}
export function receiptObserverAlerts(previous:ReceiptObservationState,next:ReceiptObservationState){
 return next.records.filter(r=>['unknown','contradiction','expired'].includes(r.state)&&!previous.records.some(p=>p.id===r.id&&p.state===r.state&&p.reason===r.reason));
}
