import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,advanceFleetScenario,submitFleetOrder,projectPlayerNotifications as rawNotifications,type FleetSetup,type FleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {classifyChanges,classifyNotice,makeTask} from '../packages/ai/src/controller/runtime/decision.js';import {AiStore,initialState,type AiSnapshot,type DecisionSignal} from '../packages/ai/src/index.js';
const projectPlayerNotifications=(s:FleetScenario,seat:number)=>rawNotifications(s,seat).map((n,i)=>({...n,id:i}));
function setup():FleetSetup{
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.economy.initialTick=100;cfg.match={mode:'mining',neptuniumGoal:200};

 return cfg;
}
const obs=(s:FleetScenario,seat=0)=>observation({state:s,scheduled:[]},seat,'notice-fix');

test('real inactivity notification is urgent without location, shares the state cause, and ignores cleared warnings',()=>{
 const before=createFleetScenario(setup()),after=advanceFleetScenario(before,196),n=projectPlayerNotifications(after,0).find(n=>n.kind==='inactivity-warning')!;
 assert.ok(n);assert.equal(n.location,null);const o=obs(after),signals=classifyChanges(obs(before),o).important;
 const s=classifyNotice(n,o.view,{signals})!;assert.equal(s.key,'activity');assert.equal(s.urgent,true);
 assert.equal(makeTask([...signals.filter(x=>x.key==='activity'),s],[],[],false).reasons.length,1);
 const clear=structuredClone(o.view);clear.self.activity!.inactivityWarningCount=0;assert.equal(classifyNotice(n,clear),null);delete clear.self.activity;assert.equal(classifyNotice(n,clear),null);
});

test('actual enemy mine announcement wakes an existing attack target, not an unrelated public announcement',()=>{
 const cfg=setup();cfg.economy.outposts.find(p=>p.id==='蓝方工厂')!.drillers=300;
 let world=createFleetScenario(cfg);world=submitFleetOrder(world,{id:'mine-real',player:0,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}}).state;world=advanceFleetScenario(world,102);
 const n=projectPlayerNotifications(world,1).find(n=>n.kind==='mine-created')!;assert.ok(n);const o=obs(world,1);
 assert.equal(classifyNotice(n,o.view,{observation:o}),null);
 o.scheduled=[{id:'pending-mine-attack',player:1,issueTick:103,status:'pending',action:{kind:'launch',source:'红方矿场',destination:n.location!.id,drillers:1}}];
 assert.ok(classifyNotice(n,o.view,{observation:o}));
 o.scheduled[0]!.status='cancelled';assert.equal(classifyNotice(n,o.view,{observation:o}),null);o.scheduled=[];
 o.view.fleets.push({id:'our-attack',owner:1,drillers:1,position:{x:0,y:0},state:'moving',gift:false,destination:{kind:'outpost',id:n.location!.id}});
 const prior={key:`attack-target:${n.location!.id}`,category:'military' as const,reason:'已有目标变化',entities:[n.location!.id],urgent:true};
 const s=classifyNotice(n,o.view,{observation:o,signals:[prior]})!;assert.equal(s.key,prior.key);assert.equal(s.reason,prior.reason);assert.ok(s.entities.includes('our-attack'));
 o.view.fleets.at(-1)!.gift=true;assert.equal(classifyNotice(n,o.view,{observation:o}),null);
 assert.equal(projectPlayerNotifications(world,0).some(n=>n.kind==='mine-created'),false);
});



test('zero-based notification-only pages process index zero and the next boundary once each',async()=>{
 const world=advanceFleetScenario(createFleetScenario(setup()),268);
 const notices=projectPlayerNotifications(world,1).filter(n=>n.kind==='inactivity-warning');assert.deepEqual(notices.map(n=>n.id),[0,1]);
 let snapshot:AiSnapshot={observation:obs(world,1),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:1,chatCount:2};
 const store=new AiStore(':memory:'),state=initialState('notice-fix',1,{model:'',personality:'sentinel'});let calls=0;
 const runner=new SeatRunner(state,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No writes');}},{step:async()=>{calls++;return {tokens:1,reply:{tool:'finish',arguments:'{}',summary:'page processed'}};}});
 try{
  await runner.pollAndFlush(0);assert.equal(calls,1);
  snapshot={...snapshot,notifications:[notices[0]!],notificationCursor:1};await runner.pollAndFlush(6000);await runner.pollAndFlush(22000);assert.equal(calls,2);assert.equal(state.notificationCursor,1);
  snapshot={...snapshot,notifications:[notices[1]!],notificationCursor:2};await runner.pollAndFlush(28000);await runner.pollAndFlush(44000);assert.equal(calls,3);assert.equal(state.notificationCursor,2);
  await runner.pollAndFlush(50000);assert.equal(calls,3);
 }finally{runner.pause();store.close();}
});
