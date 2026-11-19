import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,prepareForecastKnowledge,buildForecastWorld,projectPlayerView,type FleetSetup} from '../packages/engine/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {advanceRoom,type LabRoom} from '../packages/server/src/planning.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
function setup():FleetSetup{return{size:{width:80,height:80},positions:{a:{x:0,y:0},b:{x:20,y:0},c:{x:30,y:30},d:{x:35,y:35}},economy:{initialTick:100,teamSize:2,
 players:[0,2,99,88].map(minesCreated=>({active:true,neptunium:0,minesCreated})),
 outposts:['a','b','c','d'].map((id,i)=>({id,owner:i,type:'generator',drillers:400,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};}
test('team forecast restores allied mine history and uses original same-tick team mining competition',()=>{
 let room:LabRoom={state:createFleetScenario(setup()),scheduled:[]};
 assert.equal(projectPlayerView(room.state,0).outposts[1]!.visibility,2);
 const knowledge=prepareForecastKnowledge(room.state,0),built=buildForecastWorld(knowledge);
 assert.deepEqual(knowledge.retainedWorld.players.slice(0,2).map((p,player)=>[player,p.minesCreated]),[[0,0],[1,2]]);
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.deepEqual(built.state.economy.players.map(p=>p.minesCreated),[0,2,99,88]);
 room=scheduleOrder(room,{order:{id:'mine-own',player:0,action:{kind:'toggle-mine',outpostId:'a'}},issueTick:101});
 room=scheduleOrder(room,{order:{id:'mine-ally',player:1,action:{kind:'toggle-mine',outpostId:'b'}},issueTick:101});
 const before=JSON.stringify(room),result=simulatePlayerFuture(room,0,102),reference=advanceRoom(room,102,true);
 assert.equal(result.status,'conditional');if(result.status!=='conditional')return;
 // Original rules >=26: nonzero team count costs count*100; pending adds one.
 assert.equal(reference.state.economy.outposts[0]!.drillers,200);
 assert.equal(reference.state.economy.outposts[1]!.drillers,100);
 assert.deepEqual(result.result.outposts.slice(0,2),projectPlayerView(reference.state,0).outposts.slice(0,2));
 assert.deepEqual(result.orders.map(o=>o.id),['mine-own']);assert.equal(JSON.stringify(room),before);
});
test('inactive ally mining history affects team cost; opponent history stays outside player output',()=>{
 const cfg=setup();cfg.economy.players[1]!.active=false;const state=createFleetScenario(cfg),before=prepareForecastKnowledge(state,0);
 assert.equal(before.retainedWorld.players[1]!.minesCreated,2);
 state.economy.players[2]!.minesCreated=123456;
 const after=prepareForecastKnowledge(state,0);
 assert.deepEqual(after.view,before.view);assert.deepEqual(after.retainedWorld.players.slice(0,2),before.retainedWorld.players.slice(0,2));
 const built=buildForecastWorld(before);assert.equal(built.status,'conditional');
 if(built.status==='conditional')assert.equal(built.state.economy.players[1]!.minesCreated,2);
});
test('native funding graph is retained internally',()=>{
 const room:LabRoom={state:createFleetScenario(setup()),scheduled:[]};
 room.state.economy.funding[2]![1]=true;
 const built=buildForecastWorld(prepareForecastKnowledge(room.state,0));assert.equal(built.status,'conditional');
 if(built.status==='conditional')assert.equal(built.state.economy.funding[2]![1],true);

});
