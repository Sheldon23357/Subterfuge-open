import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {compareCounts} from './study-territory-priority.mjs';
import {mean} from './study-map-fairness.mjs';
const out='artifacts/territory-priority-study';
const r=JSON.parse(fs.readFileSync(`${out}/results.json`));
const rows=JSON.parse(gunzipSync(fs.readFileSync(`${out}/candidates.json.gz`)));
const index=new Map(rows.map(r=>[`${r.players}/${r.seed}`,r]));
const result={previousGuards:{},freshPaired:{}};
for(const dir of ['map-fairness-study','map-fairness-confirmation']){
  const a=JSON.parse(fs.readFileSync(`artifacts/${dir}/analysis.json`));let better=0,worse=0,same=0;
  for(const b of a.guardedSelections){const c=compareCounts(index.get(`${b.players}/${b.seed}`).sorted,index.get(`${b.players}/${b.original}`).sorted);if(c<0)better++;else if(c>0)worse++;else same++;}
  result.previousGuards[dir]={better,worse,same};
}
let state=91451;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
const bs=r.batches.filter(b=>b.phase==='fresh'), seeds=[...new Set(bs.map(b=>b.requestedSeed))];
for(const strategy of r.strategies){
  const m={};
  for(const key of ['variance','belowMean','objective','normalSecure20Min','staffedSecure20Min']){
    const block=seeds.map(seed=>mean(bs.filter(b=>b.requestedSeed===seed).map(b=>b.selected[strategy][key]-b.selected.original[key])));
    const bootstrap=Array.from({length:3000},()=>mean(block.map(()=>block[Math.floor(random()*block.length)]))).sort((a,b)=>a-b);
    m[key]={meanDelta:mean(block),interval95:[bootstrap[75],bootstrap[2924]]};
  }
  result.freshPaired[strategy]={metrics:m,zeroSecureMaps:bs.filter(b=>b.selected[strategy].normalSecure20Min===0).length,staffedChangedMaps:bs.filter(b=>b.selected[strategy].staffedReassigned>0).length};
}
fs.writeFileSync(`${out}/supplement.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
