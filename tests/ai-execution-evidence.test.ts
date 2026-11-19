import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pendingExecutionEvidence} from '../packages/ai/src/controller/execution/execution-evidence.js';
import {emptyReceiptObservations,reduceReceiptJournal} from '../packages/ai/src/controller/execution/receipt-observation.js';

test('undelivered execution conclusions survive rounds and disappear only after exact delivery acknowledgement',()=>{
 const state={...emptyReceiptObservations('room'),resolutions:[{id:'message',tool:'say',status:'committed' as const,reason:'authoritative receipt'}]};
 const first=pendingExecutionEvidence(state);
 assert.equal(first.notices.length,1);assert.equal(first.notices[0]!.tool,'say');
 assert.deepEqual(pendingExecutionEvidence(structuredClone(state)),first,'restart or failure does not acknowledge delivery');
 const delivered=reduceReceiptJournal(state,'execution-evidence-provided',{references:first.references});
 assert.deepEqual(pendingExecutionEvidence(delivered).notices,[]);
 assert.equal(delivered.resolutions!.length,1,'delivery does not delete the actual outcome');
 assert.equal(state.providedEvidence,undefined);
});

test('a newer batch conclusion remains pending when the in-flight model only received the older version',()=>{
 let state={...emptyReceiptObservations('room'),recoveredBatches:[{id:'batch',result:{status:'unknown',complete:false,results:[{id:'a',status:'unknown'}]}}]};
 const provided=pendingExecutionEvidence(state);
 state={...state,recoveredBatches:[{id:'batch',result:{status:'partial',complete:false,results:[{id:'a',status:'accepted'}]}}]};
 const acknowledged=reduceReceiptJournal(state,'execution-evidence-provided',{references:provided.references});
 const current=pendingExecutionEvidence(acknowledged);
 assert.equal(current.notices.length,1);assert.notEqual(current.references[0]!.digest,provided.references[0]!.digest);
 assert.equal(pendingExecutionEvidence(reduceReceiptJournal(acknowledged,'execution-evidence-provided',{references:current.references})).notices.length,0);
});

test('delivery acknowledgement keeps unresolved operations and factual observations intact',()=>{
 const state={...emptyReceiptObservations('room'),pendingWrites:['a'],resolutions:[{id:'a',tool:'order',status:'unknown' as const,reason:'history unavailable'}]};
 assert.equal(pendingExecutionEvidence(state).notices.length,0);
 const next=reduceReceiptJournal(state,'execution-evidence-provided',{references:[]});
 assert.deepEqual(next.pendingWrites,['a']);assert.deepEqual(next.resolutions,state.resolutions);
 assert.throws(()=>reduceReceiptJournal(state,'execution-evidence-provided',{references:[{id:'a',digest:'invalid'}]}),/Invalid delivered/);
});
