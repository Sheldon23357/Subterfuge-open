import {DIPLOMACY_RULES as RULES,parseDiplomacyAction as parseRulesDiplomacyAction} from '../../rules/src/index.js';
import type {AgreementTerms,AgreementSubsidy,AgreementStatus,RuleAgreement,DiplomacyReceipt,DiplomacyAction,RelationView,PlayerDiplomacy} from '../../rules/src/index.js';
export type {AgreementTerms,RuleAgreement,DiplomacyReceipt,DiplomacyAction,RelationView} from '../../rules/src/index.js';
import {torusDistance, type Point, type WorldSize} from './geometry.js';

interface RelationHistory {
  from:number;to:number;value:number;lastSigned:number|null;lastTruceReward:number|null;
  attacks:number[];captures:{id:string;time:number}[];ordinary:{time:number;amount:number}[];
}
export interface DiplomacyState {
  format:'diplomacy/2';time:number;agreements:RuleAgreement[];relations:RelationHistory[];
  peacefulSince:{players:[number,number];time:number;recovered:number}[];
  receipts:DiplomacyReceipt[];processedBattles:string[];
}
export interface DiplomacyWorld {
  size:WorldSize;players:{active:boolean;neptunium:number;drillers:number}[];
  outposts:{id:string;owner:number|null;destroyed:boolean;type:string;position:Point}[];
  ended:boolean;
}
const quarter=(n:number)=>Math.round(n*4)/4;
const clamp=(n:number)=>Math.max(-100,Math.min(100,n));
const pair=(a:number,b:number):[number,number]=>a<b?[a,b]:[b,a];
function integer(n:unknown,min:number,max=Number.MAX_SAFE_INTEGER):asserts n is number {
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid diplomacy integer');
}
function fields(v:unknown,keys:string[]):asserts v is Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid diplomacy fields');
}
function identifier(v:unknown):asserts v is string {if(typeof v!=='string'||!v.length||v.length>128)throw Error('Invalid agreement identifier');}
/** Strict action validation: neither duration nor a caller-chosen deadline is accepted. */
export function parseDiplomacyAction(raw:unknown):DiplomacyAction {return parseRulesDiplomacyAction(raw);}
export function createDiplomacyState(count:number,time:number):DiplomacyState {
  integer(count,2,10);if(!Number.isFinite(time)||time<0)throw Error('Invalid diplomacy time');
  return {format:'diplomacy/2',time,agreements:[],relations:Array.from({length:count},(_,from)=>
    Array.from({length:count},(_,to)=>({from,to,value:0,lastSigned:null,lastTruceReward:null,attacks:[],captures:[],ordinary:[]}))
      .filter(r=>r.from!==r.to)).flat(),peacefulSince:Array.from({length:count},(_,a)=>
    Array.from({length:count-a-1},(_,i)=>({players:[a,a+i+1] as [number,number],time,recovered:0}))).flat(),receipts:[],processedBattles:[]};
}
function history(s:DiplomacyState,a:number,b:number){const r=s.relations.find(r=>r.from===a&&r.to===b);if(!r)throw Error('Unknown relation');return r;}
function receipt(s:DiplomacyState,a:RuleAgreement|null,players:[number,number],time:number,kind:string,actor:number|null,details:DiplomacyReceipt['details']={}){
  s.receipts.push({id:s.receipts.length,time,players:[...players],agreementId:a?.id??null,kind,actor,details});
}
function change(s:DiplomacyState,a:number,b:number,delta:number,time:number,reason:string,agreement:RuleAgreement|null=null){
  const r=history(s,a,b),before=r.value;r.value=clamp(quarter(before+delta));
  receipt(s,agreement,[a,b],time,'trust-changed',b,{from:a,to:b,before,requested:quarter(delta),after:r.value,reason});
}
/** Bounded geometry cache shared by immutable snapshots; never caches ownership or trust. */
const diplomacyGeometryCache=new Map<string,[string,string][]>();
/** Static geometry, independent of ownership and sonar. */
export function diplomacyEdges(w:DiplomacyWorld):[string,string][] {
  const key=JSON.stringify([String(w.size.width),String(w.size.height),w.outposts.map(p=>[p.id,String(p.position.x),String(p.position.y)])]);
  const cached=diplomacyGeometryCache.get(key);
  if(cached){diplomacyGeometryCache.delete(key);diplomacyGeometryCache.set(key,cached);return cached.map(edge=>[...edge]);}
  const edges=new Map<string,[string,string]>();
  for(const p of w.outposts){
    const nearest:{q:DiplomacyWorld['outposts'][number];d:number}[]=[];
    for(const q of w.outposts){
      if(q.id===p.id)continue;
      const d=torusDistance(p.position,q.position,w.size);
      let i=0;
      while(i<nearest.length){const old=nearest[i]!;if((d-old.d||(q.id<old.q.id?-1:1))<0)break;i++;}
      if(i<3){nearest.splice(i,0,{q,d});if(nearest.length>3)nearest.pop();}
    }
    for(const {q}of nearest){const edge:[string,string]=p.id<q.id?[p.id,q.id]:[q.id,p.id];edges.set(JSON.stringify(edge),edge);}
  }
  const result=[...edges.values()];
  diplomacyGeometryCache.set(key,result);
  if(diplomacyGeometryCache.size>8)diplomacyGeometryCache.delete(diplomacyGeometryCache.keys().next().value!);
  return result.map(edge=>[...edge]);
}
export function diplomacyCompetition(w:DiplomacyWorld):{player:number;score:number;rank:number}[]{
  const alive=w.players.flatMap((p,player)=>p.active?[{player,minerals:p.neptunium,drillers:p.drillers,posts:w.outposts.filter(o=>!o.destroyed&&o.owner===player).length}]:[]);
  const percentile=(p:typeof alive[number],key:'minerals'|'drillers'|'posts')=>{
    if(alive.length<=1)return 0;
    const better=alive.filter(q=>q[key]>p[key]).length,equal=alive.filter(q=>q[key]===p[key]).length;
    return (alive.length-1-better-(equal-1)/2)/(alive.length-1);
  };
  const scored=alive.map(p=>({player:p.player,score:.5*percentile(p,'minerals')+.3*percentile(p,'drillers')+.2*percentile(p,'posts')}));
  return scored.map(p=>({...p,rank:1+scored.filter(q=>q.score>p.score+1e-12).length+(scored.filter(q=>Math.abs(q.score-p.score)<1e-12).length-1)/2}));
}
function borderEdges(s:DiplomacyState,w:DiplomacyWorld,a:number,b:number){
  const posts=new Map(w.outposts.map(p=>[p.id,p]));
  return diplomacyEdges(w).filter(([x,y])=>{const p=posts.get(x)!,q=posts.get(y)!;
    return !p.destroyed&&!q.destroyed&&((p.owner===a&&q.owner===b)||(p.owner===b&&q.owner===a));});
}
export function diplomacyRelation(s:DiplomacyState,w:DiplomacyWorld,a:number,b:number):RelationView {
  const borders=borderEdges(s,w,a,b).filter(([x,y])=>!s.agreements.some(c=>c.status==='active'&&c.terms.kind==='ceasefire'&&c.players.includes(a)&&c.players.includes(b)&&c.terms.outposts.includes(x)&&c.terms.outposts.includes(y)));
  const borderPressure=Math.min(12,3*Math.ceil(borders.length/3)),r=history(s,a,b),scores=diplomacyCompetition(w);
  const sa=scores.find(p=>p.player===a)?.score??0,sb=scores.find(p=>p.player===b)?.score??0;
  const competitionPressure=scores.length<=1||!w.players[a]?.active||!w.players[b]?.active?0:quarter(20*Math.max(0,2*sb-1)+10*Math.max(0,2*Math.min(sa,sb)-1));
  return {from:a,to:b,history:r.value,borderPressure,competitionPressure,trust:clamp(r.value-borderPressure-competitionPressure)};
}
function validateTerms(w:DiplomacyWorld,players:[number,number],terms:AgreementTerms,subsidy:AgreementSubsidy|null){
  if(players[0]===players[1]||players.some(p=>!w.players[p]?.active))throw Error('Active distinct participants required');
  if(terms.kind==='ceasefire'){
    if(terms.outposts.some(id=>!w.outposts.some(p=>p.id===id&&!p.destroyed&&p.owner!==null&&players.includes(p.owner))))throw Error('Ceasefire outpost must belong to a participant');
  }else if(players.includes(terms.enemy)||!w.players[terms.enemy]?.active)throw Error('Active third-party target required');
  if(subsidy&&!players.includes(subsidy.payer))throw Error('Subsidy payer must be a participant');
}
function finish(s:DiplomacyState,a:RuleAgreement,time:number,status:AgreementStatus,reason:string,actor:number|null=null){
  a.status=status;a.reason=reason;a.endedAt=time;receipt(s,a,a.players,time,'agreement-ended',actor,{status,reason});
}
/** Advance deadlines before any event at the exact deadline. Operates only on an owned state. */
export function advanceDiplomacy(s:DiplomacyState,w:DiplomacyWorld,time:number){
  if(!Number.isFinite(time)||time<s.time)throw Error('Nonchronological diplomacy time');
  const recover=(at:number)=>{
    for(const p of s.peacefulSince){
      const steps=Math.max(0,Math.floor((at-p.time-RULES.peaceDelay)/RULES.peaceStep)),newSteps=steps-p.recovered;
      if(newSteps>0){for(const [from,to]of [p.players,[...p.players].reverse()] as [number,number][]){const r=history(s,from,to);if(r.value<0)change(s,from,to,Math.min(-r.value,newSteps),at,'peace-recovery');}p.recovered=steps;}
    }
  };
  for(const a of [...s.agreements].sort((a,b)=>a.deadline-b.deadline)){
    if(!['proposed','active'].includes(a.status))continue;
    if(a.deadline<=time){
      recover(a.deadline);
      if(a.status==='proposed')finish(s,a,a.deadline,'expired','proposal-expired');
      else if(a.terms.kind==='ceasefire'){
        for(const [from,to]of [a.players,[...a.players].reverse()] as [number,number][]){
          const r=history(s,from,to);
          if((r.lastTruceReward===null||a.deadline-r.lastTruceReward>=RULES.ceasefireCooldown)&&Object.values(a.protectedSince).some(start=>a.deadline-start>=24)){
            change(s,from,to,RULES.ceasefireTrust,a.deadline,'ceasefire-fulfilled',a);r.lastTruceReward=a.deadline;
          }
        }
        finish(s,a,a.deadline,'completed','ceasefire-fulfilled');
      }else{
        a.players.forEach((p,i)=>{if(!a.fulfilled[i])change(s,a.players[1-i]!,p,-RULES.jointUnfulfilledPenalty,a.deadline,'joint-attack-shortfall',a);});
        finish(s,a,a.deadline,'unfulfilled','deadline-shortfall');
      }
    }else if(w.ended||a.players.some(p=>!w.players[p]?.active)||(a.terms.kind==='joint-attack'&&!w.players[a.terms.enemy]?.active))finish(s,a,time,'terminated',w.ended?'game-ended':'participant-or-target-eliminated');
  }
  recover(time);
  s.time=time;
  for(const a of s.agreements.filter(a=>a.status==='active'&&a.terms.kind==='ceasefire')){
    const edges=borderEdges(s,w,...a.players).filter(([x,y])=>a.terms.kind==='ceasefire'&&a.terms.outposts.includes(x)&&a.terms.outposts.includes(y));
    const keys=new Set(edges.map(e=>JSON.stringify(e)));
    for(const key of Object.keys(a.protectedSince))if(!keys.has(key))delete a.protectedSince[key];
    for(const key of keys)if(a.protectedSince[key]===undefined)a.protectedSince[key]=time;
  }
}
/** Atomic public transition: failed acceptance never changes balances or supersedes a proposal. */
export function submitDiplomacy(s:DiplomacyState,w:DiplomacyWorld,actor:number,id:string,input:unknown,time:number){
  identifier(id);integer(actor,0,9);const action=parseDiplomacyAction(input);
  const state=structuredClone(s),world=structuredClone(w);advanceDiplomacy(state,world,time);
  if(world.ended||!world.players[actor]?.active)throw Error('Diplomacy requires an active match participant');
  if(action.kind==='propose-agreement'){
    if(state.agreements.some(a=>a.id===id))throw Error('Agreement identity already used');
    if([actor,action.peer].some(p=>state.agreements.filter(a=>a.id!==action.counterTo&&a.players.includes(p)&&['proposed','active'].includes(a.status)).length>=RULES.maxOpenAgreements))throw Error('Too many open agreements');
    const players:[number,number]=[actor,action.peer];validateTerms(world,players,action.terms,action.subsidy);
    if(action.counterTo!==null){const old=state.agreements.find(a=>a.id===action.counterTo);
      if(!old||old.status!=='proposed'||old.players[1]!==actor||old.players[0]!==action.peer)throw Error('Counteroffer requires the current received proposal');
      finish(state,old,time,'superseded','counteroffer',actor);
    }
    const a:RuleAgreement={id,players,terms:action.terms,subsidy:action.subsidy,proposedAt:time,startedAt:null,deadline:time+RULES.proposalTicks,status:'proposed',progress:[0,0],fulfilled:[false,false],protectedSince:{},reason:null,endedAt:null};
    state.agreements.push(a);receipt(state,a,players,time,'agreement-proposed',actor);
  }else{
    const a=state.agreements.find(a=>a.id===action.agreementId);
    if(!a||a.status!=='proposed'||!a.players.includes(actor))throw Error('No actionable proposal');
    if(action.response==='withdraw'){
      if(a.players[0]!==actor)throw Error('Only proposer may withdraw');finish(state,a,time,'withdrawn','proposer-withdrew',actor);
    }else{
      if(a.players[1]!==actor)throw Error('Only recipient may answer');
      if(action.response==='reject')finish(state,a,time,'rejected','recipient-rejected',actor);
      else{
        try{
        validateTerms(world,a.players,a.terms,a.subsidy);
        const limit=a.terms.kind==='ceasefire'?RULES.maxActiveCeasefires:RULES.maxActiveJointAttacks;
        for(const player of a.players)if(state.agreements.filter(b=>b.status==='active'&&b.terms.kind===a.terms.kind&&b.players.includes(player)).length>=limit)throw Error(`Active ${a.terms.kind} agreement limit reached for player ${player}: ${limit}`);
        if(a.terms.kind==='joint-attack'&&state.agreements.some(b=>b!==a&&b.status==='active'&&b.terms.kind==='joint-attack'&&a.terms.kind==='joint-attack'&&b.terms.enemy===a.terms.enemy&&b.players.every(p=>a.players.includes(p))))throw Error('Duplicate active joint attack');
        if(a.subsidy){const {payer,amount}=a.subsidy,payee=a.players.find(p=>p!==payer)!;
          if(world.players[payer]!.neptunium<amount||!Number.isSafeInteger(world.players[payee]!.neptunium+amount))throw Error('Insufficient or overflowing subsidy balance');
        }
        }catch(e){
          receipt(state,a,a.players,time,'agreement-acceptance-failed',actor,{reason:e instanceof Error?e.message:'Acceptance failed'});
          return {state,world};
        }
        if(a.subsidy){const {payer,amount}=a.subsidy,payee=a.players.find(p=>p!==payer)!;
          world.players[payer]!.neptunium-=amount;world.players[payee]!.neptunium+=amount;
          receipt(state,a,a.players,time,'agreement-subsidy',payer,{payer,payee,amount});
        }
        a.status='active';a.startedAt=time;a.deadline=time+(a.terms.kind==='ceasefire'?RULES.ceasefireTicks:RULES.jointAttackTicks);
        receipt(state,a,a.players,time,'agreement-signed',actor,{deadline:a.deadline});
        for(const [from,to]of [a.players,[...a.players].reverse()] as [number,number][]){const r=history(state,from,to);
          if(r.lastSigned===null||time-r.lastSigned>=RULES.signingCooldown){change(state,from,to,RULES.signingTrust,time,'agreement-signed',a);r.lastSigned=time;}
        }
        advanceDiplomacy(state,world,time);
      }
    }
  }
  return {state,world};
}

