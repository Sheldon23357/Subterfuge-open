import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
// Historical map study; deliberately uses the archived reference, not live rules.
import { originalCandidate as originalMapCandidate } from '../dist/packages/engine/src/original-map.generated.js';

export const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
export const spread = a => (Math.max(...a) - Math.min(...a)) / Math.max(mean(a), 1e-12);
export function distance(a, b, map) {
  const x = Math.abs(a.x - b.x), y = Math.abs(a.y - b.y);
  return Math.hypot(Math.min(x, map.width - x), Math.min(y, map.height - y));
}
export function matrix(map) {
  return map.outposts.map(a => map.outposts.map(b => distance(a.position, b.position, map)));
}
export function territory(map, owners, d = matrix(map)) {
  const counts = Array(map.origins.length).fill(0);
  owners.forEach((owner, i) => {
    if (owner < 0) {
      let best = Infinity;
      owners.forEach((other, j) => { if (other >= 0 && d[i][j] < best) { best = d[i][j]; owner = other; } });
    }
    counts[owner]++;
  });
  return counts;
}
export function evaluate(map, owners = map.outposts.map(o => o.owner), queens = map.queens, d = matrix(map)) {
  const n = map.origins.length;
  const seats = Array.from({ length: n }, (_, owner) => {
    const own = owners.flatMap((p, i) => p === owner ? [i] : []);
    const enemy = owners.flatMap((p, i) => p >= 0 && p !== owner ? [i] : []);
    const neutral = owners.flatMap((p, i) => p < 0 ? [i] : []);
    const q = queens.find(q => q.owner === owner).outpost;
    const nearest = neutral.map(j => Math.min(...own.map(i => d[i][j]))).sort((a,b) => a-b);
    const enemyBySeat = Array.from({ length: n }, (_, p) => p === owner ? Infinity : Math.min(...own.flatMap(i => enemy.filter(j => owners[j] === p).map(j => d[i][j]))));
    // A minimum spanning tree measures how widely the five owned points are scattered.
    const visited = new Set([own[0]]); let mst = 0, largestLink = 0;
    while (visited.size < own.length) {
      let best = Infinity, target;
      for (const i of visited) for (const j of own) if (!visited.has(j) && d[i][j] < best) { best = d[i][j]; target = j; }
      visited.add(target); mst += best; largestLink = Math.max(largestLink, best);
    }
    return { border: Math.min(...enemyBySeat), queenThreat: Math.min(...enemy.map(j => d[q][j])), expansion3: mean(nearest.slice(0,3)), expansion5: mean(nearest.slice(0,5)), neighbours6: enemyBySeat.filter(v => v <= 6).length, neighbours9: enemyBySeat.filter(v => v <= 9).length, neighbours12: enemyBySeat.filter(v => v <= 12).length, mst, largestLink };
  });
  const values = key => seats.map(s => s[key]);
  const core = ['border', 'queenThreat', 'expansion3'].map(k => spread(values(k)));
  const counts = territory(map, owners, d);
  return { seats, territory: counts, score: Math.max(...counts)-Math.min(...counts), borderSpread: core[0], queenSpread: core[1], expansionSpread: core[2], objective: Math.max(...core), meanObjective: mean(core), minBorder: Math.min(...values('border')), meanBorder: mean(values('border')), minQueenThreat: Math.min(...values('queenThreat')), meanExpansion: mean(values('expansion3')), worstExpansion: Math.max(...values('expansion3')), meanMst: mean(values('mst')), worstLink: Math.max(...values('largestLink')), neighbourRange6: Math.max(...values('neighbours6'))-Math.min(...values('neighbours6')), neighbourRange9: Math.max(...values('neighbours9'))-Math.min(...values('neighbours9')), neighbourRange12: Math.max(...values('neighbours12'))-Math.min(...values('neighbours12')) };
}

// Controlled ablation: keep geometry AND building types fixed. This is not a
// complete replacement generator; changing assignment can invalidate type balance.
export function assign(map, mode) {
  const n = map.origins.length, owners = map.outposts.map(() => -1), queens = [];
  const orders = map.origins.map(origin => map.outposts.map((o, i) => [distance(origin, o.position, map), i]).sort((a,b) => a[0]-b[0] || a[1]-b[1]).map(x => x[1]));
  const take = p => { const i = orders[p].find(i => owners[i] < 0); owners[i] = p; if (!queens.some(q => q.owner === p)) queens.push({owner:p,outpost:i}); };
  if (mode === 'reverse') for (let p = n-1; p >= 0; p--) for (let r = 0; r < 5; r++) take(p);
  else if (mode === 'roundRobin') for (let r = 0; r < 5; r++) for (let p = 0; p < n; p++) take((p+r)%n);
  else throw Error('Unknown assignment');
  const generators = Array.from({length:n}, (_,p) => owners.filter((owner,i) => owner===p && map.outposts[i].type===2).length);
  return { owners, queens, typeBalanced: new Set(generators).size === 1, changedFraction: mean(owners.map((p,i) => Number(p!==map.outposts[i].owner))) };
}

