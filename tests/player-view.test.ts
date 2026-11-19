import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,fleetVisibility,projectPlayerView,fleetOutpostSonarRange,type FleetSetup,type Fleet} from '../packages/engine/src/index.js';
function setup():FleetSetup{
  const s=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  s.size={width:80,height:80};s.positions={a:{x:0,y:0},b:{x:20,y:0},c:{x:8,y:0}};
  s.economy.outposts.forEach((o,i)=>{o.id=['a','b','c'][i]!;o.owner=i===0?0:1;});return s;
}
function fleet(id:string,owner:number,destination:string):Fleet{return {id,owner,destination,source:'b',slot:128,used:true,drillers:10,state:'moving',position:{x:20,y:0},previous:{x:20,y:0},secondsUntilLaunch:0,fractionMoved:0,gift:false,giftSeconds:0};}

test('own mine price matches the charged cost and includes pending construction',()=>{
  const config=setup();
  config.economy.players[0]!.minesCreated=0;
  config.economy.outposts[0]!.drillers=500;
  let s=createFleetScenario(config);
  assert.equal(projectPlayerView(s,0).self.mineCreationCost,50);
  s=submitFleetOrder(s,{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  assert.equal(s.economy.outposts[0]!.drillers,450);
  assert.equal(projectPlayerView(s,0).self.mineCreationCost,100);
  s=submitFleetOrder(s,{id:'cancel-mine',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  assert.equal(projectPlayerView(s,0).self.mineCreationCost,50);
  s.economy.players[0]!.minesCreated=2;
  assert.equal(projectPlayerView(s,0).self.mineCreationCost,200);
});
test('original sonar inclusive boundary, wrapping, and valid seat restriction',()=>{
  const config=setup();let s=createFleetScenario(config);
  assert.deepEqual(fleetVisibility(s,0).outposts,{a:2,b:0,c:2});
  config.positions.c!.x=8.01;s=createFleetScenario(config);assert.equal(fleetVisibility(s,0).outposts.c,0);
  config.positions.a!.x=39;config.positions.c!.x=-33;s=createFleetScenario(config);assert.equal(fleetVisibility(s,0).outposts.c,2);
  for(const player of [-1,2,.5,NaN])assert.throws(()=>projectPlayerView(s,player),/Invalid player/);
});


test('team outposts share vision; hostile incoming subs visible outside sonar',()=>{
  const cfg=setup();cfg.economy.teamSize=2;let s=createFleetScenario(cfg);
  assert.equal(fleetVisibility(s,0).outposts.b,2);
  s=createFleetScenario(setup());s.fleets=[fleet('incoming',1,'a'),fleet('hidden',1,'b')];
  assert.deepEqual(fleetVisibility(s,0).fleets,{incoming:2,hidden:0});
});

test('waiting enemies remain hidden; visible ships do not reveal hidden fleets',()=>{
  const cfg=setup();
  const s=createFleetScenario(cfg);
  s.fleets=[{...fleet('waiting-enemy',1,'a'),state:'waiting'},fleet('hidden-target',1,'b'),
    {...fleet('visible-enemy',1,'c'),position:{x:1,y:0}}];
  const view=projectPlayerView(s,0);
  assert.deepEqual(view.fleets.map(f=>f.id),['visible-enemy']);
  assert.deepEqual(view.fleets[0]!.destination,{kind:'outpost',id:'c'});
});



test('hidden outpost ownership is public while armies, shields and metrics remain hidden',()=>{
 const config=setup();config.positions.b={x:30,y:30};const state=createFleetScenario(config);
 const hidden=projectPlayerView(state,0).outposts.find(o=>o.id==='b')!;
 assert.equal(hidden.visibility,0);assert.equal(hidden.owner,1);
 for(const key of ['drillers','shield','shieldMax','metrics','type'])assert.equal(key in hidden,false);
 state.economy.outposts[1]!.owner=null;
 assert.equal(projectPlayerView(state,0).outposts.find(o=>o.id==='b')!.owner,null);
});

test('hidden state, private events and RNG do not leak; observations share no mutable references',()=>{
  const s=createFleetScenario(setup());s.fleets=[fleet('secret',1,'b')];
  const before=projectPlayerView(s,0),changed=structuredClone(s);
  // Public owner totals are repeated in visible outpost metrics. Preserve
  // them while changing the hidden distribution, which must not be exposed.
  changed.economy.outposts[1]!.drillers+=5;
  changed.fleets[0]!.drillers-=5;
  changed.events.push({sequence:999,tick:100,fraction:0,kind:'secret',subject:'secret',details:{value:100}});
  assert.deepEqual(projectPlayerView(changed,0),before);
  assert.equal('initial' in before,false);assert.equal('commands' in before,false);assert.equal('events' in before,false);
  before.outposts[0]!.position.x=999;before.sonar[0]!.center.x=999;
  assert.equal(s.initial.positions.a!.x,0);
});
