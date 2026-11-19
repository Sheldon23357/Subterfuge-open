import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionChart,PromptCompositionChart,TokenChart,recentCallRounds} from '../packages/client/src/AgentDiagnostics.js';
import {aggregatePromptComposition} from '../packages/client/src/agent-statistics.js';
import type {DiagnosticCall} from '../packages/client/src/AgentCallList.js';
const call=(callRef:number,round:number|null):DiagnosticCall=>({callRef,round,step:0,attempt:0,startedAt:1,durationMs:1000,outcome:'completed',prompt:{available:true,characters:100,truncated:false},promptBreakdown:{unit:'characters',total:100,sections:{policy:20,decisionContext:80},decisionContext:{total:80,sections:{outposts:60,chat:20}}},usage:{inputTokens:20,outputTokens:5,cachedInputTokens:8,totalTokens:25,provenance:'reported'},captured:true});
const renderBars=(calls:DiagnosticCall[])=>renderToStaticMarkup(React.createElement(TokenChart,{calls}));
test('execution chart shows 50 chronological rounds with causes, zero rounds and keyboard targets',()=>{
 const rounds=Array.from({length:55},(_,i)=>({round:i+1,events:i===54?[{id:1,kind:'error' as const,source:'call-failed',reason:'timeout <script>',at:null,step:0,attempt:0}]:[]})).reverse();
 const html=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds}));
 assert.equal((html.match(/class="execution-round"/g)??[]).length,50);
 assert.ok(html.includes('最近 50 轮'));assert.ok(html.includes('第 6 轮'));assert.ok(!html.includes('第 5 轮'));
 assert.ok(!html.includes('<title>'));assert.ok(html.includes('返工 0 次'));assert.ok(html.includes('tabindex="0"'));
 assert.ok(renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[]})).includes('暂无执行轮次'));
});
test('token bars keep the latest 50 whole decision rounds, not 50 calls, in chronological order',()=>{
 const calls=Array.from({length:55},(_,i)=>[call(i*3+1,i+1),call(i*3+2,i+1),call(i*3+3,i+1)]).flat().reverse();
 const html=renderBars(calls),titles=[...html.matchAll(/<title>第 (\d+) 轮/g)].map(m=>Number(m[1]));
 assert.deepEqual(titles,Array.from({length:50},(_,i)=>i+6));assert.ok(html.includes('最近 50 轮 · 150 次调用'));
 assert.ok(html.includes('#16  输入 20'));assert.ok(html.includes('#18  输入 20'));assert.ok(!html.includes('#15  输入 20'));
 assert.equal((html.match(/class="token-round-bar"/g)??[]).length,50);
});
test('exactly 50 and fewer rounds retain all samples without mutating input',()=>{
 for(const length of [0,1,7,50]){const calls=Array.from({length},(_,i)=>call(i+1,i+1)),before=JSON.stringify(calls),html=renderBars(calls);
 assert.equal((html.match(/class="token-round-bar"/g)??[]).length,length);assert.equal(JSON.stringify(calls),before);if(!length)assert.ok(html.includes('暂无用量'));}
});
test('recent composition selects ten numbered rounds and all their attempts before checking availability',()=>{
 const calls=Array.from({length:12},(_,i)=>[call(i*2+1,i+1),call(i*2+2,i+1)]).flat();
 calls.push(call(100,null));delete calls.at(-2)!.promptBreakdown;
 const recent=recentCallRounds(calls,10),summary=aggregatePromptComposition(recent),all=aggregatePromptComposition(calls);
 assert.equal(recent.length,20);assert.deepEqual([...new Set(recent.map(c=>c.round))],Array.from({length:10},(_,i)=>i+3));
 assert.equal(summary.calls,19);assert.equal(summary.total,1900);assert.equal(all.calls,24);assert.equal(all.total,2400);
 assert.equal(summary.sections.decisionContext,1520);assert.equal(summary.decisionContext.coveredCalls,19);
 assert.equal(recentCallRounds(calls.slice(0,6),10).length,6);
});
test('unknown calls cannot consume a numbered round slot or fabricate complete token totals',()=>{
 const known=call(1,1),unknown=call(2,1);unknown.usage={inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,provenance:'unavailable'};
 const html=renderBars([known,unknown,call(3,null)]);
 assert.ok(html.includes('最近 1 轮 · 2 次调用'));assert.ok(html.includes('部分用量：输入 1/2 次 · 输出 1/2 次'));assert.ok(html.includes('#2  输入 未知'));
 assert.ok(!html.includes('合计 25 tokens'));assert.ok(!html.includes('第 null 轮'));
 const zero=call(4,2);zero.usage={inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,provenance:'reported'};
 assert.ok(renderBars([zero]).includes('合计 0 tokens'));
});
test('composition defaults to all and has a compact accessible range switch even when empty',()=>{
 const html=renderToStaticMarkup(React.createElement(PromptCompositionChart,{calls:[call(1,1)]}));
 assert.match(html,/aria-label="提示词统计范围"/);assert.match(html,/aria-pressed="true">所有<\/button>/);assert.match(html,/aria-pressed="false">最近10轮<\/button>/);
 assert.ok(html.includes('100 字符'));assert.ok(html.includes('实际字符占比'));assert.ok(html.includes('按提示词字符数统计'));assert.ok(html.includes('80 · 80.0%'));
 const empty=renderToStaticMarkup(React.createElement(PromptCompositionChart,{calls:[]}));assert.ok(empty.includes('暂无可用拆分'));assert.ok(empty.includes('最近10轮'));assert.ok(!empty.includes('NaN'));
});
test('aggregate composition renders its selected denominator and honest detail coverage',()=>{
 const first=call(1,1),second=call(2,2);delete second.promptBreakdown!.decisionContext;
 const summary=aggregatePromptComposition([first,second]);
 const html=renderToStaticMarkup(React.createElement(PromptCompositionChart,{composition:{all:summary,recent:aggregatePromptComposition([first])}}));
 assert.ok(html.includes('合计 200 字符'));assert.ok(html.includes('1/2 次调用可细分'));assert.ok(html.includes('未能细分的历史内容'));
 assert.ok(html.includes('60 · 37.5%'));assert.ok(html.includes('占总提示词 30.0%'));
});
test('all-history composition exposes missing breakdown coverage instead of treating absent records as zero',()=>{
 const summary=aggregatePromptComposition([call(1,1)]);
 const html=renderToStaticMarkup(React.createElement(PromptCompositionChart,{composition:{all:summary,recent:summary},sampleCounts:{all:3,recent:1}}));
 assert.ok(html.includes('1/3 次调用'));assert.ok(html.includes('2 次调用未记录可用字符拆分，未计入占比'));
});

