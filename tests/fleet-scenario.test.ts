import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,exportFleetReplay,replayFleetScenario,saveFleetSnapshot,restoreFleetSnapshot,
  validateFleetOrder,fleetScenarioTotals,type FleetSetup,type FleetScenario,type FleetAction,type EconomicOutpost} from '../packages/engine/src/index.js';
function base(id:string,owner:number|null,drillers:number):EconomicOutpost{return{id,owner,drillers,type:'factory',shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false};}
function setup():FleetSetup{return{size:{width:20,height:20},positions:{a:{x:0,y:0},b:{x:.3,y:0},c:{x:2,y:0}},economy:{initialTick:100,teamSize:0,players:[{active:true,neptunium:0,minesCreated:0},{active:true,neptunium:51,minesCreated:0}],outposts:[base('a',0,100),base('b',1,11),base('c',1,0)]}};}
function command(s:FleetScenario,id:string,player:number,action:FleetAction){return submitFleetOrder(s,{id,player,action}).state;}
function launch(s:FleetScenario,id='launch',player=0,source='a',destination='b',drillers=27){return command(s,id,player,{kind:'launch',delaySeconds:600,source,destination,drillers});}
test('launch reserve/edit/cancel is atomic, idempotent and bound to owner',()=>{
  const initial=createFleetScenario(setup()),s=launch(initial),payload={id:'launch',player:0,action:{kind:'launch' as const,delaySeconds:600,source:'a',destination:'b',drillers:27}};
  assert.equal(initial.economy.outposts[0]!.drillers,100);assert.equal(s.economy.outposts[0]!.drillers,73);
  assert.equal(submitFleetOrder(s,payload).duplicate,true);assert.equal(submitFleetOrder(s,payload).state,s);
  assert.throws(()=>submitFleetOrder(s,{...payload,player:1}),/conflict/);
  const changed=launch(s,'edit',0,'a','b',40);assert.equal(changed.fleets.length,1);assert.equal(changed.fleets[0]!.id,'launch');
  assert.equal(changed.economy.outposts[0]!.drillers,60);
  assert.equal(validateFleetOrder(changed,{id:'steal',player:1,action:{kind:'cancel-launch',fleetId:'launch'}}).valid,false);
  assert.throws(()=>launch(changed,'too-many',0,'a','b',101));
  const cancelled=command(changed,'cancel',0,{kind:'cancel-launch',fleetId:'launch'});
  assert.equal(cancelled.economy.outposts[0]!.drillers,100);assert.equal(cancelled.fleets[0]!.used,false);
  const next=launch(cancelled,'new');assert.equal(next.fleets.find(f=>f.used)!.id,'new');assert.equal(next.fleets.find(f=>f.used)!.slot,1);
});
test('exact zero launch retains movement timing but cannot be edited or cancelled',()=>{
  let s=launch(createFleetScenario(setup()));s=advanceFleetScenario(s,101);
  assert.equal(s.fleets[0]!.state,'waiting');assert.equal(s.fleets[0]!.secondsUntilLaunch,0);
  assert.throws(()=>launch(s,'late-edit'),/edited/);assert.throws(()=>command(s,'cancel',0,{kind:'cancel-launch',fleetId:'launch'}),/no longer be cancelled/);
  s=advanceFleetScenario(s,102);assert.equal(s.fleets[0]!.state,'moving');assert.equal(s.events.filter(e=>e.kind==='departed').length,1);
  assert.throws(()=>command(s,'late-cancel',0,{kind:'cancel-launch',fleetId:'launch'}),/departed/);
});
test('fleet drillers still consume factory capacity while waiting and underway',()=>{
  const config=setup();config.economy.outposts[0]!.drillers=150;config.economy.outposts[0]!.productionProgress=47;
  let s=launch(createFleetScenario(config), 'full',0,'a','b',50);s=advanceFleetScenario(s,103);
  assert.equal(s.economy.outposts[0]!.drillers,100);assert.equal(s.economy.outposts[0]!.productionProgress,47);
  assert.equal(fleetScenarioTotals(s)[0]!.drillers,150);
});
test('arrival resolves shields, conquest and mine loss, preserving production progress',()=>{
  const config=setup();const b=config.economy.outposts[1]!;b.type='mine';b.shield=8;b.shieldMax=8;b.productionProgress=12;
  const s=advanceFleetScenario(launch(createFleetScenario(config)),110);
  assert.equal(s.economy.outposts[1]!.owner,0);assert.equal(s.economy.outposts[1]!.drillers,8);
  assert.equal(s.economy.outposts[1]!.productionProgress,12);assert.equal(s.economy.players[1]!.neptunium,41);
  assert.equal(s.events.filter(e=>e.kind==='battle').length,1);assert.equal(s.fleets[0]!.used,false);
});
test('opposing routes encounter once before arrival, then surviving fleet captures',()=>{
  let s=launch(createFleetScenario(setup()),'attack',0,'a','b',27);s=launch(s,'defend',1,'b','a',11);
  s=advanceFleetScenario(s,110);const reports=s.events.filter(e=>e.kind==='battle');
  assert.equal(reports.length,2);assert.equal(reports[0]!.details.target,'defend');assert.equal(reports[0]!.details.attacker,16);
  assert.equal(s.economy.outposts[1]!.owner,0);assert.equal(s.economy.outposts[1]!.drillers,16);
});
test('mutual annihilation removes both fleets without capturing either outpost',()=>{
  let s=launch(createFleetScenario(setup()),'attack',0,'a','b',11);s=launch(s,'defend',1,'b','a',11);s=advanceFleetScenario(s,110);
  assert.equal(s.events.filter(e=>e.kind==='battle').length,1);assert.equal(s.events.find(e=>e.kind==='battle')!.details.winner,'draw');
  assert.ok(s.fleets.every(f=>!f.used));assert.equal(s.economy.outposts[1]!.owner,1);
});
test('enemy arrival recalls waiting defenders before combat',()=>{
  const config=setup();config.positions.b={x:.01,y:0};
  let s=launch(createFleetScenario(config));s=advanceFleetScenario(s,102);
  // Launch reaches the destination during eF; arrival is processed next tick.
  assert.equal(s.fleets[0]!.state,'arriving');
  s=launch(s,'escape',1,'b','c',11);s=advanceFleetScenario(s,103);
  const battle=s.events.find(e=>e.kind==='battle')!;assert.equal(battle.details.defenderBefore,11);
  assert.equal(s.economy.outposts[1]!.drillers,16);assert.ok(s.fleets.every(f=>!f.used));
});
test('fleet return immediately halves troops and is limited to once',()=>{
 const initial=launch(createFleetScenario(setup()));const troops=initial.economy.outposts[0]!.drillers;
 const end=command(initial,'destroy',0,{kind:'return-fleet',fleetId:'launch'});
 assert.equal(end.fleets[0]!.used,true);assert.equal(end.fleets[0]!.drillers,Math.floor(initial.fleets[0]!.drillers/2));assert.equal(end.economy.outposts[0]!.drillers,troops);
 assert.ok(end.events.some(e=>e.kind==='fleet-recalled'));assert.ok(!end.events.some(e=>e.kind==='battle'));
 assert.throws(()=>command(end,'again',0,{kind:'return-fleet',fleetId:'launch'}));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(end)),end);
});

