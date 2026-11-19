import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {HybridSummary,HybridUsage,type HybridSummaryData} from '../packages/client/src/HybridSummary.js';
import {AgentDiagnostics,ExecutionChart} from '../packages/client/src/AgentDiagnostics.js';
import {NotebookOverview} from '../packages/client/src/NotebookOverview.js';
import {ConsoleEvents} from '../packages/client/src/ConsoleEvents.js';
import {BotDecisionSummary,type BotDecisionSummaryData} from '../packages/client/src/BotDecisionSummary.js';

test('decision display omits routine assumptions while retaining specific unknowns and search interruptions',()=>{
 const value:BotDecisionSummaryData={observedTick:12,current:false,phase:'survival',kind:'defense',targets:['home'],reasons:['保留20兵守备'],operations:1,coverage:{generated:4,evaluated:2,simulations:3,complete:false,stopReason:'time-budget'},assumptions:['仅授权观察','未来执行仍需权限、资源及局面复核'],unknowns:['unobserved-world-possible','garrison:enemy','arrival-outcome-unknown']};
 const before=structuredClone(value),html=renderToStaticMarkup(React.createElement(BotDecisionSummary,{value,names:{home:'王都',enemy:'港口'}}));
 for(const text of ['保留20兵守备','历史判断，局势已变化','达到时间预算','驻军未知：港口','部分舰队抵达结果待确认','待核实'])assert.ok(html.includes(text),text);
 for(const text of [...value.assumptions,'假设与未确定事项','视野外可能发生其他变化','建议及提交不代表实际完成'])assert.ok(!html.includes(text),text);
 assert.deepEqual(value,before);
});

test('hybrid presentation keeps missing simulation data distinct from measured zero',()=>{
 const value:HybridSummaryData={state:null,feedback:null,operations:[]};
 const absent=renderToStaticMarkup(React.createElement(HybridSummary,{value,names:{}}));
 assert.match(absent,/尚无战术反馈/);assert.match(absent,/<dt>条件模拟<\/dt><dd>未记录<\/dd>/);
 const measured=renderToStaticMarkup(React.createElement(HybridSummary,{value:{...value,feedback:{selected:'capture:据点 1',coverage:{simulations:0},objects:[]}},names:{'据点 1':'ALPHA'}}));
 assert.match(measured,/<dt>条件模拟<\/dt><dd>0 次<\/dd>/);assert.match(measured,/攻占:ALPHA/);
});

test('hybrid fleet intents display fleet identities separately from named reinforcement targets',()=>{
 const value:HybridSummaryData={state:{directive:null,tasks:[],messages:[],intents:[{id:'gift',spec:{kind:'return-fleet',fleetId:'F1-12345678',until:150},status:'running',reason:'等待销毁回执'},{id:'stop',spec:{kind:'avoid',target:'home',until:150},status:'running',reason:'停止新增出航'}]},feedback:null,operations:[]};
 const html=renderToStaticMarkup(React.createElement(HybridSummary,{value,names:{home:'王都'}}));
 assert.match(html,/舰队返航 · F1-12345678/);assert.match(html,/禁止派兵 · 王都/);assert.ok(!html.includes('undefined'));
});

test('hybrid notebook hides empty strategy while preserving stored instructions',()=>{
 const value={memory:{strategy:''},commanderDirectives:{version:1,text:'守住 ALPHA'}};
 const hybrid=renderToStaticMarkup(React.createElement(NotebookOverview,{value,mode:'hybrid'}));
 assert.match(hybrid,/守住 ALPHA/);assert.ok(!hybrid.includes('暂无已保存的总体战略'));
 assert.match(hybrid,/上下文与存储/);
});

test('hybrid notebook uses one notes destination without the retired reminder tab',()=>{
 for(const mode of ['hybrid'] as const){
  const html=renderToStaticMarkup(React.createElement(AgentDiagnostics,{id:'ai-01',mode,tab:'notes',request:async<T>()=>({} as T)}));
  assert.equal(html.includes('>提醒</button>'),false);
  assert.ok(!html.includes('>攻防评估</button>'));
  assert.ok(!html.includes('aria-label="席位内容"'));
 }
});

test('programmatic execution chart reports counts without a model-call denominator',()=>{
 const rounds=[{round:1,events:[{id:1,kind:'rework' as const,source:'tool',reason:'partial execution',at:null,step:null,attempt:null}]}];
 const html=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds,showRatios:false}));
 assert.match(html,/返工次数/);assert.match(html,/<strong>1<\/strong>/);
 assert.ok(!html.includes('/ 调用次数'));assert.ok(!html.includes('100%'));
});

test('hybrid usage retains unknown usage counts and event disclosures escape untrusted text',()=>{
 const usage=renderToStaticMarkup(React.createElement(HybridUsage,{usage:{strategy:{calls:3,tokens:1400,unknown:2}}}));
 assert.match(usage,/战略规划/);assert.match(usage,/1,400/);assert.match(usage,/2 次/);
 const html=renderToStaticMarkup(React.createElement(ConsoleEvents,{entries:[{id:1,kind:'completed',payload:{summary:'<script>unsafe()</script>',nextReview:1200}}],error:'',busy:false,older:false,hasEarlier:false,onLatest:()=>{},onEarlier:()=>{}}));
 assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/原始记录/);assert.match(html,/下次复核/);
});


test('hybrid call details show context and output safely with explicit unknown usage',()=>{
 const html=renderToStaticMarkup(React.createElement(ConsoleEvents,{entries:[{id:1,kind:'mode-hybrid-model-call',payload:{sequence:2,kind:'strategy',task:'overview',attempt:0,status:'completed',model:'test',effort:'low',prompt:'<script>context</script>',responseSchema:{type:'object'},output:{summary:'<script>output</script>'},usage:{inputTokens:0,outputTokens:3},usageKnown:{input:true,output:true,cached:false},tokens:3,queuedAt:'2026-10-27T00:00:00.000Z',sentAt:'2026-10-27T00:00:01.000Z',finishedAt:'2026-10-27T00:00:03.000Z',queueWaitMs:1000,durationMs:3000,providerDurationMs:2000}}],error:'',busy:false,older:false,hasEarlier:false,onLatest:()=>{},onEarlier:()=>{}}));
 for(const text of ['完整上下文','模型输出','响应 Schema','输入 Token','缓存输入 Token','未报告','2.00 秒','调用 #2','&lt;script&gt;context','&lt;script&gt;output'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('<script>'));
 assert.match(html,/<dt>输入 Token<\/dt><dd>0<\/dd>/);
});
