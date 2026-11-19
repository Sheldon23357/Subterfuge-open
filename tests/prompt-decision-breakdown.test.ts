import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {decisionContextBreakdown} from '../packages/ai/src/controller/presentation/prompt-decision-breakdown.js';
import {PromptDecisionDetails} from '../packages/client/src/PromptDecisionDetails.js';
import {PromptCompositionChart} from '../packages/client/src/AgentDiagnostics.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {promptCompositionGroups} from '../packages/client/src/prompt-composition-groups.js';

const wrap=(v:unknown)=>'prefix\n当前受限情报及新消息：'+JSON.stringify(v)+'\n本轮行动与回执（按执行顺序）：[]\n';
const value={observation:{view:{outposts:{fields:['id','drillers'],rows:[[0,'海底',12]]},fleets:[],self:{mines:1},match:{ended:false},tick:17},intel:{contact:'reported'},scheduled:[],revision:'r'},chat:[{text:'引号"、换行\n与 emoji 🚢'}],notebook:[{text:'private note'}],opening:{active:true},executionEvidence:[{drafts:[{drillers:4}]}],futureField:{unrecognized:true}};
test('categories below two percent merge dynamically without changing the total or double counting unknown characters',()=>{
 const sections={policy:200467,taskGuidance:46309,rulesAndTools:260239,strategyAndMemory:11196,stateProjection:17880,decisionHistory:8481,decisionContext:541168,feedback:243409,closingGuidance:11040};
 const groups=promptCompositionGroups(sections),other=groups.find(g=>g.key==='other')!;
 assert.equal(groups.length,6);assert.equal(other.members.length,3);
 assert.deepEqual(new Set(other.members),new Set(['strategyAndMemory','stateProjection','closingGuidance']));
 assert.equal(other.value,40116);assert.equal(groups.reduce((n,g)=>n+g.value,0),Object.values(sections).reduce((a,b)=>a+b,0));
 assert.equal(groups.find(g=>g.key==='toolReceipts')!.value,251890);
 assert.ok(!groups.some(g=>['decisionHistory','feedback'].includes(g.key)));
 const changed=promptCompositionGroups({...sections,policy:1,unclassified:9});
 assert.ok(changed.find(g=>g.key==='other')!.members.includes('policy'));assert.ok(changed.find(g=>g.key==='other')!.members.includes('unclassified'));
 assert.equal(changed.reduce((n,g)=>n+g.value,0),Object.values({...sections,policy:1,unclassified:9}).reduce((a,b)=>a+b,0));
});

test('receipt details belong directly to the merged parent and use the parent as percentage denominator',()=>{
 const sections={policy:1000,taskGuidance:100,rulesAndTools:800,strategyAndMemory:1,stateProjection:2,decisionHistory:80,decisionContext:700,feedback:120,closingGuidance:3};
 const calls=[{promptBreakdown:{unit:'characters',total:Object.values(sections).reduce((a,b)=>a+b,0),sections,toolReturns:{recall:90,order:70}}}];
 const html=renderToStaticMarkup(React.createElement(PromptCompositionChart,{calls:calls as any}));
 assert.ok(html.includes('行动与工具回执'));assert.ok(html.includes('回执明细'));assert.ok(html.includes('本轮 120，历史 80'));
 assert.ok(html.includes('90 · 45.0%'));assert.ok(html.includes('40 · 20.0%'));assert.ok(html.includes('未分类内容'));
 assert.ok(html.indexOf('行动与工具回执')<html.indexOf('回执明细'));assert.ok(html.indexOf('回执明细')<html.indexOf('其他'));
 assert.ok(!html.includes('prompt-tool-breakdown'));assert.ok(!html.includes('<span>本轮行动与工具回执</span>'));assert.ok(!html.includes('<span>历史决策与工具回执</span>'));
 const small=promptCompositionGroups({...sections,decisionHistory:1,feedback:1});
 assert.ok(small.find(g=>g.key==='other')!.members.includes('feedback'),'small receipt parent joins other but retains its detail association');
});
test('encoded decision subparts form an exact non-overlapping partition including escaped Unicode and table structures',()=>{
 const prompt=wrap(value),detail=decisionContextBreakdown(prompt)!;
 assert.ok(detail);assert.equal(Object.values(detail.sections).reduce((a,b)=>a+b,0),detail.total);
 assert.equal(detail.total,prompt.indexOf('本轮行动与回执')-prompt.indexOf('当前受限情报'));
 assert.equal(detail.sections.outposts,JSON.stringify(value.observation.view.outposts).length);
 assert.equal(detail.sections.chat,JSON.stringify(value.chat).length);assert.equal(detail.sections.notebook,JSON.stringify(value.notebook).length);
 assert.ok(detail.sections.structure!>0);assert.ok(detail.sections.other!>0);
 assert.equal(decisionContextBreakdown(prompt.slice(0,prompt.indexOf('本轮行动'))),undefined);
 assert.equal(decisionContextBreakdown(wrap(value).replace('"tick":17','"tick": 17')),undefined);
});

test('historical diagnostic reads backfill from saved prompts without rewriting archives or leaking bodies',()=>{
 const store=new AiStore(':memory:'),state=initialState('room',0,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,v=>v);state.sequence=1;
 try{
  const prompt=wrap(value),detail=decisionContextBreakdown(prompt)!;
  store.save(state,'call-reserved',{sequence:1,step:0,promptContext:{total:prompt.length,sections:{decisionContext:detail.total}}});
  const handle=diagnostics.beginCall({model:'fake',prompt,signal:new AbortController().signal})!;
  const before=JSON.stringify(store.debugGetCall('room',0,handle.record.callRef));
  const page=diagnostics.read('calls',{}) as any;
  assert.deepEqual(page.entries[0].promptBreakdown.decisionContext,detail);
  assert.ok(!JSON.stringify(page).includes('private note'));assert.equal(JSON.stringify(store.debugGetCall('room',0,handle.record.callRef)),before);
  store.save(state,'call-reserved',{sequence:1,step:1,promptContext:{total:prompt.length,sections:{decisionContext:detail.total+1}}});
  diagnostics.beginCall({model:'fake',prompt,signal:new AbortController().signal});
  assert.equal((diagnostics.read('calls',{}) as any).entries[0].promptBreakdown.decisionContext,undefined,'mismatched or redacted lengths cannot masquerade as exact totals');
 }finally{store.close();}
});

test('UI separates parent percentages from prompt totals and exposes unknown historical coverage',()=>{
 const calls=[{promptBreakdown:{unit:'characters',total:1000,sections:{decisionContext:100},decisionContext:{total:100,sections:{outposts:60,chat:40}}}},{promptBreakdown:{unit:'characters',total:1000,sections:{decisionContext:100}}}];
 const html=renderToStaticMarkup(React.createElement(PromptDecisionDetails,{calls:calls as any,total:2000}));
 assert.ok(html.includes('1/2 次调用可细分'));assert.ok(html.includes('据点与驻军'));assert.ok(html.includes('聊天与通信'));
 assert.ok(html.includes('未能细分的历史内容'));assert.ok(html.includes('60 · 30.0%'));assert.ok(html.includes('占总提示词 3.0%'));
 const integrated=renderToStaticMarkup(React.createElement(PromptCompositionChart,{calls:calls as any}));
 assert.ok(integrated.includes('当前情报明细'));assert.ok(integrated.includes('最新局势与变化'));assert.ok(integrated.includes('合计 2,000 字符'));
});
