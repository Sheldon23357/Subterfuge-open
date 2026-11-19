import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NotebookActionMemory,NotebookCommunicationMemory,NotebookDiscussionMemory,NotebookProgramMemory,type NotebookContextMemory} from '../packages/client/src/NotebookMemory.js';
import {NotebookSettlementCards} from '../packages/client/src/NotebookOrders.js';
import type {HybridSummaryData} from '../packages/client/src/HybridSummary.js';
import {notebookContextMemory} from '../packages/ai/src/controller/diagnostics/notebook-context.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';

const value=():HybridSummaryData=>({state:{directive:null,intents:[{id:'active',version:2,spec:{kind:'capture',target:'A',until:40},status:'running',reason:'等待实际交付'},{id:'ended',spec:{kind:'capture',target:'B',until:20},status:'cancelled',reason:'取消旧方向'}],chat:[{id:'chat',from:1,to:0,tick:8,sentAt:1,text:'保留完整来信 <script>unsafe</script>'}],handledMessages:['chat'],tasks:[],messages:[{id:'message',conversation:'1',status:'unknown',text:'尚未确认送达',fulfillment:{state:'blocked',taskIds:['active'],reason:'未收到回执'}}]},feedback:{coverage:{},basis:{tick:9},selected:'hold',limitations:['仅为条件估算'],objects:[{id:'A',kind:'capture',status:'unknown',available:null}]},operations:[{id:'moving',objective:'capture:A',status:'underway',issues:[],intentBindings:[{id:'active',version:2}],drafts:[{id:'draft',issueTick:9,action:{kind:'launch',source:'B',destination:'A',drillers:30}}],commands:[{draftId:'draft',requestId:'request',state:'accepted',orderId:'order'}]},{id:'failed',objective:'capture:B',status:'failed',issues:['实际结算确认失败']}]});
const context=():NotebookContextMemory=>({observedTick:10,manual:null,pendingManual:[],mining:null,execution:{pending:[{id:'pending',status:'unknown',arguments:{drillers:0},meaning:'禁止重发'}],observations:[],notices:[]},commander:{roomId:'room',player:0,directives:{version:1,text:'守住A',appliedVersion:1},messages:[{id:'discussion',role:'assistant',text:'先讨论',tick:9,sentAt:1,status:'completed',references:[],proposal:{id:'proposal',baseVersion:1,text:'待确认的完整新指令',summary:'提出新方向',status:'pending'}}]}});

test('cross-round action cards preserve accepted versus settlement, ended intent history and unknown values',()=>{
 const input=value(),before=structuredClone(input),html=renderToStaticMarkup(React.createElement(NotebookActionMemory,{value:input,context:context(),names:{A:'ALPHA',B:'BRAVO'}}));
 for(const text of ['未完成行动','近期任务结果','取消旧方向','实际结算确认失败','ALPHA','BRAVO','命令已接受','待实际结算','禁止重发','未知','条件估算'])assert.ok(html.includes(text),text);
 assert.deepEqual(input,before);assert.ok(!html.includes('已抵达'));
});

test('diplomacy and commander records show complete text and pending proposals without activating them',()=>{
 const input=value(),html=renderToStaticMarkup(React.createElement(NotebookCommunicationMemory,{value:input,names:{}}));
 for(const text of ['保留完整来信','&lt;script&gt;','已处理','尚未确认送达','结果未知','未收到回执','受阻'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('<script>'));
 const discussion=renderToStaticMarkup(React.createElement(NotebookDiscussionMemory,{context:context(),names:{}}));
 for(const text of ['待玩家确认','待确认的完整新指令','先讨论'])assert.ok(discussion.includes(text),text);
 assert.ok(!discussion.includes('<button'));assert.ok(!discussion.includes('<details class="commander'));
});

test('program plan memory exposes scout history and independent review while deduplicating the same local plan',()=>{
 const plan={format:'bot-plan/1',atTick:10,objective:'继续观察',targets:['A'],scoutedTargets:['B'],independentReview:{atTick:9,objective:'独立行动',status:'await-current-facts'}};
 const html=renderToStaticMarkup(React.createElement(NotebookProgramMemory,{context:{...context(),localPlan:{plan}},value:value(),plans:[plan],names:{A:'ALPHA',B:'BRAVO'}}));
 for(const text of ['已接受侦察的目标','独立行动复核','ALPHA','BRAVO','待核对事实'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/aria-label="保留的行动计划"/g)??[]).length,1);
});

test('protocol results include all available receipts including relationship changes outside an agreement',()=>{
 const receipts=Array.from({length:15},(_,i)=>({id:i,time:i,players:[0,1] as [number,number],agreementId:null,kind:'trust-changed',actor:null,details:{from:0,to:1,before:0,after:i}}));
 const html=renderToStaticMarkup(React.createElement(NotebookSettlementCards,{value:{time:15,receiptCount:30,agreementCount:0,relations:[{from:0,to:1,trust:0,history:0,borderPressure:0,competitionPressure:0}],competition:[],agreements:[],receipts},names:{}}));
 assert.equal((html.match(/<b>信任已结算<\/b>/g)??[]).length,15);assert.ok(html.includes('15 / 30'));assert.ok(html.includes('双向关系与累计记录'));
});

test('notebook context diagnostics reads cached authorized memory without acknowledging, mutating or crossing seats',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'});
 try{
  const observed=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'room');
  store.save(state,'wake-observation',observed);
  const cached={commander:context().commander},before=JSON.stringify(cached),journal=store.debugRows('room',0,{limit:100}).entries.length;
  const memory=notebookContextMemory(store,'room',0,observed,cached);
  assert.equal(memory.commander?.messages.length,1);assert.equal(memory.execution,null);
  assert.equal(notebookContextMemory(store,'room',1,{...observed,view:{...observed.view,player:1}},cached).commander,null);
  assert.equal(JSON.stringify(cached),before);assert.equal(store.debugRows('room',0,{limit:100}).entries.length,journal);
  const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['private-key-canary']),()=>({}),()=>({...memory,marker:'private-key-canary'}));
  const first=diagnostics.read('notebook',{scope:'current',limit:'1'}) as Record<string,unknown>;
  assert.ok(first.contextMemory);assert.ok(!JSON.stringify(first).includes('private-key-canary'));
  const older=diagnostics.read('notebook',{scope:'current',before:'1',limit:'1'}) as Record<string,unknown>;
  assert.equal(older.contextMemory,undefined);
 }finally{store.close();}
});
