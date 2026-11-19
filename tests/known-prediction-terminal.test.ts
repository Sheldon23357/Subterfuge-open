import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,advanceFleetScenario,submitFleetOrder,fleetMatchOutcome,detectEndCondition,saveFleetSnapshot,type FleetSetup,type FleetScenario} from '../packages/engine/src/index.js';
import {createKnownPrediction,estimateKnownArrivals,previewKnownDeployment} from '../packages/prediction/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function setup(){const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.match={mode:'mining',neptuniumGoal:200};return cfg;}
function observed(state:FleetScenario,player=1){return observation({state,scheduled:[]},player,'terminal-test');}
function forecast(state:FleetScenario,player=1,target=120){const result=createKnownPrediction(observed(state,player)).predict(target);assert.equal(result.status,'conditional');if(result.status!=='conditional')throw Error('unsupported');return result;}
function nearWin(){const cfg=setup();cfg.economy.players[1]!.neptunium=199;cfg.economy.outposts[1]!.miningProgress=71;return cfg;}

test('first shared-rule crossing stops economy before later visible loss and skips terminal orders',()=>{
 const live=submitFleetOrder(createFleetScenario(nearWin()),{id:'attack',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:80}}).state;
 const now=observed(live),saved=JSON.stringify(now),actual=advanceFleetScenario(live,120);
 const session=createKnownPrediction(now,{drafts:[{id:'after-end',issueTick:105,action:{kind:'launch',source:'红方后方',destination:'蓝方工厂',drillers:1}}]});
 const result=session.predict(120);assert.equal(result.status,'conditional');if(result.status!=='conditional')return;
 assert.equal(result.result.targetTick,101);assert.equal(result.result.requestedTargetTick,120);
 assert.deepEqual(result.result.terminalPrediction!.firstCrossing,{tick:101,triggeringSeat:1,triggeringTeam:null});
 assert.equal(result.result.self.neptunium,actual.economy.players[1]!.neptunium);assert.equal(result.result.self.neptunium,200);
 assert.equal(result.result.outposts.find(o=>o.id==='红方矿场')!.owner,1);
 assert.equal(result.orders[0]!.status,'skipped-terminal');assert.equal(JSON.stringify(now),saved);
 for(const target of [110,130]){const cached=session.predict(target);assert.equal(cached.status,'conditional');if(cached.status==='conditional')assert.equal(cached.result.targetTick,101);}
 assert.equal(estimateKnownArrivals(now).arrivals[0]!.arrivalTick,null);
 assert.equal(previewKnownDeployment(now,{id:'late',issueTick:105,action:{kind:'launch',source:'红方后方',destination:'蓝方工厂',drillers:1}}).status,'conditional');
});

test('visible opposing mine crossing and same-tick tie use real engine seat order',()=>{
 const cfg=nearWin();cfg.economy.outposts[0]!.type='mine';cfg.economy.outposts[0]!.miningProgress=143;cfg.economy.players[0]!.neptunium=199;
 const state=createFleetScenario(cfg),actual=advanceFleetScenario(state,120),result=forecast(state);
 assert.equal(result.result.terminalPrediction!.firstCrossing!.triggeringSeat,fleetMatchOutcome(actual)!.triggeringSeat);
 assert.equal(result.result.targetTick,fleetMatchOutcome(actual)!.tick);assert.equal(result.result.terminalPrediction!.firstCrossing!.triggeringSeat,0);
});

test('unknown mines cannot be fabricated into a victory or leaked and known crossing remains conditional',()=>{
 const cfg=nearWin();cfg.size={width:80,height:80};cfg.positions['蓝方工厂']={x:30,y:30};
 const state=createFleetScenario(cfg),now=observed(state),a=createKnownPrediction(now).predict(120);
 assert.equal(a.status,'conditional');if(a.status!=='conditional')return;
 assert.equal(a.result.terminalPrediction!.status,'conditional');assert.equal(a.result.match,undefined);
 assert.ok(a.result.terminalPrediction!.reasons.includes('unobserved-outposts'));
 assert.equal(a.result.outposts.find(o=>o.id==='蓝方工厂')!.visibility,0);
 assert.equal('drillers' in a.result.outposts.find(o=>o.id==='蓝方工厂')!,false);
 state.economy.outposts[0]!.miningProgress=100;
 assert.deepEqual(createKnownPrediction(observed(state)).predict(120),a);
 cfg.economy.players[1]!.neptunium=0;const noCross=forecast(createFleetScenario(cfg));
 assert.equal(noCross.result.terminalPrediction!.status,'unknown');assert.equal(noCross.result.terminalPrediction!.firstCrossing,null);
});

