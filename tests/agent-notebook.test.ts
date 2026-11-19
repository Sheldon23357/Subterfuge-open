import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NotebookWorkspace,filterNotebookRecords,notebookRecords,notebookDiplomacyRecords,mergeNotebookPages,isProgramNote,readNotebookBatch,type NotebookPage} from '../packages/client/src/AgentNotebook.js';
import type {HybridSummaryData} from '../packages/client/src/HybridSummary.js';
import type {ConsoleRequest} from '../packages/client/src/AgentConnectionWizard.js';
import type {NoteEntry} from '../packages/client/src/NoteReadable.js';
import {NotebookIntentCards,NotebookAgreementCards,notebookCurrentAgreements} from '../packages/client/src/NotebookOrders.js';
import type {PlayerDiplomacy} from '../packages/contracts/src/index.js';

const entry=(id:number,payload:Record<string,unknown>,archived=false):NoteEntry=>({id,kind:'notebook-set',payload,archived});
const page=(entries:NoteEntry[],nextCursor:number|null=null):NotebookPage=>({generation:'test-generation',entries,nextCursor});
test('notebook browsing separates saved cognition, reminders, archives and program plans without guessing status',()=>{
 const active=entry(1,{kind:'plan',text:'防守据点A',record:{status:'completed'}});
 const archived=entry(2,{kind:'fact',text:'旧观察'},true);
 const program=entry(3,{id:'bot-plan',text:JSON.stringify({format:'bot-plan/1',targets:['A']})});
 const unavailable={id:4,kind:'notebook-set',payload:null,unavailable:true};
 const records=notebookRecords([active,archived,program,unavailable],[{id:1,kind:'reminder-set',payload:{note:'核对来袭',atWorldDay:20}}]);
 assert.deepEqual(filterNotebookRecords(records,'notes','','').map(r=>r.key),['notebook:1','notebook:4']);
 assert.deepEqual(filterNotebookRecords(records,'reminders','','').map(r=>r.key),['reminders:1']);
 assert.deepEqual(filterNotebookRecords(records,'archive','','').map(r=>r.key),['notebook:2']);
 assert.equal(isProgramNote(program),true);
 assert.equal(isProgramNote(entry(5,{id:'bot-plan',text:'需要检查计划'})),false);
});
test('search covers complete bodies and displayed outpost names while retaining type and archive boundaries',()=>{
 const records=notebookRecords([entry(1,{title:'防守安排',kind:'plan',text:'据点 1 暂缓扩张\n重新评估后保留 50 兵'}),entry(2,{kind:'fact',text:'ALPHA 出现来袭'},true)],[]);
 const names={'据点 1':'ALPHA'};
 assert.deepEqual(filterNotebookRecords(records,'notes',' alpha ','plan',names).map(r=>r.entry.id),[1]);
 assert.equal(filterNotebookRecords(records,'notes','重新评估','fact',names).length,0);
 assert.equal(filterNotebookRecords(records,'archive','来袭','',names).length,1);
});
test('appending old pages preserves the overview and current rows, deduplicates records, and follows empty scan pages',()=>{
 const current={...page([entry(10,{text:'new'})],9),overview:{memory:{strategy:'current strategy'}}};
 const appended=mergeNotebookPages(current,page([entry(10,{text:'duplicate'}),entry(8,{text:'old'})],7));
 assert.deepEqual(appended.entries.map(e=>e.id),[10,8]);assert.equal(appended.entries[0]?.payload,current.entries[0]?.payload);
 assert.equal(appended.overview,current.overview);
 assert.equal(mergeNotebookPages(appended,page([],3)).nextCursor,3);
 assert.throws(()=>mergeNotebookPages(current,{...page([]),generation:'another-game'}),/刷新/);
});
test('notes open on full strategic text and confirmed instructions without runtime dashboards',()=>{
 const notes:NotebookPage={...page([]),overview:{memory:{strategy:'跨轮战略记录'},commanderDirectives:{version:2,text:'北线保留 50 兵'}},hybrid:{state:{directive:{version:8,summary:'优先守住矿场 <script>unsafe</script>',commanderVersion:2,objectives:[],agreements:[]},tasks:[],messages:[]},feedback:{selected:'hold',coverage:{simulations:76},objects:[]},operations:[]}};
 const html=renderToStaticMarkup(React.createElement(NotebookWorkspace,{notes,reminders:page([]),busy:false,onRefresh:()=>{},onLoadNotes:()=>{},onLoadReminders:()=>{}}));
 for(const text of ['战略与指令','作战意图','行动与结果','外交协议','协议结算与关系','外交判断','外交往来','指挥官讨论','补充笔记','复查事项','归档记录','程序记忆与存储','跨轮战略记录','北线保留 50 兵','&lt;script&gt;'])assert.ok(html.includes(text),text);
 for(const text of ['<script>','分层协同','最近行动','条件模拟','生成候选','当前生效指令','查看全文'])assert.ok(!html.includes(text),text);
 assert.equal(notes.overview?.memory.strategy,'跨轮战略记录');
});
test('server-era diplomacy comes from saved conversations without inheriting obsolete agreement status or dates',()=>{
 const state:HybridSummaryData['state']={directive:{version:7,summary:'strategy',commanderVersion:0,objectives:[],agreements:[{conversation:'1',status:'expired',tick:5,summary:'old agreement',internalIntent:'old intent'}]},conversations:{'1':{summary:'new judgment',internalIntent:'new intent',archived:0},'2':{summary:'another conversation',internalIntent:'',archived:0}},tasks:[],messages:[]};
 const before=structuredClone(state),rows=notebookDiplomacyRecords(state);
 assert.equal(rows.length,2);assert.equal(rows[0]!.summary,'new judgment');assert.equal(rows[0]!.internalIntent,'new intent');
 assert.equal(rows[0]!.status,undefined);assert.equal(rows[0]!.tick,undefined);assert.equal(rows[0]!.source,'conversation');
 assert.deepEqual(state,before);assert.deepEqual(notebookDiplomacyRecords(undefined),[]);
});
test('review conditions are visible separately from timed reminders and do not become saved notebook entries',()=>{
 const timer={id:1,kind:'reminder-set',payload:{note:'timed review',atWorldDay:20}};
 const records=notebookRecords([], [timer],['重新评估 LIR','依据真实抵达结果判断'],9);
 const review=filterNotebookRecords(records,'reminders','','');
 assert.equal(review.length,3);assert.equal(review[0]!.entry.kind,'strategy-review-condition');
 assert.equal((review[0]!.entry.payload as Record<string,unknown>).version,9);
 assert.equal((review[0]!.entry.payload as Record<string,unknown>).atWorldDay,undefined);
 assert.equal(filterNotebookRecords(records,'notes','','').length,0);assert.equal(filterNotebookRecords(records,'archive','','').length,0);
});
test('storage count explicitly includes the program plan while cognition counts reflect saved conversations and review conditions',()=>{
 const notes:NotebookPage={...page([entry(1,{id:'bot-plan',text:JSON.stringify({format:'bot-plan/1',targets:[]})})]),overview:{memory:{strategy:''},capacity:{entries:1,entryLimit:32,characters:100,characterLimit:12000,strategyCharacters:0,strategyLimit:1000}},hybrid:{state:{directive:{version:9,summary:'strategy',reviewOn:['复查实际抵达'],commanderVersion:0,objectives:[],agreements:[]},conversations:{'1':{summary:'saved diplomacy',internalIntent:'private judgment',archived:0}},tasks:[],messages:[]},feedback:null,operations:[]}};
 const html=renderToStaticMarkup(React.createElement(NotebookWorkspace,{notes,reminders:page([]),busy:false,onRefresh:()=>{},onLoadNotes:()=>{},onLoadReminders:()=>{}}));
 assert.ok(html.includes('笔记存储 1 / 32 条（含程序记录）'));
 assert.match(html,/外交判断<\/span><small[^>]*>1<\/small>/);
 assert.match(html,/复查事项<\/span><small[^>]*>1<\/small>/);
 assert.match(html,/补充笔记<\/span><small[^>]*>0<\/small>/);
});

