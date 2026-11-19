import test from 'node:test';
import {readFileSync} from 'node:fs';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';
import {NotebookOverview,type NotebookOverviewData} from '../packages/client/src/NotebookOverview.js';
import {createRoundWorkset,appendRoundReceipt} from '../packages/ai/src/controller/execution/round-workset.js';

const relation={id:'relation:1',kind:'note',text:'先观察，不承诺结盟',updatedAt:0,expiresAt:null,record:{type:'relation',status:'negotiating',summary:'对方提出停火，尚未确认',players:[1],entities:[],links:[],evidence:[],reviewAt:null,scores:{trust:null,hostility:0,threat:30,cooperation:60,confidence:50}}};
test('current notebook capacity counts all active own bodies independently of pagination',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'});
 const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['private-key-canary']));
 try{
  state.memory.strategy='总体战略 private-key-canary';store.save(state,'notebook-set',relation);
  for(let i=0;i<5;i++)store.save(state,'notebook-set',{id:'note-'+i,kind:'fact',text:'regular',updatedAt:0,expiresAt:null});
  store.save(initialState('room',1,{model:'fake',personality:'schemer'}),'notebook-set',{...relation,text:'foreign-seat-note'});
  store.save(initialState('other-room',0,{model:'fake',personality:'schemer'}),'notebook-set',{...relation,text:'foreign-room-note'});
  const observed=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'room');
  observed.view.tick=2;store.save(state,'observation-baseline',observed);
  store.save(state,'notebook-set',{id:'expired',kind:'note',text:'excluded expired body',updatedAt:0,expiresAt:600});
  const current=diagnostics.read('notebook',{scope:'current',limit:'1'}) as any;
  assert.equal(current.entries.length,1);assert.notEqual(current.entries[0].payload.id,relation.id);
  assert.equal(current.overview.relations,undefined);assert.equal(current.overview.memory.relations,undefined);
  assert.equal(current.overview.capacity.entries,6);assert.equal(current.overview.capacity.characters,relation.text.length+5*'regular'.length);
  assert.equal(current.overview.capacity.strategyCharacters,state.memory.strategy.length);
  assert.ok(current.overview.memory.strategy.startsWith('总体战略'));assert.ok(!JSON.stringify(current).includes('private-key-canary'));assert.ok(!JSON.stringify(current).includes('foreign-'));
  assert.equal((diagnostics.read('notebook',{scope:'history'}) as any).overview,undefined);
  assert.equal((diagnostics.read('notebook',{scope:'current',before:String(current.nextCursor)}) as any).overview,undefined);
  assert.equal((diagnostics.read('reminders',{scope:'current'}) as any).overview,undefined);
  store.save(state,'notebook-removed',{id:relation.id});assert.equal((diagnostics.read('notebook',{}) as any).overview.capacity.entries,5);
 }finally{store.close();}
});
test('notebook overview shows strategy and explicit unavailable capacity without retired relationship memory',()=>{
 const value:NotebookOverviewData={memory:{strategy:'先扩张，保留两路后手。',relations:'旧关系文字',agreements:'旧协议',deceptions:'旧意图'},relations:[relation]};
 const html=renderToStaticMarkup(React.createElement(NotebookOverview,{value}));
 assert.ok(html.includes(value.memory.strategy));assert.ok(html.includes('容量未核实'));
 for(const old of ['关系表','旧关系文字','旧协议','旧意图'])assert.ok(!html.includes(old));
 const empty=renderToStaticMarkup(React.createElement(NotebookOverview,{value:{memory:{strategy:''}}}));
 assert.ok(!empty.includes('总体战略'));
});

test('diagnostics validates current round and reports stored receipt characters without exposing bodies',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'});
 const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>[]));
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'room');
 try{
  store.save(state,'observation-baseline',o);
  let workset=createRoundWorkset('round-1',o,{category:'strategy',weight:'heavy',reasons:[],entities:[],deferred:[]});
  workset=appendRoundReceipt(workset,{id:'read',tool:'chatHistory',result:{effect:'private-body-canary'}});
  workset=appendRoundReceipt(workset,{id:'write',tool:'order',result:{status:'unknown'}});
  store.save(state,'round-workset',{workset});
  store.save(state,'round-materials-changed',{roundId:'round-1',action:'release',removed:['old-read']});
  const current=(diagnostics.read('notebook',{scope:'current',limit:'1'}) as any).overview;
  assert.equal(current.roundMaterials.status,'active');assert.equal(current.roundMaterials.reads,0);assert.equal(current.roundMaterials.protected,2);
  assert.equal(current.roundMaterials.characters,workset.receipts.reduce((n,r)=>n+JSON.stringify(r).length,0));
  assert.ok(!JSON.stringify(current).includes('private-body-canary'));
  assert.equal(current.materialChanges,undefined);
  store.save(state,'round-workset',{workset:{...workset,digest:'broken'}});
  assert.deepEqual({...((diagnostics.read('notebook',{}) as any).overview.roundMaterials)},{status:'unavailable'});
  store.save(state,'round-workset',{workset:null});
  assert.deepEqual({...((diagnostics.read('notebook',{}) as any).overview.roundMaterials)},{status:'none'});
 }finally{store.close();}
});

test('round materials UI exposes protected execution receipts without retired query controls',()=>{
 const value:NotebookOverviewData={memory:{strategy:''},roundMaterials:{status:'active',id:'r',reads:0,protected:1,characters:345,entries:[{id:'write',tool:'order',characters:345,releasable:false}]}};
 const html=renderToStaticMarkup(React.createElement(NotebookOverview,{value}));
 for(const text of ['同轮工作资料','1 项受保护回执','345','write'])assert.ok(html.includes(text),text);
 for(const retired of ['成功查询','重算成功后替换','最近释放'])assert.ok(!html.includes(retired));
});
