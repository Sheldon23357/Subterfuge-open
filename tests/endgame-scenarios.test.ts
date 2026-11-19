import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unlink} from 'node:fs/promises';
import {createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {chooseEndgameScenario,scenarioMessages,scenarioMemory} from '../packages/server/src/endgame-scenarios.js';
import {restoreRoom,saveRoom} from '../packages/server/src/planning.js';
import {ChatStore} from '../packages/server/src/chat.js';

test('fixed endgame selection is deterministic and produces a non-zero starting tick',async()=>{
 const a=await createGeneratedRoom(4,100,'quantity-priority',{},'endgame');
 const b=await createGeneratedRoom(4,100,'quantity-priority',{},'endgame');
 assert.deepEqual(a.scenario,b.scenario);
 assert.equal(a.state.economy.tick,a.scenario!.startTick);
 assert.equal(a.state.economy.tick,a.state.initial.economy.initialTick);
 assert.equal(a.state.economy.players.every(p=>p.active),true);
 assert.equal(JSON.stringify(a.state).includes('game-ended'),false);
 assert.ok(a.state.economy.outposts.some(o=>o.owner===0));
 assert.ok(a.state.fleets.length>0);
 const restored=restoreRoom(saveRoom(a));
 assert.deepEqual(restored.scenario,a.scenario);
 assert.equal(restored.state.economy.tick,a.state.economy.tick);
});

test('scenario transcript is filtered to active seats and can seed the chat store',async()=>{
 const room=await createGeneratedRoom(3,1,'quantity-priority',{},'endgame');
 const messages=scenarioMessages(room.scenario!.id,3);
 assert.ok(messages.length>0);
 assert.ok(messages.every(m=>m.from<3&&(m.to===null||(Array.isArray(m.to)?m.to.every(p=>p<3):m.to<3))));
 const path=join(tmpdir(),`subterfuge-chat-${process.pid}-${Date.now()}.json`),store=new ChatStore(path);
 await store.seed(messages);
 assert.deepEqual(store.listForSeat(0),messages.filter(m=>m.to===null||m.from===0||Array.isArray(m.to)&&m.to.includes(0)||m.to===0));
 await unlink(path).catch(()=>{});
});

test('scenario memory is private per seat and selection spans the fixed catalog',()=>{
 const ids=new Set([1,2,3,4,5,6,7,8,9,10].map(seed=>chooseEndgameScenario(seed,8).id));
 assert.ok(ids.size>=2);
 const memory=scenarioMemory('broken-truce',0,4);
 assert.ok(memory?.agreements.includes('14'));
 assert.ok(!JSON.stringify(memory).includes('scenario-expansion'));
});
