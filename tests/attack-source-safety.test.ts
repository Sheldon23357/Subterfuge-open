import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes,forecastKnownObservation} from '../packages/prediction/src/index.js';
import {screenAttacks} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackTargetContext} from '../packages/ai/src/controller/analysis/attack-target-context.js';
function fixture(drillers=0){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const base=cfg.economy.outposts[2]!;
 cfg.economy.outposts=[{...base,id:'home',owner:0,drillers:30},{...base,id:'target',owner:1,drillers:0},{...base,id:'enemy',owner:1,drillers}];
 cfg.positions={home:{x:0,y:0},target:{x:1,y:0},enemy:{x:0,y:.2}};
 return createFleetScenario(cfg);
}
const see=(state:ReturnType<typeof fixture>)=>observation({state,scheduled:[]},0,'source-safety');
test('observed incoming troops remain in source safety and joint forecast reproduces an exposed source loss',()=>{
 let state=submitFleetOrder(fixture(15),{id:'raid',player:1,action:{kind:'launch',delaySeconds:600,source:'enemy',destination:'home',drillers:15}}).state;
 state=advanceFleetScenario(state,102);
 const o=see(state),before=JSON.stringify(o),report=screenAttacks(o,attackRoutes(o));
 const source=report.sourceReserves.find(p=>p.id==='home')!,incoming=source.defense.threats.find(t=>!t.estimated)!;
 assert.equal(incoming.force,15);assert.ok(source.reserve>0);assert.ok(source.available<30);
 const summary=attackTargetContext(report,o).sourceSafety!.find(p=>p.source==='home')!;
 assert.equal(summary.incoming?.[0]?.force,15);
 const action={kind:'launch' as const,source:'home',destination:'target',drillers:30};
 const forecast=forecastKnownObservation(o,130,[{id:'attack',issueTick:o.view.tick,action}]);
 const actual=advanceFleetScenario(submitFleetOrder(state,{id:'attack',player:0,action}).state,130);
 assert.equal(forecast.status,'conditional');
 if(forecast.status==='conditional')assert.equal(forecast.result.outposts.find(p=>p.id==='home')!.owner,actual.economy.outposts.find(p=>p.id==='home')!.owner);
 assert.notEqual(actual.economy.outposts.find(p=>p.id==='home')!.owner,0);assert.equal(JSON.stringify(o),before);
});
test('unknown incoming ETA cannot be converted into a known reserve calculation',()=>{
 const o=see(fixture()),routes=attackRoutes(o);
 o.view.fleets.push({id:'incoming',owner:1,state:'moving',position:{x:0,y:.1},drillers:12,gift:false,destination:{kind:'outpost',id:'home'}});
 const source=screenAttacks(o,routes).sourceReserves[0]!;
 assert.equal(source.defense.threats[0]!.ticks,null);assert.equal(source.defense.uncertain,true);
 assert.ok(source.defense.forecastReasons.includes('unknown-information'));
 routes.fleetTicks.incoming=0;
 const known=screenAttacks(o,routes).sourceReserves[0]!;
 assert.equal(known.defense.threats[0]!.ticks,0);assert.equal(known.defense.uncertain,false);assert.deepEqual(known.defense.forecastReasons,['observed-incoming']);assert.ok(known.reserve>=12);
});
test('known empty enemy outposts and unknown potential sorties stay separate from actual incoming',()=>{
 const o=see(fixture()),routes=attackRoutes(o);
 const known=screenAttacks(o,routes).sourceReserves[0]!;
 assert.ok(!known.defense.threats.some(t=>t.id==='enemy'));
 const enemy=o.view.outposts.find(p=>p.id==='enemy')!;delete enemy.drillers;delete enemy.shield;delete enemy.owner;
 const report=screenAttacks(o,routes),source=report.sourceReserves[0]!;
 assert.ok(source.defense.threats.some(t=>t.id==='enemy'&&t.unknown));assert.equal(source.defense.forecastRequired,true);
 const summary=attackTargetContext(report,o).sourceSafety![0]!;
 assert.equal(summary.incoming,undefined);assert.equal(summary.potentialSorties?.find(t=>t.id==='enemy')?.unknown,true);
});
test('ordinary nearby troops consume reserve after known shields',()=>{
 const o=see(fixture(12));o.view.outposts[0]!.shield=5;
 const ordinary=screenAttacks(o,attackRoutes(o)).sourceReserves[0]!;
 assert.equal(ordinary.reserve,7);assert.equal(ordinary.available,23);assert.equal(ordinary.defense.forecastRequired,false);
});
