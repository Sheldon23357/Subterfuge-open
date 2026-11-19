import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,advanceFleetScenario,submitFleetOrder,saveFleetSnapshot,restoreFleetSnapshot,fleetStandings,projectPlayerView,type FleetSetup} from '../packages/engine/src/index.js';
import {originalInactivity} from '../packages/engine/src/original-inactivity.generated.js';
import {tickInactivity} from '../packages/engine/src/inactivity.js';
import {createFleetReplaySession,exportFleetReplay} from '../packages/engine/src/index.js';
import {ACTIVITY_RULES,INACTIVITY_RULE_SECONDS,REALTIME_TICK_MILLISECONDS,TICK_SECONDS} from '../packages/rules/src/index.js';
import {prepareForecastKnowledge,buildForecastWorld} from '../packages/engine/src/index.js';
import {createGeneratedRoom} from '../packages/server/src/generated-room.js';
import {startRealtime,catchUpRealtime} from '../packages/server/src/realtime.js';
function setup():FleetSetup{return {match:{mode:'mining',neptuniumGoal:200},size:{width:80,height:80},positions:{a:{x:0,y:0},b:{x:30,y:0},c:{x:-30,y:0}},
 economy:{initialTick:0,teamSize:0,players:Array.from({length:3},()=>({active:true,neptunium:10,minesCreated:0})),outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:10,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))},
 };}
test("inactivity preserves the non-linear first warning interval (local rules)",()=>{

 assert.deepEqual([959,960,1319,1320,1679,1680,2879].map(originalInactivity.warningCount),[0,1,1,1,1,2,5]);
});
test('warning at 16 hours, check-in preserves warning until tick, explicit cancellation resets immediately',()=>{
 let s=advanceFleetScenario(createFleetScenario(setup()),95);assert.equal(s.activity![0]!.inactivityWarningCount,0);
 s=advanceFleetScenario(s,96);assert.equal(s.activity![0]!.inactivityWarningCount,1);
 assert.equal(s.events.filter(e=>e.kind==='inactivity-warning').length,3);
 const checked=submitFleetOrder(s,{id:'check',player:0,action:{kind:'check-in'}},590).state;
 assert.equal(checked.activity![0]!.lastCheckinTime,58190);assert.equal(checked.activity![0]!.inactivityWarningCount,1);
 const next=advanceFleetScenario(checked,97);assert.equal(next.activity![0]!.inactivityWarningCount,0);
 const canceled=submitFleetOrder(s,{id:'dismiss',player:0,action:{kind:'cancel-inactivity-warning'}},590).state;
 assert.equal(canceled.activity![0]!.lastCheckinTime,58190);assert.equal(canceled.activity![0]!.inactivityWarningCount,0);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(canceled)),canceled);
});
test('successful ordinary actions renew activity and clear warnings',()=>{
 let s=advanceFleetScenario(createFleetScenario(setup()),96);
 s=submitFleetOrder(s,{id:'shield',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}}).state;
 assert.equal(s.activity![0]!.inactivityWarningCount,0);assert.equal(s.activity![0]!.lastCheckinTime,96*600);
 s=advanceFleetScenario(s,97);assert.equal(s.activity![0]!.inactivityWarningCount,0);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});

test('failed orders and duplicate deliveries do not renew activity or mutate warnings',()=>{
 const s=advanceFleetScenario(createFleetScenario(currentSetup()),100),before=saveFleetSnapshot(s);
 assert.throws(()=>submitFleetOrder(s,{id:'invalid',player:0,action:{kind:'launch',source:'b',destination:'a',drillers:1}},590),/Invalid source/);
 assert.equal(saveFleetSnapshot(s),before);
 const order={id:'accepted-once',player:0,action:{kind:'set-shields' as const,outpostId:'a',enabled:false}};
 const accepted=submitFleetOrder(s,order,100).state;
 assert.equal(accepted.activity![0]!.lastCheckinTime,60100);
 const later=advanceFleetScenario(accepted,101),duplicate=submitFleetOrder(later,order,590);
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.state.activity![0]!.lastCheckinTime,60100);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(duplicate.state)),duplicate.state);
});

test('successful launch renews only its issuer activity, including fractional time',()=>{
 const s=advanceFleetScenario(createFleetScenario(currentSetup()),100);
 const next=submitFleetOrder(s,{id:'launch-renews',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:1}},590).state;
 assert.equal(next.activity![0]!.lastCheckinTime,60590);
 assert.deepEqual(next.activity!.slice(1),s.activity!.slice(1));
 assert.equal(s.activity![0]!.lastCheckinTime,0);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(next)),next);
 const built=buildForecastWorld(prepareForecastKnowledge(s,0));
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 const forecast=submitFleetOrder(built.state,{id:'forecast-renews',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},590).state;
 assert.equal(forecast.forecastActivity!.value.lastCheckinTime,60590);
 assert.equal(s.activity![0]!.lastCheckinTime,0);
});

