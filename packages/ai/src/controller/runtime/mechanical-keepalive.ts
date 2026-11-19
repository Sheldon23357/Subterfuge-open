import {manualVersion} from '../execution/manual-coordination.js';
import {createHash} from 'node:crypto';
import {PROFILE_ID,RULES,TICK_SECONDS} from '../../../../rules/src/index.js';
import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {GameRequestError,GameTransportError} from '../transport/gateway.js';
import {DebugStopError} from '../execution/agent-debug.js';
import type {AiSnapshot,AiState,GameGateway} from '../contracts/types.js';
import type {RunnerRepository} from '../storage/store-interfaces.js';
import type {ReceiptObservation} from '../execution/receipt-observation.js';

export const KEEPALIVE_POLICY='maintain-active-seat/1' as const;
export interface MechanicalKeepaliveOptions {
 /** Both seat opt-in and independently configured room permission were checked. */
 mechanicalKeepalive?:boolean;
 /** Runtime-owned gate: checkpoint drain, lease loss, pause, or shutdown deny. */
 canMaintain?:()=>boolean;
}
export interface KeepaliveIntent {
 format:'mechanical-keepalive/1';policy:typeof KEEPALIVE_POLICY;id:string;roomId:string;player:number;
 action:{kind:'check-in'|'cancel-inactivity-warning'};
 from:{lastCheckinTime:number;inactivityWarningCount:number};atSeconds:number;basisRevision:string;
 status:'intent'|'accepted'|'confirmed'|'rejected'|'unknown'|'not-sent';reason?:string;
}
export type KeepaliveEligibility={eligible:false;reason:string}|{eligible:true;intent:KeepaliveIntent};
export function mechanicalKeepaliveEligibility(observation:PlayerObservation,enabled:boolean,advancing=false):KeepaliveEligibility{
 const {view}=observation,a=view.self.activity;
 if(!enabled)return {eligible:false,reason:'not-authorized'};
 if(view.profile!==PROFILE_ID)return {eligible:false,reason:'unknown-room-rules'};
 if(view.match?.ended||!view.self.active||a?.autoResigned)return {eligible:false,reason:'inactive-or-ended'};
 if(!a||![a.lastCheckinTime,a.inactivityWarningCount,view.tick,observation.secondsSinceLastTick].every(Number.isFinite)||a.lastCheckinTime<0||!Number.isSafeInteger(a.inactivityWarningCount)||a.inactivityWarningCount<0)return {eligible:false,reason:'unknown-activity'};
 const now=view.tick*TICK_SECONDS+observation.secondsSinceLastTick;
 if(a.lastCheckinTime>now)return {eligible:false,reason:'activity-time-in-future'};
 // The rule checks age at the next discrete game tick, not wall-clock elapsed
 // time, command frequency, polling frequency, or current fractional seconds.
 const nextAge=(view.tick+1)*TICK_SECONDS-a.lastCheckinTime;
 const threshold=RULES.GameParams.MinutesOfInactivityBeforeFirstWarning*60;
 const action=a.inactivityWarningCount>0?'cancel-inactivity-warning':(observation.realtime||advancing)&&nextAge>=threshold?'check-in':null;
 if(!action)return {eligible:false,reason:'not-due'};
 const id='maintenance-'+createHash('sha256').update(JSON.stringify([observation.roomId,view.player,KEEPALIVE_POLICY,a.lastCheckinTime,action])).digest('hex');
 return {eligible:true,intent:{format:'mechanical-keepalive/1',policy:KEEPALIVE_POLICY,id,roomId:observation.roomId,player:view.player,action:{kind:action},from:{lastCheckinTime:a.lastCheckinTime,inactivityWarningCount:a.inactivityWarningCount},atSeconds:now,basisRevision:observation.revision,status:'intent'}};
}
export class MechanicalKeepaliveStopped extends GameTransportError {
 constructor(readonly reason:string){super();this.name='MechanicalKeepaliveStopped';this.message=reason;}
 override get displayReason(){return `机械维护已停止：${this.reason}。先核对原命令回执，不能换 ID 重发。`;}
}
interface Host {
 state:AiState;store:RunnerRepository;gateway:GameGateway;options:MechanicalKeepaliveOptions;
 beginBarrier:()=>()=>void;signal:AbortSignal;
 /** Atomically appends original business rows and their typed observer state. */
 saveEvents:(events:{kind:string;details:unknown}[],expectedBasis?:string)=>void;
}
function confirmed(intent:KeepaliveIntent,observation:PlayerObservation){
 const a=observation.view.self.activity;
 return observation.roomId===intent.roomId&&observation.view.player===intent.player&&observation.view.self.active&&!a?.autoResigned&&!!a&&a.lastCheckinTime>=intent.atSeconds&&(intent.action.kind!=='cancel-inactivity-warning'||a.inactivityWarningCount===0);
}
function validObservation(value:unknown,intent:KeepaliveIntent):value is PlayerObservation{
 const o=value as PlayerObservation|undefined;
 return !!o&&o.roomId===intent.roomId&&o.view?.format==='player-observation/2'&&o.view.player===intent.player&&typeof o.revision==='string'&&Number.isFinite(o.view.tick)&&Number.isFinite(o.secondsSinceLastTick)&&Array.isArray(o.scheduled)&&Array.isArray(o.view.fleets);
}
function persistReceipt(host:Host,intent:KeepaliveIntent,observation:PlayerObservation){
 // A commander/private CAS change while the network was in flight cannot erase
 // an accepted receipt or overwrite newer private memory. Preserve both.
 const saved=host.store.load(host.state.roomId,host.state.lobbySeat);
 if(saved){host.state.memory=saved.memory;if(saved.commanderDirectives)host.state.commanderDirectives=saved.commanderDirectives;else delete host.state.commanderDirectives;}
 const basis=host.store.localWriteBasis(host.state.roomId,host.state.lobbySeat);
 const good=confirmed(intent,observation);
 host.saveEvents([
  {kind:'tool-result',details:{id:intent.id,tool:'order',summary:'系统机械活跃维护',result:observation}},
  {kind:'mechanical-keepalive-state',details:{...intent,status:good?'confirmed':'accepted',...(good?{}:{reason:'Accepted receipt does not confirm expected activity state'})}},
 ],basis);
 if(!good)throw new MechanicalKeepaliveStopped('服务器接受命令，但返回的活跃字段未确认预期结果');
}
/** No timer or detached promise. This operation is part of the owning poll and
 * its checkpoint drain. Its caller must have no model/game write in flight. */
