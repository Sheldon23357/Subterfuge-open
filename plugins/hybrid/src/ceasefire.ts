import {createHash} from 'node:crypto';
import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {HybridState,OperationState} from './contracts.js';
import {manualProtectionEntities} from '@subterfuge/bot-sdk/execution/manual-coordination';
import {commanderProtectedFleets} from './commander-commitments.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Current authorized facts only. A treaty does not itself cancel a fleet. */
export function ceasefirePlan(o:PlayerObservation,peer:number,outposts:readonly string[],saved?:HybridState,operations:OperationState[]=[]){
 const self=o.view.player,scope=[...new Set(outposts)].sort(),protectedFleets=new Set(saved?commanderProtectedFleets(o,saved,operations):[]);
 const manual=new Set(o.manualCommands?.protections.flatMap(manualProtectionEntities)??[]);
 const conflicts=o.view.fleets.filter(f=>!f.gift&&f.destination?.kind==='outpost'&&scope.includes(f.destination.id)&&
  (f.owner===self||f.owner===peer)&&o.view.outposts.some(p=>p.id===f.destination!.id&&p.owner===(f.owner===self?peer:self)));
 const withdrawals=conflicts.filter(f=>f.owner===self).map(f=>{
  const home=o.view.outposts.find(p=>p.id===f.source),canReturn=f.canReturn===true;
  const survivingDrillers=canReturn?Math.floor(f.drillers/2):null;
  return {fleetId:f.id,target:f.destination!.id,source:f.source??null,drillers:f.drillers,canReturn,
   survivingDrillers,lostDrillers:survivingDrillers===null?null:f.drillers-survivingDrillers,
   returnBaseOwner:home?.owner??null,returnBaseFriendly:home?.owner===self&&!home.destroyed,
   protected:manual.has(f.id)||protectedFleets.has(f.id),
   knownHostileApproachesToReturnBase:home?o.view.fleets.filter(q=>q.owner!==self&&!q.gift&&q.destination?.id===home.id).map(q=>({fleetId:q.id,owner:q.owner,drillers:q.drillers})):[]};
 }).sort((a,b)=>a.fleetId.localeCompare(b.fleetId));
 const peerApproaches=conflicts.filter(f=>f.owner===peer).map(f=>({fleetId:f.id,target:f.destination!.id,drillers:f.drillers,withdrawalConfirmed:false})).sort((a,b)=>a.fleetId.localeCompare(b.fleetId));
 const blockers=withdrawals.flatMap(f=>[...(!f.canReturn?[{fleetId:f.fleetId,reason:'舰队不能再次返航'}]:[]),...(!f.returnBaseFriendly?[{fleetId:f.fleetId,reason:'返航接收点不是当前己方据点'}]:[]),...(f.protected?[{fleetId:f.fleetId,reason:'舰队仍受人工或指挥官运输保护'}]:[])]);
 const externalSignature=hash([peer,scope,scope.map(id=>[id,o.view.outposts.find(p=>p.id===id)?.owner??null]),peerApproaches]);
 return {peer,outposts:scope,withdrawals,peerApproaches,blockers,totalOwnLostDrillers:withdrawals.every(f=>f.lostDrillers!==null)?withdrawals.reduce((sum,f)=>sum+f.lostDrillers!,0):null,
  externalSignature,signature:hash([externalSignature,withdrawals]),
  meaning:'发起或接受这些停战条款表示已权衡本方撤军损兵与回收点风险。程序先确认撤回冲突舰队再提交协议；提案可能被拒绝，已发生的返航损失不退还。对方舰队未确认撤回时仍有违约和防守风险，不假定对方会撤；可调整范围、反提或等待真实结算。'};
}
export type CeasefireReview=ReturnType<typeof ceasefirePlan>&{withdrawalStatus:'pending'|'unknown'|'confirmed'|'failed'};

export function ceasefireAvoidTargets(o:PlayerObservation,saved?:HybridState){
 const now=o.view.tick+o.secondsSinceLastTick/600,self=o.view.player;
 return [...new Set((o.diplomacy?.agreements??[]).filter(a=>a.terms.kind==='ceasefire'&&a.deadline>now&&a.players.includes(self)&&
  (a.status==='active'&&!saved?.betrayAgreements?.includes(a.id)||a.status==='proposed'&&a.players[0]===self))
  .flatMap(a=>a.terms.kind==='ceasefire'?a.terms.outposts.filter(id=>o.view.outposts.some(p=>p.id===id&&p.owner!==self&&p.owner!==null&&p.owner!==undefined&&a.players.includes(p.owner))):[]))];
}

export function ceasefireMaterial(o:PlayerObservation,peers:number[],saved:HybridState,operations:OperationState[]){
 if(peers.length!==1)return null;
 const peer=peers[0]!,self=o.view.player;
 const facts=(plan:ReturnType<typeof ceasefirePlan>)=>{const {signature,externalSignature,...value}=plan;return value;};
 return {risks:saved.ceasefireRisks??[],scopeAssessment:facts(ceasefirePlan(o,peer,o.view.outposts.filter(p=>p.visibility===2&&!p.destroyed&&(p.owner===self||p.owner===peer)).map(p=>p.id),saved,operations)),
  proposals:(o.diplomacy?.agreements??[]).filter(a=>a.status==='proposed'&&a.terms.kind==='ceasefire'&&a.players.includes(self)&&a.players.includes(peer)).map(a=>({agreementId:a.id,...facts(ceasefirePlan(o,peer,a.terms.kind==='ceasefire'?a.terms.outposts:[],saved,operations))}))};
}
