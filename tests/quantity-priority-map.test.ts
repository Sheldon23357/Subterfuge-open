import test from 'node:test';
import assert from 'node:assert/strict';
import {generateQuantityPriorityMap,generateOriginalMap,originalMapCandidate,compareTerritoryCounts,quantityPriorityMetrics} from '../packages/engine/src/index.js';
import {roomFromMap,createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {advanceRoom,saveRoom,restoreRoom} from '../packages/server/src/planning.js';

// Frozen results from the independently implemented research selector, before
// production integration. Same default window, 2..10 players.
const researchSeeds=[4426,4539,4479,4662,4743,4634,4599,4324,4742];
for(let players=2;players<=10;players++)test(`quantity-first selection ${players} players matches research and preserves original minimum range`,async()=>{
  const map=await generateQuantityPriorityMap(players,4300);
  const original=await generateOriginalMap(players,4300);
  assert.equal(map.seed,researchSeeds[players-2]);
  assert.equal(map.score,original.score);
  const baseline=quantityPriorityMetrics(originalMapCandidate(players,original.seed));
  assert.ok(compareTerritoryCounts(map.selection.territoryCounts,baseline.territoryCounts)<=0);
  assert.equal(map.selection.territoryCounts.reduce((a,b)=>a+b,0),players*10);
  const candidate=originalMapCandidate(players,map.seed);
  assert.deepEqual(map.outposts,candidate.outposts);
  assert.deepEqual(map.startingOutposts,candidate.startingOutposts);
  assert.deepEqual(map.selection,quantityPriorityMetrics(candidate));
  assert.deepEqual(restoreRoom(saveRoom(advanceRoom(roomFromMap(map),2))).map,roomFromMap(map).map);
});
test('quantity priority, deterministic ties, yielding, boundaries and invalid inputs',async()=>{
  assert.ok(compareTerritoryCounts([9,10,10,10,10,11],[9,9,10,10,11,11])<0);
  assert.equal(compareTerritoryCounts([11,9,10],[9,10,11]),0);
  let yielded=0;
  const a=await generateQuantityPriorityMap(2,4300,async()=>{yielded++;});
  assert.equal(yielded,50);
  assert.deepEqual(await generateQuantityPriorityMap(2,4300),a);
  const edge=await generateQuantityPriorityMap(2,0xffffffff-499);
  assert.ok(edge.seed<=0xffffffff);
  for(const seed of [-1,1.5,NaN,Infinity,0xffffffff-498])await assert.rejects(generateQuantityPriorityMap(8,seed));
  for(const n of [1,11,2.5,NaN])await assert.rejects(generateQuantityPriorityMap(n,4300));
});
test('new rooms default to optimized; legacy snapshots stay original; malformed selection rejected',async()=>{
  const room=await createGeneratedRoom(2,4300);
  assert.equal(room.map!.algorithm,'quantity-priority-v1');
  const original=await createGeneratedRoom(2,4300,'original');
  assert.equal(original.map!.algorithm,'apk12075-rules4300');
  assert.equal(original.map!.selection,undefined);
  assert.deepEqual(restoreRoom(saveRoom(original)),original);
  await assert.rejects(createGeneratedRoom(2,4300,'unknown' as 'original'));
  for(const corrupt of [undefined,{territoryCounts:[9,10],geometryScore:0},{territoryCounts:[10,10],geometryScore:-1},{territoryCounts:[10],geometryScore:0}]){
    const raw=JSON.parse(saveRoom(room));raw.map.selection=corrupt;
    assert.throws(()=>restoreRoom(JSON.stringify(raw)),/地图筛选摘要/);
  }
});
