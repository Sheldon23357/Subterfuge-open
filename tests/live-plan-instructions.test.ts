import test from 'node:test';
import assert from 'node:assert/strict';
import {describeLiveInstruction,liveInstructionGroups,liveGuidanceCalls,instructionDeliveryState} from '../packages/client/src/AgentPlanInstructions.js';

test('dispatch display finishes at acceptance and ignores later fleet outcomes',()=>{
 for(const state of ['accepted','underway','completed'])assert.equal(instructionDeliveryState({state},'underway'),'issued');
 assert.equal(instructionDeliveryState({state:'failed',orderId:'accepted-order',reason:'战斗失败'},'failed'),'issued');
 assert.equal(instructionDeliveryState({state:'cancelled',fleetId:'confirmed-fleet'},'cancelled'),'issued');
 assert.equal(instructionDeliveryState({state:'failed',reason:'服务器拒绝'},'failed'),'rejected');
 assert.equal(instructionDeliveryState(undefined,'proposed'),'pending');
 assert.equal(instructionDeliveryState(undefined,'completed'),'unconfirmed');
 assert.equal(instructionDeliveryState({state:'unknown'},'accepted'),'unconfirmed');
 const data={generation:'g',hybrid:{operations:[{id:'operation-280',status:'underway',basis:{tick:898},drafts:[{id:'a',action:{kind:'launch',source:'s',destination:'t',drillers:13}},{id:'b',action:{kind:'launch',source:'s2',destination:'t2',drillers:15}}],commands:[{draftId:'a',state:'underway',orderId:'order-a'},{draftId:'b',state:'unknown'}]}]}};
 const before=structuredClone(data),result=liveInstructionGroups(data);
 assert.deepEqual(result.groups[0]!.instructions.map(i=>i.delivery),['issued','unconfirmed']);
 assert.deepEqual(result.groups[0]!.instructions.map(i=>i.state),['underway','unknown']);
 assert.deepEqual(data,before,'presentation must not modify the durable settlement state');
});

test('guidance uses persisted cumulative category calls, independent of retained task rows',()=>{
 const value={hybrid:{state:{tasks:[{kind:'strategy'}],usage:{strategy:{calls:127},diplomacy:{calls:302}}}}};
 const before=structuredClone(value);
 assert.deepEqual(liveGuidanceCalls(value),{strategy:127,diplomacy:302,commander:0});assert.deepEqual(value,before);
 assert.equal(liveGuidanceCalls({hybrid:{state:{}}}),null);
 assert.deepEqual(liveGuidanceCalls({hybrid:{state:{usage:{strategy:{calls:'12'},commander:{calls:-1}}}}}),{strategy:null,diplomacy:0,commander:null});
});

test('instruction descriptions retain amounts, fleet identity and explicit shield switches',()=>{
 const names={source:'晨星',target:'远港'};
 assert.deepEqual(describeLiveInstruction({kind:'launch',source:'source',destination:'target',drillers:42},names),{kind:'出兵',description:'晨星 → 远港 · 42 兵'});
 assert.equal(describeLiveInstruction({kind:'set-shields',outpostId:'source',enabled:false},names).kind,'关闭护盾');
 assert.equal(describeLiveInstruction({kind:'set-shields',outpostId:'source',enabled:true},names).kind,'开启护盾');
 assert.match(describeLiveInstruction({kind:'set-shields',outpostId:'source'},names).description,/开关未记录/);
 assert.match(describeLiveInstruction({kind:'return-fleet',fleetId:'F1-12345678'},names).description,/F1-12345678/);
 assert.match(describeLiveInstruction({kind:'launch',source:'source',destination:'target'},names).description,/兵力未记录/);
});