test('notebook expands current intent details and feedback without reviving ended or elapsed intents',()=>{
 const value:HybridSummaryData={state:{directive:null,tasks:[],messages:[],intents:[
  {id:'current',authority:'commander',spec:{kind:'capture',target:'outpost',until:30,priority:80,maxDrillersPerPlan:40},status:'blocked',reason:'等待兵力 <script>unsafe</script>'},
  {id:'elapsed',spec:{kind:'capture',target:'old',until:10},status:'pending',reason:'elapsed-hidden'},
  {id:'ended',spec:{kind:'capture',target:'old',until:50},status:'completed',reason:'completed-hidden'}
 ]},guidance:{worldDay:10,observedTick:10,forbiddenPlayers:[],forbiddenTargets:[],protectedSources:[],reserves:[],objectives:[],attackDefenseFactors:[]},feedback:null,operations:[]};
 const before=structuredClone(value),html=renderToStaticMarkup(React.createElement(NotebookIntentCards,{value,names:{outpost:'ALPHA'}}));
 for(const text of ['ALPHA','受阻','优先级 80','最多 40 兵力','指挥官指令','截止第 30 世界日','&lt;script&gt;'])assert.ok(html.includes(text),text);
 for(const text of ['<details','<script>','elapsed-hidden','completed-hidden'])assert.ok(!html.includes(text),text);
 assert.deepEqual(value,before);
 value.guidance=null;
 assert.ok(renderToStaticMarkup(React.createElement(NotebookIntentCards,{value,names:{}})).includes('待核实'));
});