export function choose(rows, strategy) {
  const baseline = rows.reduce((a,b) => b.score<a.score?b:a);
  if (strategy === 'original') return baseline;
  const pool = strategy === 'territoryTie' ? rows.filter(r => r.score===baseline.score) : rows;
  const key = {territoryTie:'objective',minimax:'objective',mean:'meanObjective',borderOnly:'borderSpread',expansionOnly:'expansionSpread'}[strategy];
  return pool.reduce((a,b) => b[key]<a[key] || (b[key]===a[key] && b.score<a.score) ? b:a);
}
export function stats(values) {
  const a = [...values].sort((a,b)=>a-b);
  const q = p => { const x = (a.length-1)*p, i = Math.floor(x); return a[i]+(a[Math.ceil(x)]-a[i])*(x-i); };
  return { n:a.length, mean:mean(a), min:a[0], p10:q(.1), median:q(.5), p90:q(.9), max:a.at(-1) };
}
const keys = ['score','objective','borderSpread','queenSpread','expansionSpread','minBorder','meanBorder','minQueenThreat','meanExpansion','worstExpansion','meanMst','worstLink','neighbourRange6','neighbourRange9','neighbourRange12'];
const strategies = ['original','territoryTie','minimax','mean','borderOnly','expansionOnly'];
export async function run({ windows = 20, players = [2,3,4,5,6,7,8,9,10], offset = 0, output = 'artifacts/map-fairness-study' } = {}) {
  const started = performance.now(), batches = [], records = [], ablations = [], examples = [];
  fs.mkdirSync(output, {recursive:true});
  // Separated windows; no overlapping candidate seeds. First half calibration,
  // second half validation. Formulas are fixed before either half is generated.
  const seeds = Array.from({length:windows}, (_,w) => { const i=w+offset; return i===0?4300:100000+i*104729; });
  for (const n of players) for (let w = 0; w < seeds.length; w++) {
    const requestedSeed = seeds[w], rows = []; let geometryValid = 0, scoreValid = 0, typesValid = 0;
    for (let i = 0; i < 500; i++) {
      const seed = requestedSeed+i, map = originalMapCandidate(n, seed);
      if (map.outposts.length !== n*10) continue;
      geometryValid++;
      if (map.score<=3) scoreValid++;
      const types = Array.from({length:n}, (_,p) => map.outposts.filter(o => o.owner===p && o.type===2).length);
      if (new Set(types).size===1) typesValid++;
      if (!map.valid) continue;
      const metric = evaluate(map);
      if (metric.score !== map.score) throw Error(`Territory mismatch ${n}/${seed}`);
      const row = {players:n,window:w,seed,...metric}; rows.push(row); records.push(row);
    }
    if (!rows.length) throw Error(`No valid candidates for ${n}/${requestedSeed}`);
    const selected = Object.fromEntries(strategies.map(s => [s,choose(rows,s)]));
    batches.push({players:n,window:w,phase:w<Math.floor(windows/2)?'calibration':'validation',requestedSeed,geometryValid,scoreValid,typesValid,valid:rows.length,selected, thresholds:Object.fromEntries([4,5,6].map(t=>[t,rows.filter(r=>r.minBorder>=t).length]))});
    const baseMap = originalMapCandidate(n,selected.original.seed);
    for (const mode of ['reverse','roundRobin']) {
      const altered = assign(baseMap,mode), metrics = evaluate(baseMap,altered.owners,altered.queens);
      ablations.push({players:n,window:w,mode,typeBalanced:altered.typeBalanced,changedFraction:altered.changedFraction,valid:altered.typeBalanced && metrics.score<=3,original:selected.original,altered:metrics});
    }
    if (n===8 && w===0) for (const strategy of ['original','territoryTie','minimax']) examples.push({strategy,seed:selected[strategy].seed,map:originalMapCandidate(n,selected[strategy].seed),metrics:selected[strategy]});
    console.log(`players=${n} window=${w+1}/${windows} valid=${rows.length}/500 original=${selected.original.seed} minimax=${selected.minimax.seed} elapsed=${((performance.now()-started)/1000).toFixed(1)}s`);
    await new Promise(resolve=>setImmediate(resolve));
  }
  const groups = {};
  for (const n of ['all',...players]) for (const phase of ['all','calibration','validation']) {
    const subset = batches.filter(b=>(n==='all'||b.players===n)&&(phase==='all'||b.phase===phase));
    if (!subset.length) continue;
    groups[`${n}/${phase}`] = Object.fromEntries(strategies.map(s=>[s,Object.fromEntries(keys.map(k=>[k,stats(subset.map(b=>b.selected[s][k]))]))]));
  }
  const summary = {schema:1, windows, offset, players, candidateCount:players.length*windows*500, seeds, strategies, metricKeys:keys, elapsedSeconds:(performance.now()-started)/1000, groups, batches, ablations,examples};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(summary,null,2));
  fs.writeFileSync(path.join(output,'candidates.json.gz'),gzipSync(JSON.stringify(records)));
  console.log(`Saved ${records.length} accepted candidates and ${batches.length} paired comparisons to ${output}`);
  return summary;
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = name => { const i=process.argv.indexOf(name); return i<0?undefined:process.argv[i+1]; };
  const options = {};
  if (arg('--windows')) options.windows=Number(arg('--windows'));
  if (arg('--players')) options.players=arg('--players').split(',').map(Number);
  if (arg('--output')) options.output=arg('--output');
  if (arg('--offset')) options.offset=Number(arg('--offset'));
  if (options.windows!==undefined && (!Number.isInteger(options.windows)||options.windows<2)) throw Error('windows must be an integer >=2');
  if (options.players && options.players.some(n=>!Number.isInteger(n)||n<2||n>10)) throw Error('players must be integers 2..10');
  if (options.offset!==undefined && (!Number.isInteger(options.offset)||options.offset<0||100000+(options.offset+(options.windows??20))*104729>0xffffffff-499)) throw Error('offset outside seed range');
  await run(options);
}
