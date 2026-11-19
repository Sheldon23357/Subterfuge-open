
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DEFAULT_BOT_SETTINGS,resolveBotSettings} from '../packages/contracts/src/index.js';
import {validateSettings,initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {botStep} from '../packages/ai/src/controller/local/bot-step.js';
import {evaluateBotFrame} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {AgentBotSettings} from '../packages/client/src/AgentBotSettings.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 setup.size={width:80,height:80};setup.match={mode:'mining',neptuniumGoal:200};
 setup.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
 for(const player of [2,3]){const id=`remote-${player}`;setup.economy.outposts.push({...setup.economy.outposts[0]!,id,owner:player,drillers:0});setup.positions[id]={x:player*10,y:30};}
 const state=submitFleetOrder(createFleetScenario(setup),{id:'settings-check-in',player:0,action:{kind:'check-in'}}).state;
 const o=observation({state,scheduled:[]},0,'bot-settings');return {o,routes:attackRoutes(o)};
}

test('bot settings use defaults without mutating input and reject unknown or invalid values',()=>{
 assert.equal(resolveBotSettings().maxSimulations,80);
 const before={aggression:1.5,maxElapsedMs:20000};
 assert.deepEqual(resolveBotSettings(before),{...DEFAULT_BOT_SETTINGS,maxSimulations:50,forceBufferRatio:0.2,maxElapsedMs:20000,horizonTicks:144,minActionGain:2,minCaptureGain:2/1.5});assert.deepEqual(before,{aggression:1.5,maxElapsedMs:20000});
 assert.equal(validateSettings({model:'',personality:'sentinel'}).bot,undefined);
 assert.equal(validateSettings({model:'',personality:'sentinel',bot:before}).bot!.minCaptureGain,2/1.5);
 for(const invalid of [null,[],{typo:1},{maxSimulations:2.5},{maxSimulations:513},{maxElapsedMs:0},{horizonTicks:145},{reviewIntervalTicks:0},{aggression:NaN},{economyWeight:Infinity},{riskForceFraction:1.01},{attackForceMargin:-0.01},{attackForceMargin:1.01},{attackForceMargin:NaN},{defenseWeight:'2'},{territoryWeight:0}])assert.throws(()=>resolveBotSettings(invalid));
});

test('each fixed controller slot persists its own bot settings across restart without connecting to a game',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'bot-settings-'));
 const config={storeDirectory:directory,seats:[],pollMs:1000,live:true as const};
 const options={fixedSlots:true,profilesPath:join(directory,'profiles.json')};
 const make=()=>new AgentRuntime(config,{step:async()=>{throw Error('No model call');}},{},options);
 let runtime=make();
 try{
  const saved=runtime.configureSeat('ai-01',{kind:'offline'},{model:'',personality:'sentinel',bot:{aggression:1.5,maxElapsedMs:20000,attackForceMargin:0.25}});
  assert.equal(saved.settings.bot!.maxElapsedMs,20000);
  const original=structuredClone(runtime.consoleConfig());
  assert.throws(()=>runtime.configureSeat('ai-01',{kind:'offline'},{model:'',personality:'sentinel',bot:{aggression:99}}));
  assert.deepEqual(runtime.consoleConfig(),original,'invalid changes must not partially switch provider or settings');
  await runtime.shutdown();runtime=make();
  const slots=runtime.consoleConfig().seats;
  assert.equal(slots.find(s=>s.id==='ai-01')!.settings.bot!.minCaptureGain,2/1.5);
  assert.equal(slots.find(s=>s.id==='ai-01')!.settings.bot!.forceBufferRatio,0.25);
  assert.equal(slots.find(s=>s.id==='ai-01')!.providerConfig.kind,'offline');
  assert.equal(slots.find(s=>s.id==='ai-02')!.settings.bot,undefined);
 }finally{await runtime.shutdown();rmSync(directory,{recursive:true,force:true});}
});

test('explicit default settings preserve the existing four-player search and custom simulation limit is honored',()=>{
 const {o,routes}=fixture(),limits={maxSimulations:16,maxElapsedMs:60000};
 const normal=planBot(o,routes,limits),explicit=planBot(o,routes,{...limits,settings:{...DEFAULT_BOT_SETTINGS}});
 assert.deepEqual(explicit,normal);
 const limited=planBot(o,routes,{settings:{maxSimulations:2,maxElapsedMs:60000}});
 assert.ok(limited.coverage.simulations<=2);assert.equal(limited.coverage.stopReason,'simulation-budget');
});

