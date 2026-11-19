import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEconomicScenario,submitEconomicCommand,advanceEconomicScenario,exportEconomicReplay,replayEconomicScenario,saveEconomicSnapshot,restoreEconomicSnapshot,economicTotals,type EconomicOutpost,type EconomicSetup} from '../packages/engine/src/index.js';

export function outpost(id:string,owner:number|null,patch:Partial<EconomicOutpost>={}):EconomicOutpost{
  return{id,owner,type:'factory',drillers:0,shield:0,shieldMax:10,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false,...patch};
}
export function setup(outposts:EconomicOutpost[]):EconomicSetup{
  return{players:[{active:true,neptunium:0,minesCreated:0},{active:true,neptunium:0,minesCreated:0}],outposts,initialTick:72,teamSize:0};
}
test('ordered factories compete for capacity; stalled factory retains its progress',()=>{
  const original=createEconomicScenario(setup([outpost('a',0,{drillers:148,productionProgress:47}),outpost('b',0,{productionProgress:47})]));
  const next=advanceEconomicScenario(original,73);
  assert.equal(next.outposts[0]!.drillers,150);assert.equal(next.outposts[1]!.drillers,0);
  assert.equal(next.outposts[1]!.productionProgress,47);assert.equal(next.outposts[0]!.productionProgress,0);
  assert.equal(original.outposts[0]!.drillers,148);
});
test('mine completes after factory production and resets both production counters',()=>{
  const state=createEconomicScenario(setup([outpost('a',0,{drillers:80,productionProgress:47,miningProgress:9})]));
  const pending=submitEconomicCommand(state,{id:'build',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  assert.equal(pending.outposts[0]!.drillers,30);
  const result=advanceEconomicScenario(pending,73),mine=result.outposts[0]!;
  assert.equal(mine.type,'mine');assert.equal(mine.drillers,36);
  assert.equal(mine.productionProgress,0);assert.equal(mine.miningProgress,0);
  assert.equal(result.players[0]!.minesCreated,1);
  assert.deepEqual(result.events.map(e=>e.kind),['mine-ordered','drillers-produced','mine-created']);
});
test('new team mine immediately commits previous pending mine and cancellation refunds current tier',()=>{
  const initial=setup([outpost('a',0,{drillers:250}),outpost('b',1,{drillers:250})]);initial.teamSize=2;
  let state=createEconomicScenario(initial);
  state=submitEconomicCommand(state,{id:'one',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  state=submitEconomicCommand(state,{id:'two',player:1,action:{kind:'toggle-mine',outpostId:'b'}}).state;
  assert.equal(state.outposts[0]!.type,'mine');assert.equal(state.players[0]!.minesCreated,1);
  assert.equal(state.outposts[1]!.drillers,150);
  state=submitEconomicCommand(state,{id:'cancel',player:1,action:{kind:'toggle-mine',outpostId:'b'}}).state;
  assert.equal(state.outposts[1]!.drillers,250);assert.equal(state.players[1]!.minesCreated,0);
  assert.equal(state.outposts[1]!.minePending,false);
});
test('funding applies to production before threshold loss expires it in postprocessing',()=>{
  const initial=setup([outpost('factory',1,{productionProgress:47}),outpost('mine',1,{type:'mine',miningProgress:71})]);
  initial.players[0]!.neptunium=20;
  let state=createEconomicScenario(initial);
  state=submitEconomicCommand(state,{id:'fund',player:0,action:{kind:'toggle-funding',recipient:1}}).state;
  assert.equal(economicTotals(state)[1]!.capacity,200);
  state=advanceEconomicScenario(state,73);
  assert.equal(state.outposts[0]!.drillers,8);assert.equal(state.players[1]!.neptunium,1);
  assert.equal(state.funding[0]![1],false);assert.equal(economicTotals(state)[1]!.capacity,150);
  assert.deepEqual(state.events.map(e=>e.kind),['funding-toggled','drillers-produced','neptunium-produced','funding-expired']);
});
test('shield disable clears charge and cannot recharge until enabled; cancellation preserves progress',()=>{
  const initial=createEconomicScenario(setup([outpost('a',0,{shield:5,shieldProgress:27})]));
  const disabled=submitEconomicCommand(initial,{id:'off',player:0,action:{kind:'set-shields',outpostId:'a',enabled:false}}).state;
  const cancelled=submitEconomicCommand(disabled,{id:'on',player:0,action:{kind:'set-shields',outpostId:'a',enabled:true}}).state;
  assert.equal(advanceEconomicScenario(cancelled,73).outposts[0]!.shield,6);
  const result=advanceEconomicScenario(disabled,100);
  assert.equal(result.outposts[0]!.shield,0);assert.equal(result.outposts[0]!.shieldProgress,27);
});
test('eliminated owner still produces drillers but mine does not produce neptunium',()=>{
  const initial=setup([outpost('a',0,{productionProgress:47}),outpost('m',0,{type:'mine',miningProgress:71})]);initial.players[0]!.active=false;
  const state=advanceEconomicScenario(createEconomicScenario(initial),73);
  assert.equal(state.outposts[0]!.drillers,6);assert.equal(state.players[0]!.neptunium,0);
});
test('rejected commands are atomic and command IDs prevent duplicate execution',()=>{
  const initial=createEconomicScenario(setup([outpost('a',0,{drillers:60})]));
  const command={id:'a',player:0,action:{kind:'toggle-mine' as const,outpostId:'a'}};
  const state=submitEconomicCommand(initial,command).state;
  assert.equal(submitEconomicCommand(state,command).state,state);
  assert.equal(submitEconomicCommand(state,{id:'a',player:0,action:{outpostId:'a',kind:'toggle-mine'}}).duplicate,true);
  assert.throws(()=>submitEconomicCommand(state,{...command,player:1}),/conflict/);
  assert.throws(()=>submitEconomicCommand(initial,{...command,id:'foreign',player:1}),/not owned/);
  assert.equal(initial.outposts[0]!.drillers,60);assert.equal(initial.events.length,0);
});
test('tick partitioning, replay, snapshot restoration and resumed execution agree',()=>{
  let state=createEconomicScenario(setup([outpost('a',0,{drillers:80}),outpost('b',1,{type:'mine'})]));
  state=submitEconomicCommand(state,{id:'build',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  const uninterrupted=advanceEconomicScenario(state,350);
  const halfway=advanceEconomicScenario(state,100);
  const restored=restoreEconomicSnapshot(saveEconomicSnapshot(halfway));
  assert.deepEqual(advanceEconomicScenario(restored,350),uninterrupted);
  assert.deepEqual(replayEconomicScenario(exportEconomicReplay(uninterrupted)),uninterrupted);
});
test('snapshot and replay reject corrupt, out-of-order, oversized and wrong-version records',()=>{
  let state=createEconomicScenario(setup([outpost('a',0,{drillers:80})]));
  state=submitEconomicCommand(state,{id:'a',player:0,action:{kind:'toggle-mine',outpostId:'a'}}).state;
  const saved=JSON.parse(saveEconomicSnapshot(state));saved.expected.outposts[0].drillers++;
  assert.throws(()=>restoreEconomicSnapshot(JSON.stringify(saved)),/disagree/);
  const replay=exportEconomicReplay(state);
  assert.throws(()=>replayEconomicScenario({...replay,profile:'custom-1'}),/Unsupported/);
  assert.throws(()=>replayEconomicScenario({...replay,targetTick:10000001}),/targetTick/);
  assert.throws(()=>advanceEconomicScenario(state,state.tick+10001),/horizon/);
  assert.throws(()=>replayEconomicScenario({...replay,commands:[...replay.commands,...replay.commands]}),/Duplicate/);
  assert.throws(()=>createEconomicScenario({...setup([outpost('a',0)]),outposts:[outpost('a',0),outpost('a',1)]}),/Duplicate/);
});
