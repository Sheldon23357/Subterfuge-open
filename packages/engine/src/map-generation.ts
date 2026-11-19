import { ordinaryCandidate } from "./ordinary-map.generated.js";
import type { Point } from "./geometry.js";
export interface OriginalMap {
  algorithm: "apk12075-rules4300";
  composition?: 'generator-45-v1';
  players: number;
  requestedSeed: number;
  seed: number;
  score: number;
  width: number;
  height: number;
  origins: Point[];
  startingOutposts: { owner: number; outpost: number }[];
  outposts: {
    position: Point;
    owner: number;
    type: number;
    drillers: number;
    shield: number;
    shieldMax: number;
    productionProgress: number;
    meantForPlayer: number;
    nameIndex: number;
  }[];
}
export function originalMapCandidate(players: number, seed: number) {
  if (!Number.isInteger(players) || players < 2 || players > 10)
    throw Error("地图人数必须为 2～10");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw Error("种子必须是 0～4294966796 的整数");
  return ordinaryCandidate(players,seed) as Omit<OriginalMap,'algorithm'|'players'|'requestedSeed'|'seed'>&{valid:boolean};
}
/** Gameplay starts with five outposts and a shared 2/3 factory-generator mix. */
export function hasBalancedStartingOutposts(map: Pick<OriginalMap, "origins" | "outposts">): boolean {
  let sharedGenerators: number | undefined;
  return map.origins.every((_, player) => {
    const owned = map.outposts.filter((o) => o.owner === player);
    const generators = owned.filter((o) => o.type === 2).length;
    const factories = owned.filter((o) => o.type === 1).length;
    sharedGenerators ??= generators;
    return owned.length === 5 && generators + factories === 5 &&
      (generators === 2 || generators === 3) && generators === sharedGenerators;
  });
}
/** Local gameplay policy; keep locked original generation and research defaults intact. */
export function hasGameplayMapComposition(map: Pick<OriginalMap, "origins" | "outposts">): boolean {
  const generators=map.outposts.filter(o=>o.type===2).length;
  return map.outposts.length>0&&generators===Math.floor((map.outposts.length*45+50)/100)&&
    hasBalancedStartingOutposts(map);
}
/** Local, versioned building allocation. Original geometry and owned buildings
 * remain intact; only neutral types are assigned to the nearest 45% count. */
export function applyGameplayMapComposition(raw:ReturnType<typeof originalMapCandidate>,seed:number):ReturnType<typeof originalMapCandidate>{
  const map=structuredClone(raw);
  map.composition='generator-45-v1';
  if(!raw.valid||!hasBalancedStartingOutposts(raw)){map.valid=false;return map;}
  const target=Math.floor((map.outposts.length*45+50)/100);
  let current=map.outposts.filter(p=>p.type===2).length;
  const counts=map.origins.map((_,player)=>map.outposts.filter(p=>p.meantForPlayer===player&&p.type===2).length);
  const totals=map.origins.map((_,player)=>map.outposts.filter(p=>p.meantForPlayer===player).length);
  const rank=(index:number)=>{let x=(seed^Math.imul(index+1,0x9e3779b9))>>>0;x=Math.imul(x^(x>>>16),0x85ebca6b);return (x^(x>>>13))>>>0;};
  while(current!==target){
    const adding=current<target,from=adding?1:2;
    const choices=map.outposts.flatMap((p,i)=>p.owner<0&&p.type===from?[{p,i}]:[]);
    choices.sort((a,b)=>{
      const ratio=(counts[a.p.meantForPlayer]??0)/Math.max(1,totals[a.p.meantForPlayer]??0)
        -(counts[b.p.meantForPlayer]??0)/Math.max(1,totals[b.p.meantForPlayer]??0);
      return (adding?ratio:-ratio)||rank(a.i)-rank(b.i)||a.i-b.i;
    });
    const next=choices[0];if(!next){map.valid=false;return map;}
    next.p.type=adding?2:1;next.p.productionProgress=0;
    const owner=next.p.meantForPlayer;
    if(owner>=0&&owner<counts.length)counts[owner]=counts[owner]!+(adding?1:-1);
    current+=adding?1:-1;
  }
  return map;
}
/** Exact best-of-500 selection, earliest seed wins equal score. Yield is supplied by host. */
export async function generateOriginalMap(
  players: number,
  seed: number,
  yieldControl: () => Promise<void> = async () => {},
  acceptCandidate: (map: ReturnType<typeof originalMapCandidate>) => boolean = () => true,
  composeCandidate: (map:ReturnType<typeof originalMapCandidate>,seed:number)=>ReturnType<typeof originalMapCandidate> = map=>map,
): Promise<OriginalMap> {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff - 499)
    throw Error("种子超出筛选范围");
  let best: ReturnType<typeof originalMapCandidate> | undefined,
    bestSeed = seed;
  for (let i = 0; i < 500; i++) {
    const candidate = composeCandidate(originalMapCandidate(players, seed + i),seed+i);
    if (candidate.valid && acceptCandidate(candidate) && (!best || candidate.score < best.score)) {
      best = candidate;
      bestSeed = seed + i;
    }
    if (i % 10 === 9) await yieldControl();
  }
  if (!best) throw Error("连续 500 个种子中无合格地图，请更换种子");
  const { valid, ...data } = best;
  return {
    ...data,
    algorithm: "apk12075-rules4300",
    players,
    requestedSeed: seed,
    seed: bestSeed,
  };
}
