
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialHybridState,basisOf,type StrategicDirective,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {applyIntentEdits} from '../plugins/hybrid/src/intents.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {HybridSummary,type HybridSummaryData} from '../packages/client/src/HybridSummary.js';
import {hybridInstructionRows} from '../packages/client/src/hybrid-instructions.js';
function fixture(){
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;c.economy.players.push({active:true,neptunium:0,minesCreated:0});
 let game=createFleetScenario(c);
 game=submitFleetOrder(game,{id:'joint',player:0,action:{kind:'propose-agreement',peer:2,terms:{kind:'joint-attack',enemy:1},subsidy:null,counterTo:null}}).state;
 game=submitFleetOrder(game,{id:'accept',player:2,action:{kind:'respond-agreement',agreementId:'joint',response:'accept'}}).state;
 const o=observation({state:game,scheduled:[]},0,'notebook'),state=initialHybridState();
 o.outpostNames!['蓝方工厂']='王都';o.outpostNames!['红方矿场']='港口';
 const d:StrategicDirective={version:3,basis:basisOf(o),summary:'集中进攻并保留后方',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[{conversation:'2',players:[2],status:'confirmed',summary:'与天火联合进攻赤潮',internalIntent:'真实合作，保留守军',forbidAttack:false,forbiddenTargets:[],expiresWorldDay:180,evidence:[],tick:100,jointAttack:{enemy:1,until:160}}]};state.directive=d;
 const operations:OperationState[]=[];
 const read=()=>hybridMode.diagnostics!({observation:o,latest:<T>(kind:string)=>(kind==='state'?state:kind==='operations'?{operations}:undefined) as T|undefined}).hybrid as HybridSummaryData;
 const html=()=>renderToStaticMarkup(React.createElement(HybridSummary,{value:read(),names:o.outpostNames!}));
 return {o,state,d,operations,read,html};
}
test('notebook renders agreements, genuine intent and exact live program guidance in readable groups',()=>{
 const f=fixture();applyIntentEdits(f.state,{cancel:[],upsert:[{id:null,task:{kind:'avoid',target:'蓝方工厂',until:160,reason:'履行停止增援'}},{id:null,task:{kind:'configure',target:'蓝方工厂',until:160,reason:'保持后方',minDrillers:30,maxDrillers:null,maintain:true,priority:70}}]},'model',0,f.o);
 f.operations.push({id:'immediate',objective:'accepted',basis:basisOf(f.o),strategyVersion:3,status:'accepted',drafts:[{id:'committed',issueTick:f.o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:20}}],orders:['accepted-order'],fleets:[],issues:[]});
 const read=f.read();assert.equal(read.guidance!.reserves[0]!.drillers,30);
 const html=f.html();for(const text of ['外交协议','天火','已确认','真实合作，保留守军','第 180 世界日','程序执行指导','禁止派兵','王都','最低留守','30 兵力','生效协议名额','港口','当前生效指令','战略判断','最近行动','运行详情','AI 任务记录'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('"forbiddenTargets"'));assert.ok(!html.includes('undefined'));
 assert.deepEqual(read.guidance!.attackDefenseFactors,[]);assert.ok(!html.includes('60%'));
});
test('fake acceptance text is displayed without inventing reinforcement or fleet commands',()=>{
 const f=fixture();f.d.agreements[0]!.jointAttack=null;f.d.agreements[0]!.summary='放心，我会销毁来袭舰队。';f.d.agreements[0]!.internalIntent='假意接受，不打算舰队返航';
 f.o.diplomacy!.agreements=[];const html=f.html();assert.ok(html.includes('假意接受，不打算舰队返航'));assert.ok(html.includes('当前没有额外执行约束'));assert.equal(f.state.intents,undefined);assert.deepEqual(f.read().guidance!.attackDefenseFactors,[]);
});
test('notebook does not keep an expired joint estimate or mutate the persisted strategy during read',()=>{
 const f=fixture();const before=structuredClone(f.state);f.o.view.tick=300;
 const read=f.read();assert.deepEqual(read.guidance!.attackDefenseFactors,[]);assert.deepEqual(read.guidance!.objectives,[]);assert.deepEqual(f.state,before);
});
test('diplomatic text is escaped and unavailable observations are shown as unknown instead of no constraints',()=>{
 const f=fixture();f.d.agreements[0]!.summary='<script>steal()</script>';
 const value=f.read();value.guidance=null;
 const html=renderToStaticMarkup(React.createElement(HybridSummary,{value,names:f.o.outpostNames!}));
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('当前观察不可用'));assert.ok(!html.includes('当前没有额外执行约束'));
});

