
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {TOOL_NAMES,toolMetadata} from '../packages/ai/src/controller/contracts/tool-metadata.js';
import {receiptMemoryEvidence} from '../packages/ai/src/controller/storage/memory-evidence.js';
import {journalPurpose,JOURNAL_PURPOSE} from '../packages/ai/src/controller/storage/journal-events.js';
import type {DiagnosticReadModel,DecisionRepository} from '../packages/ai/src/controller/storage/store-interfaces.js';

test('local receipt validation remains independent and metadata-equivalent for every tool',()=>{
 const oldLocal=new Set(['finish','remember','notebook','reminders','campaigns']);
 const oldAccepted=new Set(['order','schedule','say','notebook','remember','finish','reminders','campaigns']);
 const store=new AiStore(':memory:'),state=initialState('classify',0,{model:'',personality:'sentinel'});
 try{for(const tool of [...TOOL_NAMES,'unknown']){
  const id='receipt-'+tool,events=[{kind:'tool-result',details:{id,tool,result:{}}}];
  assert.equal(toolMetadata(tool)?.commit==='local-cas',oldLocal.has(tool));
  if(oldLocal.has(tool))assert.doesNotThrow(()=>store.saveLocalEvents(state,id,events));
  else assert.throws(()=>store.saveLocalEvents(state,id,events),/Invalid local commit receipt/);
  assert.equal(receiptMemoryEvidence(id,'tool-result',events[0]!.details)?.outcome,tool==='batch'?'partial':oldAccepted.has(tool)?'accepted':'read');
 }
 assert.equal(receiptMemoryEvidence('batch-complete','tool-result',{tool:'batch',result:{complete:true}})?.outcome,'accepted');
 assert.equal(receiptMemoryEvidence('batch-incomplete','tool-result',{tool:'batch',result:{complete:false}})?.outcome,'partial');
 assert.throws(()=>store.saveLocalEvents(state,'different',[{kind:'tool-result',details:{id:'actual',tool:'finish'}}]),/Invalid local commit receipt/);
 }finally{store.close();}
});

test('journal recovery/evidence classifications never make unknown history disposable',()=>{
 for(const kind of ['prediction-detail','campaign-detail','comparison-evidence','tool-rejected'])assert.equal(journalPurpose(kind),'business-evidence');
 for(const kind of ['wake-state','batch-item-unknown','tool-intent'])assert.equal(journalPurpose(kind),'business-recovery');
 assert.equal(journalPurpose('context-restored'),'diagnostic');assert.equal(journalPurpose('old-or-future-kind'),'unclassified-preserve');
 assert.ok(Object.keys(JOURNAL_PURPOSE).includes('campaign-state'));
});

// Compile-time capability fences. No runtime authority is created by these types.
function capabilityFence(diagnostics:DiagnosticReadModel,decision:DecisionRepository){
 // @ts-expect-error diagnostics may not commit business state
 diagnostics.saveLocalEvents;
 // @ts-expect-error decisions may not rewrite diagnostic capture
 decision.debugPutCall;
 // @ts-expect-error decisions may not close the shared database
 decision.close;
}
void capabilityFence;