test('neutral empty outpost is captured; wrapped route uses the nearest image',()=>{
  const config=setup();config.positions.a={x:9.9,y:0};config.positions.b={x:-9.9,y:0};config.economy.outposts[1]!.owner=null;config.economy.outposts[1]!.drillers=0;
  let s=launch(createFleetScenario(config));s=advanceFleetScenario(s,110);
  assert.equal(s.economy.outposts[1]!.owner,0);assert.equal(s.economy.outposts[1]!.drillers,27);
  assert.equal(s.events.filter(e=>e.kind==='battle').length,0);
});
test('split advance, unified economic orders, replay and snapshot produce identical states',()=>{
  let s=launch(createFleetScenario(setup()));s=command(s,'mine',0,{kind:'toggle-mine',outpostId:'a'});
  const full=advanceFleetScenario(s,150),split=advanceFleetScenario(advanceFleetScenario(s,103),150);
  assert.deepEqual(full,split);assert.deepEqual(replayFleetScenario(exportFleetReplay(full)),full);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(full)),full);
  const corrupt=JSON.parse(saveFleetSnapshot(full));corrupt.expected.economy.outposts[0].drillers++;
  assert.throws(()=>restoreFleetSnapshot(JSON.stringify(corrupt)),/disagree/);
  const replay=exportFleetReplay(full);replay.commands.push(replay.commands[0]!);assert.throws(()=>replayFleetScenario(replay),/Duplicate/);
  assert.throws(()=>advanceFleetScenario(s,10001+100),/horizon/);
  assert.throws(()=>createFleetScenario({...setup(),unexpected:[]} as FleetSetup),/fields/);
});
test('simultaneous arrivals resolve by player fleet slot rather than command submission order',()=>{
  const config=setup();config.positions={a:{x:-.1,y:0},b:{x:0,y:0},c:{x:.1,y:0}};
  config.economy.players.push({active:true,neptunium:0,minesCreated:0});config.economy.outposts[2]!.owner=2;config.economy.outposts[2]!.drillers=20;
  let s=launch(createFleetScenario(config),'later-slot',2,'c','b',20);
  s=launch(s,'earlier-slot',0,'a','b',27);s=advanceFleetScenario(s,110);
  const battles=s.events.filter(e=>e.kind==='battle');assert.equal(battles.length,2);
  assert.equal(battles[0]!.subject,'earlier-slot');assert.equal(battles[1]!.subject,'later-slot');
  assert.equal(battles[0]!.tick,battles[1]!.tick);assert.equal(battles[0]!.fraction,battles[1]!.fraction);
  assert.equal(s.economy.outposts[1]!.owner,2);assert.equal(s.economy.outposts[1]!.drillers,4);
});
test('funding is revoked after combat loses a mine in the same tick',()=>{
  const config=setup();config.economy.outposts[1]!.type='mine';config.economy.players[1]!.neptunium=24;
  let s=command(createFleetScenario(config),'fund',1,{kind:'toggle-funding',recipient:0});s=launch(s);s=advanceFleetScenario(s,110);
  const lost=s.events.find(e=>e.kind==='mine-loss')!,expired=s.events.find(e=>e.kind==='funding-expired')!;
  assert.equal(s.economy.players[1]!.neptunium,19);assert.equal(s.economy.funding[1]![0],false);
  assert.equal(lost.tick,expired.tick);assert.ok(lost.sequence<expired.sequence);
});
test('player sub counter advances around 128 slots and survives replay',()=>{
  let s=createFleetScenario(setup());
  for(let i=0;i<130;i++){
    s=launch(s,`launch-${i}`,0,'a','b',1);
    assert.equal(s.fleets.find(f=>f.used)!.slot,i%128);
    s=command(s,`cancel-${i}`,0,{kind:'cancel-launch',fleetId:`launch-${i}`});
  }
  assert.equal(s.subCounters[0],129);assert.equal(s.fleets.length,128);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