export async function maintainActivity(host:Host,snapshot:AiSnapshot,advancing=false):Promise<{observation:PlayerObservation;performed:boolean}> {
 const {state,store,gateway,options}=host;
 const allowed=()=>options.mechanicalKeepalive===true&&options.canMaintain?.()===true&&state.enabled&&state.status==='waiting'&&!host.signal.aborted;
 let old=store.latest<KeepaliveIntent>(state.roomId,state.lobbySeat,'mechanical-keepalive-state');
 if(old&&(old.format!=='mechanical-keepalive/1'||old.roomId!==state.roomId||old.player!==snapshot.observation.view.player||old.policy!==KEEPALIVE_POLICY))throw new MechanicalKeepaliveStopped('维护记录身份或版本不匹配');
 if(old&&['intent','unknown','accepted'].includes(old.status)){
  // This read is of the existing durable response, never a second POST. With
  // no response there is currently no server read-by-command-ID endpoint.
  const receipt=store.queryResult(state.roomId,state.lobbySeat,old.id) as {tool?:string;result?:unknown}|undefined;
  if(receipt?.tool==='order'&&validObservation(receipt.result,old)&&confirmed(old,receipt.result)){
   old={...old,status:'confirmed'};host.saveEvents([{kind:'mechanical-keepalive-state',details:old}]);
  }else throw new MechanicalKeepaliveStopped('原维护命令结果未知，缺少可核对的权威回执');
 }
 if(!allowed())return {observation:snapshot.observation,performed:false};
 let eligibility=mechanicalKeepaliveEligibility(snapshot.observation,true,advancing);
 if(!eligibility.eligible)return {observation:snapshot.observation,performed:false};
 const intent=eligibility.intent;
 if(old?.id===intent.id){
  if(['confirmed','rejected','not-sent'].includes(old.status))return {observation:snapshot.observation,performed:false};
  // An explicit resume can return to normal model review, but maintenance
  // itself never retries a rejected/not-sent cycle on a later poll.
  throw new MechanicalKeepaliveStopped('本维护周期已有未完成记录，需明确核对后处理');
 }
 const commanderVersion=state.commanderDirectives?.version??0;
 const basis=store.localWriteBasis(state.roomId,state.lobbySeat);
 await gateway.commanderCheck?.(commanderVersion);
 await gateway.manualCheck?.(manualVersion(snapshot.observation));
 if(!allowed())return {observation:snapshot.observation,performed:false};
 if((state.commanderDirectives?.version??0)!==commanderVersion||store.localWriteBasis(state.roomId,state.lobbySeat)!==basis)throw new MechanicalKeepaliveStopped('维护发送前指挥官指示或私有状态已变化，尚未发送');
 const observer:ReceiptObservation={id:`activity:${intent.id}`,owner:'system',roomId:state.roomId,player:intent.player,commandId:intent.id,predicate:{kind:'activity',commandId:intent.id,minimumCheckinTime:intent.atSeconds,clearWarnings:intent.action.kind==='cancel-inactivity-warning'},state:'pendingReceipt',deadlineSeconds:intent.atSeconds+TICK_SECONDS,onMismatch:'wake'};
 host.saveEvents([
  {kind:'mechanical-keepalive-state',details:intent},
  {kind:'tool-intent',details:{id:intent.id,tool:'order',summary:'系统机械活跃维护',arguments:{action:intent.action}}},
  {kind:'receipt-observation-set',details:observer},
 ],basis);
 const release=host.beginBarrier();let observation=snapshot.observation,sent=false;
 try{
  for(let attempt=0;attempt<2;attempt++){
   if(!allowed()){
    host.saveEvents([{kind:'mechanical-keepalive-state',details:{...intent,status:'not-sent',reason:'Pause, checkpoint, or control gate closed before dispatch'}},{kind:'tool-rejected',details:{id:intent.id,tool:'order',summary:'系统维护未发送',result:{error:'maintenance-not-sent'}}}]);
    return {observation,performed:false};
   }
   if(store.localWriteBasis(state.roomId,state.lobbySeat)!==basis||(state.commanderDirectives?.version??0)!==commanderVersion)throw new MechanicalKeepaliveStopped('维护发送前状态版本已变化，尚未发送');
   gateway.writeContext?.({turn:`maintenance:${intent.id}`,deadline:Date.now()+15000,signal:host.signal,revision:observation.revision});
   try{
    sent=true;
    const result=await gateway.request('/tool/order',{revision:observation.revision,order:{id:intent.id,action:intent.action}});
    if(!validObservation(result,intent))throw new MechanicalKeepaliveStopped('维护响应身份或结构不完整');
    persistReceipt(host,intent,result);
    return {observation:result,performed:true};
   }catch(error){
    const rejected=error instanceof GameRequestError&&error.status<500&&error.status!==408;
    const notSent=error instanceof DebugStopError;
    if(rejected&&error.status===409&&error.observation&&!error.code&&attempt===0&&validObservation(error.observation,intent)){
     observation=error.observation;
     eligibility=mechanicalKeepaliveEligibility(observation,allowed(),advancing);
     if(eligibility.eligible&&eligibility.intent.id===intent.id&&eligibility.intent.action.kind===intent.action.kind){
      host.saveEvents([{kind:'mechanical-keepalive-conflict',details:{id:intent.id,attempt:1,revision:observation.revision,outcome:'rejected'}}]);
      await gateway.commanderCheck?.(commanderVersion);continue;
     }
    }
    // A successful receipt that failed its postcondition must remain accepted.
    const receipt=store.queryResult(state.roomId,state.lobbySeat,intent.id);
    if(!receipt)host.saveEvents([{kind:'mechanical-keepalive-state',details:{...intent,status:notSent?'not-sent':rejected?'rejected':'unknown',reason:error instanceof Error?error.message:'Unknown maintenance failure'}},...(rejected||notSent?[{kind:'tool-rejected',details:{id:intent.id,tool:'order',summary:'系统维护未执行',result:{error:error instanceof Error?error.message:'Rejected',outcome:notSent?'not-sent':'rejected'}}}]:[])]);
    throw error instanceof GameTransportError?error:new MechanicalKeepaliveStopped(rejected?'维护被拒绝，未继续重试':'维护写入或回执持久化结果未知');
   }
  }
  throw new MechanicalKeepaliveStopped('维护冲突未能在一次刷新内消解');
 }catch(error){
  if(!sent)host.saveEvents([{kind:'mechanical-keepalive-state',details:{...intent,status:'not-sent',reason:error instanceof Error?error.message:'Not sent'}},{kind:'tool-rejected',details:{id:intent.id,tool:'order',summary:'系统维护未发送',result:{error:'maintenance-not-sent'}}}]);
  throw error;
 }finally{gateway.writeContext?.(null);release();}
}
