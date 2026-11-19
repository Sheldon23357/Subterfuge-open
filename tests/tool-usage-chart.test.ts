import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ToolUsageChart,ToolUsageBars} from '../packages/client/src/ToolUsageChart.js';
test('tool chart defaults to all with accessible all/latest50 switches and an explicit counting basis',()=>{
 const html=renderToStaticMarkup(React.createElement(ToolUsageChart,{usage:{all:{total:12,counts:{finish:10,compare:2}},recent:{total:2,counts:{compare:2}},recentRounds:[20],unassigned:1},labels:{finish:'结束本轮',compare:'方案比较'}}));
 assert.match(html,/工具调用次数/);assert.match(html,/aria-label="工具统计范围"/);assert.match(html,/aria-pressed="true">全部/);assert.match(html,/aria-pressed="false">最近50轮/);
 assert.match(html,/12 次请求/);assert.match(html,/结束本轮/);assert.match(html,/batch、queries 各计一次请求/);assert.match(html,/1 次历史请求未关联轮次/);
});
test('bar chart orders by count and preserves tiny tools and safely renders unknown tool names',()=>{
 const counts=Object.fromEntries([['__proto__',1],['forecast',100],['future<script>',2]]);
 const html=renderToStaticMarkup(React.createElement(ToolUsageBars,{bucket:{total:103,counts}}));
 assert.ok(html.indexOf('forecast')<html.indexOf('future&lt;script&gt;'));assert.ok(html.includes('__proto__'));assert.ok(html.includes('width:1%'));assert.ok(!html.includes('<script>'));
 assert.match(renderToStaticMarkup(React.createElement(ToolUsageBars,{bucket:{total:0,counts:{}}})),/此范围暂无工具调用/);
});
