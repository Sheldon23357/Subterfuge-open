import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync,gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {originalCandidate as originalMapCandidate} from '../dist/packages/engine/src/original-map.generated.js';
import {matrix,evaluate,mean,stats} from './study-map-fairness.mjs';

export function distribution(counts) {
  const sorted=[...counts].sort((a,b)=>a-b), average=mean(counts);
  return {sorted,score:sorted.at(-1)-sorted[0],minCount:sorted[0],belowMean:counts.filter(x=>x<average).length,variance:mean(counts.map(x=>(x-average)**2))};
}
// Compare worse-off seats first. Negative means a is preferred; seat labels do
// not participate. Range is handled first by the selector, outside this function.
export function compareCounts(a,b) {
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return b[i]-a[i];
  return 0;
}
export function race(map,d=matrix(map),staffed=false) {
  const n=map.origins.length, counts=Array(n).fill(0);
  const secure=Object.fromEntries([.1,.2,.3].map(t=>[t,Array(n).fill(0)]));
  const factories=Array(n).fill(0), generators=Array(n).fill(0), details=[];
  for(let i=0;i<map.outposts.length;i++) {
    if(map.outposts[i].owner>=0)continue;
    const best=Array(n).fill(Infinity);
    for(let j=0;j<map.outposts.length;j++){
      const o=map.outposts[j];
      if(o.owner>=0&&(!staffed||o.drillers>0))best[o.owner]=Math.min(best[o.owner],d[i][j]);
    }
    const ranked=best.map((distance,owner)=>({distance,owner})).sort((a,b)=>a.distance-b.distance||a.owner-b.owner);
    // For all-point territory use the original generator's authoritative owner
    // to preserve float32 and tie behavior; margin still compares distinct seats.
    const owner=!staffed&&Number.isInteger(map.outposts[i].meantForPlayer)?map.outposts[i].meantForPlayer:ranked[0].owner;
    const first=best[owner], second=Math.min(...best.filter((_,p)=>p!==owner));
    const margin=Math.max(0,(second-first)/second);
    counts[owner]++;
    if(map.outposts[i].type===1)factories[owner]++; else generators[owner]++;
    for(const t of [.1,.2,.3])if(margin>=t)secure[t][owner]++;
    details.push({index:i,owner,first,second,margin});
  }
  return {counts,secure,factories,generators,details};
}
export function analyzeMap(map,metric) {
  const d=matrix(map), normal=race(map,d), staffed=race(map,d,true);
  const counts=normal.counts.map((v,p)=>v+map.outposts.filter(o=>o.owner===p).length);
  const t=distribution(counts);
  if(t.score!==map.score)throw Error('Original territory mismatch');
  const a={...t,counts,objective:metric?.objective??evaluate(map,undefined,undefined,d).objective};
  for(const [name,r]of [['normal',normal],['staffed',staffed]])for(const q of [.1,.2,.3]){
    const suffix=Math.round(q*100),values=r.secure[q];
    a[`${name}Secure${suffix}Min`]=Math.min(...values);
    a[`${name}Secure${suffix}Mean`]=mean(values);
    a[`${name}Secure${suffix}Range`]=Math.max(...values)-Math.min(...values);
  }
  a.staffedCounts=staffed.counts.map(v=>v+5);
  a.staffedRange=distribution(a.staffedCounts).score;
  a.staffedMin=Math.min(...a.staffedCounts);
  a.staffedReassigned=normal.details.filter((o,i)=>o.owner!==staffed.details[i].owner).length;
  a.neutralFactoryRange=Math.max(...normal.factories)-Math.min(...normal.factories);
  a.neutralGeneratorRange=Math.max(...normal.generators)-Math.min(...normal.generators);
  a.secureCounts20=normal.secure[.2];a.staffedSecureCounts20=staffed.secure[.2];
  return a;
}
export const strategies=['original','geometryTie','countOnly','countGeometry','countSecure'];
export function select(rows,mode) {
  const bestRange=Math.min(...rows.map(r=>r.score));
  let pool=rows.filter(r=>r.score===bestRange);
  if(mode==='original')return pool[0];
  if(mode.startsWith('count')){
    const best=pool.reduce((a,b)=>compareCounts(b.sorted,a.sorted)<0?b:a);
    pool=pool.filter(r=>compareCounts(r.sorted,best.sorted)===0);
  }
  if(mode==='countOnly')return pool[0];
  if(mode==='countSecure') {
    const minBest=Math.max(...pool.map(r=>r.normalSecure20Min));
    pool=pool.filter(r=>r.normalSecure20Min===minBest);
    // A research sensitivity experiment, not a claim that 20% is a game rule.
  }
  return pool.reduce((a,b)=>b.objective<a.objective?b:a);
}

