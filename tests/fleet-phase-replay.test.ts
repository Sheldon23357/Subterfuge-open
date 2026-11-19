import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,settleFleetScenarioPhase,exportFleetReplay,saveFleetSnapshot,restoreFleetSnapshot,replayFleetScenario,createFleetReplaySession,projectPlayerHistory,type FleetSetup} from '../packages/engine/src/index.js';
function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.positions['红方后方']={x:0.025,y:0};cfg.economy.outposts[2]!.owner=0;
 let state=submitFleetOrder(createFleetScenario(cfg),{id:'supply',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}}).state;
 return advanceFleetScenario(state,101);
}
test('clock settlement without a player order survives cold and cached restore, including a later tick',()=>{
 const base=fixture(),settled=settleFleetScenarioPhase(base,599);
 assert.ok(settled.events.some(e=>e.kind==='unloaded'));
 const advanced=advanceFleetScenario(settled,103);
 for(const state of [settled,advanced]){
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)),state);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state),{trustedLocalStorage:true,verifiedReplayBase:base}),state);
 }
 const missing=JSON.parse(saveFleetSnapshot(advanced));delete missing.replay.phaseSettlements;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(missing)),/disagree/);
});
test('phase settlements preserve command interleaving and resumable historical branches',()=>{
 let state=settleFleetScenarioPhase(fixture(),400);
 const prefix=state;
 state=submitFleetOrder(state,{id:'shields',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}},450).state;
 state=settleFleetScenarioPhase(state,599);
 state=advanceFleetScenario(state,104);
 assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state),{trustedLocalStorage:true,verifiedReplayBase:prefix}),state);
 const replay=exportFleetReplay(state),session=createFleetReplaySession(replay);
 for(const target of [104,101,103,102,104]){
  session.begin(target);while(!session.step(1)){}
  const cut={...replay,targetTick:target,commands:replay.commands.filter(c=>c.tick<=target),phaseSettlements:replay.phaseSettlements!.filter(p=>p.tick<=target)};
  assert.deepEqual(session.snapshot(),replayFleetScenario(cut));
 }
 assert.doesNotThrow(()=>projectPlayerHistory(state,0,101,300));
 assert.doesNotThrow(()=>replayLabHistory({replay},100,-1));
 const bad=JSON.parse(saveFleetSnapshot(state));bad.expected.economy.outposts[0].drillers++;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(bad)),/disagree/);
 const reversed=structuredClone(replay);reversed.phaseSettlements!.reverse();
 assert.throws(()=>replayFleetScenario(reversed),/chronological/);
});
import {catchUpRealtime,startRealtime} from '../packages/server/src/realtime.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {replayLabHistory} from '../packages/prediction/src/lab-history.js';
test('realtime diplomacy expiry with an arriving fleet remains valid after SQLite close and reopen',async()=>{
 let state=fixture();
 state=submitFleetOrder(state,{id:'offer',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'ceasefire',outposts:['蓝方工厂','红方矿场']},subsidy:null,counterTo:null}},540).state;
 state=submitFleetOrder(state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'offer',response:'accept'}},540).state;
 state=advanceFleetScenario(state,200);
 state=submitFleetOrder(state,{id:'second-supply',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:10}}).state;
 state=advanceFleetScenario(state,201);
 const room=await catchUpRealtime(startRealtime({state,scheduled:[]},10000),19000);
 assert.equal(room.state.diplomacy.agreements[0]!.status,'completed');
 assert.ok(room.state.phaseSettlements?.length);
 const advanced=await catchUpRealtime(room,30000);
 const dir=mkdtempSync(join(tmpdir(),'phase-restore-')),path=join(dir,'room.sqlite');
 let store=new RoomStore(path);
 try{store.commit(advanced,0);store.close();store=new RoomStore(path);assert.deepEqual(store.load()!.room,advanced);}
 finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
