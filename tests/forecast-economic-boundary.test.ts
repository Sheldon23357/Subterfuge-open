import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/fleet-scenario.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {RULES} from '../packages/rules/src/index.js';

test('native server prediction retains hidden factory phase and its effect on visible production',()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};
 cfg.positions={own:{x:0,y:0},hidden:{x:30,y:30},visible:{x:1,y:0},power:{x:35,y:35}};
 const base=cfg.economy.outposts[0]!;
 const capacity=RULES.GameParams.BaseElectricalOutput+RULES.OutpostParams.GeneratorElectricalOutput;
 cfg.economy.outposts=[
  {...base,id:'own',owner:0,productionProgress:0},
  {...base,id:'hidden',owner:1,drillers:capacity-1,productionProgress:47},
  {...base,id:'visible',owner:1,drillers:0,productionProgress:47},
  {...base,id:'power',owner:1,type:'generator',drillers:0,productionProgress:0},
 ];
 const a=createFleetScenario(cfg),b=structuredClone(a);
 b.economy.outposts[1]!.productionProgress=0;
 const ka=prepareForecastKnowledge(a,0),kb=prepareForecastKnowledge(b,0);
 assert.equal(ka.view.outposts.some(o=>o.id==='hidden'&&o.visibility===2),false);
 assert.equal(ka.view.outposts.some(o=>o.id==='visible'&&o.visibility===2),true);
 assert.deepEqual(ka.view,kb.view,'ordinary player observations must not expose hidden progress');
 assert.deepEqual(ka.publicIntel,kb.publicIntel);
 assert.notDeepEqual(ka.retainedWorld,kb.retainedWorld,'original internal prediction retains hidden outpost clocks');
 // Source ZOe keeps unknown outposts, including their economic clocks. This
 // is a reconstruction consistency counterexample, not a server oracle.
 for(const state of [a,b]){
  state.forecastPlayer=0;
  for(const id of ['hidden','power'])state.economy.outposts.find(o=>o.id===id)!.futureUnknown=true;
 }
 const nextA=advanceFleetScenario(a,101,true),nextB=advanceFleetScenario(b,101,true);
 assert.equal(nextA.economy.outposts[2]!.drillers,0,'earlier hidden production fills capacity');
 assert.ok(nextB.economy.outposts[2]!.drillers>0,'without that hidden batch visible production proceeds');
 const builtA=buildForecastWorld(ka),builtB=buildForecastWorld(kb);
 assert.equal(builtA.status,'conditional');
 assert.equal(builtB.status,'conditional');
 if(builtA.status!=='conditional'||builtB.status!=='conditional')return;
 assert.equal(advanceFleetScenario(builtA.state,101,true).economy.outposts[2]!.drillers,nextA.economy.outposts[2]!.drillers);
 assert.equal(advanceFleetScenario(builtB.state,101,true).economy.outposts[2]!.drillers,nextB.economy.outposts[2]!.drillers);
});
