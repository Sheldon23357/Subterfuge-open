import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {AiSnapshot} from '@subterfuge/bot-sdk/contracts/types';
import type {BotDecision} from '@subterfuge/bot-sdk/analysis/tactical-planner';
import {compareBotEvaluations} from '@subterfuge/bot-sdk/analysis/tactical-evaluation';
import {botDistance} from '@subterfuge/bot-sdk/analysis/tactical-evaluation';
import {openingExpansion,openingContestCurrent} from '@subterfuge/bot-sdk/analysis/opening-expansion';
import {constraints} from './operations.js';
import {cooperationBonus} from './relation-policy.js';
import {intentGuidance} from './intents.js';
import {scopeMatches,type DiplomacyNeed,type HybridState,type OperationState,type TacticalFeedback} from './contracts.js';

/** Evidence for a diplomatic review, never a proof that local defense is impossible. */
export function diplomacyNeeds(o:PlayerObservation,d:BotDecision,state:HybridState,operations:OperationState[]):DiplomacyNeed[]{
 const needs:DiplomacyNeed[]=[],self=o.view.player,hard=constraints(state.directive,o,state);
 const opening=d.opening??openingExpansion(o);
 for(const target of opening.targets.filter(t=>['rival-near','contested'].includes(t.zone)&&t.rivalPlayer!==null)){
  if(!openingContestCurrent(o,[target.id],[target.rivalPlayer!]))continue;
  if(hard.forbiddenTargets.includes(target.id)||hard.forbiddenPlayers.includes(target.rivalPlayer!))continue;
  const intended=d.selected.captureTargets?.includes(target.id)||state.directive?.objectives.some(g=>['capture','expand'].includes(g.kind)&&g.targets.includes(target.id))
    ||operations.some(p=>['accepted','underway'].includes(p.status)&&p.drafts.some(d=>d.action.destination===target.id));
  if(!intended)continue;
  needs.push({id:'opening:'+target.id+':'+target.rivalPlayer,kind:'opening-contest',targets:[target.id],opponents:[target.rivalPlayer!],
   evidence:{basis:opening.basis,target,uncoveredHome:opening.uncoveredHome,selected:d.selected.objective,search:d.coverage},
   limits:['中立点当前仍是中立；对手先占为地理规划假设，不代表已占领或已出兵','优先覆盖己方近点，再比较增兵争夺、预备反夺、边界协商与第三方合作；未执行外交不当作协议',...opening.unknowns]});
 }
 for(const r of d.risk?.outposts??[]){
  const incoming=o.view.fleets.filter(f=>f.owner!==self&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===r.id);
  if(!(incoming.length&&r.arrivalShortfall>0)&&!(r.shortfall>0&&r.pressureRatio>=1.5))continue;
  const responding=d.selected.targets.includes(r.id)&&d.selected.kind!=='hold';
  const selected=d.assessments.find(a=>a.candidate.id===d.selected.id)?.score;
  // A selected local response gets time to execute unless a conditional loss remains.
  if(responding&&selected&&selected.outcome>=0&&(selected.components.mineLosses??0)>=0)continue;
  const nearby=o.view.outposts.filter(p=>p.owner!=null&&p.owner!==self&&!p.destroyed&&p.visibility===2&&p.drillers!==undefined)
   .filter(p=>botDistance(p.position,o.view.outposts.find(p=>p.id===r.id)!.position,o.view.size)<=40);
  needs.push({id:'defense:'+r.id,kind:'defense-pressure',targets:[r.id],opponents:[...new Set(incoming.length?incoming.map(f=>f.owner):nearby.map(p=>p.owner!))],
   evidence:{basis:r.basis,actualIncoming:incoming.map(f=>({id:f.id,owner:f.owner,drillers:f.drillers})),arrivalShortfall:r.arrivalShortfall,estimatedShortfall:r.shortfall,pressureRatio:r.pressureRatio,support:r.support,earliestDeficitTicks:r.earliestDeficitTicks,selected:d.selected.objective,selectedConditional:selected?{outcome:selected.outcome,mineLosses:selected.components.mineLosses??null}:null,localResponses:d.assessments.filter(a=>a.candidate.targets.includes(r.id)).slice(0,3).map(a=>({objective:a.candidate.objective,status:a.status,reasons:a.reasons})),search:d.coverage},
   limits:['静态压力和有限搜索不能证明无法防守；援助航程和盟友意愿未知',...r.unknowns]});
 }
 const baseline=d.assessments.find(a=>a.candidate.kind==='hold')?.score;
 for(const target of new Set([...(state.directive?.objectives??[]),...intentGuidance(o,state).objectives].filter(g=>g.kind==='capture').flatMap(g=>g.targets))){
  const post=o.view.outposts.find(p=>p.id===target);
  if(!post||post.destroyed||post.owner===self||post.owner==null||hard.forbiddenTargets.includes(target)||hard.forbiddenPlayers.includes(post.owner))continue;
  if(d.selected.captureTargets?.includes(target)||operations.some(p=>['accepted','underway'].includes(p.status)&&p.drafts.some(d=>d.action.destination===target)))continue;
  const attempts=d.assessments.filter(a=>a.candidate.captureTargets?.includes(target));
  if(!attempts.some(a=>['evaluated','invalid','protected'].includes(a.status)))continue;
  if(attempts.some(a=>a.status==='evaluated'&&a.score&&baseline&&compareBotEvaluations(a.score,baseline)>0))continue;
  needs.push({id:`attack:${target}:${post.owner}`,kind:'attack-stalled',targets:[target],opponents:[post.owner],
   evidence:{targetOwner:post.owner,selected:d.selected.objective,search:d.coverage,attempts:attempts.slice(0,4).map(a=>({objective:a.candidate.objective,status:a.status,reasons:a.reasons,utility:a.score?.utility??null})),evaluated:attempts.filter(a=>a.status==='evaluated').length},
   limits:['连续未找到可取进攻方案不等于目标不可攻克；未覆盖候选和敌方意图保持未知']});
 }
 if(d.selected.kind==='hold'&&!d.selected.drafts.length&&d.assessments.some(a=>a.candidate.kind!=='hold'&&['evaluated','invalid','protected'].includes(a.status))&&!operations.some(p=>['proposed','accepted','underway'].includes(p.status))){
  needs.push({id:'stalemate',kind:'stalemate',targets:[],opponents:[],evidence:{selected:'hold',search:d.coverage,evaluated:d.assessments.filter(a=>a.status==='evaluated').length,attempts:d.assessments.filter(a=>a.candidate.kind!=='hold').slice(0,4).map(a=>({objective:a.candidate.objective,status:a.status,reasons:a.reasons}))},limits:['有限搜索未找到更优行动，不代表全局无解；比较交易、牵制、游戏内欺骗和等待，不能虚构对方履约']});
 }
 return needs;
}

