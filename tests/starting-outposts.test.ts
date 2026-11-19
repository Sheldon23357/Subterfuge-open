import test from 'node:test';
import assert from 'node:assert/strict';
import {hasBalancedStartingOutposts,hasGameplayMapComposition,applyGameplayMapComposition, originalMapCandidate} from '../packages/engine/src/index.js';
import {createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {saveRoom,restoreRoom} from '../packages/server/src/planning.js';

test('gameplay excludes the four-generator start without changing the original candidate', () => {
  const candidate = originalMapCandidate(4, 4479);
  assert.equal(candidate.valid, true);
  assert.equal(candidate.outposts.filter(o => o.owner === 0 && o.type === 2).length, 4);
  assert.equal(hasBalancedStartingOutposts(candidate), false);
  for (const generators of [2, 3]) {
    const balanced = structuredClone(candidate);
    for (let player = 0; player < 4; player++) {
      balanced.outposts.filter(o => o.owner === player)
        .forEach((o, i) => {o.type = i < generators ? 2 : 1;});
    }
    assert.equal(hasBalancedStartingOutposts(balanced), true);
    balanced.outposts.find(o => o.owner === 0 && o.type === 2)!.type = 1;
    assert.equal(hasBalancedStartingOutposts(balanced), false);
  }
});

for (const mode of ['original', 'quantity-priority'] as const)
  for (let players = 2; players <= 10; players++)
    test(`${mode} new ${players}-seat room gives every player the same 2/3 starting mix`, async () => {
      const room = await createGeneratedRoom(players, 4300, mode);
      const allPosts=room.state.initial.economy.outposts;
      assert.equal(allPosts.filter(o=>o.type==='generator').length,Math.floor((allPosts.length*45+50)/100));
      assert.equal(room.map!.composition,'generator-45-v1');
      assert.deepEqual(restoreRoom(saveRoom(room)),room);
      const counts = Array.from({length: players}, (_, player) => {
        const owned = room.state.initial.economy.outposts.filter(o => o.owner === player);
        const generators = owned.filter(o => o.type === 'generator').length;
        const factories = owned.filter(o => o.type === 'factory').length;
        assert.equal(owned.length, 5);
        assert.ok(generators === 2 || generators === 3);
        assert.equal(factories, 5 - generators);
        return generators;
      });
      assert.equal(new Set(counts).size, 1);
      const candidate = originalMapCandidate(players, room.map!.seed);
      assert.equal(candidate.valid, true);
      assert.equal(hasBalancedStartingOutposts(candidate), true);
      assert.deepEqual(room.state.initial.economy.outposts.map(o => o.type),
        applyGameplayMapComposition(candidate,room.map!.seed).outposts.map(o => o.type === 2 ? 'generator' : 'factory'));
      assert.deepEqual(room.state.initial.economy.outposts.filter(o=>o.owner!==null).map(o=>o.type),candidate.outposts.filter(o=>o.owner>=0).map(o=>o.type===2?'generator':'factory'));
    });


test('gameplay composition accepts the nearest integer to forty-five percent and rejects neighboring counts',()=>{
 const candidate=originalMapCandidate(4,4479);
 const map=structuredClone(candidate);
 for(let player=0;player<4;player++)map.outposts.filter(p=>p.owner===player).forEach((p,i)=>{p.type=i<2?2:1;});
 const neutral=map.outposts.filter(p=>p.owner<0);
 for(const generators of [8,9,10,11]){
  neutral.forEach((p,i)=>{p.type=i<generators?2:1;});
  assert.equal(hasGameplayMapComposition(map),generators===10);
 }
 assert.equal(candidate.outposts.filter(p=>p.owner===0&&p.type===2).length,4);
});


test('45 percent neutral allocation is deterministic, leaves geometry and starting buildings intact, and does not mutate raw candidates',()=>{
 const changes=new Set<number>();
 for(let seed=4300;seed<4400;seed++){
  const raw=originalMapCandidate(8,seed);if(!raw.valid||!hasBalancedStartingOutposts(raw))continue;
  const before=structuredClone(raw),map=applyGameplayMapComposition(raw,seed);
  assert.deepEqual(raw,before);assert.deepEqual(applyGameplayMapComposition(raw,seed),map);
  assert.equal(hasGameplayMapComposition(map),true);assert.equal(map.outposts.filter(p=>p.type===2).length,36);
  assert.deepEqual(map.origins,raw.origins);assert.deepEqual(map.startingOutposts,raw.startingOutposts);
  assert.deepEqual(map.outposts.map(p=>[p.position,p.owner,p.shield,p.shieldMax,p.drillers,p.meantForPlayer]),raw.outposts.map(p=>[p.position,p.owner,p.shield,p.shieldMax,p.drillers,p.meantForPlayer]));
  assert.deepEqual(map.outposts.filter(p=>p.owner>=0),raw.outposts.filter(p=>p.owner>=0));
  changes.add(raw.outposts.filter(p=>p.type===2).length-36);
 }
 assert.ok([...changes].some(n=>n<0));assert.ok([...changes].some(n=>n>0));
});


test('composition version is saved and unknown composition metadata is rejected',async()=>{
 const room=await createGeneratedRoom(2,4300),raw=JSON.parse(saveRoom(room));
 assert.equal(raw.map.composition,'generator-45-v1');raw.map.composition='unknown';
 assert.throws(()=>restoreRoom(JSON.stringify(raw)),/地图元数据/);
});