export interface DiplomacyBattle {
  id:string;time:number;attacker:number;defender:number;attackerLoss:number;defenderLoss:number;
  outpost:string|null;captured:boolean;mine:boolean;
}
/** One complete battle including any capture: no intermediate fulfilment or duplicate receipts. */
export function recordDiplomacyBattle(s:DiplomacyState,w:DiplomacyWorld,b:DiplomacyBattle){
  if(s.processedBattles.includes(b.id))return;
  if(b.attacker===b.defender||!w.players[b.attacker]||!w.players[b.defender])return;
  integer(b.attackerLoss,0);integer(b.defenderLoss,0);advanceDiplomacy(s,w,b.time);
  const before=diplomacyRelation(s,w,b.defender,b.attacker).trust;
  s.processedBattles.push(b.id);
  const peace=s.peacefulSince.find(p=>p.players.join()===pair(b.attacker,b.defender).join())!;
  if(b.outpost!==null){
    peace.time=b.time;peace.recovered=0;
    const r=history(s,b.defender,b.attacker);r.attacks=r.attacks.filter(t=>t>b.time-RULES.attackCooldown);r.captures=r.captures.filter(e=>e.time>b.time-RULES.attackCooldown);r.ordinary=r.ordinary.filter(e=>e.time>b.time-RULES.attackCooldown);
    let penalty=0;
    if(!r.attacks.length){penalty+=RULES.attackPenalty;r.attacks.push(b.time);}
    if(b.captured&&!r.captures.some(p=>p.id===b.outpost)){penalty+=b.mine?RULES.mineCapturePenalty:RULES.capturePenalty;r.captures.push({id:b.outpost,time:b.time});}
    penalty=Math.min(penalty,RULES.ordinaryPenaltyCap-r.ordinary.reduce((n,e)=>n+e.amount,0));
    if(penalty>0){r.ordinary.push({time:b.time,amount:penalty});change(s,b.defender,b.attacker,-penalty,b.time,'hostile-battle');}
    const broken=s.agreements.filter(a=>a.status==='active'&&a.terms.kind==='ceasefire'&&a.players.includes(b.attacker)&&a.players.includes(b.defender)&&a.terms.outposts.includes(b.outpost!));
    if(broken.length){change(s,b.defender,b.attacker,-quarter(30+Math.max(0,before)/2),b.time,'ceasefire-violated',broken[0]!);
      for(const a of broken)finish(s,a,b.time,'violated','hostile-battle',b.attacker);}
  }
  for(const a of s.agreements){
    if(a.status!=='active'||a.terms.kind!=='joint-attack')continue;
    // Only a real post-signature capture of the named enemy fulfils a party.
    // Each party may fulfil once; the ally cannot satisfy the other party's goal.
    const i=a.players.indexOf(b.attacker);
    if(b.defender!==a.terms.enemy||i<0||a.fulfilled[i]||!b.captured||b.outpost===null)continue;
    a.progress[i]=RULES.jointCaptureGoal;a.fulfilled[i]=true;
    receipt(s,a,a.players,b.time,'agreement-progress',b.attacker,{capturedOutposts:1,total:a.progress[i]!});
    change(s,a.players[1-i]!,b.attacker,RULES.jointFulfillmentTrust,b.time,'joint-attack-fulfilled',a);
    receipt(s,a,a.players,b.time,'agreement-personal-fulfilled',b.attacker);
    if(a.fulfilled.every(Boolean))finish(s,a,b.time,'completed','both-fulfilled');
  }
}

