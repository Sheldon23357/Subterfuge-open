import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {recentAiCalls,recentCallSummary,loadRecentAiCalls,RecentAiCallCharts} from '../packages/client/src/RecentAiCalls.js';
import type {DiagnosticCall} from '../packages/client/src/AgentCallList.js';
import type {ConsoleRequest} from '../packages/client/src/AgentConnectionWizard.js';

const call=(id:number):DiagnosticCall=>({callRef:id,round:null,step:null,attempt:null,startedAt:null,durationMs:1000,outcome:'completed',prompt:{available:true,characters:100,truncated:false},usage:{inputTokens:20,outputTokens:5,cachedInputTokens:null,totalTokens:25,provenance:'reported'},captured:true});
test('recent calls merge all lanes by journal order, deduplicate and keep exactly the last fifty',()=>{
 const automatic=Array.from({length:60},(_,i)=>({...call(i*2+1),lane:'strategy'})),commander=Array.from({length:60},(_,i)=>({...call(i*2+2),lane:'commander'}));
 const before=structuredClone(automatic),result=recentAiCalls([...automatic,call(120)],commander);
 assert.deepEqual(result.map(c=>c.callRef),Array.from({length:50},(_,i)=>71+i));
 assert.equal(result.at(-1)?.lane,'commander');assert.deepEqual(automatic,before);
});
test('context and elapsed means use their own known samples, retaining zero and excluding absent or invalid values',()=>{
 const values=[{...call(1),durationMs:0,prompt:{available:true,characters:0,truncated:false}},call(2),{...call(3),durationMs:null,prompt:{available:false,characters:null as unknown as number,truncated:false}},{...call(4),durationMs:-1,prompt:{available:true,characters:Infinity,truncated:false}}];
 assert.deepEqual(recentCallSummary(values),{context:{known:2,average:50,max:100},duration:{known:2,average:500,max:1000}});
 assert.equal(recentCallSummary([{...call(5),prompt:{available:false,characters:0,truncated:false}}]).context.known,0);
 assert.deepEqual(recentCallSummary([]),{context:{known:0,average:null,max:null},duration:{known:0,average:null,max:null}});
});
test('recent-call queries include both sources and reject mixed generations or a partial response',async()=>{
 const routes:string[]=[];
 const request:ConsoleRequest=async<T>(route:string)=>{routes.push(route);return {generation:'g',entries:[call(route.includes('commander-calls')?2:1)]} as T;};
 assert.deepEqual((await loadRecentAiCalls('seat 1',request,new AbortController().signal)).map(c=>c.callRef),[1,2]);
 assert.ok(routes.every(route=>route.includes('seat=seat%201&limit=50')));
 const changed:ConsoleRequest=async<T>(route:string)=>({generation:route.includes('commander-calls')?'new':'old',entries:[]} as T);
 await assert.rejects(loadRecentAiCalls('seat',changed,new AbortController().signal),/更新/);
 const partial:ConsoleRequest=async<T>(route:string)=>{if(route.includes('commander-calls'))throw Error('unavailable');return {generation:'g',entries:[]} as T;};
 await assert.rejects(loadRecentAiCalls('seat',partial,new AbortController().signal),/暂不可用/);
});
test('charts expose per-call lengths and timing, unknown values and safe content without reading prompt bodies',()=>{
 const calls=[{...call(1),prompt:{available:false,characters:null as unknown as number,truncated:false},durationMs:null},{...call(2),lane:'strategy',mode:'strategy',providerDurationMs:800,queueWaitMs:200}];
 const html=renderToStaticMarkup(React.createElement(RecentAiCallCharts,{calls}));
 for(const text of ['上下文长度 · 字符','调用总耗时 · 秒','逐次明细','模型耗时','排队耗时','100 字符','1 秒','0.8 秒','0.2 秒','未知'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/<svg/g)??[]).length,1);assert.match(html,/双坐标轴折线图/);assert.match(html,/data-series="context"/);assert.match(html,/data-series="duration"/);
 const empty=renderToStaticMarkup(React.createElement(RecentAiCallCharts,{calls:[],error:'<script>unavailable</script>'}));
 assert.ok(empty.includes('role="alert"'));assert.ok(empty.includes('&lt;script&gt;'));assert.ok(!empty.includes('<svg'));
});
