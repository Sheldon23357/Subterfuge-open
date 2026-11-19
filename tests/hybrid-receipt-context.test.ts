import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {receiptContext,acknowledgeReceipts} from '../plugins/hybrid/src/receipt-context.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
const strategy={kind:'strategy' as const,scope:'overview'};
function fixture(count=20){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'receipt-context');
 o.diplomacy!.receiptCount=count;
 o.diplomacy!.receipts=Array.from({length:20},(_,i)=>({id:i*3+2,time:i,players:[0,1] as [number,number],agreementId:null,kind:'trust-changed',actor:1,details:{from:0,to:1,before:i,after:i+1,reason:'peace-recovery'}}));
 return {o,saved:initialHybridState()};
}
test('all available unseen receipts survive, including more than twelve, and selection alone never consumes facts',()=>{
 const {o,saved}=fixture(),before=structuredClone(saved),first=receiptContext(o,saved,strategy);
 assert.equal(first.records.length,20);assert.deepEqual(saved,before);assert.equal(first.coverage.unavailableBeforeWindow,0);
 acknowledgeReceipts(saved,first.key,first.delivery);
 assert.equal(receiptContext(o,saved,strategy).records.length,0);
 o.diplomacy!.receiptCount++;o.diplomacy!.receipts.push({id:100,time:25,players:[0,1],agreementId:null,kind:'trust-changed',actor:1,details:{from:0,to:1,before:20,after:21}});
 const next=receiptContext(o,saved,strategy);assert.deepEqual(next.records.map(r=>r.id),[100]);assert.equal(next.coverage.unavailableBeforeWindow,0,'global ID gaps do not imply missing authorized events');
});
test('consumer scopes are independent and unavailable source history is explicit rather than invented',()=>{
 const {o,saved}=fixture(25),first=receiptContext(o,saved,strategy);
 assert.equal(first.coverage.unavailableBeforeWindow,5);acknowledgeReceipts(saved,first.key,first.delivery);
 assert.equal(receiptContext(o,saved,{kind:'diplomacy',scope:'1'}).records.length,20);
 assert.equal(receiptContext(o,saved,strategy).coverage.unavailableBeforeWindow,5);
 o.diplomacy!.receiptCount=50;o.diplomacy!.receipts=o.diplomacy!.receipts.slice(-2).map((r,i)=>({...r,id:200+i}));
 const next=receiptContext(o,saved,strategy);assert.equal(next.records.length,2);assert.equal(next.coverage.unavailableBeforeWindow,28);
});
test('newer successful delivery fences cannot be rolled back and a different identity cannot suppress events',()=>{
 const {o,saved}=fixture(),first=receiptContext(o,saved,strategy);acknowledgeReceipts(saved,first.key,{...first.delivery,count:30,lastId:100});
 acknowledgeReceipts(saved,first.key,first.delivery);assert.equal(saved.receiptDelivery![first.key]!.count,30);
 o.roomId='different-room';assert.equal(receiptContext(o,saved,strategy).records.length,20);
});
