import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,fleetPublicIntel,submitFleetOrder,projectPlayerView,type FleetSetup} from '../packages/engine/src/index.js';
function setup(){const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};cfg.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:20,y:0},'红方后方':{x:25,y:0}};return cfg;}

test('intel exposes original aggregate statistics while positions and local troops remain hidden',()=>{
 const s=createFleetScenario(setup()),before=JSON.stringify(s),intel=fleetPublicIntel(s);
 // Rules4300: base capacity150 + generator50; 1 mine × 2 outposts per day.
 assert.deepEqual(intel[1],{player:1,active:true,neptunium:51,npPerDay:2,outposts:{mine:1,generator:1,factory:0},numOutposts:2,drillers:11,output:200,drillerRate:0});
 assert.equal(projectPlayerView(s,0).outposts[1]!.visibility,0);assert.equal('drillers' in projectPlayerView(s,0).outposts[1]!,false);
 for(const key of ['红方矿场','红方后方','specialist','position','productionProgress','shield','seed'])assert.equal(JSON.stringify(intel).includes(key),false);
 assert.equal(JSON.stringify(s),before);intel[1]!.outposts.mine=999;assert.equal(fleetPublicIntel(s)[1]!.outposts.mine,1);
});
test('hidden distribution and timers cannot alter aggregate intel',()=>{
 const s=createFleetScenario(setup()),before=fleetPublicIntel(s);
 s.economy.outposts[1]!.drillers-=5;s.economy.outposts[2]!.drillers+=5;
 s.economy.outposts[1]!.miningProgress=900;
 assert.deepEqual(fleetPublicIntel(s),before);
 s.economy.outposts[1]!.drillers+=1;assert.equal(fleetPublicIntel(s)[1]!.drillers,before[1]!.drillers+1);
 s.economy.players[1]!.active=false;assert.equal(fleetPublicIntel(s)[1]!.npPerDay,0);
});
test('public production rate is theoretical despite capacity saturation, and fleet dispatch preserves total troops',()=>{
 const s=createFleetScenario(setup());s.economy.outposts[0]!.drillers=1000;
 const before=fleetPublicIntel(s);assert.equal(before[0]!.drillerRate,18); // 144 ticks / 48 ticks × 6 drillers, after opening acceleration.
 const next=submitFleetOrder(s,{id:'depart',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:50}}).state;
 assert.deepEqual(fleetPublicIntel(next),before);
 s.economy.outposts[0]!.destroyed=true;
 assert.equal(fleetPublicIntel(s)[0]!.drillerRate,0);
});
