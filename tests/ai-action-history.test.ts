import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,initialState} from '../packages/ai/src/index.js';
import {actionHistory} from '../packages/ai/src/controller/diagnostics/action-history.js';
import {liveInstructionGroups} from '../packages/client/src/AgentPlanInstructions.js';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';

for(const automatic of [false,true])test(`automatic tick uses the strategy coalescing policy with local clock=${automatic}`,async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any,calls:unknown[]=[];
 const e={desired:true,config:{serverUrl:'https://example.invalid',roomId:'room',settings:{}},gateway:{programmaticAutoAdvance:automatic,expiresAt:Date.now()+60000},commander:{tick(){}},runner:{state:{}}};
 Object.assign(runtime,{entries:new Map([['seat',e]]),fixedController:true,timer:null,resolveMode:()=>({automaticEventCoalesceMs:1000}),pollBackground:()=>{},poll:async(_e:unknown,_force:unknown,window:unknown)=>{calls.push(window);}});
 await runtime.tick();assert.deepEqual(calls,[1000]);
});

test('offline actions and their original child receipts are visible after reopening the store',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-actions-')),file=join(dir,'ai.sqlite');let store=new AiStore(file);
 try{
  const s=initialState('room',5,{model:'',personality:'schemer'});s.sequence=2;
  store.save(s,'started',{sequence:2,tick:6});
  store.save(s,'tool-intent',{id:'batch',tool:'batch',arguments:{actions:[{tool:'order',arguments:{action:{kind:'launch',source:'s',destination:'t',drillers:2}}},{tool:'order',arguments:{action:{kind:'return-fleet',fleetId:'fleet'}}}]}});
  store.save(s,'batch-item-result',{id:'batch-item-0',status:'accepted'});
  store.save(s,'tool-unknown',{id:'batch',tool:'batch',result:{results:[{id:'batch-item-0',status:'accepted'},{id:'batch-item-1',status:'unknown'}]}});
  store.close();store=new AiStore(file);
  let history=actionHistory(store.debugActionRows('room',5));
  assert.deepEqual(history[0]!.instructions.map(i=>i.state),['accepted','unknown']);
  assert.deepEqual(liveInstructionGroups({generation:'g',executionHistory:history,hybrid:{operations:[]}}).groups[0]!.instructions.map(i=>i.delivery),['issued','unconfirmed']);
  store.save(s,'write-reconciled',{id:'batch-item-1',tool:'order',status:'committed',reason:'权威确认'});
  history=actionHistory(store.debugActionRows('room',5));assert.deepEqual(history[0]!.instructions.map(i=>i.state),['accepted','accepted']);
  const diagnostics=new AgentDiagnostics(store,s,v=>v),page=diagnostics.read('notebook',{scope:'current',limit:'1'}) as {executionHistory:typeof history};
  assert.deepEqual(page.executionHistory,history);
  assert.equal(store.debugActionRows('room',4).length,0);assert.equal(store.debugActionRows('other',5).length,0);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('recent five action rounds survive arbitrary later no-action rounds without duplicate mode records',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-action-rounds-')),store=new AiStore(join(dir,'ai.sqlite'));
 try{const s=initialState('room',0,{model:'',personality:'schemer'});
  for(let i=1;i<=9;i++){s.sequence=i;store.save(s,'started',{sequence:i,tick:i*3});store.save(s,'tool-intent',{id:'order-'+i,tool:'order',arguments:{action:{kind:'launch',source:'s',destination:'t',drillers:1}}});store.save(s,'tool-result',{id:'order-'+i,tool:'order',result:{}});}
  for(let i=10;i<110;i++){s.sequence=i;store.save(s,'started',{sequence:i,tick:i*3});store.save(s,'tool-intent',{id:'finish-'+i,tool:'finish',arguments:{}});}
  const history=actionHistory(store.debugActionRows('room',0)),groups=liveInstructionGroups({generation:'g',executionHistory:history,hybrid:{operations:[{id:'operation-9',basis:{tick:27},drafts:[{action:{kind:'launch'}}]}]}}).groups;
  assert.deepEqual(groups.map(g=>g.round),[9,8,7,6,5]);assert.equal(groups.reduce((n,g)=>n+g.instructions.length,0),5);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('partial batch distinguishes rejection, skipped children, and an intent without confirmation',()=>{
 const intent={id:'b',tool:'batch',arguments:{actions:[0,1,2].map(()=>({tool:'order',arguments:{action:{kind:'toggle-mine',outpostId:'x'}}}))}};
 const source={round:1,tick:1,intent,events:[{kind:'tool-result',payload:{id:'b',result:{results:[{id:'b-item-0',status:'accepted'},{id:'b-item-1',status:'rejected',error:'denied'},{id:'b-item-2',status:'not-executed'}]}}}]};
 const history=actionHistory([source]);assert.deepEqual(history[0]!.instructions.map(i=>i.state),['accepted','failed','skipped']);
 assert.deepEqual(liveInstructionGroups({generation:'g',executionHistory:history}).groups[0]!.instructions.map(i=>i.delivery),['issued','rejected','skipped']);
 assert.deepEqual(actionHistory([{...source,events:[]}])[0]!.instructions.map(i=>i.state),['proposed','proposed','proposed']);
});