test('notebook treaty cards distinguish proposals and active server agreements, showing complete terms and actual zero progress',()=>{
 const treaty:PlayerDiplomacy['agreements'][number]={id:'joint',players:[0,1],terms:{kind:'joint-attack',enemy:2},subsidy:{payer:0,amount:5},proposedAt:5,startedAt:10,deadline:210,status:'active',progress:[0,1],fulfilled:[false,true],reason:null,endedAt:null};
 const value:PlayerDiplomacy={time:20,receiptCount:0,agreementCount:3,relations:[],competition:[],receipts:[],agreements:[treaty,{...treaty,id:'proposal',status:'proposed',startedAt:null,terms:{kind:'ceasefire',outposts:['outpost']}},{...treaty,id:'closed',status:'completed',reason:'hidden-closed'}]};
 const before=structuredClone(value),html=renderToStaticMarkup(React.createElement(NotebookAgreementCards,{value,names:{outpost:'ALPHA'}}));
 assert.deepEqual(notebookCurrentAgreements(value)?.map(a=>a.id),['joint','proposal']);
 for(const text of ['履约中','待签署','0 / 1 占领据点','1 / 1 占领据点','矿产补贴','ALPHA','履约截止 <b>210</b> tick'])assert.ok(html.includes(text),text);
 for(const text of ['hidden-closed','<details','同意并签署'])assert.ok(!html.includes(text),text);
 assert.deepEqual(value,before);assert.equal(notebookCurrentAgreements(undefined),undefined);
 const unknown=renderToStaticMarkup(React.createElement(NotebookAgreementCards,{value:undefined,names:{}}));
 assert.ok(unknown.includes('未核实'));assert.ok(!unknown.includes('暂无'));
});
test('sparse journal scans fill the next visible batch while preserving the first-page strategy and respecting cancellation',async()=>{
 const responses=[{...page([],20),overview:{memory:{strategy:'full strategy'}}},page([],10),page([entry(5,{text:'available'})])];
 const routes:string[]=[];
 const request:ConsoleRequest=async<T>(route:string)=>{routes.push(route);return responses.shift() as T;};
 const result=await readNotebookBatch(request,'seat 1','notebook',new AbortController().signal);
 assert.equal(result.overview?.memory.strategy,'full strategy');assert.deepEqual(result.entries.map(e=>e.id),[5]);assert.equal(routes.length,3);
 assert.match(routes[1]!,/before=20&generation=test-generation/);
 const abort=new AbortController();abort.abort();await assert.rejects(readNotebookBatch(request,'seat','notebook',abort.signal));assert.equal(routes.length,3);
});
