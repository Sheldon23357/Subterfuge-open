import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';import {AiStore,initialState,type AiSnapshot,type DecisionTask} from '../packages/ai/src/index.js';
import {createRoundWorkset,restoreRoundWorkset,appendRoundReceipt,addRoundCauses,reconcileRoundReceipts,roundMaterialSummary,type RoundWorkset} from '../packages/ai/src/controller/execution/round-workset.js';
import {emptyReceiptObservations,reduceReceiptJournal,receiptObservationKind,serverOrderId,observeReceipts} from '../packages/ai/src/controller/execution/receipt-observation.js';
const task:DecisionTask={category:'strategy',weight:'heavy',reasons:['开始判断'],entities:[],deferred:[]};
function fixture(){
 const observationValue=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'round-durable');
 const snapshot:AiSnapshot={observation:observationValue,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 return {snapshot,state:initialState('round-durable',0,{model:'',personality:'schemer'}),gateway:{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No remote writes');}}};
}
test('round checkpoint verifies identity and complete content, preserves alternatives and unknown writes',()=>{
 const f=fixture(),base=createRoundWorkset('round-1',f.snapshot.observation,task);
 const one=appendRoundReceipt(base,{id:'a',tool:'forecast',arguments:{targetTick:110},result:{status:'conditional',value:1}});
 assert.equal(appendRoundReceipt(one,one.receipts[0]!),one);
 assert.throws(()=>appendRoundReceipt(one,{...one.receipts[0],result:{value:2}}),/identity conflict/);
 const two=appendRoundReceipt(one,{id:'b',tool:'forecast',arguments:{targetTick:111},result:{status:'conditional',value:1}});
 const complete=appendRoundReceipt(two,{id:'c',tool:'order',result:{status:'unknown'}});
 assert.equal(complete.receipts.length,3);assert.equal(base.receipts.length,0);
 assert.deepEqual(restoreRoundWorkset(JSON.parse(JSON.stringify(complete)),f.snapshot.observation),complete);
 const damaged=structuredClone(complete);damaged.receipts.pop();
 assert.equal(restoreRoundWorkset(damaged,f.snapshot.observation),null);
 assert.equal(restoreRoundWorkset(complete,{...f.snapshot.observation,roomId:'other'}),null);
 assert.equal(restoreRoundWorkset(complete,{...f.snapshot.observation,view:{...f.snapshot.observation.view,player:1}}),null);
 assert.equal(restoreRoundWorkset({version:1},f.snapshot.observation),null);
 assert.deepEqual(addRoundCauses(complete,{...task,reasons:['开始判断','新的来袭']}).causes,['开始判断','新的来袭']);
 const pending=appendRoundReceipt(base,{id:'write',tool:'order',kind:'tool-intent',result:{status:'pending'}});
 const accepted=appendRoundReceipt(pending,{id:'write',tool:'order',kind:'tool-result',result:{status:'accepted'}});
 assert.equal(accepted.receipts.length,1);assert.deepEqual(accepted.receipts[0]!.result,{status:'accepted'});
 assert.throws(()=>appendRoundReceipt(accepted,{id:'write',tool:'order',kind:'tool-result',result:{status:'unknown'}}),/identity conflict/);
});

test('archived query records remain protected audit data without a release capability',()=>{
 const f=fixture();let current=createRoundWorkset('protected-status',f.snapshot.observation,task);
 for(const status of ['unconfirmed','interrupted','partial','cancelled','conditional'])current=appendRoundReceipt(current,{id:status,tool:'forecast',kind:'tool-result',result:{status}});
 const summary=roundMaterialSummary(current,f.snapshot.observation);
 assert.equal(summary.reads,0);assert.equal(summary.protected,5);
 assert.ok(summary.entries?.every(row=>row.releasable===false));
});

test('only exact authoritative command acceptance resolves an unknown round write',()=>{
 const f=fixture(),id='unknown-command',action={kind:'check-in'};
 const workset=appendRoundReceipt(createRoundWorkset('r',f.snapshot.observation,task),{id,tool:'order',kind:'tool-unknown',arguments:{action},result:{status:'unknown'}});
 let ledger=reduceReceiptJournal(emptyReceiptObservations('round-durable'),'tool-intent',{id,tool:'order',arguments:{action}},f.snapshot.observation);
 ledger=reduceReceiptJournal(ledger,'tool-result',{id,tool:'order',result:f.snapshot.observation},f.snapshot.observation);
 const accepted=reconcileRoundReceipts(workset,ledger);
 assert.equal((accepted.receipts[0]!.result as any).status,'accepted');
 assert.equal((accepted.receipts[0]!.result as any).execution,'not-established');
 assert.deepEqual(restoreRoundWorkset(accepted,f.snapshot.observation),accepted);
 assert.equal((workset.receipts[0]!.result as any).status,'unknown');
 for(const mutate of [
  (r:any)=>({...r,commandId:'other'}),
  (r:any)=>({...r,player:1}),
  (r:any)=>({...r,roomId:'other-room'}),
  (r:any)=>({...r,state:'expired'}),
  (r:any)=>({...r,acceptedRef:undefined}),
  (r:any)=>({...r,fact:'visible-moving'}),
 ])assert.equal(reconcileRoundReceipts(workset,{...ledger,records:ledger.records.map(mutate)}),workset);
 assert.equal(reconcileRoundReceipts(workset,null),workset);
 const batch=appendRoundReceipt(createRoundWorkset('batch',f.snapshot.observation,task),{id:'parent',tool:'batch',kind:'tool-unknown',result:{status:'unknown',complete:false,results:[{id:'first',tool:'order',status:'accepted'},{id,tool:'order',status:'unknown'},{id:'last',tool:'order',status:'not-executed'}]}});
 const updated=reconcileRoundReceipts(batch,ledger).receipts[0]!.result as any;
 assert.equal(updated.status,'partial');assert.equal(updated.complete,false);
 assert.deepEqual(updated.results.map((r:any)=>r.status),['accepted','accepted','not-executed']);
 assert.equal(updated.results[1].execution,'not-established');
 assert.equal(updated.results[2].id,'last');
});

test('player schedules do not create bot command observers',()=>{
 const f=fixture(),o=f.snapshot.observation;
 o.scheduled=[{id:'human',player:0,issueTick:o.view.tick+3,status:'pending',action:{kind:'check-in'}}];
 const ledger=observeReceipts(emptyReceiptObservations(o.roomId),o);
 assert.deepEqual(ledger.records,[]);assert.deepEqual(ledger.pendingWrites,[]);
});

test('runner checkpoints reconciled acceptance before dispatch without repeating the command',async()=>{
 const f=fixture(),store=new AiStore(':memory:'),id='prior-command',action={kind:'check-in'};
 const workset=appendRoundReceipt(createRoundWorkset('r',f.snapshot.observation,task),{id,tool:'order',kind:'tool-unknown',arguments:{action},result:{status:'unknown'}});
 let ledger=reduceReceiptJournal(emptyReceiptObservations('round-durable'),'tool-intent',{id,tool:'order',arguments:{action}},f.snapshot.observation);
 ledger=reduceReceiptJournal(ledger,'tool-result',{id,tool:'order',result:f.snapshot.observation},f.snapshot.observation);
 store.saveEvents(f.state,[{kind:'round-workset',details:{workset}},{kind:receiptObservationKind,details:ledger}]);
 try{
  let calls=0;
  await new SeatRunner(f.state,store,f.gateway,{step:async input=>{
   calls++;const checkpoint=store.latest<{workset:RoundWorkset}>('round-durable',0,'round-workset')!.workset;
   assert.equal((checkpoint.receipts[0]!.result as any).status,'accepted');
   assert.equal(store.latest<ReturnType<typeof emptyReceiptObservations>>('round-durable',0,receiptObservationKind)!.records.some(record=>record.commandId===id),false,'confirmation is pruned only after the accepted round checkpoint commits');
   assert.match(input.prompt,/not-established/);assert.match(input.prompt,/禁止重发/);
   return {tokens:0,reply:{tool:'finish',arguments:{},summary:'确认已接受，结束'}};
  }}).poll(0,true);
  assert.equal(calls,1);assert.equal(store.latest<{workset:null}>('round-durable',0,'round-workset')!.workset,null);
  assert.ok(store.latest<any>('round-durable',0,receiptObservationKind).records.every((record:any)=>record.state!=='confirmedFact'),'finished rounds release retained confirmation evidence');
 }finally{store.close();}
});
