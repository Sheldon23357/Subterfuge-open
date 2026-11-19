import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {computeBot} from '../packages/ai/src/controller/local/bot-worker.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {closeBotForecastPool} from '../packages/ai/src/controller/analysis/tactical-forecast-pool.js';
import {liveOperations} from '../plugins/hybrid/src/live-operations.js';
import {AgentDiagnostics} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {createDiagnosticRedactor} from '../packages/ai/src/application/agent-redactor.js';
import {SeatRunner} from '../packages/ai/src/reference.js';
import {LivePipeline,liveSeatPhase,liveEngineCounts} from '../packages/client/src/AgentLiveOperations.js';
import type {ConsoleSeat} from '../packages/client/src/agent-console-state.js';
import type {BotLiveSnapshot,BotSearchProgress} from '../packages/contracts/src/index.js';

function fixture(){const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.match={mode:'mining',neptuniumGoal:200};const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'live-diagnostics');return {o,routes:attackRoutes(o)};}

test('engine counts distinguish active model calls from all busy program phases',()=>{
 const telemetry={round:3,phase:'observation',tool:null,tick:1,pendingSignals:0,background:{active:0,queued:0},search:null};
 const seat:ConsoleSeat={id:'a',roomId:'r',lobbySeat:0,bound:true,mode:'live',status:'waiting',enabled:true,busy:false,calls:0,tokens:0,error:null,telemetry};
 const search={...telemetry,phase:'local',search:{sequence:3,at:0,progress:{} as BotSearchProgress}};
 const model={...telemetry,background:{active:1,queued:0}};
 const seats=[{...seat,telemetry:model},{...seat,busy:true,telemetry:search},{...seat,busy:true,telemetry:{...search,background:model.background}},
  {...seat,busy:true},{...seat,telemetry:{...telemetry,background:{active:0,queued:2}}},{...seat,bound:false,telemetry:model}];
 assert.deepEqual(liveEngineCounts(seats,true),{total:5,ai:2,search:3});
 assert.deepEqual(liveEngineCounts(seats,false),{total:5,ai:0,search:0});
 for(const changes of [{enabled:false},{starting:true},{stopping:true},{error:'failed'},{status:'ended'},{status:'error'}]){
  assert.deepEqual(liveEngineCounts([{...seat,busy:true,telemetry:{...search,background:model.background},...changes}],true),{total:1,ai:0,search:0});
 }
 assert.equal(liveEngineCounts([{...seat,telemetry:search}],true).search,0,'old search samples alone do not make an idle program busy');
 for(const phase of ['observation','local','tool'])assert.equal(liveEngineCounts([{...seat,busy:true,telemetry:{...search,phase}}],true).search,1);
 for(const foreground of ['planning-sync','readiness'] as const)assert.equal(liveEngineCounts([{...seat,busy:true,telemetry:{...telemetry,foreground}}],true).search,1);
});

test('real worker progress reports authorized branches without changing the selected decision or budget',async t=>{
 t.after(closeBotForecastPool);const {o,routes}=fixture(),samples:BotSearchProgress[]=[];
 const options={maxSimulations:12,maxElapsedMs:60000};
 const expected=planBot(o,routes,options),actual=await computeBot(o,routes,{...options,onProgress:p=>samples.push(p)});
 assert.deepEqual(actual,expected);assert.ok(samples.length>0);
 for(const p of samples){assert.equal(p.basisRevision,o.revision);assert.equal(p.observedTick,o.view.tick);assert.ok(p.simulations<=12);assert.ok(p.evaluated<=p.generated+1);assert.ok(p.elapsedMs>=0);assert.ok(p.branches.some(b=>b.status==='running'));for(const b of p.branches)for(const r of b.routes){assert.ok(o.view.outposts.some(outpost=>outpost.id===r.source));assert.ok(o.view.outposts.some(outpost=>outpost.id===r.target));}}
 assert.ok(samples.every((s,i)=>!i||s.simulations>=samples[i-1]!.simulations));
});

