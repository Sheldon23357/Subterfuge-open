import type {PlayerObservation} from '../../../../contracts/src/index.js';
import type {BotCandidate} from './tactical-candidates.js';
import {botDispatchPlanAllowed} from './tactical-dispatch-policy.js';

const actionKey=(c:BotCandidate)=>JSON.stringify([[...(c.captureTargets??[])].sort(),c.drafts.map(d=>[d.issueTick,d.action])]);
/** Only independent immediate captures can be split. Deferred gathering,
 * transports, mine construction and fleet edits retain their dependencies. */
export function botCaptureSubplan(o:PlayerObservation,original:BotCandidate,excluded:ReadonlySet<string>):BotCandidate|null{
 const targets=original.captureTargets;
 if(original.combatIntent||!targets||targets.length<2||!original.drafts.length||original.drafts.some(d=>d.issueTick!==o.view.tick||d.action.kind!=='launch'||typeof d.action.destination!=='string'||!targets.includes(d.action.destination)))return null;
 const kept=targets.filter(t=>!excluded.has(t));if(!kept.length||kept.length===targets.length)return null;
 const drafts=original.drafts.filter(d=>kept.includes(String(d.action.destination))).map(d=>({...d,action:{...d.action}}));
 if(!drafts.length||kept.some(t=>!drafts.some(d=>d.action.destination===t)))return null;
 return {id:`subplan:${original.id}:${kept.join('|')}`,kind:kept.length>1?'combined':'attack',objective:kept.map(t=>'capture:'+t).join('+'),targets:kept,captureTargets:kept,drafts,priority:original.priority,
  reasons:['移除本组合在条件反夺中未能持有的目标；剩余立即进攻独立重算资源、路径与同组压力场景，不继承原方案评分']};
}
/** Alternatives for the same launch/fleet edit must never be stacked as if
 * they were independent commands. All surviving bundles still need the full
 * joint resource/path forecast and the same adversarial checks as singles. */
export function combineBotCandidates(o:PlayerObservation,parts:readonly BotCandidate[]):BotCandidate|null{
 if(parts.length<2||parts.some(c=>c.kind==='hold'||c.kind==='scout'||c.combatIntent==='attrition'))return null;
 const drafts=parts.flatMap(c=>c.drafts);
 if(drafts.length>8||new Set(parts.map(c=>c.id)).size!==parts.length)return null;
 const edits=new Set<string>();
 for(const d of drafts){
  const a=d.action,key=typeof a.fleetId==='string'?'fleet:'+a.fleetId:a.kind==='launch'?`launch:${a.source}:${a.destination}`:typeof a.outpostId==='string'?`post:${a.kind}:${a.outpostId}`:JSON.stringify([a.kind,a]);
  if(edits.has(key))return null;edits.add(key);
 }
 // A batch of fresh immediate launches cannot borrow the same stationed
 // troops twice. Mixed command transactions retain the engine's own rules.
 if(drafts.every(d=>d.issueTick===o.view.tick&&d.action.kind==='launch'&&d.action.fleetId===undefined)){
  const spent=new Map<string,number>();
  for(const d of drafts){const source=String(d.action.source);spent.set(source,(spent.get(source)??0)+Number(d.action.drillers));}
  if([...spent].some(([id,n])=>{const p=o.view.outposts.find(p=>p.id===id&&p.owner===o.view.player&&p.visibility===2);return p?.drillers!==undefined&&n>p.drillers;}))return null;
 }
 if(!botDispatchPlanAllowed(o,drafts))return null;
 const id='joint:'+parts.map(c=>c.id).sort().join('|');
 return {id,kind:'combined',components:parts.flatMap(c=>c.components??[{id:c.id,kind:c.kind,targets:c.targets,drafts:c.drafts,reasons:c.reasons}]),objective:[...new Set(parts.map(c=>c.objective))].join('+'),targets:[...new Set(parts.flatMap(c=>c.targets))],
  captureTargets:[...new Set(parts.flatMap(c=>c.captureTargets??[]))],drafts,priority:Math.max(...parts.map(c=>c.priority)),
  reasons:[...new Set(parts.flatMap(c=>c.reasons)),'多指令整组比较资源、交付、来源安全及敌方反应，不叠加单项评分']};
}

