import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {AttackRoutes,PlayerObservation} from '../packages/contracts/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {screenAttacks,screeningSummary} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {initialState,PERSONALITIES,type AiSnapshot,type Personality} from '../packages/ai/src/controller/contracts/types.js';

function fixture(){
  const o:PlayerObservation=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'war');
  o.view.outposts=[
    {id:'home',owner:0,position:{x:0,y:0},visibility:2,type:'factory',drillers:40,shield:0},
    {id:'enemy',owner:1,position:{x:1,y:0},visibility:2,type:'mine',drillers:80,shield:0},
    {id:'partner',owner:2,position:{x:2,y:0},visibility:0},
  ];
  o.outpostNames=Object.fromEntries(o.view.outposts.map(p=>[p.id,p.id]));
  o.view.playerCount=3;
  o.view.fleets=[];o.intel=[];
  const routes:AttackRoutes={roomId:o.roomId,revision:o.revision,observedTick:o.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',postTicks:{home:{enemy:8,partner:16},enemy:{home:8,partner:8},partner:{enemy:8,home:16}},fleetTicks:{}};
  return {o,routes};
}

test('cooperation survives a complete solo-force deadlock without creating allied soldiers or changing reserves',()=>{
  const {o,routes}=fixture(),before=JSON.stringify({o,routes}),report=screenAttacks(o,routes);
  assert.equal(report.sourceReserves[0]!.available,0);assert.equal(report.ranked.length,0);
  assert.equal(report.budget.proposals.length,0);
  const lead=report.cooperation.opportunities.find(p=>p.opponent===1)!;
  assert.deepEqual(lead.ownApproaches,[{source:'home',target:'enemy',ticks:8}]);
  assert.deepEqual(lead.partners,[{player:2,approaches:[{source:'partner',target:'enemy',ticks:8}]}]);
  assert.ok(lead.purposes.includes('joint-attack-or-diversion'));
  assert.deepEqual(screeningSummary(report).cooperation,report.cooperation);
  assert.equal(JSON.stringify({o,routes}),before);
  const changed=structuredClone(o);changed.view.outposts[2]!.drillers=900;
  assert.deepEqual(screenAttacks(changed,routes).cooperation,report.cooperation,'reachable partner is not assumed to have any free troops');
});

test('defensive counterattack outreach survives no solo route and distinguishes waiting from moving',()=>{
  const {o,routes}=fixture();delete routes.postTicks.home!.enemy;
  o.view.fleets.push({id:'incoming',owner:1,drillers:20,gift:false,state:'waiting',position:{x:1,y:0},destination:{kind:'outpost',id:'home'}});
  routes.fleetTicks.incoming=3;
  const lead=screenAttacks(o,routes).cooperation.opportunities[0]!;
  assert.equal(lead.opponent,1);assert.deepEqual(lead.ownApproaches,[]);
  assert.deepEqual(lead.purposes,['seek-defense-or-counterattack']);
  assert.deepEqual(lead.incoming,[{id:'incoming',target:'home',state:'waiting',ticks:3}]);
  o.view.fleets[0]!.state='moving';
  assert.equal(screenAttacks(o,routes).cooperation.opportunities[0]!.incoming[0]!.state,'moving');
  o.view.fleets[0]!.gift=true;
  assert.ok(!screenAttacks(o,routes).cooperation.opportunities.some(p=>p.opponent===1),'gifts are not incoming attackers');
});

test('outreach has no invented partners in duels, inaccessible territory, eliminated players or destroyed posts',()=>{
  for(const change of ['duel','far','inactive','destroyed'] as const){
    const {o,routes}=fixture();
    if(change==='duel')o.view.outposts.pop();
    if(change==='far')routes.postTicks.partner!.enemy=144;
    if(change==='inactive')o.intel=[{player:2,active:false,neptunium:0,npPerDay:0,outposts:{mine:0,generator:0,factory:0},numOutposts:0,output:0,drillerRate:0,drillers:0}];
    if(change==='destroyed')o.view.outposts[2]!.destroyed=true;
    assert.ok(!screenAttacks(o,routes).cooperation.opportunities.some(p=>p.opponent===1),change);
  }
});

test('real route matrix includes a partner counterattack on a remote attacker outside our solo frontier',()=>{
  const {o}=fixture();o.view.size={width:80,height:80};
  o.view.outposts[1]!.position={x:30,y:0};o.view.outposts[2]!.position={x:30.01,y:0};
  const before=attackRoutes(o);
  assert.equal(before.postTicks.home!.enemy,null);
  assert.equal(before.postTicks.partner!.enemy,undefined);
  o.view.fleets.push({id:'remote-attack',owner:1,drillers:20,gift:false,state:'moving',position:{x:0.01,y:0},destination:{kind:'outpost',id:'home'}});
  const routes=attackRoutes(o);
  assert.equal(routes.postTicks.home!.enemy,null);
  assert.equal(typeof routes.postTicks.partner!.enemy,'number');
  const lead=screenAttacks(o,routes).cooperation.opportunities.find(p=>p.opponent===1)!;
  assert.ok(lead);assert.deepEqual(lead.ownApproaches,[]);assert.equal(lead.partners[0]!.player,2);
});

test('cooperation leads are bounded and prioritize current attackers over other opponents',()=>{
  const {o,routes}=fixture();o.view.playerCount=10;
  for(let player=3;player<10;player++){
    const id=`p${player}`;
    o.view.outposts.push({id,owner:player,visibility:0,position:{x:player,y:0}});
    routes.postTicks[id]={};
  }
  for(const source of o.view.outposts)for(const target of o.view.outposts)if(source!==target)routes.postTicks[source.id]![target.id]=10;
  o.view.fleets.push({id:'attack',owner:8,drillers:1,gift:false,state:'moving',position:{x:1,y:0},destination:{kind:'outpost',id:'home'}});
  const leads=screenAttacks(o,routes).cooperation.opportunities;
  assert.equal(leads.length,3);assert.equal(leads[0]!.opponent,8);
  assert.ok(leads.every(p=>p.partners.length<=3&&p.ownApproaches.length<=3&&p.partners.every(a=>a.approaches.length<=3)));
});
