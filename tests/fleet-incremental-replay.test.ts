import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,replayFleetScenario,exportFleetReplay,type FleetSetup} from '../packages/engine/src/index.js';
import {readActivity} from '../packages/engine/src/notification-journal.js';
const fresh=()=>createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup);
test('verified prefix replay retains activity and exactly matches full replay after same-tick writes and advances',()=>{
 const start=fresh(),base=restoreFleetSnapshot(saveFleetSnapshot(start));
 let next=submitFleetOrder(start,{id:'incremental-off',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state;
 next=advanceFleetScenario(next,next.economy.tick+3);
 const text=saveFleetSnapshot(next),resumed=restoreFleetSnapshot(text,{trustedLocalStorage:true,verifiedReplayBase:base}),full=restoreFleetSnapshot(text);
 assert.deepEqual(resumed,full);assert.deepEqual(readActivity(resumed,0),readActivity(full,0));assert.deepEqual(base,start);
 const sameTick=submitFleetOrder(resumed,{id:'incremental-on',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true}}).state;
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(sameTick),{trustedLocalStorage:true,verifiedReplayBase:resumed}),restoreFleetSnapshot(saveFleetSnapshot(sameTick)));
});
test('cached replay continues to reject changed expected state and malformed appended commands',()=>{
 const base=restoreFleetSnapshot(saveFleetSnapshot(fresh())),raw=JSON.parse(saveFleetSnapshot(base));
 raw.expected.economy.outposts[0].drillers++;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(raw),{trustedLocalStorage:true,verifiedReplayBase:base}),/disagree/);
 const bad=JSON.parse(saveFleetSnapshot(base));bad.replay.commands.push({id:'bad',player:0,tick:base.economy.tick,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true},extra:true});
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(bad),{trustedLocalStorage:true,verifiedReplayBase:base}));
});
test('different command prefixes and rewind targets use full replay; observers still receive complete history',()=>{
 const initial=fresh(),changed=submitFleetOrder(initial,{id:'other-prefix',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state;
 const base=advanceFleetScenario(changed,changed.economy.tick+3),text=saveFleetSnapshot(initial);
 assert.deepEqual(restoreFleetSnapshot(text,{trustedLocalStorage:true,verifiedReplayBase:base}),initial);
 const target=advanceFleetScenario(initial,initial.economy.tick+5),ticks:number[]=[];
 replayFleetScenario(exportFleetReplay(target),{trustedLocalStorage:true,verifiedReplayBase:base},s=>ticks.push(s.economy.tick));
 assert.equal(ticks[0],initial.economy.tick);assert.equal(ticks.at(-1),target.economy.tick);
});