/** Count world-time progress, not repeated refreshes or harmless revision changes. */
export function updateDiplomacyPressure(state:HybridState,f:TacticalFeedback,o:PlayerObservation,commanderVersion:number){
 if(!scopeMatches(f.basis,o)||f.basis.commanderVersion!==commanderVersion||f.basis.tick>o.view.tick||o.view.tick-f.basis.tick>24)return [];
 const p=state.diplomacyPressure??={streaks:{},attempts:{}};
 if(p.lastBasis&&f.basis.tick<p.lastBasis.tick)return [];
 const currentIds=new Set((f.diplomacyNeeds??[]).map(n=>n.id));
 // Partial changes are represented in the review key. Only a fully resolved
 // episode releases every contact; a disappearing secondary need must not reset all peers.
 if(!currentIds.size&&Object.keys(p.streaks).length)for(const contact of Object.values(p.contacts??{}))delete contact.reviewKey;
 for(const id of Object.keys(p.streaks))if(!currentIds.has(id))delete p.streaks[id];
 if(!p.lastBasis||f.basis.tick>p.lastBasis.tick){
  p.streaks=Object.fromEntries((f.diplomacyNeeds??[]).map(n=>[n.id,(p.streaks[n.id]??0)+1]));p.lastBasis=f.basis;
 }
 const active=new Set((f.diplomacyNeeds??[]).map(n=>n.id));
 for(const id of Object.keys(p.attempts))if(!active.has(id))delete p.attempts[id];
 return (f.diplomacyNeeds??[]).filter(n=>!['attack-stalled','stalemate'].includes(n.kind)||(p.streaks[n.id]??0)>=3)
  .filter(n=>n.kind==='stalemate'?f.selected==='hold':n.kind==='opening-contest'?openingContestCurrent(o,n.targets,n.opponents):n.targets.every(id=>{const post=o.view.outposts.find(p=>p.id===id);return post&&!post.destroyed&&(n.kind==='defense-pressure'?post.owner===o.view.player:post.owner!=null&&n.opponents.includes(post.owner));}));
}

/** Public geography ranks possible helpers; no inference of their willingness or free troops. */
export function diplomacyPeers(snapshot:Readonly<AiSnapshot>,needs:DiplomacyNeed[],chat:HybridState['chat']=snapshot.chat,contacts:NonNullable<HybridState['diplomacyPressure']>['contacts']={}){
 const o=snapshot.observation,targets=o.view.outposts.filter(p=>needs.some(n=>n.targets.includes(p.id)));
 const opponents=new Set(needs.flatMap(n=>n.opponents));
 const respondents=new Set(chat.filter(m=>m.from!==snapshot.chatPlayer&&(m.to===null||(Array.isArray(m.to)?m.to:[m.to]).includes(snapshot.chatPlayer))).map(m=>m.from));
 return o.intel.filter(p=>p.player!==o.view.player&&p.active).flatMap(p=>{
  const chat=snapshot.roster?.find(r=>r.gamePlayer===p.player)?.chatPlayer;if(chat===undefined)return [];
  const posts=o.view.outposts.filter(t=>t.owner===p.player&&!t.destroyed);
  const distance=targets.length?Math.min(1000000,...posts.flatMap(p=>targets.map(t=>botDistance(p.position,t.position,o.view.size)))):0;
  return [{game:p.player,chat,role:opponents.has(p.player)?'negotiate-with-opponent':'seek-cooperation',rank:(opponents.has(p.player)?10000:0)+distance-cooperationBonus(o,p.player)}];
 }).sort((a,b)=>Number(a.role==='negotiate-with-opponent')-Number(b.role==='negotiate-with-opponent')||Number(respondents.has(b.chat))-Number(respondents.has(a.chat))||a.rank-b.rank||(contacts[String(a.game)]?.wall??0)-(contacts[String(b.game)]?.wall??0)||a.game-b.game);
}
