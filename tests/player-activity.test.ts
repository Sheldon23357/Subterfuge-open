import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerActivity,projectGlobalActivity,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup,type FleetAction,type FleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function setup():FleetSetup {
  return {size:{width:80,height:80},positions:{a:{x:0,y:0},b:{x:2,y:0},c:{x:35,y:35}},
    economy:{initialTick:0,teamSize:0,players:Array.from({length:3},()=>({active:true,neptunium:0,minesCreated:0})),
      outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:200,shield:0,shieldMax:10,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))},
    };
}
let uid=0;
function order(s:FleetScenario,action:FleetAction,player=0){return submitFleetOrder(s,{id:`activity-${++uid}`,player,action}).state;}
function launch(s:FleetScenario){return order(s,{kind:'launch',delaySeconds:600,source:'a',destination:'b',drillers:20,});}

test('friendly arrival provides authoritative delivered troops while cancellation is not an arrival',()=>{
 const cfg=setup();cfg.economy.outposts[1]!.owner=0;
 const prepared=launch(createFleetScenario(cfg)),id=prepared.fleets[0]!.id;
 const arrived=advanceFleetScenario(prepared,35),event=projectPlayerActivity(arrived,0).find(e=>e.subject===id&&e.arrival);
 assert.ok(event);assert.equal(event.kind,'fleet-arrived');assert.deepEqual(event.arrival,{outpost:'b',outcome:'delivered',drillers:20});
 assert.equal(event.drillers,20);assert.equal(event.destination?.id,'b');
 assert.deepEqual(projectPlayerActivity(arrived,2),[]);
 assert.deepEqual(projectPlayerActivity(restoreFleetSnapshot(saveFleetSnapshot(arrived)),0),projectPlayerActivity(arrived,0));
 const cancelled=order(prepared,{kind:'cancel-launch',fleetId:id});
 assert.equal(projectPlayerActivity(cancelled,0).some(e=>e.arrival),false);
});

test('activity captures visible fleet preparation and cancellation before troops return',()=>{
  const original=createFleetScenario(setup()),prepared=launch(original),id=prepared.fleets[0]!.id;
  assert.deepEqual(projectPlayerActivity(original,0),[]);
  const cancelled=order(prepared,{kind:'cancel-launch',fleetId:id});
  for(const player of [0]){
    const events=projectPlayerActivity(cancelled,player);
    assert.deepEqual(events.map(e=>e.kind),['launch-ordered','launch-cancelled','fleet-recovered']);
    for(const event of events){assert.equal(event.actor,0);assert.equal(event.drillers,20);assert.equal(event.destination?.id,event.kind==='fleet-recovered'?'a':'b');}
  }
  assert.deepEqual(projectPlayerActivity(cancelled,2),[]);
  assert.equal(projectPlayerActivity(cancelled,1).length,3);
  assert.equal(projectPlayerActivity(prepared,0).length,1);
});

test('activity keeps exactly ten latest entries, survives snapshots, and returns detached data',()=>{
  const cfg=setup();cfg.economy.initialTick=100;
  let state=createFleetScenario(cfg);
  for(let i=0;i<14;i++)state=order(state,{kind:'set-shields',outpostId:'a',enabled:i%2===1});
  const events=projectPlayerActivity(state,0);
  assert.equal(events.length,10);
  assert.equal(new Set(events.map(e=>e.id)).size,10);
  assert.deepEqual(projectPlayerActivity(restoreFleetSnapshot(saveFleetSnapshot(state)),0),events);
  assert.deepEqual(observation({state,scheduled:[]},0,'fixture').activity,events);
  events[0]!.actor=2;
  assert.equal(projectPlayerActivity(state,0)[0]!.actor,0);
  assert.deepEqual(projectPlayerActivity(state,2),[]);
});

test('mine construction and shield changes are captured with their actors',()=>{
  const cfg=setup();cfg.economy.initialTick=100;
  let state=createFleetScenario(cfg);
  state=order(state,{kind:'set-shields',outpostId:'a',enabled:false});
  state=order(state,{kind:'toggle-mine',outpostId:'a'});
  state=advanceFleetScenario(state,102);
  const events=projectPlayerActivity(state,0);
  assert.ok(events.some(e=>e.kind==='shield-order'&&e.enabled===false));
  assert.ok(events.some(e=>e.kind==='shield-disabled'));
  assert.ok(events.some(e=>e.kind==='mine-ordered'));
  assert.ok(events.some(e=>e.kind==='mine-created'));
  assert.deepEqual(projectPlayerActivity(state,2),[]);
});

