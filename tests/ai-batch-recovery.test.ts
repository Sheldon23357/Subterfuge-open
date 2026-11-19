import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverBatchOutcome,type BatchChildEvidence} from '../packages/ai/src/controller/execution/batch-recovery.js';
import {emptyReceiptObservations,reduceReceiptJournal} from '../packages/ai/src/controller/execution/receipt-observation.js';
const args={actions:[{tool:'order',arguments:{action:{kind:'check-in'}}},{tool:'order',arguments:{action:{kind:'check-in'}}},{tool:'order',arguments:{action:{kind:'check-in'}}}]};
const child=(index:number,started:boolean,status?:string):BatchChildEvidence=>({id:`batch-item-${index}`,intentRecorded:started,evidence:status?{kind:'batch-item-result',result:{status,revision:'r'}}:{kind:'no-durable-outcome'}});

test('batch crash recovery retains accepted prefix, unknown started item and untouched suffix',()=>{
 const evidence=[child(0,true,'accepted'),child(1,true),child(2,false)],original=structuredClone(evidence);
 const result=recoverBatchOutcome('batch',args,evidence,[]);
 assert.deepEqual(result.results.map(r=>r.status),['accepted','unknown','not-executed']);
 assert.equal(result.complete,false);assert.equal(result.processed,2);assert.deepEqual(evidence,original);
 const resolved=recoverBatchOutcome('batch',args,evidence,[{id:'batch-item-1',tool:'order',status:'committed',reason:'verified'}]);
 assert.deepEqual(resolved.results.map(r=>r.status),['accepted','accepted','not-executed']);
 assert.equal(resolved.status,'partial');assert.equal(resolved.complete,false);
});

test('complete durable children recover a successful parent without executing another operation',()=>{
 const result=recoverBatchOutcome('batch',args,[child(0,true,'accepted'),child(1,true,'accepted'),child(2,true,'accepted')],[]);
 assert.equal(result.complete,true);assert.equal(result.status,'accepted');assert.equal(result.processed,3);
});

test('parent stays pending while any started child is unknown and clears only with full known coverage',()=>{
 let state=emptyReceiptObservations('room');
 state=reduceReceiptJournal(state,'tool-intent',{id:'batch',tool:'batch',arguments:args});
 const evidence=[child(0,true,'accepted'),child(1,true),child(2,false)];
 state=reduceReceiptJournal(state,'batch-recovered',{id:'batch',tool:'batch',result:recoverBatchOutcome('batch',args,evidence,[])});
 assert.deepEqual(state.pendingWrites,['batch']);
 state=reduceReceiptJournal(state,'batch-recovered',{id:'batch',tool:'batch',result:recoverBatchOutcome('batch',args,evidence,[{id:'batch-item-1',tool:'order',status:'rejected',reason:'authoritative rejection'}])});
 assert.deepEqual(state.pendingWrites,[]);
 assert.throws(()=>recoverBatchOutcome('batch',args,[child(0,true,'accepted')],[]),/coverage/);
});
