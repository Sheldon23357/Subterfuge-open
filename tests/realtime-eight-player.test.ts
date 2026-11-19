import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {startRealtime,catchUpRealtime,TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
import {saveRoom,restoreRoom} from '../packages/server/src/planning.js';

test('eight-player original map advances continuously for ten simulated days with exactly-once scheduled orders',async()=>{
  const epoch=1_800_000_000_000;
  let room=startRealtime(await createGeneratedRoom(8,4300,'original'),epoch);
  for(let player=0;player<8;player++){
    const owned=room.state.economy.outposts.filter(o=>o.owner===player);
    const source=owned.find(o=>o.drillers>=10)!;
    const target=owned.find(o=>o.id!==source.id)!;
    room=scheduleOrder(room,{order:{id:`launch-${player}`,player,action:{kind:'launch',source:source.id,destination:target.id,drillers:10}},issueTick:10});
    for(let tick=100;tick<=1400;tick+=100)
      room=scheduleOrder(room,{order:{id:`check-${player}-${tick}`,player,action:{kind:'check-in'}},issueTick:tick});
  }
  // Different service polling intervals exercise the same live wall-clock anchor.
  const intervals=[1,7,13,29];let tick=0,iteration=0;
  while(tick<1440){
    tick=Math.min(1440,tick+intervals[iteration++%intervals.length]!);
    room=await catchUpRealtime(room,epoch+tick*TICK_MILLISECONDS);
    assert.equal(room.state.economy.tick,tick);
    assert.equal(room.state.economy.players.filter(p=>p.active).length,8);
    assert.ok(room.scheduledOrders!.every(p=>p.issueTick>tick||p.status==='executed'));
    assert.equal(await catchUpRealtime(room,epoch+tick*TICK_MILLISECONDS),room);
    for(const outpost of room.state.economy.outposts){
      assert.ok(Number.isFinite(outpost.drillers)&&outpost.drillers>=0);
      assert.ok(Number.isFinite(outpost.shield)&&outpost.shield>=0);
    }
  }
  assert.equal(room.scheduledOrders!.length,120);
  for(const plan of room.scheduledOrders!)
    assert.equal(room.state.commands.filter(c=>c.id===plan.id).length,1,plan.id);
  assert.equal(new Set(room.state.commands.map(c=>c.id)).size,room.state.commands.length);
  // Validate the current persisted representation, without simulating an outage.
  assert.deepEqual(restoreRoom(saveRoom(room)),room);
});