/** Only relationships involving the authorized seat, never the global private matrix. */
export function projectDiplomacy(s:DiplomacyState,w:DiplomacyWorld,player:number):PlayerDiplomacy{
  if(!w.players[player])throw Error('Unknown diplomacy perspective');
  return projectDiplomacyScope(s,w,player);
}

/** Full authority only: local lab/OB and global prediction, never player observations. */
export function projectGlobalDiplomacy(s:DiplomacyState,w:DiplomacyWorld):PlayerDiplomacy{return projectDiplomacyScope(s,w,null);}
function projectDiplomacyScope(s:DiplomacyState,w:DiplomacyWorld,player:number|null):PlayerDiplomacy{
  const agreements=s.agreements.filter(a=>player===null||a.players.includes(player)),receipts=s.receipts.filter(r=>player===null||r.players.includes(player));
  const closed=new Set(agreements.filter(a=>!['proposed','active'].includes(a.status)).slice(-RULES.recentAgreements).map(a=>a.id));
  return {time:s.time,receiptCount:receipts.length,agreementCount:agreements.length,relations:s.relations.filter(r=>player===null||r.from===player||r.to===player).map(r=>diplomacyRelation(s,w,r.from,r.to)),
    competition:diplomacyCompetition(w),agreements:structuredClone(agreements.filter(a=>['proposed','active'].includes(a.status)||closed.has(a.id)).map(({protectedSince,...publicAgreement})=>publicAgreement)),
    receipts:structuredClone(receipts.slice(-RULES.recentReceipts))};
}

/** Seat-local cursor; global receipt gaps and hidden battle identities never become read permissions. */
export function diplomacyReceiptPage(s:DiplomacyState,player:number,after:number,through:number|undefined,limit=100){
  const rows=s.receipts.filter(r=>r.players.includes(player)),end=through??rows.length;
  integer(after,0,rows.length);integer(end,after,rows.length);integer(limit,1,200);
  const receipts:DiplomacyReceipt[]=[],agreements:PlayerDiplomacy['agreements']=[];let size=2048;
  for(const r of rows.slice(after,Math.min(after+limit,end))){
    const a=r.agreementId===null||agreements.some(a=>a.id===r.agreementId)?null:s.agreements.find(a=>a.id===r.agreementId&&a.players.includes(player));
    const projected=a?(({protectedSince,...publicAgreement})=>publicAgreement)(a):null;
    const bytes=JSON.stringify(r).length*6+(projected?JSON.stringify(projected).length*6:0);
    if(receipts.length&&size+bytes>150_000)break;
    receipts.push(structuredClone(r));if(projected)agreements.push(structuredClone(projected));size+=bytes;
  }
  return {receipts,agreements,nextCursor:String(after+receipts.length),through:String(end),hasMore:after+receipts.length<end};
}
