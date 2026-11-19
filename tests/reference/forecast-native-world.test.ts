import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,prepareForecastKnowledge,buildForecastWorld,projectForecastResult,type FleetSetup} from '../../packages/engine/src/index.js';
import {scheduleOrder,launchSlot} from '../../packages/server/src/scheduled-orders.js';
import {advanceRoom,type LabRoom} from '../../packages/server/src/planning.js';
import {simulatePlayerFuture} from '../../packages/server/src/player-forecast.js';
const reference=await import(new URL('../../../scripts/reference-functions.mjs',import.meta.url).href);
function setup():FleetSetup{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={own:{x:0,y:0},hidden:{x:30,y:30},visible:{x:1,y:0},power:{x:35,y:35}};
 const base=cfg.economy.outposts[0]!;
 cfg.economy.outposts=[{...base,id:'own',owner:0,drillers:100,productionProgress:47},
  {...base,id:'hidden',owner:1,drillers:199,productionProgress:47},
  {...base,id:'visible',owner:1,drillers:0,productionProgress:47},
  {...base,id:'power',owner:1,type:'generator',drillers:0,productionProgress:0}];
 return cfg;
}
test('retained hidden economics agree with independently executed original p3e across every tick',()=>{
 const original=reference.readReference();
 for(const phase of [0,47])for(const start of [0,72,100]){
  const cfg=setup();cfg.economy.initialTick=start;cfg.economy.outposts[1]!.productionProgress=phase;
  const live=createFleetScenario(cfg),before=JSON.stringify(live),k=prepareForecastKnowledge(live,0),built=buildForecastWorld(k);
  assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
  // This server branch retains authoritative hidden economics. The original
  // client future flag deliberately disables foreign capacity enforcement,
  // so compare the retained state with the original ordinary world update.
  const expected=reference.runReferenceEconomy(original,cfg.economy,80);
  let actual=built.state;
  for(const tick of expected){
   actual=advanceFleetScenario(actual,actual.economy.tick+1,true);
   assert.deepEqual(actual.economy.outposts.map(o=>({type:{factory:1,generator:2,mine:0}[o.type],drillers:o.drillers,shield:o.shield,
    productionProgress:o.productionProgress,miningProgress:o.miningProgress,shieldProgress:o.shieldProgress})),tick.outposts,`start=${start},phase=${phase},tick=${actual.economy.tick}`);
   const out=projectForecastResult(k,actual),unknown=out.outposts.find(o=>o.id==='hidden')!;
   assert.equal('owner'in unknown,true);assert.equal('drillers'in unknown,false);assert.equal('metrics'in unknown,false);
   assert.equal('retainedWorld'in out,false);
  }
  assert.equal(JSON.stringify(live),before);
 }
});
