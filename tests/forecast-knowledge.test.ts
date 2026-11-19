import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,prepareForecastKnowledge,buildForecastWorld,projectForecastResult,type FleetSetup,type Fleet} from '../packages/engine/src/index.js';
function setup():FleetSetup{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={a:{x:0,y:0},b:{x:20,y:0},c:{x:8,y:0}};
 cfg.economy.outposts.forEach((o,i)=>{o.id=['a','b','c'][i]!;o.owner=i===0?0:1;o.type='generator';o.drillers=100;o.shield=0;o.shieldMax=0;});return cfg;
}
test('own forecast runtime preserves phase-inclusive launch clocks without mutating the live world',()=>{
 const live=submitFleetOrder(createFleetScenario(setup()),{id:'own-sub',player:0,action:{kind:'launch',delaySeconds:600,source:'a',destination:'c',drillers:10}},500).state;
 const before=JSON.stringify(live),k=prepareForecastKnowledge(live,0),own=k.ownUnits.fleets[0]!;
 assert.equal(k.observedSeconds,500);assert.equal(own.secondsUntilLaunch,1100);assert.equal(own.destination,'c');
 own.previous.x=999;assert.equal(live.fleets[0]!.previous.x,0);assert.equal(JSON.stringify(live),before);
 assert.equal(prepareForecastKnowledge(advanceFleetScenario(live,101),0).ownUnits.fleets[0]!.secondsUntilLaunch,500);
});
test('server forecast retains visible foreign movement clocks and removes hidden fleet identities',()=>{
 let live=createFleetScenario(setup());live=submitFleetOrder(live,{id:'visible-enemy',player:1,action:{kind:'launch',delaySeconds:1200,source:'c',destination:'a',drillers:10}},200).state;
 live=submitFleetOrder(live,{id:'hidden-enemy',player:1,action:{kind:'launch',delaySeconds:1200,source:'b',destination:'c',drillers:10}},200).state;
 const k=prepareForecastKnowledge(live,0);
 assert.equal(k.visibleRuntime.fleets.find(f=>f.id==='visible-enemy')!.secondsUntilLaunch,1400);
 assert.equal(k.ownUnits.fleets.length,0);assert.equal(JSON.stringify(k).includes('hidden-enemy'),false);
 assert.equal(k.visibleRuntime.fleets.length,1);
});
test('retained economics stay inside the server boundary and projected unknown posts remain unknown',()=>{
 const live=createFleetScenario(setup()),k=prepareForecastKnowledge(live,0),built=buildForecastWorld(k);assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(k.retainedWorld.outposts.find(p=>p.id==='b')!.drillers,100);assert.deepEqual(k.unknownOutposts,['b']);
 const future=advanceFleetScenario(built.state,110,true),result=projectForecastResult(k,future),hidden=result.outposts.find(p=>p.id==='b')!;
 assert.equal(hidden.owner,1);for(const key of ['drillers','metrics','retainedWorld','commands'])assert.equal(key in hidden,false);
 assert.equal('retainedWorld'in result,false);assert.equal('commands'in result,false);
 assert.throws(()=>saveFleetSnapshot(built.state),/Prediction/);assert.throws(()=>advanceFleetScenario(built.state,111),/Prediction/);
});
test('hidden fleet changes may change public aggregates without exposing private locations',()=>{
 const live=createFleetScenario(setup()),before=prepareForecastKnowledge(live,0),other=structuredClone(live);
 other.fleets.push({id:'secret-sub',slot:128,used:true,owner:1,drillers:50,source:'b',destination:'b',position:{x:20,y:0},previous:{x:20,y:0},state:'waiting',secondsUntilLaunch:1200,fractionMoved:0,gift:false,giftSeconds:0} as Fleet);
 const after=prepareForecastKnowledge(other,0);assert.equal(JSON.stringify(after).includes('secret-sub'),false);
 assert.equal(after.publicIntel[1]!.drillers-before.publicIntel[1]!.drillers,50);assert.deepEqual(after.view.fleets,before.view.fleets);
});
test('arrival at an unknown post is unresolved, cannot establish a capture, and cannot be saved as reality',()=>{
 const cfg=setup();cfg.positions.c={x:.3,y:0};
 let live=createFleetScenario(cfg);live=submitFleetOrder(live,{id:'scout',player:0,action:{kind:'launch',source:'a',destination:'c',drillers:10}}).state;
 live.economy.outposts.find(p=>p.id==='c')!.futureUnknown=true;
 const before=JSON.stringify(live),future=advanceFleetScenario(live,130,true),events=future.events.filter(e=>e.subject==='scout');
 assert.equal(events.filter(e=>e.kind==='future-unknown-arrival').length,1);assert.ok(!events.some(e=>e.kind==='battle'));
 assert.equal(future.economy.outposts.find(p=>p.id==='c')!.owner,1);assert.equal(future.fleets.find(f=>f.id==='scout')!.used,false);
 assert.equal(JSON.stringify(live),before);assert.throws(()=>saveFleetSnapshot(future),/Prediction/);
});
