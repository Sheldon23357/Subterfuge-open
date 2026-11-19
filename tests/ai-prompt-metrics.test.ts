import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promptReceiptBreakdown,renderedReceiptCharacters} from '../packages/ai/src/controller/presentation/prompt-receipt-breakdown.js';

test('receipt metrics partition captured text without changing whitespace or counting wrappers twice',()=>{
 const text=JSON.stringify([{tool:'forecast',id:'one',result:{status:'conditional'}},{tool:'compare',id:'two',result:{scenarios:[]}}],null,2);
 const metrics=renderedReceiptCharacters(text);
 assert.ok(metrics.tools.forecast!>0);assert.ok(metrics.tools.compare!>0);
 assert.equal(metrics.unavailable,0);
 assert.equal(Object.values(metrics.tools).reduce((sum,n)=>sum+n,0)+metrics.structure,text.length);
});

test('batched receipt metrics transfer child spans to current subtools and retain wrapper overhead',()=>{
 const text=JSON.stringify([{tool:'queries',id:'batch',arguments:{queries:[
  {id:'a',tool:'chatHistory',arguments:{limit:10}},
  {id:'c',tool:'compare',arguments:{targetTick:102,plans:[]}},
 ]},result:{results:[
  {id:'a',tool:'chatHistory',status:'success',result:{messages:[]}},
  {id:'c',tool:'compare',status:'success',result:{scenarios:[]}},
 ]}}]);
 const metrics=renderedReceiptCharacters(text);
 for(const tool of ['queries','chatHistory','compare'])assert.ok(metrics.tools[tool]!>0,tool);
 assert.equal(metrics.unavailable,0);
 assert.equal(Object.values(metrics.tools).reduce((sum,n)=>sum+n,0)+metrics.structure,text.length);
});

test('archived prompt accounting requires complete modules and preserves unavailable receipt bytes',()=>{
 const history='最近决策与回执：[]\n',feedback='本轮行动与回执（按执行顺序）：[{"tool":"forecast","result":{}}]\n';
 const metrics=promptReceiptBreakdown('prefix\n'+history+feedback+'suffix');
 assert.ok(metrics);assert.ok(metrics.tools.forecast!>0);assert.equal(metrics.total,history.length+feedback.length);
 assert.equal(Object.values(metrics.tools).reduce((sum,n)=>sum+n,0)+metrics.structure+metrics.unavailable,metrics.total);
 assert.equal(promptReceiptBreakdown(history+feedback.trimEnd()),undefined);
 const broken='[{"tool":"forecast"';
 assert.deepEqual(renderedReceiptCharacters(broken),{tools:{},structure:0,unavailable:broken.length});
});