test('recorded action check-ins preserve existing history and renew new orders after recovery',()=>{
 const state=submitFleetOrder(advanceFleetScenario(createFleetScenario(currentSetup()),100),{id:'historic-order',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},590).state;
 const saved=JSON.parse(saveFleetSnapshot(state));
 // Existing accepted commands cleared warnings without renewing the activity time.
 delete saved.replay.commands[0].activityCheckin;delete saved.expected.commands[0].activityCheckin;
 saved.expected.activity[0].lastCheckinTime=0;
 const restored=restoreFleetSnapshot(JSON.stringify(saved));
 assert.deepEqual(restored,saved.expected);
 let next=advanceFleetScenario(restored,101);
 next=submitFleetOrder(next,{id:'new-order',player:0,action:{kind:'set-shields',outpostId:'a',enabled:true}},200).state;
 assert.equal(next.activity![0]!.lastCheckinTime,60800);
 assert.deepEqual(next.commands[0],restored.commands[0]);
 assert.equal(next.commands[1]!.activityCheckin,true);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(next)),next);
 const replay=createFleetReplaySession(exportFleetReplay(next));replay.begin(101);
 while(!replay.step()){}
 assert.deepEqual(replay.snapshot().activity,next.activity);
 assert.deepEqual(replay.snapshot().events,next.events);
 const bad=JSON.parse(saveFleetSnapshot(next));bad.replay.commands[1].activityCheckin=false;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(bad)),/Invalid action check-in record/);
 delete bad.replay.commands[1].activityCheckin;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(bad)),/disagree/);
});
test('48-hour autoresign runs after world rules and clears funding and NP',()=>{
 const cfg=setup();cfg.economy.players[1]!.neptunium=150;let s=createFleetScenario(cfg);s=submitFleetOrder(s,{id:'fund',player:1,action:{kind:'toggle-funding',recipient:0}}).state;
 s=advanceFleetScenario(s,200);s=submitFleetOrder(s,{id:'present',player:0,action:{kind:'check-in'}}).state;
 s=advanceFleetScenario(s,287);assert.ok(s.economy.players.every(p=>p.active));
 s=advanceFleetScenario(s,288);assert.deepEqual(s.economy.players.map(p=>p.active),[true,false,false]);
 assert.equal(s.economy.players[1]!.neptunium,0);assert.ok(s.economy.funding.every(row=>row.every(v=>!v)));
 assert.deepEqual(s.activity!.map(a=>a.autoResigned),[false,true,true]);
 assert.deepEqual(fleetStandings(s).winners,[0]);assert.ok(s.activity!.every(a=>a.inactivityWarningCount===0));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
 // Repeated future activity checks do not re-retire inactive players.
 const copy=structuredClone(s);copy.economy.tick=10000;tickInactivity(copy,true);
});
test('simulated future suppresses auto-resignation; self activity does not disclose another seat',()=>{
 const s=createFleetScenario(setup());s.economy.tick=288;tickInactivity(s,true);assert.ok(s.economy.players.every(p=>p.active));
 const view=projectPlayerView(s,0),copy=structuredClone(s);copy.activity![1]!.lastCheckinTime=123456;
 assert.deepEqual(projectPlayerView(copy,0),view);assert.deepEqual(view.self.activity,s.activity![0]);
});




test('authoritative offline advancement auto-resigns while isolated preview does not mutate the room',()=>{
 const s=createFleetScenario(setup()),before=JSON.stringify(s);
 const future=advanceFleetScenario(s,300,true);assert.ok(future.economy.players.every(p=>p.active));assert.equal(future.economy.tick,300);
 const live=advanceFleetScenario(s,300);assert.ok(live.economy.players.every(p=>!p.active));assert.equal(live.economy.tick,288);
 assert.equal(JSON.stringify(s),before);assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(live)),live);
});

