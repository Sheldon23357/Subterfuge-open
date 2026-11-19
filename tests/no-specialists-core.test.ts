import {test} from 'node:test';import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,parseFleetOrder,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/fleet-scenario.js';
import {resolveDrillerPhase} from '../packages/engine/src/combat.js';
import {factoryPeriodTicks,productionAmount} from '../packages/engine/src/economy.js';
import {projectPlayerView} from '../packages/engine/src/player-view.js';
import {fleetPublicIntel} from '../packages/engine/src/world-economy.js';
import {forecastKnownPath,attackRoutes} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {intentSchemaFor} from '../plugins/hybrid/src/intent-protocol.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {projectForecastResult} from '../packages/engine/src/forecast-result.js';
import {createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {applyCoordinatedOrder} from '../packages/server/src/player-commands.js';
import {manualCommandView,ManualCommandConflict} from '../packages/server/src/manual-commands.js';
import {saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {RULES} from '../packages/rules/src/index.js';
import {parseProtocolAction} from '../packages/contracts/src/index.js';
import {originalMapCandidate} from '../packages/engine/src/map-generation.js';
import {originalCandidate} from '../packages/engine/src/original-map.generated.js';
function setup():FleetSetup{return {
 size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:.2,y:0}},match:{mode:'mining',neptuniumGoal:200},
 economy:{initialTick:100,teamSize:0,players:[{active:true,neptunium:0,minesCreated:0},{active:true,neptunium:0,minesCreated:0}],outposts:['a','b'].map((id,i)=>({id,owner:i,type:'generator',drillers:i===0?50:5,shield:0,shieldMax:10,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))},
};}
test('ordinary production and combat have no unit-type modifiers',()=>{
 assert.equal('SpecialistParams'in RULES,false);assert.equal('HoursBeforeFirstHire'in RULES.GameParams,false);
 assert.ok(factoryPeriodTicks()>0);assert.equal(productionAmount({funders:0,capacity:100,currentDrillers:99}),1);
 assert.deepEqual(resolveDrillerPhase({attackerDrillers:15,defenderDrillers:10,shield:5,isOutpost:true}),{attacker:0,defender:0,shield:0,winner:'defender',attackerLoss:15,defenderLoss:10});
 assert.equal(resolveDrillerPhase({attackerDrillers:10,defenderDrillers:10,shield:0,isOutpost:false}).winner,'draw');
});

test('ordinary map adaptation preserves seeded geometry, building allocation and starting troops',()=>{
 for(const players of [2,4,6,10])for(let seed=4300;seed<=4320;seed++){
  const {queens,...reference}=originalCandidate(players,seed),current=originalMapCandidate(players,seed);
  assert.deepEqual(current,{...reference,startingOutposts:queens.map(({owner,outpost}:{owner:number;outpost:number})=>({owner,outpost}))});
  if(current.valid)for(let player=0;player<players;player++){
   const own=current.outposts.filter(p=>p.owner===player);assert.equal(own.length,5);assert.equal(own.reduce((n,p)=>n+p.drillers,0),160);
  }
 }
});
test('state, observations and commands do not expose recruitment or passengers',()=>{
 const s=createFleetScenario(setup()),view=projectPlayerView(s,0);
 assert.equal('specialists'in s,false);assert.equal('recruitment'in view,false);assert.equal('specialists'in view,false);assert.equal('specialistCount'in view.self,false);
 for(const action of [{kind:'hire',choice:0,hireNumber:1},{kind:'promote',specialistId:'x'},{kind:'change-course',fleetId:'x',destination:'b'},{kind:'launch',source:'a',destination:'b',drillers:0},{kind:'launch',source:'a',destination:'b',drillers:1,specialistIds:[]}]){
  assert.throws(()=>parseFleetOrder({id:'invalid',player:0,action}));assert.throws(()=>parseProtocolAction(action));
 }
 assert.throws(()=>createFleetScenario({...setup(),specialists:[]} as FleetSetup));
});
test('capture eliminates an opponent without assets and snapshot replay stays exact',()=>{
 const start=createFleetScenario(setup()),sent=submitFleetOrder(start,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:40}}).state,end=advanceFleetScenario(sent,130);
 assert.equal(end.economy.outposts.find(p=>p.id==='b')!.owner,0);assert.equal(end.economy.players[1]!.active,false);
 assert.ok(end.events.some(e=>e.kind==='player-eliminated'&&e.details.reason==='assets-lost'));assert.ok(end.events.some(e=>e.kind==='game-ended'));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(end)),end);
});
test('a player without posts stays active while a positive fleet can recapture',()=>{
 const cfg=setup();cfg.positions.b={x:.1,y:0};cfg.positions.c={x:4,y:0};cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id:'c',owner:null,drillers:0});
 cfg.economy.outposts[1]!.drillers=30;
 let s=createFleetScenario(cfg);s=submitFleetOrder(s,{id:'survivor',player:0,action:{kind:'launch',source:'a',destination:'c',drillers:50}}).state;
 s=submitFleetOrder(s,{id:'take-home',player:1,action:{kind:'launch',source:'b',destination:'a',drillers:25}}).state;
 s=advanceFleetScenario(s,110);assert.equal(s.economy.outposts.some(p=>p.owner===0),false);assert.equal(s.economy.players[0]!.active,true);
 s=advanceFleetScenario(s,210);assert.equal(s.economy.outposts.find(p=>p.id==='c')!.owner,0);assert.equal(s.economy.players[0]!.active,true);
});
test('authorized prediction and programmatic candidates use only ordinary units',()=>{
 const s=createFleetScenario(setup()),o:PlayerObservation={roomId:'core',revision:'basis',outpostNames:{a:'ALPHA',b:'BRAVO'},view:projectPlayerView(s,0),intel:fleetPublicIntel(s),scheduled:[],secondsSinceLastTick:0,historyStartTick:100,realtime:false};
 const f=forecastKnownPath(o,{targetTick:130,drafts:[{id:'raid',issueTick:100,action:{kind:'launch',source:'a',destination:'b',drillers:40}}]});
 assert.equal(f.forecast.status,'conditional');if(f.forecast.status==='conditional'){
  assert.equal('specialists'in f.forecast.result,false);assert.equal('recruitment'in f.forecast.result,false);
  assert.equal(f.forecast.result.outposts.find(p=>p.id==='b')!.owner,0);
 }
 const d=planBot(o,attackRoutes(o),{maxSimulations:12,maxElapsedMs:3000});
 assert.ok(d.assessments.length>0);assert.ok(d.assessments.every(a=>String(a.candidate.kind)!=='specialist'));
 assert.ok(d.assessments.every(a=>a.candidate.drafts.every(d=>!('specialistIds'in d.action)&&!['hire','promote','release-prisoner','change-course'].includes(String(d.action.kind)))));
});
test('hybrid inputs contain no obsolete units, actions or configuration fields',()=>{
 const s=createFleetScenario(setup()),o:PlayerObservation={roomId:'core',revision:'basis',outpostNames:{a:'ALPHA',b:'BRAVO'},view:projectPlayerView(s,0),intel:fleetPublicIntel(s),scheduled:[],secondsSinceLastTick:0,historyStartTick:100,realtime:false};
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState('core',0,{mode:'hybrid',model:'mock',personality:'schemer'});
 const brief=makeBrief({id:'strategy',kind:'strategy',scope:'global',posts:['a','b'],messageIds:[],players:[1]},state,snapshot,initialHybridState());
 assert.doesNotMatch(JSON.stringify(brief),/专家|女王|公主|王室|招募|俘虏|晋升|specialist|recruitment|royal|Queen|Princess|\bhire\b/);
 assert.doesNotMatch(JSON.stringify(intentSchemaFor('strategy',['a','b'])),/experts|specialist|recruitment/);
});

