import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, spread, evaluate, territory, assign, choose } from './study-map-fairness.mjs';
import { originalCandidate as originalMapCandidate } from '../dist/packages/engine/src/original-map.generated.js';
import { generateOriginalMap } from '../dist/packages/engine/src/map-generation.js';

test('toroidal distance crosses both seams and is translation invariant', () => {
  const size = {width:40,height:40};
  assert.ok(Math.abs(distance({x:-19,y:-19},{x:19,y:19},size)-Math.sqrt(8))<1e-12);
  assert.equal(distance({x:0,y:0},{x:20,y:0},size),20);
  assert.equal(spread([4,4,4]),0);
  assert.equal(spread([2,4,6]),1);
});
test('territory uses nearest owned point, including across a seam', () => {
  const map={width:40,height:40,origins:[{},{}],outposts:[{position:{x:-19,y:0}},{position:{x:0,y:0}},{position:{x:19,y:0}},{position:{x:2,y:0}}]};
  assert.deepEqual(territory(map,[0,1,-1,-1]),[2,2]);
});
test('hand constructed symmetric map has equal metrics and known expansion distances', () => {
  const points=[];
  for (const x of [-10,10]) for (const y of [-4,-2,0,2,4]) points.push({position:{x,y},owner:x<0?0:1,type:1});
  for (const x of [-6,6]) for (const y of [-4,-2,0,2,4]) points.push({position:{x,y},owner:-1,type:1});
  const map={width:40,height:40,origins:[{x:-10,y:0},{x:10,y:0}],outposts:points,queens:[{owner:0,outpost:2},{owner:1,outpost:7}]};
  const m=evaluate(map);
  assert.equal(m.objective,0); assert.equal(m.minBorder,20); assert.equal(m.meanExpansion,4); assert.equal(m.meanMst,8);
  assert.deepEqual(m.territory,[10,10]);
});
test('selectors retain earliest ties, and territoryTie never worsens territory score', () => {
  const rows=[{seed:1,score:1,objective:.8},{seed:2,score:2,objective:.1},{seed:3,score:1,objective:.3},{seed:4,score:1,objective:.3}];
  assert.equal(choose(rows,'original').seed,1);
  assert.equal(choose(rows,'territoryTie').seed,3);
  assert.equal(choose(rows,'minimax').seed,2);
});
test('assignment experiments conserve five owned points and one queen per seat', () => {
  const map=originalMapCandidate(8,4308);
  for (const mode of ['reverse','roundRobin']) {
    const a=assign(map,mode);
    assert.equal(a.owners.filter(p=>p<0).length,40);
    for (let p=0;p<8;p++) {
      assert.equal(a.owners.filter(owner=>owner===p).length,5);
      assert.equal(a.owners[a.queens.find(q=>q.owner===p).outpost],p);
    }
  }
});
test('research baseline agrees with production selector and documented 4308 geometry', async () => {
  const rows=[];
  for(let seed=4300;seed<4800;seed++) {const m=originalMapCandidate(8,seed);if(m.valid)rows.push({seed,score:m.score});}
  const selected=choose(rows,'original'), production=await generateOriginalMap(8,4300);
  assert.equal(selected.seed,production.seed);
  const metric=evaluate(production,undefined,production.startingOutposts);
  assert.equal(metric.score,production.score);
  assert.ok(Math.abs(metric.minBorder-3.375617)<1e-5);
});
