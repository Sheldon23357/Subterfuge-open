import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,advanceFleetScenario,submitFleetOrder,fleetMatchOutcome,restoreFleetSnapshot,saveFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {advanceRoom,scheduleLaunch,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
function setup():FleetSetup{
 const s=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 s.match={mode:'mining',neptuniumGoal:200};return s;
}

test('mining victory freezes world at terminal tick and restores deterministically',()=>{
 const cfg=setup();cfg.economy.players[1]!.neptunium=199;cfg.economy.outposts[1]!.miningProgress=1000;
 const initial=createFleetScenario(cfg),before=JSON.stringify(initial),ended=advanceFleetScenario(initial,200);
 assert.equal(ended.economy.tick,101);assert.deepEqual(fleetMatchOutcome(ended),{ended:true,tick:101,triggeringSeat:1,triggeringTeam:null});
 assert.equal(JSON.stringify(initial),before);assert.deepEqual(advanceFleetScenario(ended,300),ended);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(ended)),ended);
 assert.throws(()=>submitFleetOrder(ended,{id:'late',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}),/ended/);
});
test('original resignation clears resources and funding; terminal order remains idempotent',()=>{
 const initial=createFleetScenario(setup());initial.economy.funding[0]![1]=true;initial.economy.funding[1]![0]=true;
 const order={id:'resign-1',player:1,action:{kind:'resign' as const}};
 const s=submitFleetOrder(initial,order).state;
 assert.equal(s.economy.players[1]!.neptunium,0);assert.equal(s.economy.players[1]!.active,false);assert.ok(s.economy.funding.flat().every(v=>!v));
 assert.equal(s.economy.outposts[1]!.owner,1);assert.equal(fleetMatchOutcome(s)!.triggeringSeat,0);assert.equal(submitFleetOrder(s,order).duplicate,true);
 // Replay fixture without out-of-band funding edits.
 const replayable=submitFleetOrder(createFleetScenario(setup()),order).state;
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(replayable)),replayable);
});
test('scheduled orders after an earlier terminal tick fail without advancing the finished world',()=>{
 const cfg=setup();cfg.economy.players[1]!.neptunium=199;cfg.economy.outposts[1]!.miningProgress=1000;
 // Accept a plan while victory has not yet happened; store a pre-existing pending plan to test execution.
 const room:LabRoom={state:createFleetScenario(cfg),scheduled:[{id:'future',player:0,action:{kind:'launch' as const,source:'蓝方工厂',destination:'红方后方',drillers:1,delaySeconds:1200},issueTick:105,departureTick:107,status:'pending' as const}]};
 const ended=advanceRoom(room,110);assert.equal(ended.state.economy.tick,101);assert.equal(ended.scheduled[0]!.status,'failed');assert.match(ended.scheduled[0]!.reason!,/ended/);
 assert.equal(advanceRoom(room,101).scheduled[0]!.status,'failed');
 assert.deepEqual(restoreRoom(saveRoom(ended)),ended);
 assert.throws(()=>scheduleLaunch({state:createFleetScenario(cfg),scheduled:[]},{order:{id:'new',player:0,action:room.scheduled[0]!.action},departureTick:107}),/ended/);
});
test('domination excludes mines and team victory uses original team goal',()=>{
 const cfg=setup();cfg.match!.mode='domination';
 const template=cfg.economy.outposts[0]!;cfg.economy.outposts=[];cfg.positions={};
 for(let i=0;i<11;i++){const id=`p${i}`;cfg.economy.outposts.push({...template,id,owner:0,type:i===10?'mine':'factory'});cfg.positions[id]={x:0,y:0};}
 cfg.economy.outposts.push({...template,id:'enemy-post',owner:1,type:'generator',drillers:1});cfg.positions['enemy-post']={x:8,y:0};
 assert.equal(fleetMatchOutcome(createFleetScenario(cfg)),null);
 assert.throws(()=>submitFleetOrder(createFleetScenario(cfg),{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:'p0'}}),/disabled/);
 cfg.economy.outposts[10]!.type='generator';assert.equal(fleetMatchOutcome(createFleetScenario(cfg))!.triggeringSeat,0);
 const team=setup();team.economy.players=Array.from({length:4},()=>({active:true,neptunium:100,minesCreated:0}));team.economy.teamSize=2;
 for(const player of [2,3]){const id=`team-opponent-${player}`;team.positions[id]={x:player,y:2};team.economy.outposts.push({...team.economy.outposts[0]!,id,owner:player});}
 assert.equal(fleetMatchOutcome(createFleetScenario(team))!.triggeringTeam,0);
});
test('last outpost loss resolves elimination before the terminal event and freezes subsequent ticks',()=>{
 const cfg=setup();cfg.economy.outposts[2]!.owner=0;
 const start=submitFleetOrder(createFleetScenario(cfg),{id:'attack',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:80}}).state;
 const ended=advanceFleetScenario(start,120),outcome=fleetMatchOutcome(ended)!;
 assert.equal(outcome.triggeringSeat,0);assert.ok(outcome.tick<120);
 assert.ok(ended.events.findIndex(e=>e.kind==='player-eliminated')<ended.events.findIndex(e=>e.kind==='game-ended'));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(ended)),ended);
});
test('legacy scenarios keep opt-out semantics and malformed match configuration is rejected',()=>{
 const cfg=setup();delete cfg.match;cfg.economy.players[1]!.active=false;
 assert.equal(advanceFleetScenario(createFleetScenario(cfg),110).economy.tick,110);
 assert.throws(()=>createFleetScenario({...cfg,match:null as never}));
});

