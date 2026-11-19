import { originalMapCandidate, type OriginalMap } from './map-generation.js';

export interface MapSelectionMetrics {
  /** Initial potential territory, in player order; never recomputed during play. */
  territoryCounts: number[];
  geometryScore: number;
}
export type QuantityPriorityMap = Omit<OriginalMap, 'algorithm'> & {
  algorithm: 'quantity-priority-v1';
  selection: MapSelectionMetrics;
};
export type GeneratedMap = OriginalMap | QuantityPriorityMap;
type Candidate = ReturnType<typeof originalMapCandidate>;

/** Negative means a is preferred: protect the poorest seat, then the next. */
export function compareTerritoryCounts(a: number[], b: number[]): number {
  const x = [...a].sort((a,b) => a-b), y = [...b].sort((a,b) => a-b);
  for (let i=0;i<x.length;i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
  return 0;
}

/** Version 1 uses the research metric exactly, without float32 distance rounding.
 * Only breaks ties in the complete territory distribution; it cannot buy land
 * equality with distance. Candidate geometry and ownership remain original. */
export function quantityPriorityMetrics(map: Candidate): MapSelectionMetrics {
  const n = map.origins.length, counts = Array<number>(n).fill(0);
  for (const o of map.outposts) counts[o.meantForPlayer]!++;
  const d = map.outposts.map(a => map.outposts.map(b => {
    const x = Math.abs(a.position.x-b.position.x), y = Math.abs(a.position.y-b.position.y);
    return Math.hypot(Math.min(x,map.width-x),Math.min(y,map.height-y));
  }));
  const border: number[] = [], origin: number[] = [], expansion: number[] = [];
  for (let p=0;p<n;p++) {
    const own = map.outposts.flatMap((o,i) => o.owner===p?[i]:[]);
    const enemies = map.outposts.flatMap((o,i) => o.owner>=0&&o.owner!==p?[i]:[]);
    const neutrals = map.outposts.flatMap((o,i) => o.owner<0?[i]:[]);
    const q = map.startingOutposts.find(q => q.owner===p)!.outpost;
    border.push(Math.min(...own.flatMap(i => enemies.map(j => d[i]![j]!))));
    origin.push(Math.min(...enemies.map(j => d[q]![j]!)));
    const nearest = neutrals.map(j => Math.min(...own.map(i => d[i]![j]!))).sort((a,b) => a-b).slice(0,3);
    expansion.push(nearest.reduce((s,v) => s+v,0)/nearest.length);
  }
  const spread = (a: number[]) => (Math.max(...a)-Math.min(...a))/(a.reduce((s,v)=>s+v,0)/a.length);
  return {territoryCounts:counts,geometryScore:Math.max(spread(border),spread(origin),spread(expansion))};
}

export async function generateQuantityPriorityMap(
  players: number, seed: number, yieldControl: () => Promise<void> = async () => {},
  acceptCandidate: (map: Candidate) => boolean = () => true,
  composeCandidate: (map:Candidate,seed:number)=>Candidate = map=>map,
): Promise<QuantityPriorityMap> {
  if (!Number.isInteger(seed) || seed<0 || seed>0xffffffff-499) throw Error('种子超出筛选范围');
  let best: Candidate | undefined, selection: MapSelectionMetrics | undefined, bestSeed=seed;
  for (let i=0;i<500;i++) {
    const candidate = composeCandidate(originalMapCandidate(players,seed+i),seed+i);
    if (candidate.valid && acceptCandidate(candidate) && (!best || candidate.score<=best.score)) {
      const metrics = quantityPriorityMetrics(candidate);
      const order = selection ? compareTerritoryCounts(metrics.territoryCounts,selection.territoryCounts) : -1;
      if (!best || candidate.score<best.score || order<0 || (order===0 && metrics.geometryScore<selection!.geometryScore)) {
        best=candidate;selection=metrics;bestSeed=seed+i;
      }
    }
    if(i%10===9)await yieldControl();
  }
  if (!best || !selection) throw Error('连续 500 个种子中无合格地图，请更换种子');
  const {valid,...data}=best;
  return {...data,algorithm:'quantity-priority-v1',players,requestedSeed:seed,seed:bestSeed,selection};
}