test('server forecast preserves ordinary fleets, fog boundaries and known captures',()=>{
 const s=createFleetScenario(setup()),k=prepareForecastKnowledge(s,0),built=buildForecastWorld(k);
 assert.equal(k.format,'forecast-knowledge/2');assert.equal(built.status,'conditional');
 if(built.status!=='conditional')return;
 const sent=submitFleetOrder(built.state,{id:'forecast-raid',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:40}}).state;
 const future=advanceFleetScenario(sent,130,true),projected=projectForecastResult(k,future);
 assert.equal(projected.outposts.find(p=>p.id==='b')!.owner,0);
 assert.equal('specialists'in k,false);assert.equal('recruitment'in k,false);
 const hidden=setup();hidden.positions.b={x:20,y:0};hidden.size={width:60,height:60};
 const secret=prepareForecastKnowledge(createFleetScenario(hidden),0),unknown=buildForecastWorld(secret);
 assert.equal(unknown.status,'conditional');if(unknown.status==='conditional'){
  assert.ok(unknown.state.economy.outposts.find(p=>p.id==='b')!.futureUnknown);
  const p=projectForecastResult(secret,advanceFleetScenario(unknown.state,110,true)).outposts.find(p=>p.id==='b')!;
  assert.equal(p.visibility,0);assert.equal('drillers'in p,false);assert.equal('type'in p,false);
 }
});

