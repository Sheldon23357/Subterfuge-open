import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,advanceFleetScenario,fleetMatchOutcome,prepareForecastKnowledge,buildForecastWorld,submitFleetOrder,exportFleetReplay,type FleetSetup} from '../packages/engine/src/index.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
const setup=()=>JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

test('fully located mining prediction uses original terminal tick and stops notification scans',()=>{
 const cfg=setup();cfg.match={mode:'mining',neptuniumGoal:200};
 cfg.economy.players[1]!.neptunium=199;cfg.economy.outposts[1]!.miningProgress=1000;
 const live=createFleetScenario(cfg),before=JSON.stringify(live);
 const actual=advanceFleetScenario(live,110),forecast=simulatePlayerFuture({state:live,scheduled:[]},1,110);
 assert.equal(forecast.status,'conditional');if(forecast.status!=='conditional')return;
 assert.equal(forecast.result.targetTick,101);
 assert.deepEqual(forecast.result.match?.ended,fleetMatchOutcome(actual));
 assert.equal(forecast.notificationHorizonTick,101);
 assert.ok(forecast.ruleNotifications.some(e=>e.kind==='game-ended'));
 assert.ok(forecast.notificationTimeline.every(e=>e.notification.tick<=101));
 assert.equal(JSON.stringify(live),before);
});

test('native domination prediction retains mining prohibition even with unseen outposts',()=>{
 const cfg=setup();cfg.match={mode:'domination',neptuniumGoal:200};
 cfg.size={width:80,height:80};cfg.positions[cfg.economy.outposts[2]!.id]={x:35,y:35};
 const built=buildForecastWorld(prepareForecastKnowledge(createFleetScenario(cfg),0));
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(built.state.forecastVictoryEnabled,true);
 assert.equal(built.state.initial.match?.mode,'domination');
 assert.throws(()=>submitFleetOrder(built.state,{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:cfg.economy.outposts[0]!.id}}),/disabled/);
 assert.equal(fleetMatchOutcome(advanceFleetScenario(built.state,110,true)),null);
 // This marker is forecast state even if a caller strips the seat field.
 delete built.state.forecastPlayer;
 assert.throws(()=>exportFleetReplay(built.state),/Prediction/);
 assert.throws(()=>advanceFleetScenario(built.state,101),/Prediction/);
});

test('native hidden-outpost retention permits the original terminal prediction',()=>{
 const cfg=setup();cfg.match={mode:'mining',neptuniumGoal:200};
 cfg.size={width:80,height:80};cfg.positions[cfg.economy.outposts[0]!.id]={x:35,y:35};
 cfg.economy.players[1]!.neptunium=199;cfg.economy.outposts[1]!.miningProgress=1000;
 const forecast=simulatePlayerFuture({state:createFleetScenario(cfg),scheduled:[]},1,110);
 assert.equal(forecast.status,'conditional');if(forecast.status!=='conditional')return;
 assert.equal(forecast.result.targetTick,101);
 assert.equal(forecast.result.match?.ended?.ended,true);
 assert.equal(forecast.ruleNotifications.some(e=>e.kind==='game-ended'),true);
 const unknown=forecast.result.outposts.find(o=>o.id===cfg.economy.outposts[0]!.id)!;
 assert.equal('owner' in unknown,true);assert.equal('drillers' in unknown,false);
});

