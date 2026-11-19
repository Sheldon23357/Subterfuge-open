import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,exportFleetReplay,replayFleetScenario,
 saveFleetSnapshot,restoreFleetSnapshot,projectHistoricalSonar,projectPlayerView,prepareForecastKnowledge,buildForecastWorld,type FleetSetup} from '../packages/engine/src/index.js';
const setup=()=>JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

test('replay observer samples after zero-second commands and before phase-positive commands exactly once',()=>{
 const cfg=setup(),id=cfg.economy.outposts[0]!.id;
 let state=advanceFleetScenario(createFleetScenario(cfg),101);
 state=submitFleetOrder(state,{id:'zero',player:0,action:{kind:'set-shields',outpostId:id,enabled:false}},0).state;
 state=submitFleetOrder(state,{id:'phase',player:0,action:{kind:'set-shields',outpostId:id,enabled:true}},250).state;
 state=advanceFleetScenario(state,103);
 const frames:{tick:number;commands:string[]}[]=[];
 const restored=replayFleetScenario(exportFleetReplay(state),{},s=>frames.push({tick:s.economy.tick,commands:s.commands.map(c=>c.id)}));
 assert.deepEqual(frames,[{tick:100,commands:[]},{tick:101,commands:['zero']},{tick:102,commands:['zero','phase']},{tick:103,commands:['zero','phase']}]);
 assert.deepEqual(restored,state);
});

test('catch-up and snapshot restart retain actual sonar contact after the fleet has left sight',()=>{
 const cfg=setup();cfg.size={width:80,height:80};
 cfg.positions[cfg.economy.outposts[1]!.id]={x:12,y:0};cfg.positions[cfg.economy.outposts[2]!.id]={x:-12,y:0};
 const launched=submitFleetOrder(createFleetScenario(cfg),{id:'cross-sonar',player:1,action:{kind:'launch',source:cfg.economy.outposts[1]!.id,destination:cfg.economy.outposts[2]!.id,drillers:10}}).state;
 assert.equal(projectPlayerView(launched,0).fleets.length,0);
 const caughtUp=advanceFleetScenario(launched,1000),before=JSON.stringify(caughtUp);
 assert.equal(projectPlayerView(caughtUp,0).fleets.length,0);
 const history=projectHistoricalSonar(caughtUp,0);
 assert.equal(history.length,1);assert.equal(history[0]!.fleetId,'cross-sonar');
 assert.ok(history[0]!.tick>100&&history[0]!.tick<1000);
 assert.equal(history[0]!.multiple,false);
 assert.deepEqual(projectHistoricalSonar(caughtUp,1),[],'owners receive no sonar contact for their own fleet');
 assert.deepEqual(projectHistoricalSonar(restoreFleetSnapshot(saveFleetSnapshot(caughtUp)),0),history);
 history[0]!.position.x=999;assert.notEqual(projectHistoricalSonar(caughtUp,0)[0]!.position.x,999);
 assert.equal(JSON.stringify(caughtUp),before);
 const built=buildForecastWorld(prepareForecastKnowledge(launched,0));
 assert.equal(built.status,'conditional');if(built.status==='conditional')assert.throws(()=>projectHistoricalSonar(built.state,0),/Prediction/);
});

