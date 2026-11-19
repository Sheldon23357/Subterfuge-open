import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {encodePromptSections,readPromptSections,readPromptMaterial} from '../packages/contracts/src/prompt-sections.js';
import {promptMaterialSections} from '../plugins/hybrid/src/prompt-material.js';
import {PromptContext} from '../packages/client/src/PromptContext.js';
import {promptContextModules,promptFieldLabel,promptValueHasContent} from '../packages/client/src/prompt-context.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';

test('producer tags preserve material, source spans and exact totals including headers, newlines and surrogate pairs',()=>{
 const brief={format:'hybrid-brief/1',basis:{player:0,tick:12},kind:'strategy',global:{self:{drillers:0}},facts:{unknown:null,empty:'',enabled:false,list:[]},futureField:{anything:'保留🛰️'}};
 const instructions='规则\n[instructions 示例]\n[/instructions]\n[[/instructions]]\n';
 const text=encodePromptSections([{id:'instructions',label:'模型规则',format:'text',text:instructions},...promptMaterialSections(brief)]);
 assert.ok(text.startsWith('[[[instructions 模型规则]]]\n'));
 assert.ok(!text.includes('"format":"text"'));assert.ok(!text.includes('"length":'));
 assert.deepEqual(readPromptMaterial(text),brief);
 const modules=promptContextModules(text);
 assert.equal(modules[0]?.value,instructions);
 assert.equal(modules.reduce((n,m)=>n+m.characters,0),text.length);
 assert.equal(modules.map(m=>m.source).join(''),text);
 assert.equal(modules.reduce((n,m)=>n+m.bodyCharacters,0),readPromptSections(text)!.reduce((n,s)=>n+s.text.length,0));
 for(let i=0;i<modules.length;i++){
  assert.equal(modules[i]!.end-modules[i]!.start,modules[i]!.characters);
  assert.equal(modules[i]!.start,i?modules[i-1]!.end:0);
 }
 assert.equal(modules.find(m=>m.key==='brief.global')?.label,'全局局势');
 assert.equal(promptFieldLabel('__proto__'),'__proto__');
});

test('unmarked, damaged and truncated source never receives guessed boundaries or partial totals',()=>{
 const framed=encodePromptSections([{id:'x',label:'明确名称',format:'text',text:'body'}]);
 assert.equal(framed,'[x 明确名称]\nbody\n[/x]\n');
 for(const source of ['plain <script>text</script>','规则\n简报：{"global":{"x":1}}',framed.slice(0,-1),framed+'extra',framed.replace('[/x]','[/other]')]){
  assert.equal(readPromptSections(source),null);
  const [module]=promptContextModules(source);
  assert.equal(module?.key,'raw');assert.equal(module?.value,source);assert.equal(module?.characters,source.length);
 }
 assert.throws(()=>encodePromptSections([{id:'x',label:'x',format:'text',text:''},{id:'x',label:'x',format:'text',text:''}]),/Duplicate/);
});

test('credential redaction keeps exact safe section lengths across repeated exports',()=>{
 const secret='synthetic-private-credential',redact=createDiagnosticRedactor(()=>[secret]);
 const prompt=encodePromptSections([{id:'facts',label:'事实',format:'text',text:'note '+secret+'\nBearer synthetic-token'}]);
 const safe=redact(prompt) as string;
 assert.ok(!safe.includes(secret));assert.ok(!safe.includes('synthetic-token'));
 const parts=readPromptSections(safe)!;assert.ok(parts);
 assert.equal(parts.reduce((sum,s)=>sum+s.end-s.start,0),safe.length);
 assert.equal(redact(safe),safe);
});

test('search opens tagged modules and renders tables without losing false, null or zero; HTML stays escaped',()=>{
 const text=encodePromptSections(promptMaterialSections({global:{players:{columns:['name','count','known','optional'],rows:[['ALPHA',0,false,null],['BETA',5,true,'x']]}},evidence:{messages:['<script>unsafe()</script>']}}));
 const closed=renderToStaticMarkup(React.createElement(PromptContext,{text}));
 assert.match(closed,/全局局势/);assert.ok(!closed.includes('<table'));
 const table=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'ALPHA'}));
 assert.match(table,/<table>/);assert.match(table,/ALPHA/);
 for(const token of ['>0<','>false<','>null<'])assert.ok(table.includes(token),token);
 const escaped=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'unsafe'}));
 assert.ok(!escaped.includes('<script>'));assert.match(escaped,/&lt;script&gt;unsafe/);
 const empty=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'no such content'}));
 assert.match(empty,/无匹配内容/);
});

