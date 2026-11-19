import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,fleetStandings,fleetMatchOutcome,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
function setup(count=4):FleetSetup{
 return {match:{mode:'mining',neptuniumGoal:200},size:{width:20,height:20},positions:Object.fromEntries(Array.from({length:count},(_,i)=>[`p${i}`,{x:i,y:0}])),economy:{initialTick:100,teamSize:0,players:Array.from({length:count},()=>({active:true,neptunium:0,minesCreated:0})),outposts:Array.from({length:count},(_,i)=>({id:`p${i}`,owner:i,type:'generator',drillers:10,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
}
test('original ranking orders NP, mines, non-mine outposts, drillers, then descending local account substitute',()=>{
 const cfg=setup(6);cfg.economy.players[0]!.neptunium=1;cfg.economy.outposts[1]!.type='mine';cfg.economy.outposts[2]!.drillers=20;
 const template=cfg.economy.outposts[3]!;cfg.economy.outposts.push({...template,id:'extra'});cfg.positions.extra={x:8,y:0};
 const s=createFleetScenario(cfg),before=JSON.stringify(s),result=fleetStandings(s);
 assert.deepEqual(result.players.map(p=>p.seat),[0,1,3,2,5,4]);assert.deepEqual(result.winners,[]);assert.equal(JSON.stringify(s),before);
});
test('simultaneous target attainment uses original ranking winner, not first end-condition trigger',()=>{
 const cfg=setup();cfg.economy.players[0]!.neptunium=200;cfg.economy.players[1]!.neptunium=250;
 const s=createFleetScenario(cfg);assert.equal(fleetMatchOutcome(s)!.triggeringSeat,0);assert.deepEqual(fleetStandings(s).winners,[1]);
 assert.deepEqual(fleetStandings(restoreFleetSnapshot(saveFleetSnapshot(s))),fleetStandings(s));
});
test('elimination ranks later deaths above earlier deaths, survivor above both',()=>{
 let s=createFleetScenario(setup());
 for(const [seat,tick] of [[0,100],[1,101],[2,102]] as const){s=advanceFleetScenario(s,tick);s=submitFleetOrder(s,{id:`resign-${seat}`,player:seat,action:{kind:'resign'}}).state;}
 const result=fleetStandings(s);assert.deepEqual(result.players.map(p=>p.seat),[3,2,1,0]);assert.deepEqual(result.winners,[3]);assert.equal(result.players[1]!.deathTick,102);
 assert.deepEqual(fleetStandings(restoreFleetSnapshot(saveFleetSnapshot(s))),result);
});
test('team winner includes eliminated teammate; team order preserves seat order within teams',()=>{
 const cfg=setup();cfg.economy.teamSize=2;let s=createFleetScenario(cfg);
 for(const seat of [0,2,3])s=submitFleetOrder(s,{id:`resign-${seat}`,player:seat,action:{kind:'resign'}}).state;
 const result=fleetStandings(s);assert.deepEqual(result.winners,[0,1]);assert.deepEqual(result.players.map(p=>p.seat),[0,1,2,3]);assert.equal(result.players[0]!.active,false);assert.equal(result.players[0]!.teamRank,1);
});
test('all dead produces no winner; unknown initial death history is explicitly marked',()=>{
 const cfg=setup();cfg.economy.players.forEach(p=>p.active=false);const result=fleetStandings(createFleetScenario(cfg));
 assert.deepEqual(result.winners,[]);assert.ok(result.players.every(p=>p.assumedDeathTime&&p.deathTick===null));
});
test('ranking driller total includes dispatched fleets',()=>{
 const cfg=setup();cfg.economy.outposts[0]!.drillers=100;
 let s=createFleetScenario(cfg);s=submitFleetOrder(s,{id:'fleet',player:0,action:{kind:'launch',source:'p0',destination:'p1',drillers:90}}).state;
 const result=fleetStandings(s);assert.equal(result.players[0]!.seat,0);assert.equal(result.players[0]!.drillers,100);
});

 test('same-tick resignation ranks by original game seconds, including replay',()=>{
 let s=createFleetScenario(setup());
 s=submitFleetOrder(s,{id:'early',player:2,action:{kind:'resign'}},10).state;
 s=submitFleetOrder(s,{id:'late',player:0,action:{kind:'resign'}},590).state;
 assert.deepEqual(fleetStandings(s).players.filter(p=>!p.active).map(p=>p.seat),[0,2]);
 assert.deepEqual(fleetStandings(restoreFleetSnapshot(saveFleetSnapshot(s))),fleetStandings(s));
 });