test('live projection keeps newer search distinct from receipts and marks an obsolete observation',()=>{
 const {o,routes}=fixture(),decision=planBot(o,routes,{maxSimulations:2,maxElapsedMs:60000});
 const records:Record<string,unknown>={decision:{sequence:1,decision},search:{sequence:2,decision}};
 const projection=liveOperations({...o,revision:'changed'},<T>(kind:string)=>records[kind] as T|undefined);
 assert.equal(projection.decision?.sequence,2);assert.equal(projection.decision?.finalized,false);assert.equal(projection.decision?.current,false);
 assert.deepEqual(projection.operations,[]);assert.ok(!JSON.stringify(projection).includes('prompt'));
 assert.deepEqual(projection.decision?.coverage,decision.coverage);
 assert.equal(liveOperations(o,<T>()=>undefined as T|undefined).decision,null);
 records.search={sequence:1,step:2,decision};records.decision={sequence:1,step:1,decision};assert.equal(liveOperations(o,<T>(k:string)=>records[k] as T|undefined).decision?.finalized,false);
 records.decision={sequence:1,step:2,decision};assert.equal(liveOperations(o,<T>(k:string)=>records[k] as T|undefined).decision?.finalized,true);
});

test('live diagnostics redact summaries, preserve nulls, and reject mismatched generation or extra queries',()=>{
 const store=new AiStore(':memory:'),state=initialState('live-room',0,{model:'',personality:'schemer'});
 try{
  store.save(state,'tool-result',{tool:'batch',summary:'receipt secret-canary',sequence:3});
  const diagnostics=new AgentDiagnostics(store,state,createDiagnosticRedactor(()=>['secret-canary']));
  const result=diagnostics.read('live') as BotLiveSnapshot;
  assert.equal(result.decision,null);assert.equal(result.observedTick,null);assert.equal(result.events[0]?.round,3);
  assert.ok(!JSON.stringify(result).includes('secret-canary'));assert.ok(JSON.stringify(result).includes('[redacted]'));
  assert.throws(()=>diagnostics.read('live',{generation:'wrong'}));assert.throws(()=>diagnostics.read('live',{limit:'50'}));
 }finally{store.close();}
});

test('transient search display samples do not write durable memory, receipts or journals',()=>{
 const runner=Object.create(SeatRunner.prototype) as SeatRunner;
 const internal=runner as unknown as {save:(kind:string,details:unknown)=>void;searchProgress:unknown;store:unknown;state:unknown;runtime:unknown};
 internal.store={saveEvents:()=>{throw Error('telemetry attempted persistence');}};internal.state={sequence:7};internal.runtime={phase:'local',activeTool:null,observed:null,signals:new Map()};
 const progress={stage:'discovery'};internal.save('mode-hybrid-search-progress',{sequence:7,progress});
 assert.equal(runner.telemetry.search?.sequence,7);assert.deepEqual(runner.telemetry.search?.progress,progress);
 internal.state={sequence:8};assert.equal(runner.telemetry.search,null);
});

test('pipeline stops in paused/disconnected states and only animates actual active lanes',()=>{
 const paused=renderToStaticMarkup(React.createElement(LivePipeline,{active:false,searchActive:false,modelActive:false,executing:false,phase:'已暂停',hasDirective:false,hasDecision:false}));
 assert.ok(!paused.includes('animateMotion'));assert.ok(!paused.includes('live-orbit'));assert.ok(!paused.includes('is-active'));
 const searching=renderToStaticMarkup(React.createElement(LivePipeline,{active:true,searchActive:true,modelActive:false,executing:false,phase:'对手反应测试',hasDirective:true,hasDecision:true}));
 assert.ok(searching.includes('animateMotion'));assert.ok(searching.includes('对手反应测试'));assert.ok(searching.includes('live-orbit'));
 const seat:ConsoleSeat={id:'a',roomId:'r',lobbySeat:0,mode:'live',status:'waiting',enabled:true,busy:false,calls:0,tokens:0,error:null};
 assert.equal(liveSeatPhase(seat,false),'连接中断');assert.equal(liveSeatPhase({...seat,bound:false},true),'未绑定');assert.equal(liveSeatPhase({...seat,status:'ended'},true),'已结束');assert.equal(liveSeatPhase({...seat,error:'failure'},true),'异常');assert.equal(liveSeatPhase(seat,true),'监听局势');
});

