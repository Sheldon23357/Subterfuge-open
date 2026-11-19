import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,exportFleetReplay,replayFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
function setup(){const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 return cfg;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
test('private replay equals immutable live execution across fractional orders and ticks without borrowing input arrays',()=>{
 const cfg=setup();let s=createFleetScenario(cfg);
 const launch={id:'depart',player:0,action:{kind:'launch' as const,source:'蓝方工厂',destination:'红方后方',drillers:20,}};
 const original=JSON.stringify(s);s=submitFleetOrder(s,launch,300).state;
 launch.action.drillers=99;assert.equal(s.commands[0]!.action.kind==='launch'?s.commands[0]!.action.drillers:0,20);
 assert.equal(JSON.stringify(createFleetScenario(cfg)),original);
 s=advanceFleetScenario(s,101);s=submitFleetOrder(s,{id:'shields',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}},301).state;
 s=advanceFleetScenario(s,102);s=submitFleetOrder(s,{id:'return',player:0,action:{kind:'return-fleet',fleetId:'depart'}},200).state;
 s=advanceFleetScenario(s,108);
 const replay=freeze(exportFleetReplay(s)),input=JSON.stringify(replay),restored=replayFleetScenario(replay);
 assert.deepEqual(restored,s);assert.equal(JSON.stringify(replay),input);
 const action=restored.commands[0]!.action;if(action.kind==='launch')action.drillers=999;
 assert.equal(JSON.stringify(replay),input);
});
test('late failure in private replay cannot mutate the caller history or a caller-owned live world',()=>{
 const initial=createFleetScenario(setup()),before=JSON.stringify(initial),replay=exportFleetReplay(initial);
 replay.commands=[{id:'valid',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:20},tick:100},
 {id:'invalid',player:1,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},tick:101}];replay.targetTick=102;
 const frozen=freeze(replay),text=JSON.stringify(frozen);
 assert.throws(()=>replayFleetScenario(frozen),/owned/);assert.equal(JSON.stringify(frozen),text);assert.equal(JSON.stringify(initial),before);
 assert.throws(()=>submitFleetOrder(initial,{id:'bad-live',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:99999}}));
 assert.equal(JSON.stringify(initial),before);
});
