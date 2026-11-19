import test from 'node:test';
import assert from 'node:assert/strict';
import {distribution,compareCounts,race,analyzeMap,select} from './study-territory-priority.mjs';
import {originalCandidate as originalMapCandidate} from '../dist/packages/engine/src/original-map.generated.js';

test('same range can hide different numbers of disadvantaged seats',()=>{
  const a=distribution([9,9,10,10,11,11]),b=distribution([9,10,10,10,10,11]);
  assert.equal(a.score,b.score);assert.equal(a.minCount,b.minCount);
  assert.ok(compareCounts(b.sorted,a.sorted)<0);
  assert.equal(compareCounts(b.sorted,distribution([11,10,9,10,10,10]).sorted),0);
});
test('range precedes full count distribution, which precedes geometry',()=>{
  const rows=[
    {seed:1,...distribution([9,9,11,11]),objective:.1,normalSecure20Min:3},
    {seed:2,...distribution([9,10,10,11]),objective:.9,normalSecure20Min:1},
    {seed:3,...distribution([8,10,11,11]),objective:.01,normalSecure20Min:4},
  ];
  assert.equal(select(rows,'original').seed,1);
  assert.equal(select(rows,'geometryTie').seed,1);
  for(const mode of ['countOnly','countGeometry','countSecure'])assert.equal(select(rows,mode).seed,2);
});
test('protecting the poorest seat is an explicit priority, not variance minimization',()=>{
  const a=distribution([8,10,10,11,11]),b=distribution([9,9,9,11,12]);
  assert.equal(a.score,3);assert.equal(b.score,3);
  assert.ok(compareCounts(b.sorted,a.sorted)<0);
  assert.ok(b.variance>a.variance);
});
test('race margin compares different players, not the two nearest outposts',()=>{
  const map={width:40,height:40,origins:[{},{}],outposts:[
    {position:{x:0,y:0},owner:0,drillers:40},
    {position:{x:1,y:0},owner:0,drillers:40},
    {position:{x:9,y:0},owner:1,drillers:40},
    {position:{x:3,y:0},owner:-1,type:1,meantForPlayer:0},
  ]};
  const r=race(map);
  assert.equal(r.details[0].first,2);assert.equal(r.details[0].second,6);
  assert.deepEqual(r.secure[.3],[1,0]);
});
test('zero-driller queen outpost can change nearest-player assignment',()=>{
  const map={width:40,height:40,origins:[{},{}],outposts:[
    {position:{x:0,y:0},owner:0,drillers:0},
    {position:{x:-10,y:0},owner:0,drillers:40},
    {position:{x:10,y:0},owner:1,drillers:40},
    {position:{x:2,y:0},owner:-1,type:1,meantForPlayer:0},
  ]};
  assert.deepEqual(race(map).counts,[1,0]);
  assert.deepEqual(race(map,undefined,true).counts,[0,1]);
});
test('race ties are not classified as secure and thresholds are nested',()=>{
  const map={width:40,height:40,origins:[{},{}],outposts:[
    {position:{x:-4,y:0},owner:0,drillers:40},
    {position:{x:4,y:0},owner:1,drillers:40},
    {position:{x:0,y:0},owner:-1,type:2,meantForPlayer:0},
  ]};
  const r=race(map);assert.equal(r.details[0].margin,0);assert.deepEqual(r.secure[.1],[0,0]);
});
test('real candidates preserve original territory totals and monotonic secure counts',()=>{
  for(const n of [2,5,8,10])for(const seed of [4300,4308,4524]){
    const map=originalMapCandidate(n,seed),m=analyzeMap(map);
    assert.equal(m.counts.reduce((a,b)=>a+b,0),n*10);
    assert.equal(m.score,map.score);
    const expected=Array.from({length:n},(_,p)=>map.outposts.filter(o=>o.meantForPlayer===p).length);
    assert.deepEqual(m.counts,expected);
    assert.ok(m.normalSecure10Min>=m.normalSecure20Min&&m.normalSecure20Min>=m.normalSecure30Min);
    assert.ok(m.staffedSecure10Min>=m.staffedSecure20Min&&m.staffedSecure20Min>=m.staffedSecure30Min);
  }
});
