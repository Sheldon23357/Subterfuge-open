import type {AiSnapshot,AiState} from '@subterfuge/bot-sdk/contracts/types';
import {gameSeconds} from '@subterfuge/bot-sdk/contracts/types';
import {diplomacyCooldown} from '@subterfuge/bot-sdk/analysis/chat-budget';
import type {DiplomacyNeed,HybridState} from './contracts.js';
import {forceBand} from './strategy-review.js';

export const pressureReviewInterval={ms:60000,ticks:6} as const;

/** Use the executor's existing cooldown and current incoming-message exemption. */
export function canInitiateDiplomacy(snapshot:Readonly<AiSnapshot>,state:Readonly<AiState>,players:readonly number[]){
 const budget=diplomacyCooldown(gameSeconds(snapshot),state.lastSpoke,0,snapshot.chat,snapshot.chatPlayer);
 return budget.remainingSeconds===0||players.length>0&&players.every(p=>budget.replyAllowedTargets.includes(p));
}

const sorted=<T>(values:readonly T[])=>[...values].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const deficit=(value:unknown)=>typeof value==='number'?value>0:null;

/** Stable diplomatic causes: production, travel, search counts and wording are not new causes. */
export function pressureReviewKey(snapshot:Readonly<AiSnapshot>,saved:HybridState,needs:readonly DiplomacyNeed[],chatPlayer:number){
 const o=snapshot.observation,now=o.view.tick+o.secondsSinceLastTick/600;
 const agreement=saved.directive?.agreements.find(a=>a.conversation===String(chatPlayer));
 const deadlines=[agreement?.expiresWorldDay,agreement?.jointAttack?.until].filter((v):v is number=>typeof v==='number');
 const goal=o.view.match?.neptuniumGoal;
 const peer=snapshot.roster?.find(p=>p.chatPlayer===chatPlayer)?.gamePlayer??(snapshot.chatPlayer===o.view.player?chatPlayer:undefined);
 const relevant=new Set([o.view.player,peer,...needs.flatMap(n=>n.opponents)]);
 return JSON.stringify({
  commanderVersion:saved.commanderVersion,
  players:sorted(o.intel.filter(p=>relevant.has(p.player)).map(p=>[p.player,p.active,forceBand(p.npPerDay),goal?Math.floor(p.neptunium/goal*5):null])),
  contracts:sorted(o.diplomacy?.agreements.filter(a=>a.players.includes(o.view.player)&&a.players.includes(peer!)).map(a=>[a.id,a.status,a.fulfilled,a.deadline-now<=pressureReviewInterval.ticks])??[]),
  agreement:agreement?{
   status:['proposed','negotiating','confirmed'].includes(agreement.status)?'open':agreement.status,
   forbidAttack:agreement.forbidAttack,targets:sorted(agreement.forbiddenTargets),jointAttack:agreement.jointAttack??null,
   until:agreement.expiresWorldDay,nearExpiry:deadlines.some(until=>until-now<=pressureReviewInterval.ticks),
  }:null,
  needs:sorted(needs.map(n=>{
   const e=(n.evidence??{}) as Record<string,any>,target=e.target??{};
   return {id:n.id,kind:n.kind,opponents:sorted(n.opponents),targets:sorted(n.targets.map(id=>{const p=o.view.outposts.find(p=>p.id===id);return [id,p?.owner??null,p?.type??null,p?.destroyed??null];})),
    incoming:sorted(Array.isArray(e.actualIncoming)?[...new Set(e.actualIncoming.map((f:any)=>f.owner))].map(owner=>[owner,forceBand(e.actualIncoming.filter((f:any)=>f.owner===owner).reduce((n:number,f:any)=>n+f.drillers,0))]):[]),
    arrivalDeficit:deficit(e.arrivalShortfall),estimatedDeficit:deficit(e.estimatedShortfall),
    imminent:typeof e.earliestDeficitTicks==='number'?e.earliestDeficitTicks<=pressureReviewInterval.ticks:null,
    contest:n.kind==='opening-contest'?[target.zone,target.rivalPlayer,target.friendlyIncoming,target.hostileIncoming]:null};
  })),
 });
}

/** Successful incoming reviews also cover their current pressure; don't immediately ask again. */
export function recordDiplomacyReview(saved:HybridState,snapshot:Readonly<AiSnapshot>,needs:readonly DiplomacyNeed[],players:readonly number[],wall:number){
 const pressure=saved.diplomacyPressure??={streaks:{},attempts:{}},contacts=pressure.contacts??={};
 for(const chat of players){
  const game=snapshot.roster?.find(p=>p.chatPlayer===chat)?.gamePlayer;
  if(game!==undefined)contacts[String(game)]={wall,tick:snapshot.observation.view.tick,reviewKey:pressureReviewKey(snapshot,saved,needs,chat)};
 }
}