test('last outpost loss eliminates only when surviving assets are known absent',()=>{
 const cfg=setup();cfg.economy.outposts[2]!.owner=0;
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'last-post-attack',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:80}}).state;
 const actual=advanceFleetScenario(state,120),own=forecast(state,1),foreign=forecast(state,0);
 assert.ok(fleetMatchOutcome(actual));assert.equal(own.result.self.active,false);
 assert.equal(own.result.terminalPrediction!.firstCrossing!.tick,fleetMatchOutcome(actual)!.tick);
 assert.equal(own.result.terminalPrediction!.status,'conditional');
 const complete=observed(state,1);complete.view.fullMapVisible=true;const proven=createKnownPrediction(complete).predict(120);
 assert.equal(proven.status,'conditional');if(proven.status==='conditional')assert.equal(proven.result.terminalPrediction!.status,'determinate');
 assert.equal(foreign.result.terminalPrediction!.firstCrossing,null);assert.equal(foreign.result.terminalPrediction!.status,'unknown');
 assert.ok(foreign.result.terminalPrediction!.reasons.includes('unobserved-world-possible'));
 const completeOpponent=observed(state,0);completeOpponent.view.fullMapVisible=true;const completeResult=createKnownPrediction(completeOpponent).predict(120);
 assert.equal(completeResult.status,'conditional');if(completeResult.status==='conditional'){assert.equal(completeResult.result.terminalPrediction!.status,'determinate');assert.equal(completeResult.result.terminalPrediction!.firstCrossing!.tick,fleetMatchOutcome(actual)!.tick);}
});

test('restricted engine boundary uses shared domination/team rule and is never authoritative or exportable',()=>{
 for(const [players,teamSize,mode] of [[2,0,'domination'],[4,2,'domination'],[4,2,'mining']] as const){
  const cfg=setup();cfg.economy.teamSize=teamSize;cfg.economy.players=Array.from({length:players},()=>({active:true,neptunium:0,minesCreated:0}));
  for(let player=2;player<players;player++){const id=`opponent-${player}`;cfg.positions[id]={x:player,y:1};cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id,owner:player});}
  const state=createFleetScenario(cfg);state.initial.match={mode,neptuniumGoal:200};state.forecastPlayer=0;state.forecastTerminal={reasons:[]};
  if(mode==='mining'){state.economy.players[0]!.neptunium=100;state.economy.players[1]!.neptunium=100;}
  else {for(let i=0;i<25;i++){const id=`extra-${i}`;state.economy.outposts.push({...state.economy.outposts[0]!,id,owner:0,type:'generator'});state.initial.positions[id]={x:0,y:0};state.initial.economy.outposts.push({...state.initial.economy.outposts[0]!,id,owner:0,type:'generator'});}}
  const seats=state.economy.players.map((p,i)=>({alive:p.active,neptunium:p.neptunium,outposts:state.economy.outposts.filter(o=>o.owner===i&&!o.destroyed&&o.type!=='mine').length}));
  const expected=detectEndCondition(seats,teamSize,mode,200),future=advanceFleetScenario(state,110,true);
  assert.equal(expected.ended,true);assert.equal(future.economy.tick,101);assert.equal(future.forecastTerminal!.firstCrossing!.triggeringSeat,expected.triggeringSeat);
  assert.equal(future.forecastTerminal!.firstCrossing!.triggeringTeam,expected.triggeringTeam);assert.equal(fleetMatchOutcome(future),null);
  assert.throws(()=>saveFleetSnapshot(future),/Prediction/);assert.throws(()=>submitFleetOrder(future,{id:'late',player:0,action:{kind:'check-in'}}),/ended/);
 }
});

