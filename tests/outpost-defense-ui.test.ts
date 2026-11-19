import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OutpostDefense,type OutpostDefenseData} from '../packages/client/src/OutpostDefense.js';
import {AttackScreeningNotebook,type AttackScreeningNotebookData} from '../packages/client/src/NotebookOverview.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {BotModeDiagnosticsInput} from '../packages/ai/src/controller/contracts/bot-mode.js';

const value:OutpostDefenseData={observedTick:24,current:false,parameters:{horizonTicks:48,firstSupportWeight:0.5,secondSupportWeight:0.2,outerEnemyWeight:0.5},outposts:[
 {id:'quiet',available:20,defense:20,enemy:0,pressureRatio:0,priority:0,importance:1,shortfall:0,requiredGarrison:0,friendlyIncoming:0,hostileIncoming:0,arrivalShortfall:0,earliestDeficitTicks:null,unknowns:['garrison:remote'],support:[]},
 {id:'home',available:20,defense:30,enemy:45,pressureRatio:1.5,priority:3.75,importance:2.5,shortfall:15,requiredGarrison:35,friendlyIncoming:0,hostileIncoming:40,arrivalShortfall:20,earliestDeficitTicks:5,unknowns:[],support:[{id:'quiet',ticks:10,available:20,weighted:10}]},
]};

test('defense table ranks pressure and retains historical basis, zeroes, unknowns and support evidence',()=>{
 const before=structuredClone(value);
 const html=renderToStaticMarkup(React.createElement(OutpostDefense,{value,names:{home:'王都',quiet:'后方',remote:'远方'}}));
 assert.ok(html.indexOf('王都')<html.indexOf('后方'));
 for(const text of ['历史评分，局势已变化','第 24 天','1.5','3.75','<td class="number">0</td>','驻军或归属未知：远方','10 天，可用 20，计入 10','未检出'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('情报不完整'));assert.deepEqual(value,before);
 assert.equal((html.match(/role="tooltip"/g)??[]).length,2);
 assert.match(html,/aria-label="王都 · 防守明细"/);
 assert.doesNotMatch(html.match(/<tbody>[\s\S]*?<\/tbody>/)![0],/<details/);
});

test('both mode diagnostic channels expose the saved defense calculation and preserve stale basis',()=>{
 const decision={observedTick:24,basisRevision:'old',risk:{parameters:value.parameters,outposts:value.outposts},assessments:[],selected:{id:'hold',kind:'hold',targets:[],drafts:[],reasons:[]},situation:{phase:'survival'},coverage:{},assumptions:[]};
 const observed=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[]},0,'diagnostic-basis');observed.revision='now';
 const input={observation:observed,latest:<T>(kind:string)=>kind==='decision'?{decision} as T:undefined} as BotModeDiagnosticsInput;
 for(const mode of [hybridMode,hybridMode]){
  const data=mode.diagnostics!(input).outpostDefense as OutpostDefenseData;
  assert.deepEqual(data,value);
  const current=mode.diagnostics!({...input,observation:{...observed,revision:'old'}}).outpostDefense as OutpostDefenseData;
  assert.equal(current.current,true);
  assert.equal(mode.diagnostics!({...input,latest:()=>undefined}).outpostDefense,undefined);
 }
});

test('attack table preserves supplied order, negative margins and evidence in tooltips without expandable rows',()=>{
 const item={target:'alpha',name:'Alpha',owner:null,type:'generator',score:10,confidence:1,assessment:'needs-more-force',selection:'conditional',tags:['reconnaissance'],reasons:['<script>reason</script>'],attackMargin:-4.5,additionalForceEstimate:5,components:{},valueBreakdown:{base:1,mineInvestment:0,total:1},timing:{attackTicks:12}};
 const value:AttackScreeningNotebookData={basisRevision:1,observedTick:24,current:false,ranked:[item,{...item,target:'beta',name:'Beta',score:90}],excluded:[{target:'gamma',reason:'no-uncommitted-source-within-time-window'}]};
 const html=renderToStaticMarkup(React.createElement(AttackScreeningNotebook,{value,names:{alpha:'甲',beta:'乙',gamma:'丙'}}));
 assert.ok(html.indexOf('甲')<html.indexOf('乙'),'backend group order is retained instead of sorting only by score');
 for(const text of ['历史评分，局势已变化','-4.5','需补充兵力','明细','防守数据不全','丙','时间窗口内没有未预留的可用出兵点','&lt;script&gt;reason'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('<script>'));
 assert.equal((html.match(/role="tooltip"/g)??[]).length,2);
 assert.match(html,/popover="auto"/);
 assert.doesNotMatch(html.match(/<tbody>[\s\S]*?<\/tbody>/)![0],/<details/);
});
