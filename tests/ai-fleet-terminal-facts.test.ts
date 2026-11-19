import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup,type FleetScenario,type EconomicOutpost} from '../packages/engine/src/index.js';
import {readActivityPage} from '../packages/engine/src/notification-journal.js';
import {observation} from '../packages/server/src/player-observation.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import {observationChanges} from '../packages/ai/src/controller/observation/changes.js';
const base=(id:string,owner:number,drillers:number):EconomicOutpost=>({id,owner,drillers,type:'generator',shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false});
const setup=():FleetSetup=>({size:{width:20,height:20},positions:{a:{x:0,y:0},b:{x:.3,y:0},c:{x:2,y:0}},economy:{initialTick:100,teamSize:0,players:[{active:true,neptunium:0,minesCreated:0},{active:true,neptunium:0,minesCreated:0}],outposts:[base('a',0,100),base('b',1,30),base('c',1,0)]}});
const launch=(s:FleetScenario,id:string,player:number,source:string,destination:string,drillers:number)=>submitFleetOrder(s,{id,player,action:{kind:'launch',delaySeconds:600,source,destination,drillers}}).state;
const view=(state:FleetScenario,player=0)=>observation({state,scheduled:[]},player,'terminal-facts');
function facts(state:FleetScenario,player=0){const o=view(state,player);return readActivityPage(state,player,0,o.activityCursor!,200).events;}

test('sea annihilation supplies explicit terminal facts including a complete journey between observations and replay',()=>{
 let s=createFleetScenario(setup());const before=view(s);
 s=launch(s,'attack',0,'a','b',11);s=launch(s,'defend',1,'b','a',11);
 s=advanceFleetScenario(s,110);
 const events=facts(s),ended=events.find(e=>e.subject==='attack'&&e.termination)!;
 assert.deepEqual(ended.termination,{outcome:'removed',outpost:null,drillers:0});
 assert.equal(ended.seconds,0);assert.ok(!events.some(e=>e.subject==='attack'&&e.arrival));
 const after={...view(s),activity:events};
 assert.match(classifyChanges(before,after).important.find(e=>e.key==='arrival:attack')!.reason,/程序移除/);
 assert.ok(observationChanges(before,after).settlements?.some(e=>e.subject==='attack'&&e.termination));
 assert.deepEqual(facts(restoreFleetSnapshot(saveFleetSnapshot(s))),events);
});

test('waiting defenders report actual recovery at the combat fraction before the outpost changes ownership',()=>{
 const config=setup();config.positions.b={x:.01,y:0};config.economy.outposts[1]!.drillers=11;
 let s=launch(createFleetScenario(config),'attack',0,'a','b',27);s=advanceFleetScenario(s,102);
 s=launch(s,'escape',1,'b','c',11);const before=view(s,1);s=advanceFleetScenario(s,103);
 const events=facts(s,1),recovered=events.find(e=>e.subject==='escape'&&e.termination)!;
 assert.deepEqual(recovered.termination,{outcome:'recovered',outpost:'b',drillers:11});
 const unload=s.events.find(e=>e.subject==='escape'&&e.kind==='unloaded')!;
 assert.equal(recovered.tick+recovered.seconds/600,unload.tick-1+unload.fraction);
 assert.ok(!events.some(e=>e.subject==='escape'&&e.arrival));
 assert.ok(!events.some(e=>e.subject==='escape'&&e.termination?.outcome==='removed'));
 assert.match(classifyChanges(before,{...view(s,1),activity:events}).important.find(e=>e.key==='arrival:escape')!.reason,/实际回收/);
});

test('normal arrival and cancellation retain their exact facts without invented empty-removal settlements',()=>{
 let s=launch(createFleetScenario(setup()),'arrive',0,'a','b',40);s=advanceFleetScenario(s,110);
 assert.equal(facts(s).filter(e=>e.subject==='arrive'&&e.arrival).length,1);
 assert.ok(!s.events.some(e=>e.kind==='fleet-arrived'),'derived arrival facts must not change canonical save journals');
 assert.deepEqual(facts(restoreFleetSnapshot(saveFleetSnapshot(s))),facts(s));
 assert.equal(facts(s).filter(e=>e.subject==='arrive'&&e.termination).length,0);
 s=launch(s,'cancel',0,'a','b',1);s=submitFleetOrder(s,{id:'recall',player:0,action:{kind:'cancel-launch',fleetId:'cancel'}}).state;
 assert.ok(facts(s).some(e=>e.subject==='cancel'&&e.kind==='launch-cancelled'));
 assert.deepEqual(facts(s).find(e=>e.subject==='cancel'&&e.termination)?.termination,{outcome:'recovered',outpost:'a',drillers:1});
});

test('return provides an explicit route fact without claiming termination or arrival',()=>{
 let s=launch(createFleetScenario(setup()),'destroyed',0,'a','b',5);
 s=submitFleetOrder(s,{id:'destroy-command',player:0,action:{kind:'return-fleet',fleetId:'destroyed'}}).state;
 const events=facts(s),event=events.find(e=>e.subject==='destroyed'&&e.kind==='fleet-recalled')!;
 assert.ok(event);assert.equal(event.termination,undefined);assert.equal(event.drillers,2);assert.equal(event.arrival,undefined);assert.equal(event.transfer,undefined);
 assert.deepEqual(facts(restoreFleetSnapshot(saveFleetSnapshot(s))),events);
});