/** Interleave distinct-objective pairs, same-target joint assaults and three
 * independent components. Ranked includes some non-profitable singles: their
 * combination can be useful, but no unverified score is inherited. */
export function botCombinationCandidates(o:PlayerObservation,ranked:readonly BotCandidate[],generated:readonly BotCandidate[]):BotCandidate[]{
 const diverse:BotCandidate[]=[],objectives=new Set<string>();
 for(const c of ranked){if(c.kind==='hold'||c.kind==='scout'||c.kind==='combined'||c.combatIntent==='attrition'||objectives.has(c.objective))continue;objectives.add(c.objective);diverse.push(c);if(diverse.length===8)break;}
 const pairs:BotCandidate[]=[],joint:BotCandidate[]=[],triples:BotCandidate[]=[];
 const add=(lane:BotCandidate[],parts:BotCandidate[])=>{const c=combineBotCandidates(o,parts);if(c)lane.push(c);};
 // Preserve force/route alternatives among the strongest existing singles;
 // one representative per objective is not a dominance proof.
 const leaders=ranked.filter(c=>c.kind!=='hold'&&c.kind!=='scout'&&c.kind!=='combined'&&c.combatIntent!=='attrition').slice(0,6);
 for(let i=0;i<leaders.length;i++)for(let j=i+1;j<leaders.length;j++)add(pairs,[leaders[i]!,leaders[j]!]);
 for(let i=0;i<diverse.length;i++)for(let j=i+1;j<diverse.length;j++)add(pairs,[diverse[i]!,diverse[j]!]);
 // Individually failed captures can become a valid coordinated assault.
 // Keep the strongest generated seed per source; the bundle is simulated
 // from scratch, including both arrivals and the full capture predicates.
 const targets=new Map<string,Map<string,BotCandidate>>();
 for(const c of generated){
  const d=c.drafts[0];
  if(c.kind!=='attack'||c.combatIntent||c.captureTargets?.length!==1||c.drafts.length!==1||d?.action.kind!=='launch'||d.action.fleetId!==undefined)continue;
  const key=c.captureTargets[0]!,sources=targets.get(key)??new Map<string,BotCandidate>(),source=String(d.action.source),old=sources.get(source);
  if(!old||Number(d.action.drillers)>Number(old.drafts[0]!.action.drillers))sources.set(source,c);targets.set(key,sources);
 }
 const targetLanes:BotCandidate[][]=[];
 for(const sources of targets.values()){
  const seeds=[...sources.values()].slice(0,4),lane:BotCandidate[]=[];
  if(seeds.length>=2)add(lane,seeds.slice(0,2));
  if(seeds.length>=3)add(lane,seeds.slice(0,3));
  if(seeds.length>=4)add(lane,seeds.slice(0,4));
  for(let i=0;i<seeds.length;i++)for(let j=i+1;j<seeds.length;j++)add(lane,[seeds[i]!,seeds[j]!]);
  if(lane.length)targetLanes.push(lane);
 }
 for(let i=0;targetLanes.some(l=>i<l.length);i++)for(const lane of targetLanes)if(lane[i])joint.push(lane[i]!);
 for(let i=0;i<Math.min(6,diverse.length);i++)for(let j=i+1;j<Math.min(6,diverse.length);j++)for(let k=j+1;k<Math.min(6,diverse.length);k++)add(triples,[diverse[i]!,diverse[j]!,diverse[k]!]);
 const result:BotCandidate[]=[],seen=new Set<string>();
 for(let i=0;[pairs,joint,triples].some(l=>i<l.length);i++)for(const lane of [pairs,joint,triples]){
  const c=lane[i];if(!c)continue;const key=actionKey(c);if(seen.has(key))continue;seen.add(key);result.push(c);if(result.length===40)return result;
 }
 return result;
}
