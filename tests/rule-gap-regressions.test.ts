import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {outpostMetrics} from '../packages/server/src/inspection.js';
function setup():FleetSetup{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.positions={a:{x:0,y:0},b:{x:.3,y:0},c:{x:.6,y:0}};
 cfg.economy.outposts.forEach((o,i)=>Object.assign(o,{id:['a','b','c'][i],owner:i===0?0:1,type:'generator',drillers:i===0?100:5,shield:0,shieldMax:0,productionProgress:0}));return cfg;
}
test('ordinary production metrics agree with actual factory settlement',()=>{
 const cfg=setup();Object.assign(cfg.economy.outposts[0]!,{type:'factory',drillers:0});
 const state=createFleetScenario(cfg),metrics=outpostMetrics(state,'a');
 assert.equal(metrics.cycleMinutes,480);assert.equal(metrics.output,6);assert.equal(metrics.nextMinutes,480);
 assert.equal(advanceFleetScenario(state,148).economy.outposts[0]!.drillers,metrics.output);
});
test('factory settlement shares one capacity budget in outpost array order',()=>{
 const cfg=setup();Object.assign(cfg.economy.outposts[0]!,{type:'factory',drillers:147,productionProgress:47});
 Object.assign(cfg.economy.outposts[2]!,{type:'factory',owner:0,drillers:0,productionProgress:47});
 const state=advanceFleetScenario(createFleetScenario(cfg),101);
 assert.equal(state.economy.outposts[0]!.drillers,150);assert.equal(state.economy.outposts[2]!.drillers,0);
 assert.equal(state.economy.outposts[2]!.productionProgress,47);
});
test('cancelling a waiting transport restores troops without refilling shields',()=>{
 const cfg=setup();cfg.economy.outposts[0]!.shieldMax=20;cfg.economy.outposts[0]!.shield=3;
 let state=createFleetScenario(cfg);
 state=submitFleetOrder(state,{id:'wait',player:0,action:{kind:'launch',delaySeconds:600,source:'a',destination:'b',drillers:10}}).state;
 state=submitFleetOrder(state,{id:'cancel',player:0,action:{kind:'cancel-launch',fleetId:'wait'}}).state;
 assert.equal(state.economy.outposts[0]!.shield,3);assert.equal(state.economy.outposts[0]!.drillers,100);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
});
