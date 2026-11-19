import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {stats,mean} from './study-map-fairness.mjs';
const dir=process.argv[2]??'artifacts/map-fairness-study';
const r=JSON.parse(fs.readFileSync(`${dir}/results.json`));
const records=JSON.parse(gunzipSync(fs.readFileSync(`${dir}/candidates.json.gz`)));
const core=['borderSpread','queenSpread','expansionSpread'];
// Exploratory guard, added after the initial experiment: preserve all three
// baseline relative spreads AND minimum border/queen distance and expansion mean.
for(const b of r.batches){
  const base=b.selected.original;
  const pool=records.filter(c=>c.players===b.players&&c.window===b.window&&c.score===base.score&&core.every(k=>c[k]<=base[k]+1e-12)&&c.minBorder>=base.minBorder-1e-12&&c.minQueenThreat>=base.minQueenThreat-1e-12&&c.meanExpansion<=base.meanExpansion+1e-12);
  b.selected.guardedTie=pool.reduce((a,c)=>c.objective<a.objective?c:a,base);
  b.guardPool=pool.length;
}
let state=57123;
const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
function paired(subset,strategy,key){
  const delta=subset.map(b=>b.selected[strategy][key]-b.selected.original[key]);
  // Resample complete seed windows, keeping all player counts together. This
  // preserves pairing and dependence from shared requested seed windows.
  const windows=[...new Set(subset.map(b=>b.window))];
  const block=windows.map(w=>mean(subset.filter(b=>b.window===w).map(b=>b.selected[strategy][key]-b.selected.original[key])));
  const boot=Array.from({length:3000},()=>mean(block.map(()=>block[Math.floor(random()*block.length)]))).sort((a,b)=>a-b);
  return {meanDelta:mean(delta),decreased:delta.filter(d=>d < -1e-10).length,increased:delta.filter(d=>d > 1e-10).length,equal:delta.filter(d=>Math.abs(d)<=1e-10).length,interval95:[boot[75],boot[2924]]};
}
const analysis={candidateCount:r.candidateCount,accepted:records.length,groups:{},assignment:{},examples:r.examples,sourceHashes:{},guardedNote:r.offset>=20?'Fresh seed windows after the guard was fixed. Treat all windows together as confirmation; internal phase labels are irrelevant.':'Post-hoc exploratory; guard requires a fresh untouched validation set before a product decision.'};
for(const group of ['all','5-10',...r.players]) for(const phase of ['all','calibration','validation']){
  const subset=r.batches.filter(b=>(group==='all'||group==='5-10'&&b.players>=5||b.players===group)&&(phase==='all'||b.phase===phase));
  if(!subset.length)continue;
  const entry={windows:subset.length,validCandidates:stats(subset.map(b=>b.valid)),thresholds:{},strategies:{},seatMeans:{}};
  for(const t of [4,5,6])entry.thresholds[t]={windowsWithoutAny:subset.filter(b=>b.thresholds[t]===0).length,totalCandidates:subset.reduce((n,b)=>n+b.thresholds[t],0)};
  for(const s of [...r.strategies,'guardedTie'])entry.strategies[s]={metrics:Object.fromEntries(r.metricKeys.map(k=>[k,stats(subset.map(b=>b.selected[s][k]))])),paired:Object.fromEntries(r.metricKeys.map(k=>[k,paired(subset,s,k)])),changed:subset.filter(b=>b.selected[s].seed!==b.selected.original.seed).length};
  if(typeof group==='number')for(let p=0;p<group;p++)entry.seatMeans[p]=Object.fromEntries(['border','queenThreat','expansion3','mst'].map(k=>[k,mean(subset.map(b=>b.selected.original.seats[p][k]))]));
  analysis.groups[`${group}/${phase}`]=entry;
}
for(const mode of ['reverse','roundRobin']){
  const a=r.ablations.filter(a=>a.mode===mode);
  analysis.assignment[mode]={count:a.length,changedMaps:a.filter(a=>a.changedFraction>0).length,meanChangedFraction:mean(a.map(a=>a.changedFraction)),valid:a.filter(a=>a.valid).length,typeBalanced:a.filter(a=>a.typeBalanced).length,objectiveMeanDelta:mean(a.map(a=>a.altered.objective-a.original.objective)),meanMstDelta:mean(a.map(a=>a.altered.meanMst-a.original.meanMst)),objectiveImproved:a.filter(a=>a.altered.objective<a.original.objective-1e-10).length,objectiveWorsened:a.filter(a=>a.altered.objective>a.original.objective+1e-10).length};
}
for(const file of ['packages/engine/src/original-map.generated.ts','packages/engine/src/map-generation.ts','docs/rules/data/profile-4300.json','scripts/study-map-fairness.mjs','scripts/analyze-map-fairness.mjs','scripts/study-map-fairness.test.mjs'])analysis.sourceHashes[file]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
analysis.runtime=process.version;
analysis.guardedSelections=r.batches.map(b=>({players:b.players,window:b.window,requestedSeed:b.requestedSeed,pool:b.guardPool,seed:b.selected.guardedTie.seed,original:b.selected.original.seed}));
fs.writeFileSync(`${dir}/analysis.json`,JSON.stringify(analysis,null,2));
for(const g of ['5-10/validation','8/all','10/all']){
  const e=analysis.groups[g];console.log(g,'thresholds',e.thresholds);
  for(const s of ['original','territoryTie','minimax','guardedTie'])console.log(s,Object.fromEntries(['score','objective','borderSpread','queenSpread','expansionSpread','minBorder','meanExpansion'].map(k=>[k,+e.strategies[s].metrics[k].mean.toFixed(4)])),s==='original'?'':e.strategies[s].paired.objective);
}
console.log('assignment',analysis.assignment);
