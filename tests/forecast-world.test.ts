import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,type FleetSetup} from '../packages/engine/src/fleet-scenario.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {originalPruneForecast} from '../packages/engine/src/original-forecast.generated.js';
const setup=()=>JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
const outposts=(s:ReturnType<typeof createFleetScenario>)=>s.economy.outposts.map(o=>({...o,destroyed:o.destroyed??false}));
test('verbatim original pruning retains visible foreign runtime rather than applying an ownership filter',()=>{
 const list=<T>(items:T[])=>({count:items.length,get:(i:number)=>items[i]!});
 const fleet={used:true,ownerIndex:1,secsUntilLaunch:1050,secsUntilGifting:700,prevSecsUntilLaunch:850};
 const base={futureUnknown:false,ticksSinceLastDrillerProduction:47,private_secsUntilMineCreation:950};
 const before=structuredClone({fleet,base});
 originalPruneForecast({info:{maxPlayerCount:2},world:{specialists:list([]),subs:list([fleet]),outposts:list([base]),
  destroySub:()=>assert.fail('visible enemy removed'),destroySpecialist:()=>assert.fail('visible enemy removed')}},()=>2);
 assert.deepEqual({fleet,base},before);
});
test('restricted bootstrap preserves visible foreign late launch timing and visible economic progress',()=>{
 const cfg=setup();const source=cfg.economy.outposts[1]!.id,target=cfg.economy.outposts[0]!.id;
 const live=submitFleetOrder(createFleetScenario(cfg),{id:'enemy-sub',player:1,action:{kind:'launch',delaySeconds:600,source,destination:target,drillers:7}},450).state;
 const before=JSON.stringify(live),knowledge=prepareForecastKnowledge(live,0),built=buildForecastWorld(knowledge);
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(built.state.fleets[0]!.secondsUntilLaunch,1050);
 assert.equal(built.state.secondsSinceLastTick,0);
 const future=advanceFleetScenario(built.state,104,true),reference=advanceFleetScenario(live,104,true);
 assert.deepEqual(outposts(future),outposts(reference));
 assert.deepEqual(future.fleets,reference.fleets.map(f=>({...f,})));
 assert.equal(JSON.stringify(live),before);
 assert.throws(()=>saveFleetSnapshot(built.state),/prediction|forecast/i);
 built.state.fleets[0]!.position.x=999;assert.notEqual(knowledge.visibleRuntime.fleets[0]!.position.x,999);
});
test('native hidden economic clocks stay server-side',()=>{
 const cfg=setup();cfg.size={width:80,height:80};cfg.positions[cfg.economy.outposts[1]!.id]={x:30,y:30};
 cfg.positions[cfg.economy.outposts[2]!.id]={x:35,y:35};
 const live=createFleetScenario(cfg),a=prepareForecastKnowledge(live,0);
 live.economy.outposts[1]!.miningProgress=987;
 assert.deepEqual(prepareForecastKnowledge(live,0).view,a.view);
 const result=buildForecastWorld(a);assert.equal(result.status,'conditional');if(result.status!=='conditional')return;
 assert.equal(result.state.economy.outposts[1]!.futureUnknown,true);
 assert.equal(result.state.economy.outposts[1]!.miningProgress,a.retainedWorld.outposts[1]!.miningProgress);
 assert.ok(result.assumptions.some(s=>s.includes('retained only inside the server')));
 assert.throws(()=>advanceFleetScenario(result.state,101),/Prediction/);

});
