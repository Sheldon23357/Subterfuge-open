
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExecutionChart} from '../packages/client/src/AgentDiagnostics.js';
import {aggregateModelRateLimits} from '../packages/ai/src/controller/diagnostics/model-rate-limit-stats.js';

test('429 counts appear in execution bars and cumulative totals without a standalone module',()=>{
 const html=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[{round:7,events:[]}],rateLimits:{total:12,byLane:{automatic:2,background:9,commander:1},lastAt:null,byRound:{7:2,8:9},unassigned:1}}));
 assert.match(html,/第 7 轮[^"<]*限流（HTTP 429） 2 次/);
 assert.match(html,/第 8 轮[^"<]*限流（HTTP 429） 9 次/);
 assert.match(html,/本局累计 HTTP 429：12 次/);
 assert.match(html,/1 次未关联轮次，仅计入累计/);
 assert.doesNotMatch(html,/模型限流统计/);
 assert.equal((html.match(/<section/g)??[]).length,1);
 const empty=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[{round:1,events:[]}]}));
 assert.match(empty,/限流（HTTP 429） 0 次/);
});

test('execution statistics render the server aggregate with background failures and with no failures',()=>{
 const rows=[{id:1,kind:'call-failed',metrics:[429,null,[],[],7]},
  {id:2,kind:'mode-hybrid-task-failed',metrics:[429,null,[],[],8]},
  {id:3,kind:'commander-call-failed',metrics:[429,null,[],[],null]}];
 for(const events of [rows,[]]){
  const stats=aggregateModelRateLimits(()=>events,0);
  const html=renderToStaticMarkup(React.createElement(ExecutionChart,{rounds:[],rateLimits:stats}));
  assert.match(html,new RegExp(`本局累计 HTTP 429：${events.length} 次`));
  assert.match(html,new RegExp(`Hybrid 后台 ${events.length?1:0}`));
  assert.ok(!html.includes('undefined'));
 }
});
