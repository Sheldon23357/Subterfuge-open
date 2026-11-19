import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TokenChart,tokenSeriesPath} from '../packages/client/src/AgentDiagnostics.js';
const call=(input:number|null,output:number|null,cached:number|null)=>({callRef:1,round:1,step:1,attempt:1,startedAt:1,durationMs:null,outcome:'complete',prompt:{available:false,characters:0,truncated:false},usage:{inputTokens:input,outputTokens:output,cachedInputTokens:cached,totalTokens:null,provenance:'legacy-unknown'},captured:false});
test('unknown usage creates gaps rather than fabricated zero samples',()=>{const path=tokenSeriesPath([10,null,20],20);assert.equal((path.match(/ M /g)??[]).length,2);assert.equal(path.includes(' L '),false);});
test('token chart states cache subset and displays unknown historical data honestly',()=>{const html=renderToStaticMarkup(React.createElement(TokenChart,{calls:[call(null,null,null)]}));assert.ok(html.includes('暂无用量'));assert.ok(html.includes('未知'));assert.ok(html.includes('输入中的缓存部分'));assert.ok(!html.includes('class="token-line'));});


test('a single reported round shows input and output bars without double counting cached input',()=>{
 const html=renderToStaticMarkup(React.createElement(TokenChart,{calls:[call(120,20,40)]}));
 assert.equal((html.match(/class="token-bar-input"/g)??[]).length,1);assert.equal((html.match(/class="token-bar-output"/g)??[]).length,1);
 assert.ok(html.includes('合计 140 tokens'));assert.ok(html.includes('缓存占输入 33.3%'));assert.ok(html.includes('token-legend'));
});

const renderCache=(calls:ReturnType<typeof call>[])=>renderToStaticMarkup(React.createElement(TokenChart,{calls}));
const heights=(html:string):Record<string,number>=>Object.fromEntries([...html.matchAll(/<rect class="token-bar-([\w-]+)"[^>]*height="([\d.e+-]+)"/g)].map(m=>[m[1],Number(m[2])]));
test('cache 0, 80 and 100 percent change real SVG partitions but conserve total height',()=>{
 const parts=[0,80,100].map(cached=>{const html=renderCache([call(100,10,cached)]);assert.ok(html.includes(`缓存占输入 ${cached.toFixed(1)}%`));assert.ok(html.includes('合计 110 tokens'));return heights(html);});
 assert.equal(parts[0]!.cached,undefined);assert.equal(parts[2]!.input,undefined);
 for(const part of parts)assert.ok(Math.abs(Object.values(part).reduce((a,b)=>a+b,0)-174)<1e-10);
 assert.ok(parts[1]!.cached!>parts[1]!.input!);assert.equal(parts[0]!.output,parts[2]!.output);
 assert.ok(Math.abs(parts[1]!.cached!/parts[0]!.input!-.8)<1e-10);
});
test('unknown cached input is hatched, not uncached, and partial ratios use matching known input',()=>{
 const unknown=renderCache([call(100,10,null)]),part=heights(unknown);
 assert.equal(part.input,undefined);assert.equal(part.cached,undefined);assert.ok(part['cache-unknown']!>0);
 assert.match(unknown,/class="token-bar-cache-unknown"[^>]*fill="url\(#token-cache-unknown-/);assert.ok(unknown.includes('缓存占输入 未知'));
 const second={...call(300,30,null),callRef:2},html=renderCache([call(100,10,80),second]),partial=heights(html);
 assert.ok(html.includes('缓存占输入 80.0%（仅已知样本）'));assert.ok(html.includes('缓存统计覆盖 1/2 次调用 · 对应输入分母 100'));
 assert.ok(html.includes('缓存未知的已记录输入 300'));assert.ok(html.includes('合计 440 tokens'));
 assert.ok(Math.abs(Object.values(partial).reduce((a,b)=>a+b,0)-174)<1e-10);
});
test('zero, absent and invalid cache values never invent a known ratio or invalid geometry',()=>{
 for(const values of [[0,0,0],[null,10,8],[100,10,101],[100,10,-1],[100,10,NaN]] as const){
  const html=renderCache([call(values[0],values[1],values[2])]);assert.ok(!html.includes('缓存占输入 NaN'));assert.ok(!html.includes('height="NaN"'));assert.ok(!html.includes('height="-'));
  if(values[0]===0)assert.ok(html.includes('不适用（输入为 0）'));
  else {assert.ok(html.includes('缓存统计覆盖 0/1 次调用'));assert.equal(heights(html).cached,undefined);}
 }
});
test('multiple mounted charts have unique cache pattern references',()=>{
 const html=renderToStaticMarkup(React.createElement(React.Fragment,null,React.createElement(TokenChart,{calls:[call(100,10,null)]}),React.createElement(TokenChart,{calls:[call(100,10,null)]})));
 const ids=[...html.matchAll(/<pattern id="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,2);assert.equal(new Set(ids).size,2);
 for(const id of ids)assert.ok(html.includes(`fill="url(#${id})"`));
});