function currentSetup(){const cfg=setup();cfg.match!.activityRules=ACTIVITY_RULES;return cfg;}
test('new matches pin three real hours while old match snapshots keep their original rules',async()=>{
 const room=await createGeneratedRoom(2,4300);
 assert.equal(room.state.initial.match!.activityRules,ACTIVITY_RULES);
 assert.equal(INACTIVITY_RULE_SECONDS/TICK_SECONDS*REALTIME_TICK_MILLISECONDS,3*60*60*1000);
 const legacy=advanceFleetScenario(createFleetScenario(setup()),288);
 assert.ok(legacy.economy.players.every(p=>!p.active&&p.neptunium===0));
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(legacy)),legacy);
 const cfg=currentSetup();(cfg.match as {activityRules:string}).activityRules='unknown';
 assert.throws(()=>createFleetScenario(cfg),/activity rules/);
});
test('three-hour inactivity retains mined inventory and clears funding without awarding an inactive winner',()=>{
 const cfg=currentSetup();cfg.economy.players[1]!.neptunium=150;
 let s=submitFleetOrder(createFleetScenario(cfg),{id:'fund-new',player:1,action:{kind:'toggle-funding',recipient:0}}).state;
 s=advanceFleetScenario(s,1000);
 s=submitFleetOrder(s,{id:'present-new',player:0,action:{kind:'check-in'}}).state;
 s=advanceFleetScenario(s,1079);assert.ok(s.economy.players.every(p=>p.active));
 s=advanceFleetScenario(s,1080);
 assert.deepEqual(s.economy.players.map(p=>({active:p.active,np:p.neptunium})),[{active:true,np:10},{active:false,np:150},{active:false,np:10}]);
 assert.ok(s.economy.funding.every(row=>row.every(v=>!v)));
 const standings=fleetStandings(s);assert.deepEqual(standings.winners,[0]);
 assert.equal(standings.players.find(p=>p.seat===1)!.neptunium,150);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('fractional check-in renews the full three-hour window across restart',()=>{
 let s=advanceFleetScenario(createFleetScenario(currentSetup()),100);
 s=submitFleetOrder(s,{id:'fractional',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}},590).state;
 s=restoreFleetSnapshot(saveFleetSnapshot(s));
 // Keep the other seats present so their retirement does not end this test early.
 s=advanceFleetScenario(s,1000);
 for(const player of [1,2])s=submitFleetOrder(s,{id:`renew-${player}`,player,action:{kind:'check-in'}}).state;
 s=advanceFleetScenario(s,1180);assert.equal(s.economy.players[0]!.active,true);
 s=advanceFleetScenario(s,1181);assert.equal(s.economy.players[0]!.active,false);
 assert.equal(s.economy.players[0]!.neptunium,10);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('an inventory reaching the mining goal on automatic retirement cannot end the match',()=>{
 const cfg=currentSetup();cfg.economy.initialTick=1079;cfg.economy.players[1]!.neptunium=199;
 const mine=cfg.economy.outposts[1]!;mine.type='mine';mine.miningProgress=143;
 let s=createFleetScenario(cfg);s.activity![1]!.lastCheckinTime=0;
 s=advanceFleetScenario(s,1080);
 assert.equal(s.economy.players[1]!.active,false);assert.equal(s.economy.players[1]!.neptunium,200);
 assert.equal(fleetStandings(s).ended,false);
 s=advanceFleetScenario(s,1224);assert.equal(s.economy.players[1]!.neptunium,200);
 assert.equal(fleetStandings(s).ended,false);
});
test('current activity rules survive restricted forecasts without resigning unknown players',()=>{
 const s=createFleetScenario(currentSetup()),built=buildForecastWorld(prepareForecastKnowledge(s,0));
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 assert.equal(built.state.initial.match!.activityRules,ACTIVITY_RULES);
 const future=advanceFleetScenario(built.state,1200,true);
 assert.equal(future.economy.players[0]!.active,true);assert.equal(future.forecastActivity!.value.autoResigned,false);
 assert.equal(s.economy.tick,0);
});
test('real-time offline catch-up keeps inventories and retires exactly at three hours',async()=>{
 const room=startRealtime({state:createFleetScenario(currentSetup()),scheduled:[]},1_000);
 let next=await catchUpRealtime(room,1_000+3*60*60*1000-1);
 assert.equal(next.state.economy.tick,1079);assert.ok(next.state.economy.players.every(p=>p.active));
 next=await catchUpRealtime(next,1_000+3*60*60*1000);
 assert.equal(next.state.economy.tick,1080);assert.ok(next.state.economy.players.every(p=>!p.active&&p.neptunium===10));
 assert.deepEqual(fleetStandings(next.state).winners,[]);
 const restored=restoreFleetSnapshot(saveFleetSnapshot(next.state));assert.deepEqual(restored,next.state);
 const ended=await catchUpRealtime({...next,state:restored},1_000+12*60*60*1000);
 assert.deepEqual(ended.state,next.state);assert.equal(room.state.economy.tick,0);
});