test('execution percentages use calls from the same latest 50 execution rounds',()=>{
 const rounds=Array.from({length:51},(_,i)=>({round:i+1,events:i===50?[
  {id:3,kind:'error' as const,source:'call-failed',reason:'terminal failure',at:null,step:0,attempt:0},
  {id:1,kind:'rework' as const,source:'tool-rejected',reason:'rejected',at:null,step:0,attempt:0},
  {id:2,kind:'retry' as const,source:'provider-retry',reason:'retry',at:null,step:0,attempt:1},
 ]:[]}));
 const callRounds=[{round:1,calls:Array.from({length:20},(_,i)=>call(i+10,1))},{round:51,calls:[call(1,51),call(2,51)]},{round:52,calls:[call(3,52)]}];
 const html=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds,callRounds}));
 assert.equal((html.match(/<strong>50.0%<\/strong>/g)??[]).length,3);
 assert.equal((html.match(/1 次 \/ 2 次调用/g)??[]).length,3);
 const empty=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[],callRounds}));
 assert.equal((empty.match(/<strong>—<\/strong>/g)??[]).length,3);assert.ok(!/NaN|Infinity/.test(empty));
 const multiple=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[{round:51,events:[rounds[50]!.events[0]!,{...rounds[50]!.events[0]!,id:4}]}],callRounds:[{round:51,calls:[call(1,51)]}]}));
 assert.ok(multiple.includes('<strong>200.0%</strong>'));
});

test('token chart omits both per-round and per-call usage detail tables',()=>{
 const html=renderBars([call(1,1)]);
 assert.ok(!html.includes('<table'));assert.ok(!html.includes('用量明细'));assert.ok(!html.includes('逐轮用量'));
 assert.ok(html.includes('token-round-bar'));assert.ok(html.includes('近期缓存命中'));
});