test('AI and program lanes animate independently and can both run without a serial dependency',()=>{
 const base={active:false,searchActive:false,modelActive:false,executing:false,phase:'监听局势',hasDirective:false,hasDecision:false};
 const tasks=[{id:'strategy',kind:'strategy',status:'running',attempt:0,characters:100}];
 const render=(changes:Partial<React.ComponentProps<typeof LivePipeline>>)=>renderToStaticMarkup(React.createElement(LivePipeline,{...base,...changes}));
 const lanes=(html:string)=>({ai:html.split('data-lane="ai"')[1]!.split('</section>')[0]!,program:html.split('data-lane="program"')[1]!.split('</section>')[0]!});
 const aiOnly=lanes(render({modelActive:true,tasks}));
 assert.ok(aiOnly.ai.includes('animateMotion'));assert.ok(!aiOnly.program.includes('animateMotion'));
 const programOnly=lanes(render({active:true,searchActive:true,phase:'候选发现'}));
 assert.ok(!programOnly.ai.includes('animateMotion'));assert.ok(programOnly.program.includes('animateMotion'));
 const both=lanes(render({active:true,searchActive:true,modelActive:true,tasks}));
 assert.ok(both.ai.includes('animateMotion'));assert.ok(both.program.includes('animateMotion'));
 const stopped=render({enabled:false,active:true,searchActive:true,modelActive:true,tasks,backgroundQueued:1,hasDirective:true,hasReceipts:true});
 assert.ok(!stopped.includes('animateMotion'));assert.ok(stopped.includes('data-state="available"'));
 const queue=render({modelActive:true,tasks:[{...tasks[0]!,status:'queued'}]});
 assert.match(queue,/data-node="模型排队" data-state="active"/);assert.match(queue,/data-node="模型处理" data-state="idle"/);
 const finishing=render({active:true,executing:true,programTool:'finish'});
 assert.match(finishing,/data-node="复核执行" data-state="idle"/);
 const submitting=render({active:true,executing:true,programTool:'batch'});
 assert.match(submitting,/data-node="复核执行" data-state="active"/);
 const stale=render({tasks,hasDirective:true});assert.ok(!stale.includes('animateMotion'));
});

test('background observation and readiness are distinct from round material preparation',()=>{
 const seat:ConsoleSeat={id:'a',roomId:'r',lobbySeat:0,mode:'live',status:'waiting',enabled:true,busy:true,calls:0,tokens:0,error:null};
 const telemetry={round:3,phase:'observation',tool:null,tick:8,pendingSignals:0,background:{active:0,queued:0},search:null};
 for(const [foreground,label] of [['observation','后台观察'],['planning-sync','本轮同步'],['readiness','就绪上报']] as const){
  assert.equal(liveSeatPhase({...seat,telemetry:{...telemetry,foreground}},true),label);
 }
 const html=renderToStaticMarkup(React.createElement(LivePipeline,{active:true,searchActive:false,modelActive:false,executing:false,phase:'同步授权事实',planningSync:false,hasDirective:false,hasDecision:false,lane:'program'}));
 assert.match(html,/data-node="事实同步" data-state="active"/);
 assert.ok(html.includes('animateMotion'));
});


test('program flow keeps rings and packets active through sync, observation, readiness and bookkeeping',()=>{
 const base={active:true,searchActive:false,modelActive:false,executing:false,phase:'监听局势',hasDirective:false,hasDecision:false,lane:'program' as const};
 const cases:[Partial<React.ComponentProps<typeof LivePipeline>>,string][]=[
  [{planningSync:true,phase:'本轮同步'},'本轮同步'],
  [{planningSync:false,phase:'后台观察'},'事实同步'],
  [{phase:'就绪上报'},'就绪上报'],
  [{executing:true,programTool:'finish'},'本轮收尾'],
  [{executing:true,programTool:'say'},'消息提交'],
  [{executing:true,programTool:'notebook'},'内部更新'],
 ];
 for(const [phase,node] of cases){
  const props={...base,...phase},html=renderToStaticMarkup(React.createElement(LivePipeline,props));
  assert.ok(html.includes('data-node="'+node+'" data-state="active"'),node);
  assert.ok(html.includes('live-lit-rotor'),node);assert.ok(html.includes('live-flow-line'),node);assert.ok(html.includes('animateMotion'),node);
  const idle=renderToStaticMarkup(React.createElement(LivePipeline,{...props,active:false}));
  assert.ok(!idle.includes('animateMotion'),node+' must stop when idle');
 }
});