test('departure and return reports include fleet quantities, destination',()=>{
  let state=advanceFleetScenario(launch(createFleetScenario(setup())),2);
  state=order(state,{kind:'return-fleet',fleetId:state.fleets[0]!.id});
  const events=projectPlayerActivity(state,0);
  assert.ok(events.some(e=>e.kind==='fleet-recalled'&&e.termination===undefined&&e.drillers===10));
  assert.ok(events.some(e=>e.kind==='departed'&&e.destination?.id==='b'));
});

test('departure activity uses interval start so the explicit preparation lasts exactly ten minutes',()=>{
  for(const seconds of [0,120,599])for(const delaySeconds of [600,1200]){
    const cfg=setup();cfg.economy.initialTick=100;
    let state=createFleetScenario(cfg);state.secondsSinceLastTick=seconds;
    state=order(state,{kind:'launch',source:'a',destination:'b',drillers:20,delaySeconds});
    state=advanceFleetScenario(state,104);
    for(const events of [projectPlayerActivity(state,0),projectGlobalActivity(state)]){
      const ordered=events.find(e=>e.kind==='launch-ordered')!;
      const departed=events.find(e=>e.kind==='departed')!;
      assert.equal(departed.tick*600+departed.seconds-(ordered.tick*600+ordered.seconds),delaySeconds);
    }
    assert.deepEqual(projectPlayerActivity(restoreFleetSnapshot(saveFleetSnapshot(state)),0),projectPlayerActivity(state,0));
  }
});

test('combat and occupation are captured for observers in event-time sonar',()=>{
  const cfg=setup();cfg.economy.outposts[1]!.drillers=1;
  let state=launch(createFleetScenario(cfg));
  state=advanceFleetScenario(state,35);
  for(const player of [0,1]){
    const events=projectPlayerActivity(state,player);
    assert.ok(events.some(e=>e.kind==='battle'&&e.actor===0&&e.destination?.id==='b'));
    const battle=events.find(e=>e.kind==='battle')!;
    const raw=state.events.find(e=>e.kind==='battle')!.details;
    const rawEvent=state.events.find(e=>e.kind==='battle')!;
    assert.equal(battle.tick,rawEvent.tick-1);
    assert.equal(battle.seconds,Math.round(rawEvent.fraction*600));
    const capture=events.find(e=>e.kind==='outpost-captured')!;
    assert.equal(capture.tick*600+capture.seconds,battle.tick*600+battle.seconds);
    assert.deepEqual(battle.battle,{
      attacker:{player:0,loss:Math.max(0,Number(raw.attackerBefore)-Number(raw.attacker))},
      defender:{player:1,loss:Math.max(0,Number(raw.defenderBefore)-Number(raw.defender))},
    });
    assert.equal(battle.battle!.defender.loss,1);
    assert.deepEqual(projectPlayerActivity(restoreFleetSnapshot(saveFleetSnapshot(state)),player),events);
    assert.ok(events.some(e=>e.kind==='outpost-captured'&&e.subject==='b'&&e.actor===0));
  }
  assert.deepEqual(projectPlayerActivity(state,2),[]);
});

test('hidden actions neither appear nor alter local event numbering; later vision does not reveal their archive',()=>{
  let state=createFleetScenario(setup());
  state=order(state,{kind:'set-shields',outpostId:'c',enabled:false},2);
  state=launch(state);
  assert.deepEqual(projectPlayerActivity(state,0).map(e=>e.id),[0]);
  // Simulate a later ownership/vision change: historical access stays fixed.
  state.economy.outposts.find(o=>o.id==='c')!.owner=0;
  assert.ok(projectPlayerActivity(state,0).every(e=>e.subject!=='c'));
  assert.ok(projectPlayerActivity(state,2).some(e=>e.subject==='c'&&e.actor===2));
});

test('global observer sees one copy of every event while player archives keep their visibility limits',()=>{
  let state=createFleetScenario(setup());
  state=order(state,{kind:'set-shields',outpostId:'c',enabled:false},2);
  state=launch(state);
  const events=projectGlobalActivity(state);
  assert.deepEqual(events.map(e=>e.kind),['shield-order','launch-ordered']);
  assert.deepEqual(events.map(e=>e.actor),[2,0]);
  assert.equal(events[1]!.source,'a');
  assert.deepEqual(projectGlobalActivity(restoreFleetSnapshot(saveFleetSnapshot(state))),events);
  assert.equal(projectPlayerActivity(state,0).length,1);
  assert.throws(()=>projectPlayerActivity(state,-1),/Invalid player/);
  for(let i=0;i<12;i++)state=order(state,{kind:'set-shields',outpostId:'c',enabled:i%2===0},2);
  assert.equal(projectGlobalActivity(state).length,10);
  assert.equal(projectPlayerActivity(state,0).length,1);
});
