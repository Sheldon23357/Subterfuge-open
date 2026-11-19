import type {PlayerObservation,AttackRoutes} from '../../../../contracts/src/index.js';
import type {KnownEnemyLaunch} from '../../../../prediction/src/index.js';
import type {BotCandidate} from './tactical-candidates.js';
import {enemyWaitingSources} from '../../controller/analysis/waiting-defense.js';
import {mineLossCost} from '../../controller/analysis/mine-strategy.js';
import {openingExpansion} from './opening-expansion.js';

export interface BotOpponentScenario {id:string;description:string;enemyWaiting?:'defend';enemyLaunches?:KnownEnemyLaunch[];holdingTarget?:string;protectedMine?:string}
/** Small, explicit alternatives. Each sortie is one opponent's reaction, not
 * an invented grand coalition; actual orders remain in every simulation. */
export function botOpponentScenarios(o:PlayerObservation,routes:AttackRoutes,candidates:readonly BotCandidate[],horizon=144):BotOpponentScenario[]{
  const v=o.view,scenarios:BotOpponentScenario[]=[];
  if(v.fleets.some(f=>f.owner!==v.player&&f.state==='waiting'))scenarios.push({id:'waiting-recall',description:'敌方可见待发舰撤回防御',enemyWaiting:'defend'});
  const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed&&p.visibility===2);
  const enemies=v.outposts.filter(p=>p.owner!==v.player&&p.owner!==null&&p.owner!==undefined&&!p.destroyed&&p.visibility===2&&(p.drillers??0)>0&&o.intel.some(i=>i.player===p.owner&&i.active));
  const waitingSources=enemyWaitingSources(v);
  const waiting=(a:string,b:string)=>v.fleets.some(f=>f.state==='waiting'&&(f.source??waitingSources.get(f.id))===a&&f.destination?.id===b);
  const launches=(source:typeof enemies[number],destination:string):KnownEnemyLaunch[]=>[{
    id:`hypothesis:${source.id}:${destination}`,player:source.owner!,source:source.id,destination,
    issueTick:v.tick+1,drillers:Math.max(1,Math.floor(source.drillers!*0.65)),
  }];
  const exposed=new Set(candidates.flatMap(c=>c.drafts.flatMap(d=>typeof d.action.source==='string'?[d.action.source]:[])));
  const attacks=enemies.flatMap(source=>own.flatMap(target=>{
    const eta=routes.postTicks[source.id]?.[target.id];
    if(eta===undefined||eta===null||eta+1>horizon||waiting(source.id,target.id))return [];
    const value=(target.type==='mine'?60:25)+(exposed.has(target.id)?30:0);
    return [{source,target,score:value+Math.min(50,source.drillers!/(1+(target.drillers??0)))-eta/4}];
  })).sort((a,b)=>b.score-a.score||a.source.id.localeCompare(b.source.id)||a.target.id.localeCompare(b.target.id));
  if(attacks[0]){
    const first=attacks[0],sources=attacks.filter(a=>a.target.id===first.target.id&&a.source.owner===first.source.owner).slice(0,2);
    scenarios.push({id:'counterattack',description:'同一对手最多两个不同可见来源以部分驻军集中反击关键或抽兵据点（假设）',enemyLaunches:sources.flatMap(a=>launches(a.source,a.target.id))});
  }
  if(v.match?.mode==='mining'){
    const newMines=new Set(candidates.flatMap(c=>c.drafts.filter(d=>d.action.kind==='toggle-mine'&&v.outposts.some(p=>p.id===d.action.outpostId&&p.type!=='mine'&&!p.minePending)).map(d=>String(d.action.outpostId))));
    const capturedMines=new Set(candidates.flatMap(c=>c.captureTargets??[]).filter(id=>v.outposts.some(p=>p.id===id&&p.type==='mine')));
    const mines=v.outposts.filter(p=>p.visibility===2&&!p.destroyed&&(p.owner===v.player&&p.type==='mine'||newMines.has(p.id)||capturedMines.has(p.id)));
    const raids=enemies.flatMap(source=>mines.flatMap(target=>{
      if(source.id===target.id||waiting(source.id,target.id))return [];
      const eta=routes.postTicks[source.id]?.[target.id];if(eta==null||eta+1>horizon)return [];
      // An explicit later reaction tests holding after the candidate's first
      // ordinary arrival, rather than only reinforcing the original defender.
      const arrivals=candidates.flatMap(c=>c.drafts.flatMap(d=>{
        const travel=typeof d.action.source==='string'?routes.postTicks[d.action.source]?.[target.id]:null;
        return d.action.kind==='launch'&&d.action.destination===target.id&&travel!=null?[d.issueTick+travel]:[];
      }));
      const issueTick=capturedMines.has(target.id)&&arrivals.length?Math.max(v.tick+1,Math.ceil(Math.min(...arrivals))+1):v.tick+1;
      if(issueTick-v.tick+eta>horizon)return [];
      return [{source,target,issueTick,score:60+Math.min(60,mineLossCost(v.self.neptunium))+(newMines.has(target.id)||capturedMines.has(target.id)?30:0)
        +Math.min(50,source.drillers!/(1+(target.drillers??0)))-eta/4}];
    })).sort((a,b)=>b.score-a.score||a.source.id.localeCompare(b.source.id)||a.target.id.localeCompare(b.target.id));
    for(const mine of mines){
      const threats=raids.filter(r=>r.target.id===mine.id);
      const owners=[...new Set(threats.map(r=>r.source.owner!))].slice(0,2);
      for(const owner of owners)for(const fraction of [0.65,1]){
        const fronts=threats.filter(r=>r.source.owner===owner).slice(0,2);
        scenarios.push({id:`mine-pressure:${mine.id}:${owner}:${fraction}`,...mine.owner===v.player?{protectedMine:mine.id}:{},
          description:`单一对手最多两个可见来源以${fraction===1?'全部':'65%'}驻军进攻矿场；独立压力假设，不表示实际命令`,
          enemyLaunches:fronts.flatMap(r=>launches(r.source,r.target.id).map(d=>({...d,issueTick:r.issueTick,drillers:Math.max(1,Math.floor(r.source.drillers!*fraction))})))});
      }
    }
  }
  const targets=new Set(candidates.flatMap(c=>c.targets));
  // Each target gets its own independent same-owner reinforcement and
  // post-arrival retake branches. Never combine different players' armies.
  const contestedTargets=v.outposts.filter(p=>targets.has(p.id)&&p.owner!==v.player&&p.visibility===2&&!p.destroyed);
  for(const target of contestedTargets){
    const sources=enemies.filter(source=>source.id!==target.id&&!waiting(source.id,target.id))
      .flatMap(source=>{const eta=routes.postTicks[source.id]?.[target.id];
        return eta!=null&&eta+1<=horizon?[{source,eta}]:[];});
    const defenders=sources.filter(r=>r.source.owner===target.owner);
    if(defenders.length)scenarios.push({id:`reinforcement:${target.id}`,description:'目标所属玩家从窗口内可见来源联合补防（独立假设）',
      enemyLaunches:defenders.flatMap(r=>launches(r.source,target.id))});
    const arrivals=candidates.flatMap(c=>c.drafts.flatMap(d=>{
      const eta=typeof d.action.source==='string'?routes.postTicks[d.action.source]?.[target.id]:null;
      return d.action.kind==='launch'&&d.action.destination===target.id&&eta!=null?[d.issueTick+eta]:[];
    }));
    if(!arrivals.length)continue;
    const issueTick=Math.max(v.tick+1,Math.ceil(Math.min(...arrivals))+1);
    const owners=[...new Set(sources.map(r=>r.source.owner!))].sort((a,b)=>a-b);
    for(const owner of owners){
      const reachable=sources.filter(r=>r.source.owner===owner&&issueTick-v.tick+r.eta<=horizon);
      if(reachable.length)scenarios.push({id:`holding:${target.id}:${owner}`,holdingTarget:target.id,
        description:'占领后同一对手从窗口内可见来源联合反夺（独立假设）',
        enemyLaunches:reachable.flatMap(r=>launches(r.source,target.id).map(d=>({...d,issueTick})))});
    }
  }
  // A different player can take a neutral/enemy target before or after our
  // arrival. This is a separate branch, not a coalition with its defender.
  const contested=v.outposts.filter(p=>targets.has(p.id)&&p.owner!==v.player&&p.visibility===2&&!p.destroyed);
  const competitors=contested.flatMap(target=>enemies.flatMap(source=>{
    const eta=routes.postTicks[source.id]?.[target.id];
    return source.owner!==target.owner&&eta!==undefined&&eta!==null&&eta+1<=horizon&&!waiting(source.id,target.id)
      ?[{source,target,eta}]:[];
  })).sort((a,b)=>a.eta-b.eta||b.source.drillers!-a.source.drillers!||a.source.id.localeCompare(b.source.id));
  const opening=openingExpansion(o).targets.filter(t=>targets.has(t.id)&&['rival-near','contested'].includes(t.zone))
    .flatMap(target=>{const source=enemies.find(p=>p.id===target.rivalSource),eta=source?routes.postTicks[source.id]?.[target.id]:null;
      return source&&eta!=null&&eta+1<=horizon&&!waiting(source.id,target.id)?[{source,target,eta}]:[];})
    .sort((a,b)=>a.eta-b.eta||a.target.id.localeCompare(b.target.id));
  if(opening[0])scenarios.push({id:'opening-rival-claim',description:'开局对手可能先占距其更近或距离相当的中立点（单一对手可见部分驻军假设，不改变当前归属事实）',enemyLaunches:launches(opening[0].source,opening[0].target.id)});
  else if(competitors[0])scenarios.push({id:'third-party-contest',description:'另一玩家争夺同一目标（独立假设，不表示协同）',enemyLaunches:launches(competitors[0].source,competitors[0].target.id)});
  return scenarios;
}