test('remote mines retain fog while public ownership remains known',()=>{
 const cfg=setup();cfg.positions.b={x:20,y:0};cfg.size={width:60,height:60};cfg.economy.outposts[1]!.type='mine';
 const state=createFleetScenario(cfg),post=projectPlayerView(state,0).outposts.find(p=>p.id==='b')!;
 assert.equal(post.visibility,0);assert.equal(post.owner,1);
 for(const field of ['type','drillers','shield','shieldMax','metrics'])assert.equal(field in post,false);
});

test('a generated six-player game contains only ordinary units and survives save/replay',async()=>{
 const room=await createGeneratedRoom(6,4300);
 assert.equal(room.map!.startingOrigins.length,6);
 assert.doesNotMatch(JSON.stringify(room),/specialist|recruitment|queen|princess/i);
 for(let player=0;player<6;player++){
  const own=room.state.economy.outposts.filter(p=>p.owner===player);
  assert.equal(own.length,5);assert.equal(own.reduce((n,p)=>n+p.drillers,0),160);
 }
 const advanced=advanceFleetScenario(room.state,30);
 assert.ok(advanced.economy.players.every(p=>p.active));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(advanced)),advanced);
});

test('manual fleet protection, troop reservations and room persistence remain enforced',()=>{
 const room:LabRoom={state:createFleetScenario(setup()),scheduled:[]};
 const sent=applyCoordinatedOrder(room,{id:'human-attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:10}},'manual',0);
 const fleet=sent.state.fleets.find(f=>f.used&&f.owner===0)!;
 assert.ok(manualCommandView(sent,0).protections.some(p=>p.kind==='fleet'&&p.scope.includes(`fleet:${fleet.id}`)));
 assert.throws(()=>applyCoordinatedOrder(sent,{id:'agent-return',player:0,action:{kind:'return-fleet',fleetId:fleet.id}},'agent',0),ManualCommandConflict);
 const returned=applyCoordinatedOrder(sent,{id:'human-return',player:0,action:{kind:'return-fleet',fleetId:fleet.id}},'manual',0);
 assert.equal(returned.state.fleets.find(f=>f.id===fleet.id)!.drillers,5);
 const restored=restoreRoom(saveRoom(returned));assert.deepEqual(restored.state,returned.state);assert.deepEqual(restored.manualCoordination,returned.manualCoordination);
 const reserved=applyCoordinatedOrder(room,{id:'human-future',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:35}},'manual',0,101);
 assert.ok(manualCommandView(reserved,0).protections.some(p=>p.kind==='resources'));
 assert.throws(()=>applyCoordinatedOrder(reserved,{id:'agent-spend',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:20}},'agent',0),ManualCommandConflict);
 assert.deepEqual(restoreRoom(saveRoom(reserved)).manualCoordination,reserved.manualCoordination);
});
