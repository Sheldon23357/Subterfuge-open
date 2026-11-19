import type {BotCandidate,BotCandidateKind} from './tactical-candidates.js';

/** Fair category and target lanes within the total search budget. */
export function botDiscoveryQueues(candidates:readonly BotCandidate[],kinds:readonly BotCandidateKind[]):BotCandidate[][] {
  return kinds.flatMap(kind=>{
    const rows=candidates.filter(c=>c.kind===kind);
    const lanes=[rows];
    return lanes.filter(lane=>lane.length).map(lane=>{
      const objectives=new Map<string,BotCandidate[]>();
      for(const c of lane){const key=botDiscoveryObjective(c),q=objectives.get(key)??[];q.push(c);objectives.set(key,q);}
      const queues=[...objectives.values()].map(q=>q.sort(compareBotDiscovery));
      // Rank the first alternative for each objective by the same hints too.
      queues.sort((a,b)=>compareBotDiscovery(a[0]!,b[0]!));
      const ordered:BotCandidate[]=[];
      for(let i=0;queues.some(q=>i<q.length);i++)for(const q of queues)if(q[i])ordered.push(q[i]!);
      return ordered;
    });
  });
}
export function botDiscoveryObjective(c:BotCandidate):string{return c.objective;}

/** Discovery order only. Ordinary force estimates do not decide combat,
 * prune alternatives; every chosen line is simulated. */
export function compareBotDiscovery(a:BotCandidate,b:BotCandidate):number {
  const shortfall=(c:BotCandidate)=>c.forceEstimate
    ?Math.max(0,c.forceEstimate.required-c.forceEstimate.committed)/Math.max(1,c.forceEstimate.required):0;
  return shortfall(a)-shortfall(b)||b.priority-a.priority;
}

/** Cover ordinary force sources before role/amount permutations consume the
 * discovery window. This changes ordering only, never forecast admission. */
export function botDiscoveryOrder(groups:readonly BotCandidate[][],coverageLimit:number,urgentDefenseTargets:ReadonlySet<string>=new Set(),strategicPriority:(c:BotCandidate)=>number=()=>0):BotCandidate[]{
  const all=groups.flat(),prefix:BotCandidate[]=[],seen=new Set<string>();
  const add=(c:BotCandidate)=>{if(!seen.has(c.id)){seen.add(c.id);prefix.push(c);}};
  // Real incoming threats keep their first response ahead of expansion.
  for(const c of all.filter(c=>c.kind==='defense'&&c.targets.some(t=>urgentDefenseTargets.has(t))).slice(0,2))add(c);
  const sources=new Map<string,BotCandidate[]>();
  for(const c of all){
    const a=c.drafts[0]?.action;
    if(c.kind!=='attack'||c.drafts.length!==1||a?.kind!=='launch'||a.fleetId||typeof a.source!=='string'||!(Number(a.drillers)>0))continue;
    const q=sources.get(a.source)??[];q.push(c);sources.set(a.source,q);
  }
  const force=(c:BotCandidate)=>Number(c.drafts[0]!.action.drillers);
  const lanes=[...sources.entries()].map(([source,rows])=>{
    const objectives=new Map<string,BotCandidate[]>();
    for(const c of rows){const q=objectives.get(c.objective)??[];q.push(c);objectives.set(c.objective,q);}
    // Keep the generator's buffered seed before equally viable half/full
    // variants; the raw static requirement is not a safe minimum force.
    const targets=[...objectives.values()].map(q=>q.sort(compareBotDiscovery));
    targets.sort((a,b)=>strategicPriority(b[0]!)-strategicPriority(a[0]!)||compareBotDiscovery(a[0]!,b[0]!)||a[0]!.objective.localeCompare(b[0]!.objective));
    const representatives=targets.map(q=>q[0]!);
    const stronger=targets.map(q=>[...q].sort((a,b)=>force(b)-force(a))[0]!).filter(c=>!representatives.includes(c));
    return {source,priority:Math.max(...rows.map(strategicPriority)),available:Math.max(...rows.map(force)),stronger,queue:[...representatives,...stronger]};
  }).sort((a,b)=>b.priority-a.priority||b.available-a.available||a.source.localeCompare(b.source));
  const limit=Math.max(prefix.length,Math.floor(coverageLimit));
  const reserve=limit-prefix.length>=4?Math.min(2,lanes.filter(l=>l.stronger.length).length):0;
  for(const lane of lanes){if(prefix.length>=limit-reserve)break;if(lane.queue[0])add(lane.queue[0]);}
  for(const lane of lanes){if(prefix.length>=limit)break;if(lane.stronger[0])add(lane.stronger[0]);}
  for(let i=0;prefix.length<limit&&lanes.some(l=>i<l.queue.length);i++)for(const lane of lanes){
    if(prefix.length>=limit)break;if(lane.queue[i])add(lane.queue[i]!);
  }
  // Preserve fair category coverage after the bounded
  // ordinary-force pass; all untested alternatives remain in the queue.
  for(let i=0;groups.some(g=>i<g.length);i++)for(const group of groups)if(group[i])add(group[i]!);
  return prefix;
}

/** Joint resource and timing checks validate independent candidate combinations. */
export function canCombineBotCandidates(a:BotCandidate,b:BotCandidate):boolean{return a.id!==b.id;}