test('empty collection fields and their empty parents are hidden without treating scalar values as empty',()=>{
 for(const value of [[],{},{ceasefire:[],jointAttack:[]},{nested:{history:[]}}, {columns:['name','count'],rows:[]}])assert.equal(promptValueHasContent(value),false);
 for(const value of [0,false,null,'',[0],{count:0},{enabled:false},{unknown:null},{columns:['count'],rows:[[0]]}])assert.equal(promptValueHasContent(value),true);
 const value={history:{ceasefire:[],jointAttack:[]},otherHistory:[],active:[{name:'visible'}],count:0,enabled:false,unknown:null};
 const text=encodePromptSections([{id:'brief.evidence',label:'测试字段',format:'json',text:JSON.stringify(value)}]);
 const html=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'测试字段'}));
 const fields=html.split('<details class="context-module-source">')[0]!;
 for(const label of ['最近讨论','otherHistory','ceasefire','jointAttack'])assert.ok(!fields.includes(label),label);
 assert.ok(fields.includes('active'));assert.ok(fields.includes('>1 项<'));
 for(const token of ['>0<','>false<','>null<'])assert.ok(fields.includes(token),token);
 assert.deepEqual(promptContextModules(text)[0]!.value,value);
 assert.ok(html.includes('&quot;ceasefire&quot;:[]'),'the exact module source remains available');
});

test('entirely empty structured modules are hidden while source spans and character totals stay intact',()=>{
 const text=encodePromptSections([{id:'brief.evidence',label:'空分组',format:'json',text:'{"history":{"ceasefire":[],"jointAttack":[]}}'}]);
 const html=renderToStaticMarkup(React.createElement(PromptContext,{text}));
 assert.ok(!html.includes('<b>空分组</b>'));assert.ok(html.includes('0 个模块'));
 assert.equal(promptContextModules(text).map(m=>m.source).join(''),text);
 assert.ok(html.includes(`${text.length.toLocaleString()} 字符`));
});

test('tables with coverage metadata render directly and object wrappers become one labelled path',()=>{
 const value={estimates:{forceSources:{columns:['source','stationed','reserveEstimate','availableEstimate','unknownSchedules','type'],rows:[['GABLER',40,12,28,0,'factory'],['OTHER',0,0,0,null,false]],coverage:{listed:2,total:3},futureMetadata:'retained'}}};
 const text=encodePromptSections([{id:'brief.planning',label:'候选与条件估算',format:'json',text:JSON.stringify(value)}]);
 const html=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'候选与条件估算'}));
 const fields=html.split('<details class="context-module-source">')[0]!;
 assert.match(fields,/<table>/);assert.match(fields,/条件估算 \/ 兵力来源/);
 assert.match(fields,/>来源<\/th>/);assert.match(fields,/GABLER/);assert.match(fields,/OTHER/);
 assert.match(fields,/资料覆盖 \/ 已列出/);assert.match(fields,/资料覆盖 \/ 总数/);assert.match(fields,/retained/);
 assert.equal((fields.match(/class="context-disclosure"/g)??[]).length,1,'opening the module is sufficient to read the table');
 for(const token of ['>0<','>false<','>null<'])assert.ok(fields.includes(token),token);
 assert.deepEqual(promptContextModules(text)[0]!.value,value,'the source data is not flattened or rewritten');
 const searched=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'GABLER'})).split('<details class="context-module-source">')[0]!;
 assert.match(searched,/GABLER/);assert.ok(!searched.includes('OTHER'));
});

test('record arrays render their fields without a separate disclosure for every item',()=>{
 const text=encodePromptSections([{id:'brief.facts',label:'授权事实',format:'json',text:JSON.stringify({records:[{identity:{name:'GABLER'},count:0},{identity:{name:'OTHER'},count:1}]})}]);
 const html=renderToStaticMarkup(React.createElement(PromptContext,{text,search:'records'})).split('<details class="context-module-source">')[0]!;
 assert.match(html,/identity \/ name/);assert.match(html,/GABLER/);assert.match(html,/OTHER/);
 assert.equal((html.match(/class="context-disclosure"/g)??[]).length,2,'only the module and array can collapse');
 assert.ok(!html.includes('第 1 项'));
});