test('same tick mine capture is settled before the terminal check, not a precomputed production win',()=>{
 const cfg=setup();cfg.economy.outposts[1]!.shield=0;cfg.economy.outposts[1]!.shieldMax=0;
 let state=submitFleetOrder(createFleetScenario(cfg),{id:'capture',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:80}}).state;
 const battle=advanceFleetScenario(state,120).events.find(e=>e.kind==='battle')!;
 state=advanceFleetScenario(state,battle.tick-1);state.economy.players[1]!.neptunium=199;state.economy.outposts[1]!.miningProgress=71;
 const actual=advanceFleetScenario(state,battle.tick),result=forecast(state,1,battle.tick);
 assert.equal(fleetMatchOutcome(actual),null);assert.equal(result.result.terminalPrediction!.firstCrossing,null);
 assert.equal(result.result.self.neptunium,actual.economy.players[1]!.neptunium);
 assert.ok(result.result.self.neptunium<200);assert.equal(result.result.outposts.find(o=>o.id==='红方矿场')!.owner,0);
});

test('domination capture crosses on the same tick as the real shared engine',()=>{
 const cfg=setup();cfg.match!.mode='domination';cfg.economy.outposts[1]!.type='generator';cfg.economy.outposts[1]!.shield=0;cfg.economy.outposts[1]!.shieldMax=0;
 const goal=Array.from({length:100},(_,outposts)=>outposts).find(outposts=>detectEndCondition([{alive:true,neptunium:0,outposts},{alive:true,neptunium:0,outposts:0}],0,'domination').ended)!;
 for(let i=0;i<goal-2;i++){const id=`owned-${i}`;cfg.economy.outposts.push({...cfg.economy.outposts[0]!,id,type:'generator',drillers:0});cfg.positions[id]={x:0,y:.1+i*.001};}
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'domination-capture',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:80}}).state;
 const actual=advanceFleetScenario(state,120),result=forecast(state,0);
 assert.ok(fleetMatchOutcome(actual));assert.deepEqual(result.result.terminalPrediction!.firstCrossing,{tick:fleetMatchOutcome(actual)!.tick,triggeringSeat:0,triggeringTeam:null});
 assert.equal(result.result.targetTick,fleetMatchOutcome(actual)!.tick);
});

test('hidden opponent can win earlier: a later known crossing is conditional, never an asserted winner',()=>{
 const cfg=nearWin();cfg.size={width:80,height:80};cfg.positions['蓝方工厂']={x:30,y:30};cfg.economy.outposts[0]!.type='mine';cfg.economy.players[0]!.neptunium=199;cfg.economy.outposts[0]!.miningProgress=143;
 cfg.economy.outposts[1]!.miningProgress=70;
 const state=createFleetScenario(cfg),actual=advanceFleetScenario(state,120),result=forecast(state);
 assert.equal(fleetMatchOutcome(actual)!.tick,101);assert.equal(fleetMatchOutcome(actual)!.triggeringSeat,0);
 assert.equal(result.result.targetTick,102);assert.equal(result.result.terminalPrediction!.firstCrossing!.triggeringSeat,1);
 assert.equal(result.result.terminalPrediction!.status,'conditional');assert.equal(result.result.match,undefined);
});

// All outposts can be observed while the ocean still contains hidden actors.


test('all visible outposts alone never certify a globally complete terminal prediction',()=>{
 const cfg=nearWin();cfg.size={width:80,height:80};

 const state=createFleetScenario(cfg);
 const hidden=structuredClone(state);
 hidden.fleets.push({id:'hidden-fleet',slot:1,used:true,owner:0,drillers:1,source:'蓝方工厂',destination:'蓝方工厂',position:{x:30,y:30},previous:{x:30,y:30},state:'moving',secondsUntilLaunch:0,fractionMoved:0,gift:false,giftSeconds:0});
 const now=observed(hidden),moved=structuredClone(hidden);moved.fleets[0]!.position={x:35,y:35};moved.fleets[0]!.previous={x:35,y:35};
 assert.ok(now.view.outposts.every(o=>o.visibility===2));assert.equal(now.view.fullMapVisible,false);
 assert.deepEqual(observed(moved),now);
 const a=createKnownPrediction(now).predict(120),b=createKnownPrediction(observed(moved)).predict(120);assert.deepEqual(a,b);
 assert.equal(a.status,'conditional');if(a.status==='conditional'){assert.equal(a.result.terminalPrediction!.status,'conditional');assert.ok(a.result.terminalPrediction!.reasons.includes('unobserved-world-possible'));assert.equal(a.result.match,undefined);}
});
