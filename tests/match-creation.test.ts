import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchCreation,roomFromMap} from '../packages/server/src/generated-room.js';
import {generateOriginalMap,submitFleetOrder} from '../packages/engine/src/index.js';
import {saveRoom,restoreRoom} from '../packages/server/src/planning.js';

test('creation keeps individual modes and rejects all team options before generation',()=>{
  assert.deepEqual(matchCreation(8),{mode:'mining',teamSize:0,neptuniumGoal:200});
  assert.deepEqual(matchCreation(8,{mode:'domination',teamSize:0}),{mode:'domination',teamSize:0,neptuniumGoal:200});
  for(let players=2;players<=10;players++)for(let teamSize=1;teamSize<=players;teamSize++)assert.throws(()=>matchCreation(players,{teamSize}),/不开放组队/);
  for(const raw of [null,{mode:'anything'},{teamSize:1},{teamSize:3},{teamSize:8},{neptuniumGoal:0},{neptuniumGoal:2.5},{neptuniumGoal:100001},{unknown:true}])assert.throws(()=>matchCreation(8,raw));
});

test('created individual domination room retains its rule choices through a save and prohibits mining',async()=>{
  const map=await generateOriginalMap(4,4300);
  assert.throws(()=>roomFromMap(map,{mode:'domination',teamSize:2}),/不开放组队/);
  const r=roomFromMap(map,{mode:'domination',teamSize:0,neptuniumGoal:300});
  assert.equal(r.state.initial.match!.mode,'domination');assert.equal(r.state.economy.initial.teamSize,0);
  const owned=r.state.economy.outposts.find(o=>o.owner===0)!;
  assert.throws(()=>submitFleetOrder(r.state,{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:owned.id}}),/disabled/);
  assert.deepEqual(restoreRoom(saveRoom(r)),r);
  const mining=roomFromMap(map,{mode:'mining',neptuniumGoal:350});
  assert.equal(mining.state.initial.match!.neptuniumGoal,350);
});
