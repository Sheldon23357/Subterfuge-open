
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {queryComputeSummary,ToolTimeSummary,JournalToolTimeSummary} from '../packages/client/src/DiagnosticTime.js';

test('query compute display distinguishes actual usage, partial coverage and missing measurements',()=>{
 const value={complete:false,processed:1,requested:3,computeBudget:{simulations:3,maxSimulations:32,computeMs:2510,maxComputeMs:2500,stopReason:'time-budget'}};
 const text=queryComputeSummary(value).join('；');
 assert.match(text,/已处理 1 \/ 3 项/);assert.match(text,/预测尝试 3 \/ 32 次/);
 assert.match(text,/2,510 \/ 2,500 毫秒/);assert.match(text,/时间预算耗尽/);assert.match(text,/不表示无解/);
 const html=renderToStaticMarkup(React.createElement(ToolTimeSummary,{tool:'queries',value}));
 assert.match(html,/预测尝试/);assert.match(html,/部分完成/);
 const unavailable=queryComputeSummary({complete:false});
 assert.match(unavailable.join('；'),/已处理 未知 \/ 未知 项/);assert.ok(unavailable.includes('计算用量未记录'));
 assert.ok(!unavailable.join('；').includes(' 0 '));
});

test('journal shows partial rejected query usage without claiming an intention was executed',()=>{
 const value={tool:'queries',result:{complete:false,processed:1,requested:2}};
 assert.match(renderToStaticMarkup(React.createElement(JournalToolTimeSummary,{kind:'tool-rejected',value})),/已处理 1/);
 assert.equal(renderToStaticMarkup(React.createElement(JournalToolTimeSummary,{kind:'tool-intent',value})), '');
});
