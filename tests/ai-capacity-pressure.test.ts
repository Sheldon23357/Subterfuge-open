
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {AttackRoutes,OutpostMetrics} from '../packages/contracts/src/index.js';
import {capacityPressure} from '../packages/ai/src/controller/analysis/capacity-pressure.js';
import {classifyChanges} from '../packages/ai/src/controller/runtime/decision.js';
import {screenAttacks,screeningClass} from '../packages/ai/src/controller/analysis/attack-screening.js';
import {attackScreeningConfig} from '../packages/ai/src/controller/analysis/attack-screening-config.js';

function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'capacity');
 o.view.self={...o.view.self,active:true,drillers:100,capacity:100};
 const metrics:OutpostMetrics={active:true,paused:true,output:12,cycleMinutes:480,nextMinutes:null,progress:0.4,capacity:100,used:100,contribution:0,neptunium:0,mines:0};
 o.view.outposts=[{id:'home',owner:0,type:'factory',visibility:2,position:{x:0,y:0},drillers:100,shield:0,metrics},
  {id:'near',owner:1,type:'factory',visibility:2,position:{x:1,y:0},drillers:5,shield:0},
  {id:'far',owner:1,type:'factory',visibility:2,position:{x:2,y:0},drillers:5,shield:0}];
 o.view.fleets=[];o.intel=[];o.scheduled=[];
 o.outpostNames={home:'HOME',near:'NEAR',far:'FAR'};
 const routes:AttackRoutes={roomId:o.roomId,revision:o.revision,observedTick:o.view.tick,maxTicks:144,basis:'ordinary-speed-public-geometry',postTicks:{home:{near:10,far:90},near:{home:null,far:144},far:{home:null,near:144}},fleetTicks:{}};
 return {o,routes};
}

test('capacity facts count all troops, discriminate production stalls, and never invent missing metrics',()=>{
 const {o}=fixture(),before=JSON.stringify(o);
 assert.deepEqual(capacityPressure(o),{state:'blocked',pausedFactories:1,nominalOutputPer24WorldDays:6,estimatedFillWorldDays:0,strength:1});
 assert.equal(JSON.stringify(o),before);
 o.view.outposts[0]!.drillers=20;o.view.fleets.push({id:'sent',owner:0,drillers:80,state:'moving',gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:'near'}});
 assert.equal(capacityPressure(o).state,'blocked'); // dispatch is not global consumption
 o.view.self.drillers=140;assert.equal(capacityPressure(o).state,'blocked');
 o.view.outposts[0]!.metrics!.active=false;assert.equal(capacityPressure(o).state,'none');
 o.view.outposts[0]!.metrics!.active=true;delete o.view.outposts[0]!.metrics;
 assert.equal(capacityPressure(o).state,'none');assert.equal(capacityPressure(o).estimatedFillWorldDays,null);
});

test('near-capacity warning requires both actual utilization and a short nominal fill estimate',()=>{
 const {o}=fixture();o.view.outposts[0]!.metrics!.paused=false;
 o.view.self.drillers=99;assert.equal(capacityPressure(o).state,'tight');
 assert.equal(capacityPressure(o).estimatedFillWorldDays,4);
 o.view.self.drillers=90;assert.equal(capacityPressure(o).state,'none'); // 40 days, no urgent stall
 o.view.self.drillers=50;o.view.outposts[0]!.metrics!.output=1000;assert.equal(capacityPressure(o).state,'none');
 o.view.self.active=false;o.view.self.drillers=100;o.view.outposts[0]!.metrics!.paused=true;assert.equal(capacityPressure(o).state,'none');
});

test('new pressure wakes once, never once per tick or merely on dispatch',()=>{
 const {o}=fixture(),before=structuredClone(o);before.view.self.drillers=80;before.view.outposts[0]!.metrics!.paused=false;
 const signal=classifyChanges(before,o).important.filter(s=>s.key==='capacity-pressure');
 assert.equal(signal.length,1);assert.equal(signal[0]!.kind,'investment-opportunity');
 const later=structuredClone(o);later.view.tick+=12;
 assert.equal(classifyChanges(o,later).important.filter(s=>s.key==='capacity-pressure').length,0);
 assert.equal(classifyChanges(before,o,{ignoreOwnEffects:true}).important.filter(s=>s.key==='capacity-pressure').length,0);
 const near=structuredClone(before);near.view.self.drillers=99;
 assert.equal(classifyChanges(before,near).important.filter(s=>s.key==='capacity-pressure').length,1);
 assert.equal(classifyChanges(near,o).important.filter(s=>s.key==='capacity-pressure').length,1);
});

test('pressure favors timely new offensives without changing budgets or classifying deficits as safe',()=>{
 const {o,routes}=fixture(),disabled=attackScreeningConfig({capacityPressure:{maximumBonus:0}});
 const base=screenAttacks(o,routes,disabled),full=screenAttacks(o,routes);
 assert.deepEqual(full.sourceReserves,base.sourceReserves);
 const near=full.ranked.find(p=>p.target==='near')!,far=full.ranked.find(p=>p.target==='far')!;
 assert.ok(near.pressureBonus>far.pressureBonus&&far.pressureBonus>0);
 assert.ok(near.score>base.ranked.find(p=>p.target==='near')!.score);assert.equal(screeningClass(near),'action');
 o.view.outposts[1]!.drillers=1000;
 const deficit=screenAttacks(o,routes).ranked.find(p=>p.target==='near')!;
 assert.equal(deficit.pressureBonus,0);assert.equal(screeningClass(deficit),'conditional');
 assert.throws(()=>attackScreeningConfig({capacityPressure:{maximumBonus:11}}));
});

test('existing and contested operations receive no pressure bonus or repeated allocation',()=>{
 const {o,routes}=fixture();o.view.fleets=[{id:'current',owner:0,drillers:20,state:'moving',gift:false,position:{x:0,y:0},destination:{kind:'outpost',id:'near'}}];routes.fleetTicks.current=4;
 const report=screenAttacks(o,routes),target=report.ranked.find(p=>p.target==='near')!;
 assert.equal(target.pressureBonus,0);assert.equal(screeningClass(target),'review');assert.ok(!report.budget.proposals.some(p=>p.target==='near'));
 o.view.fleets[0]!.owner=2;
 assert.equal(screenAttacks(o,routes).ranked.find(p=>p.target==='near')!.pressureBonus,0);
});