test('economic, defense and territory preferences change only their scored components, not terminal outcomes',()=>{
 const {o}=fixture(),prediction=forecastKnownPath(o,{targetTick:o.view.tick+144});
 assert.equal(prediction.forecast.status,'conditional');if(prediction.forecast.status!=='conditional')return;
 const plain=evaluateBotFrame(o,prediction.forecast.result,prediction.path);
 const weighted=evaluateBotFrame(o,prediction.forecast.result,prediction.path,resolveBotSettings({economyWeight:2,defenseWeight:3,territoryWeight:4}));
 assert.equal(weighted.components.production,plain.components.production!*2);
 assert.equal(weighted.components.shields,plain.components.shields!*3);
 assert.equal(weighted.components.territory,plain.components.territory!*4);
 assert.equal(weighted.components.troops,plain.components.troops);
 assert.equal(weighted.outcome,plain.outcome);assert.equal(weighted.crossingTick,plain.crossingTick);
});

test('after opening, the unified gain setting admits a small profitable capture',()=>{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 // Isolate the gain threshold after the opening-coverage reward expires.
 setup.size={width:80,height:80};setup.match={mode:'mining',neptuniumGoal:200};setup.economy.initialTick=144;
 setup.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
 const template=setup.economy.outposts[0]!;
 const entries=[['home',0,10,0,0],['target',null,1,0.1,0],['rival1',1,0,20,30],['rival2',2,0,30,30],['rival3',3,0,-30,30]] as const;
 setup.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x,y])=>[id,{x,y}]));
 setup.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:0,shieldMax:0}));
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'aggression'),routes=attackRoutes(o);
  // Keep every useful capture below 2, with the best capture above 1. Do not
  // rely on replacing a better original force with a worse buffered variant.
  const settings={schemaVersion:2 as const,economyWeight:0.25,territoryWeight:0.25,maxSimulations:32,maxElapsedMs:60000,minActionGain:2};
 const normal=planBot(o,routes,{settings}),active=planBot(o,routes,{settings:{...settings,minActionGain:1}});
 assert.equal(normal.selected.kind,'hold',JSON.stringify(normal.selected));
 assert.ok(active.selected.captureTargets?.includes('target'),JSON.stringify(active.selected));
 const chosen=active.assessments.find(a=>a.candidate.id===active.selected.id)!,baseline=active.assessments.find(a=>a.candidate.id==='hold')!;
 assert.equal(chosen.score!.components.openingCoverage,0);
 assert.equal(baseline.score!.components.openingCoverage,0);
 const gain=chosen.score!.utility-baseline.score!.utility;
 assert.ok(gain>active.parameters.minActionGain&&gain<normal.parameters.minActionGain,`capture gain ${gain} must straddle the two admission thresholds`);
 assert.notEqual(active.parameters.minActionGain,normal.parameters.minActionGain);
 assert.equal(chosen.score!.outcome,baseline.score!.outcome);
});

test('actual bot adapter forwards seat budget without scheduling extra check-ins',async()=>{
 const {o,routes}=fixture(),state=initialState(o.roomId,0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({maxSimulations:2,reviewIntervalTicks:9})});
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:4};
 let simulations=-1;
 const result=await botStep({model:'',prompt:'',signal:new AbortController().signal},state,snapshot,routes,[],decision=>{simulations=decision.coverage.simulations;});
 assert.ok(simulations>=1&&simulations<=2,'settings must reach the worker, not merely save in the UI');
 assert.equal(result.reply.tool,'finish');
 const args=result.reply.arguments as {reminders:{set:{id:string;atWorldDay:number}[]}};
 assert.equal(args.reminders.set.some(r=>r.id==='bot-review'),false);
 assert.deepEqual(args.reminders.set,[]);
 state.settings.bot!.reviewIntervalTicks=144;
 const finished=await botStep({model:'',prompt:'',signal:new AbortController().signal},state,snapshot,undefined,[{tool:'order',result:{}}],()=>{throw Error('Do not replan accepted writes');});
 const memory=finished.reply.arguments as {reminders:{set:{atWorldDay:number}[]}};
 assert.deepEqual(memory.reminders.set,[]);
});

test('programmatic parameter form exposes current values, units, reset and disabled state',()=>{
 const html=renderToStaticMarkup(React.createElement(AgentBotSettings,{value:resolveBotSettings({aggression:1.5,riskForceFraction:0.4,maxElapsedMs:20000,attackForceMargin:0.25}),disabled:true,onChange:()=>{}}));
 assert.match(html,/战术策略参数/);assert.match(html,/恢复默认参数/);assert.match(html,/计算与调度/);assert.match(html,/行动选择/);assert.match(html,/评分倾向/);
 assert.match(html,/兵力余量/);assert.match(html,/value="25"/);assert.match(html,/value="20"/);assert.match(html,/value="40"/);assert.match(html,/name="minActionGain"/);assert.doesNotMatch(html,/name="minCaptureGain"/);assert.doesNotMatch(html,/name="schemaVersion"|进攻积极度/);
 assert.match(html,/<fieldset disabled=""/);assert.equal((html.match(/type="number"/g)??[]).length,11);
 assert.doesNotMatch(html,/<details/);
});