test('partial batch receipts never make sibling commands inherit an operation outcome',()=>{
 const input={generation:'seat-generation',outpostNames:{home:'晨星',target:'远港'},hybrid:{operations:[{id:'operation',status:'completed',basis:{tick:28},drafts:[
  {id:'accepted',action:{kind:'launch',source:'home',destination:'target',drillers:17}},
  {id:'rejected',action:{kind:'set-shields',outpostId:'home',enabled:false}},
  {id:'missing',action:{kind:'return-fleet',fleetId:'F2'}},
 ],commands:[{draftId:'rejected',state:'failed',reason:'控制权已变化'},{draftId:'accepted',state:'accepted'}]}]}};
 const before=structuredClone(input),result=liveInstructionGroups(input);
 assert.equal(result.generation,'seat-generation');assert.equal(result.groups[0]?.tick,28);
 assert.deepEqual(result.groups[0]?.instructions.map(i=>[i.id,i.state]),[['accepted','accepted'],['rejected','failed'],['missing','unknown']]);
 assert.match(result.groups[0]!.instructions[0]!.description,/17 兵/);
 assert.equal(result.groups[0]?.instructions[1]?.reason,'控制权已变化');
 assert.deepEqual(input,before);
});

test('history shows five distinct action rounds, skips idle rounds and merges batches within a round',()=>{
 const row=(id:string,status:string)=>({id,status,basis:{tick:1},drafts:[{id:'draft-'+id,action:{kind:'toggle-mine',outpostId:'post'}}]});
 const input={generation:'g',hybrid:{operations:[row('operation-203','review'),row('operation-230','completed'),row('operation-231','completed'),row('operation-232','completed'),row('operation-241','completed'),row('operation-243-internal','accepted'),row('operation-243','proposed'),{id:'operation-245',status:'completed',basis:{tick:2},drafts:[]}]}};
 const before=structuredClone(input),result=liveInstructionGroups(input);
 assert.deepEqual(result.groups.map(g=>g.round),[243,241,232,231,230]);
 assert.equal(result.groups[0]!.instructions.length,2);
 assert.ok(result.groups[0]!.instructions.some(i=>i.state==='proposed'));
 assert.ok(result.groups.every(g=>g.instructions.length>0));
 assert.deepEqual(liveInstructionGroups({...input,hybrid:{operations:[]}}).groups,[]);
 assert.ok(!JSON.stringify(result).includes('draft-operation-203'));
 assert.deepEqual(input,before);
});

test('cancelled unsubmitted drafts are cancelled while partial or unknown submissions remain unconfirmed',()=>{
 const draft=(id:string)=>({id,action:{kind:'launch',source:'home',destination:'target',drillers:3}});
 const input={generation:'g',hybrid:{operations:[
  {id:'operation-7',basis:{tick:7},status:'cancelled',drafts:[draft('a'),draft('b')],commands:[],orders:[],fleets:[],receiptIds:[]},
  {id:'operation-8',basis:{tick:8},status:'cancelled',drafts:[draft('accepted'),draft('missing'),draft('unknown')],commands:[{draftId:'accepted',state:'accepted',orderId:'real-order'},{draftId:'unknown',state:'unknown',reason:'等待查账'}],orders:['real-order'],fleets:[],receiptIds:['batch']},
  {id:'operation-9',basis:{tick:9},status:'failed',drafts:[draft('rejected'),draft('skipped')],commands:[{draftId:'rejected',state:'failed',reason:'REVISION_CONFLICT'},{draftId:'skipped',state:'failed',reason:'未执行'}]},
 ]}};
 const before=structuredClone(input),groups=liveInstructionGroups(input).groups;
 assert.deepEqual(groups.find(g=>g.round===7)!.instructions.map(i=>i.delivery),['cancelled','cancelled']);
 assert.ok(groups.find(g=>g.round===7)!.instructions.every(i=>i.reason==='方案在提交前已取消'));
 assert.deepEqual(groups.find(g=>g.round===8)!.instructions.map(i=>i.delivery),['issued','unconfirmed','unconfirmed']);
 assert.deepEqual(groups.find(g=>g.round===9)!.instructions.map(i=>i.delivery),['rejected','skipped']);
 assert.equal(groups.find(g=>g.round===9)!.instructions[0]!.reason,'REVISION_CONFLICT');
 assert.deepEqual(input,before,'display must not alter execution or reconciliation evidence');
 for(const evidence of ['orders','fleets','receiptIds'])assert.equal(instructionDeliveryState(undefined,'cancelled',{status:'cancelled',[evidence]:['existing-evidence']}),'unconfirmed');
 assert.equal(instructionDeliveryState({state:'unknown'},'cancelled',{commands:[]}), 'unconfirmed');
 assert.equal(instructionDeliveryState({state:'cancelled'},'cancelled'),'cancelled');
});
