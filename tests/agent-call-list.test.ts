import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentCallList,ModelCallFailure,callDisplayState,groupCallRecords,type DiagnosticCall} from '../packages/client/src/AgentCallList.js';
const call=(callRef:number,round=1,step=0):DiagnosticCall=>({callRef,round,step,attempt:0,startedAt:100,durationMs:1200,outcome:'completed',prompt:{available:true,characters:50000,truncated:false},usage:{inputTokens:null,outputTokens:null,cachedInputTokens:null,totalTokens:null,provenance:'unavailable'},captured:true,tool:'campaignCompare',summary:'先比较扩张方案',observedTick:0});
test('call groups show latest rounds first and preserve chronological attempts inside each round',()=>{
 const retry={...call(12,1,0),attempt:1};const groups=groupCallRecords([call(14,2),call(13,1,1),retry,call(11,1,0)]);
 assert.deepEqual(groups.map(g=>g.round),[2,1]);assert.deepEqual(groups[1]!.entries.map(c=>c.callRef),[11,12,13]);
});
test('model completion is distinct from tool rejection and interruption',()=>{
 assert.equal(callDisplayState({...call(1),toolOutcome:'not-executed',toolReconciled:true}).label,'已确认未执行');
 assert.equal(callDisplayState({...call(1),toolOutcome:'returned',toolReconciled:true}).label,'结果已核实');
 assert.equal(callDisplayState({...call(1),toolOutcome:'rejected'}).label,'工具被拒绝');
 assert.equal(callDisplayState({...call(1),tool:'queries',toolOutcome:'partial'}).label,'查询部分完成');
 assert.equal(callDisplayState({...call(1),tool:'order',toolOutcome:'unknown'}).label,'操作结果未知');
 assert.equal(callDisplayState({...call(1),outcome:'cancelled'}).label,'已中断');
 assert.equal(callDisplayState({...call(1),outcome:'failed'}).label,'调用失败');
 const html=renderToStaticMarkup(React.createElement(AgentCallList,{calls:[call(1),{...call(2,1,1),tool:'batch',toolOutcome:'rejected',toolError:'stale-observation'}],rounds:[{round:1,tick:0,reasons:['首次进入对局','恢复AI后重新检查']}],selected:2,busy:false,onSelect:()=>{}}));
 assert.ok(html.includes('首次入局 · 启动检查'));assert.ok(html.includes('aria-expanded="false"'));assert.ok(!html.includes('class="call-row'));
 assert.equal(callDisplayState({...call(2),tool:'batch',toolOutcome:'rejected'}).label,'批次未完成');
 assert.ok(html.includes('本页 2 次'));assert.ok(html.includes('耗时 2.4秒'));assert.ok(html.includes('Token 未知'));assert.ok(!html.includes('输入 0'));
});


test('hybrid automatic calls expose their task and usage directly without an execution-log disclosure',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentCallList,{calls:[{...call(7),round:null,lane:'strategy',mode:'diplomacy',processingStatus:'completed',tool:null,summary:'讨论共同进攻'}],newestFirst:true,selected:null,busy:false,onSelect:()=>{}}));
 for(const text of ['后台模型调用','外交谈判','已发布','讨论共同进攻'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('aria-expanded="true"'));assert.ok(!html.includes('执行记录'));
});


test('failure reason is visible in both call row and details and distinguishes returned-but-rejected output',()=>{
 const failed={...call(1),lane:'strategy',processingStatus:'failed',outcome:'completed',validationError:'双方确认缺少原文依据 <script>',failure:{stage:'validation',retryDelayMs:5000}};
 assert.equal(callDisplayState(failed).label,'回复被拒绝');
 const detail=renderToStaticMarkup(React.createElement(ModelCallFailure,{call:failed}));
 for(const value of ['双方确认缺少原文依据','回复校验','重试间隔 5 秒','&lt;script&gt;'])assert.ok(detail.includes(value));
 const provider=renderToStaticMarkup(React.createElement(ModelCallFailure,{call:{...call(2),error:'模型服务暂时不可用',failure:{stage:'provider',httpStatus:429,code:'transient'}}}));assert.match(provider,/HTTP 429/);assert.match(provider,/模型供应商/);
});

test('canonical background lane distinguishes provider return, publication, stale results and current inference',()=>{
 for(const [processingStatus,outcome,label] of [['queued','running','排队中'],['running','running','模型处理中'],['completed','completed','已发布'],['superseded','completed','已过时'],['stale-dependency','completed','依据已失效'],['incomplete-conversation','completed','会话已更新']] as const){
  assert.equal(callDisplayState({...call(1),lane:'strategy',processingStatus,outcome}).label,label);
 }
 assert.equal(callDisplayState({...call(1),lane:'strategy',callPhase:'transport',processingStatus:'completed'}).label,'已返回');
 assert.equal(callDisplayState({...call(1),lane:'strategy',processingStatus:'completed',outcome:'cancelled'}).label,'已中断');
 assert.equal(callDisplayState({...call(1),lane:'strategy',processingStatus:'completed',validationError:'rejected'}).label,'回复被拒绝');
});
