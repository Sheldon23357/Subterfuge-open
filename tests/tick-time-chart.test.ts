
import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TickTimeLine} from '../packages/client/src/TickTimeChart.js';
import type {TickTimeAnchor} from '../packages/contracts/src/index.js';

test('tick line shows boundary durations and preserve partial, batch and adjusted records',()=>{
 const records:TickTimeAnchor[]=[
  {id:1,revision:1,fromTick:null,tick:10,wallTimeMs:10000,monotonicMs:0,sessionId:'s',kind:'observed',source:'startup'},
  {id:2,revision:2,fromTick:10,tick:11,wallTimeMs:12000,monotonicMs:2000,sessionId:'s',kind:'advance',source:'automatic'},
  {id:3,revision:3,fromTick:11,tick:14,wallTimeMs:15000,monotonicMs:5000,sessionId:'s',kind:'batch',source:'manual'},
  {id:4,revision:4,fromTick:14,tick:15,wallTimeMs:14000,monotonicMs:9000,sessionId:'s',kind:'advance',source:'automatic'},
 ];
 const html=renderToStaticMarkup(React.createElement(TickTimeLine,{records}));
 assert.match(html,/Tick 10 → 11：2 s/);assert.match(html,/起点记录不完整/);
 assert.match(html,/Tick 11 → 14：3 s/);assert.match(html,/批量推进，未拆分单 tick/);
 assert.match(html,/Tick 14 → 15：4 s/);assert.match(html,/系统时钟调整/);
 assert.ok(!html.includes('Tick 12 → 13'));assert.ok(!/NaN|Infinity/.test(html));
});
test('tick chart handles an empty history and bounds the initial display to 50 intervals',()=>{
 assert.match(renderToStaticMarkup(React.createElement(TickTimeLine,{records:[]})),/尚无已结束/);
 const records:TickTimeAnchor[]=Array.from({length:102},(_,i)=>({id:i+1,revision:i+1,fromTick:i?i-1:null,tick:i,wallTimeMs:i*1000,monotonicMs:i*1000,sessionId:'s',kind:i?'advance':'observed',source:'automatic'}));
 const html=renderToStaticMarkup(React.createElement(TickTimeLine,{records}));
 assert.equal((html.match(/Tick \d+ → \d+：/g)??[]).length,50);assert.equal((html.match(/data-series="tick-duration"/g)??[]).length,1);assert.match(html,/Tick 100 → 101/);assert.ok(!html.includes('Tick 0 → 1'));
});
