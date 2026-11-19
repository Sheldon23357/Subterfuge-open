import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerView,type FleetSetup} from '../packages/engine/src/index.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {partitionForecastResources} from '../packages/engine/src/forecast-resources.js';
function setup(){const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};return cfg;}
test('forecast partitions public totals without reconstructing hidden locations',()=>{
 const s=createFleetScenario(setup()),before=JSON.stringify(s),k=prepareForecastKnowledge(s,0);
 assert.deepEqual(k.resources,[
  {player:0,publicDrillers:100,locatedDrillers:100,unlocatedDrillers:0,unlocatedOutposts:{mine:0,factory:0,generator:0},uncertainties:[]},
  {player:1,publicDrillers:11,locatedDrillers:0,unlocatedDrillers:11,unlocatedOutposts:{mine:1,factory:0,generator:1},uncertainties:['unlocated-armies','unlocated-outposts']},
 ]);
 assert.equal(JSON.stringify(s),before);
 s.economy.outposts[1]!.drillers-=5;s.economy.outposts[2]!.drillers+=5;
 assert.deepEqual(prepareForecastKnowledge(s,0).resources,k.resources);
 assert.deepEqual(prepareForecastKnowledge(s,0).view,k.view);
 assert.equal(JSON.stringify(k.resources).includes('红方'),false);
 // A zero residual is justified by public arithmetic, not assumed for an unknown location.
 s.economy.outposts[1]!.drillers=0;s.economy.outposts[2]!.drillers=0;
 const empty=prepareForecastKnowledge(s,0).resources[1]!;
 assert.equal(empty.unlocatedDrillers,0);assert.deepEqual(empty.uncertainties,['unlocated-outposts']);
});
test('known enemy armies and dispatched own fleets are counted once, without guessing the remainder location',()=>{
 const cfg=setup();cfg.positions['红方矿场']={x:1,y:0};cfg.economy.outposts[2]!.drillers=30;
 let s=createFleetScenario(cfg);s=submitFleetOrder(s,{id:'depart',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:20}}).state;
 const k=prepareForecastKnowledge(s,0);
 assert.equal(k.resources[0]!.locatedDrillers,100);assert.equal(k.resources[0]!.unlocatedDrillers,0);
 assert.equal(k.resources[1]!.locatedDrillers,11);assert.equal(k.resources[1]!.unlocatedDrillers,30);
 assert.deepEqual(k.resources[1]!.unlocatedOutposts,{mine:0,factory:0,generator:1});
});
test('player outpost type follows original strict phase getter and agrees with public count before tick commitment',()=>{
 let s=submitFleetOrder(createFleetScenario(setup()),{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}},500).state;
 s=advanceFleetScenario(s,101);s.secondsSinceLastTick=500;
 assert.equal((projectPlayerView(s,0).outposts[0] as {type:string}).type,'factory');
 assert.deepEqual(prepareForecastKnowledge(s,0).resources[0]!.uncertainties,[]);
 s.secondsSinceLastTick=501;const k=prepareForecastKnowledge(s,0);
 assert.equal((k.view.outposts[0] as {type:string}).type,'mine');assert.equal(k.publicIntel[0]!.outposts.mine,1);
 assert.deepEqual(k.resources[0]!.unlocatedOutposts,{mine:0,factory:0,generator:0});
 assert.deepEqual(k.resources[0]!.uncertainties,[]);
 assert.equal(s.economy.outposts[0]!.type,'factory'); // Projection does not commit the authoritative tick early.
});
test('inconsistent public inputs are explicit unknowns, never silently clamped to zero',()=>{
 const k=prepareForecastKnowledge(createFleetScenario(setup()),0),intel=structuredClone(k.publicIntel);
 intel[0]!.drillers=1;intel[0]!.outposts.factory=0;
 const p=partitionForecastResources(k.view,intel)[0]!;
 assert.equal(p.unlocatedDrillers,null);assert.equal(p.unlocatedOutposts,null);
 assert.deepEqual(p.uncertainties,['inconsistent-public-totals']);
});