test('one live instruction is shown once, with actual merged reserve and treaty provenance; history is separate',()=>{
 const f=fixture();f.d.agreements[0]!.forbiddenTargets=['红方矿场'];
 applyIntentEdits(f.state,{cancel:[],upsert:[{id:null,task:{kind:'avoid',target:'红方矿场',until:160,reason:'局部边界'}},{id:null,task:{kind:'configure',target:'蓝方工厂',until:160,reason:'保持后方',minDrillers:30,maxDrillers:null,maintain:true,priority:70}}]},'model',0,f.o);
 const value=f.read(),before=structuredClone(value),rows=hybridInstructionRows(value);
 assert.equal(rows.filter(r=>r.kind==='avoid'&&r.target==='红方矿场').length,1);
 assert.ok(!rows.find(r=>r.kind==='avoid')!.sources.some(source=>source.startsWith('外交协议')),'内部谈判不能冒充约束来源');
 assert.equal(rows.filter(r=>r.target==='蓝方工厂').length,1);
 assert.match(rows.find(r=>r.kind==='configure')!.detail,/执行最低留守 30/);
 assert.deepEqual(value,before);
 f.state.intents![0]!.status='cancelled';f.d.agreements[0]!.forbiddenTargets=[];
 assert.ok(!hybridInstructionRows(f.read()).some(r=>r.kind==='avoid'));
 assert.ok(!f.html().includes('已结束记录'));
});

test('repeated planning goals are merged per target and a live capture intent is not rendered again as a derived goal',()=>{
 const f=fixture();f.d.agreements=[];f.o.diplomacy!.agreements=[];
 f.d.objectives=[{id:'diplomacy:1:guard',kind:'defend',targets:['蓝方工厂'],priority:80,reason:'保护后方'},{id:'diplomacy:2:guard',kind:'defend',targets:['蓝方工厂'],priority:100,reason:'保护核心'}];
 applyIntentEdits(f.state,{cancel:[],upsert:[{id:null,task:{kind:'capture',target:'红方矿场',priority:90,until:160,reason:'集中进攻'}}]},'model',0,f.o);
 const rows=hybridInstructionRows(f.read());
 assert.equal(rows.filter(r=>r.kind==='defend').length,1);assert.match(rows.find(r=>r.kind==='defend')!.detail,/100/);
 assert.equal(rows.filter(r=>r.kind==='capture').length,1);
 const html=f.html();assert.ok(!html.includes('程序战略目标'));assert.ok(!html.includes('后台任务'));assert.ok(!html.includes('持续任务'));
});


test('an informational follow-up does not hide an existing live treaty rule',()=>{
 const f=fixture(),a=f.d.agreements[0]!;a.jointAttack=null;a.forbiddenTargets=['红方矿场'];
 f.state.messages=[{id:'follow-up',conversation:a.conversation,to:[2],text:'收到',basis:basisOf(f.o),messageIds:[],status:'accepted',agreement:a,fulfillment:{state:'none',taskIds:[],reason:'没有新增操作'}}];
 const html=f.html();assert.ok(html.includes('禁攻规则生效'));assert.ok(!html.includes('没有新增操作'));
});


test('notebook hides expired intent history while keeping outstanding operations visible',()=>{
 const f=fixture(),value=f.read(),now=value.guidance!.worldDay;
 value.state!.intents=[{id:'expired',spec:{kind:'avoid',target:'蓝方工厂',until:now+10},status:'expired',reason:'hidden-expired-status'}, {id:'elapsed',spec:{kind:'capture',target:'红方矿场',until:now},status:'cancelled',reason:'hidden-elapsed-deadline'}, {id:'recent',spec:{kind:'capture',target:'红方矿场',until:now+10},status:'completed',reason:'visible-recent-result'}];
 value.operations=[{id:'in-flight',objective:'capture:红方矿场',status:'underway',issues:['visible-pending-receipt']},{id:'finished',objective:'capture:蓝方工厂',status:'completed',issues:['hidden-finished-operation']}];
 const before=structuredClone(value),html=renderToStaticMarkup(React.createElement(HybridSummary,{value,names:f.o.outpostNames!}));
 assert.ok(!html.includes('hidden-expired-status'));assert.ok(!html.includes('hidden-elapsed-deadline'));
 assert.ok(!html.includes('visible-recent-result'));assert.ok(html.includes('visible-pending-receipt'));
 assert.ok(!html.includes('hidden-finished-operation'));assert.ok(!html.includes('已结束记录'));
 assert.ok(html.indexOf('aria-label="最近行动"')<html.indexOf('aria-label="运行详情"'));
 assert.ok(html.indexOf('aria-label="运行详情"')<html.indexOf('aria-label="战略判断"'));
 assert.deepEqual(value,before);
 value.state!.intents=value.state!.intents.slice(0,2);value.operations=[];
 assert.ok(!renderToStaticMarkup(React.createElement(HybridSummary,{value,names:{}})).includes('已结束记录'));
});


test('notebook omits closed and elapsed agreements without changing their stored audit data',()=>{
 const f=fixture(),a=structuredClone(f.d.agreements[0]!);
 f.o.view.tick=100;
 f.d.agreements=[...['fulfilled','expired','terminated','violated','none'].map((status,i)=>({...a,conversation:'closed-'+i,status:status as typeof a.status,summary:'hidden-closed-'+i})),{...a,conversation:'elapsed',expiresWorldDay:100,summary:'hidden-elapsed-agreement'},{...a,conversation:'stale-proposal',status:'proposed',tick:28,summary:'hidden-stale-proposal'}, {...a,summary:'visible-live-agreement'}];
 const before=structuredClone(f.state),html=f.html();
 assert.ok(html.includes('visible-live-agreement'));
 for(const text of ['已结束协议','hidden-closed-','hidden-elapsed-agreement','hidden-stale-proposal'])assert.ok(!html.includes(text),text);
 assert.deepEqual(f.state,before);
});