export async function run() {
  const out='artifacts/territory-priority-study';fs.mkdirSync(out,{recursive:true});
  const batches=[], saved=[], examples=[];let processed=0;
  const inputs=['artifacts/map-fairness-study','artifacts/map-fairness-confirmation'];
  for(const dir of inputs){
    const source=JSON.parse(fs.readFileSync(`${dir}/results.json`));
    const records=JSON.parse(gunzipSync(fs.readFileSync(`${dir}/candidates.json.gz`)));
    for(const b of source.batches){
      const rows=records.filter(c=>c.players===b.players&&c.window===b.window).map(c=>({players:b.players,seed:c.seed,...analyzeMap(originalMapCandidate(b.players,c.seed),c)}));
      processed+=rows.length;
      record(b.players,b.requestedSeed,rows,'historical');
      if(b.window%5===0)console.log(`historical n=${b.players} window=${b.window} analyzed=${processed}`);
      await new Promise(r=>setImmediate(r));
    }
  }
  // Untouched windows fixed before examining results; count rules and 20% race
  // threshold above are frozen. Historical seed windows ended at index 29.
  for(let n=5;n<=10;n++)for(let w=30;w<40;w++){
    const requestedSeed=100000+w*104729,rows=[];
    for(let seed=requestedSeed;seed<requestedSeed+500;seed++){
      const map=originalMapCandidate(n,seed);
      if(map.valid)rows.push({players:n,seed,...analyzeMap(map)});
    }
    if(!rows.length)throw Error('No valid map');
    processed+=rows.length;record(n,requestedSeed,rows,'fresh');
    console.log(`fresh n=${n} window=${w} accepted=${rows.length}`);
    await new Promise(r=>setImmediate(r));
  }
  function record(n,requestedSeed,rows,phase){
    const selected=Object.fromEntries(strategies.map(s=>[s,select(rows,s)]));
    const best=selected.original.score, pool=rows.filter(r=>r.score===best);
    const patterns=[...new Set(pool.map(r=>r.sorted.join(',')))];
    batches.push({players:n,requestedSeed,phase,valid:rows.length,bestPool:pool.length,distributionPatterns:patterns.length,selected});
    saved.push(...rows.map(r=>({...r,requestedSeed,phase})));
    for(const s of strategies)if(selected[s].score!==best)throw Error('Range regressed');
    for(const s of ['countOnly','countGeometry','countSecure'])if(compareCounts(selected[s].sorted,selected.original.sorted)>0)throw Error('Count priority regressed');
    if(n===8&&requestedSeed===4300)examples.push({players:n,requestedSeed,selected});
  }
  const metrics=['score','minCount','belowMean','variance','objective','normalSecure10Min','normalSecure20Min','normalSecure30Min','normalSecure20Mean','normalSecure20Range','staffedSecure10Min','staffedSecure20Min','staffedSecure30Min','staffedSecure20Mean','staffedRange','staffedMin','staffedReassigned','neutralFactoryRange','neutralGeneratorRange'];
  const groups={};
  for(const phase of ['historical','fresh'])for(const n of ['all','5-10',2,3,4,5,6,7,8,9,10]){
    const bs=batches.filter(b=>b.phase===phase&&(n==='all'||n==='5-10'&&b.players>=5||b.players===n));if(!bs.length)continue;
    groups[`${phase}/${n}`]={count:bs.length,multiplePatterns:bs.filter(b=>b.distributionPatterns>1).length,strategies:Object.fromEntries(strategies.map(s=>[s,{metrics:Object.fromEntries(metrics.map(k=>[k,stats(bs.map(b=>b.selected[s][k]))])),countsBetter:bs.filter(b=>compareCounts(b.selected[s].sorted,b.selected.original.sorted)<0).length,countsWorse:bs.filter(b=>compareCounts(b.selected[s].sorted,b.selected.original.sorted)>0).length,changed:bs.filter(b=>b.selected[s].seed!==b.selected.original.seed).length,geometryWorse:bs.filter(b=>b.selected[s].objective>b.selected.original.objective+1e-12).length}]))};
  }
  const hashes=Object.fromEntries(['scripts/study-territory-priority.mjs','packages/engine/src/original-map.generated.ts','docs/rules/data/profile-4300.json'].map(f=>[f,createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
  fs.writeFileSync(`${out}/results.json`,JSON.stringify({historicalCandidates:120000,newCandidates:30000,accepted:processed,runtime:process.version,hashes,metrics,strategies,groups,batches,examples},null,2));
  fs.writeFileSync(`${out}/candidates.json.gz`,gzipSync(JSON.stringify(saved)));
  console.log(JSON.stringify(groups['fresh/5-10'],null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await run();
