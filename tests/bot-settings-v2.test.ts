import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BOT_SETTINGS_SCHEMA_VERSION,BOT_UTILITY_SCALE,BOT_SETTING_LIMITS,DEFAULT_BOT_SETTINGS,LEGACY_BOT_SETTINGS_DEFAULTS,resolveBotSettings,type BotSettings,type LegacyBotSettings} from '../packages/contracts/src/index.js';
import {botActionGainThreshold,canRetainBotObjective,planBot,planBotAsync} from '../packages/ai/src/controller/local/bot-planner.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {evaluateBotFrame,type BotEvaluation} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState,validateSettings,type AiState} from '../packages/ai/src/controller/contracts/types.js';
import {botAttackPressure} from '../packages/ai/src/controller/analysis/tactical-force-policy.js';
import {planBot as planTactical} from '../packages/ai/src/controller/analysis/tactical-planner.js';

function fixture(initialTick=0){
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.size={width:80,height:80};setup.match={mode:'mining',neptuniumGoal:200};setup.economy.initialTick=initialTick;
  setup.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
  const template=setup.economy.outposts[0]!;
  const entries=[['home',0,10,0,0],['target',null,1,0.1,0],['rival1',1,0,20,30],['rival2',2,0,30,30],['rival3',3,0,-30,30]] as const;
  setup.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x,y])=>[id,{x,y}]));
  setup.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:0,shieldMax:0}));
  const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'bot-settings-v2');
  return {o,routes:attackRoutes(o)};
}

test('v2 has twelve numeric settings and one version, with a conservative force buffer',()=>{
  assert.equal(BOT_SETTINGS_SCHEMA_VERSION,2);
  assert.deepEqual(resolveBotSettings(),{
    schemaVersion:2,maxSimulations:80,maxElapsedMs:4000,horizonTicks:196,reviewIntervalTicks:6,
    minActionGain:1,minCaptureGain:1,objectiveSwitchTolerance:6,forceBufferRatio:0.4,
    remoteUncertaintyForceFraction:0.35,economyWeight:1,defenseWeight:1,territoryWeight:1,
  });
  assert.equal(Object.keys(BOT_SETTING_LIMITS).length,12);
  assert.equal(Object.hasOwn(BOT_SETTING_LIMITS,'schemaVersion'),false);
  assert.deepEqual(resolveBotSettings({}),{...DEFAULT_BOT_SETTINGS,maxSimulations:50,maxElapsedMs:10000,horizonTicks:144,forceBufferRatio:0.2,minActionGain:2,minCaptureGain:2});
  assert.deepEqual(resolveBotSettings({schemaVersion:2}),DEFAULT_BOT_SETTINGS);
  assert.deepEqual(resolveBotSettings(LEGACY_BOT_SETTINGS_DEFAULTS),{...DEFAULT_BOT_SETTINGS,maxSimulations:50,maxElapsedMs:10000,horizonTicks:144,forceBufferRatio:0.2,minActionGain:2,minCaptureGain:2});
  assert.equal(Object.isFrozen(LEGACY_BOT_SETTINGS_DEFAULTS),true);
});

test('196-tick default reaches the forecast while bounds and explicit seat values remain enforced',async()=>{
  const policy=resolveBotSettings();
  assert.equal(policy.maxSimulations,80);assert.equal(policy.maxElapsedMs,4000);assert.equal(policy.horizonTicks,196);
  assert.equal(BOT_SETTING_LIMITS.horizonTicks.max,196);
  assert.throws(()=>resolveBotSettings({schemaVersion:2,horizonTicks:197}),/horizonTicks/);
  const explicit=resolveBotSettings({schemaVersion:2,maxElapsedMs:8000,horizonTicks:144});
  assert.equal(explicit.maxElapsedMs,8000);assert.equal(explicit.horizonTicks,144);
  const {o,routes}=fixture(144);
  const targets:number[]=[];
  const d=await planBotAsync(o,routes,{settings:{schemaVersion:2,maxSimulations:2,maxElapsedMs:60000},internalTransfers:false},async requests=>requests.map(r=>{targets.push(r.targetTick);return executeBotForecast(o,r);}));
  assert.equal(d.parameters.horizonTicks,196);
  assert.ok(targets.length>0);assert.ok(targets.every(t=>t===o.view.tick+196));
  assert.throws(()=>planBot(o,routes,{horizonTicks:197}),/search budget/);
});

test('valid current v1 inputs normalize once without mutation and preserve every effective preference',()=>{
  const old:LegacyBotSettings={...LEGACY_BOT_SETTINGS_DEFAULTS,maxSimulations:32,maxElapsedMs:20000,
    aggression:1.5,actionMargin:7,objectiveSwitchMargin:8,riskForceFraction:0.4,attackForceMargin:0.3,
    economyWeight:1.25,defenseWeight:2,territoryWeight:0.5};
  const before=structuredClone(old),next=resolveBotSettings(old);
  assert.deepEqual(next,{
    schemaVersion:2,maxSimulations:32,maxElapsedMs:20000,horizonTicks:144,reviewIntervalTicks:6,
    minActionGain:7,minCaptureGain:7/1.5,objectiveSwitchTolerance:8,forceBufferRatio:0.3,
    remoteUncertaintyForceFraction:0.4,economyWeight:1.25,defenseWeight:2,territoryWeight:0.5,
  });
  assert.deepEqual(old,before);
  assert.deepEqual(resolveBotSettings(next),next);
  assert.equal(resolveBotSettings({aggression:2}).minCaptureGain,1,'partial v1 fills frozen v1 defaults before migration');
  assert.equal(resolveBotSettings({actionMargin:20,aggression:0.5}).minCaptureGain,40);
  assert.equal(resolveBotSettings({actionMargin:0,aggression:2}).minCaptureGain,0);
  for(const key of ['aggression','actionMargin','objectiveSwitchMargin','riskForceFraction','attackForceMargin'])assert.equal(Object.hasOwn(next,key),false);
});

test('v2 input is explicit, strict and atomic instead of accepting aliases or silent clamps',()=>{
  const invalid:unknown[]=[null,[],{schemaVersion:1},{schemaVersion:3},{schemaVersion:'2'},{schemaVersion:undefined},
    {minCaptureGain:1},{schemaVersion:2,aggression:1},{schemaVersion:2,actionMargin:2},
    {schemaVersion:2,objectiveSwitchMargin:6},{schemaVersion:2,attackForceMargin:0.2},
    {schemaVersion:2,riskForceFraction:0.35},{schemaVersion:2,minCaptureGain:41},
    {schemaVersion:2,minCaptureGain:NaN},{schemaVersion:2,minActionGain:-1},
    {schemaVersion:2,objectiveSwitchTolerance:51},{schemaVersion:2,forceBufferRatio:1.01},
    {schemaVersion:2,remoteUncertaintyForceFraction:-0.01},{schemaVersion:2,defenseWeight:Infinity},
    {schemaVersion:2,maxSimulations:2.5},{schemaVersion:2,maxElapsedMs:999},
    {schemaVersion:2,reviewIntervalTicks:0},{schemaVersion:2,teamSize:0},
    {aggression:0.49},{actionMargin:20.01},{attackForceMargin:undefined}];
  for(const raw of invalid)assert.throws(()=>resolveBotSettings(raw));
  for(const fraction of [0,1])assert.equal(resolveBotSettings({schemaVersion:2,forceBufferRatio:fraction,remoteUncertaintyForceFraction:fraction}).forceBufferRatio,fraction);
  assert.equal(resolveBotSettings({schemaVersion:2,minCaptureGain:40}).minCaptureGain,40);
});

test('all autonomous action types share one gain threshold, including captures and attrition',()=>{
 const base=resolveBotSettings();
 for(const candidate of [{},{captureTargets:['target']},{captureTargets:['a','b']},{combatIntent:'attrition' as const}]){
  assert.equal(botActionGainThreshold(base,candidate),1);
  assert.equal(botActionGainThreshold({...base,minActionGain:3,minCaptureGain:0},candidate),3);
  assert.equal(botActionGainThreshold({...base,minActionGain:0,minCaptureGain:40},candidate),0);
 }
});


test('the unified gain threshold controls real capture admission',()=>{
 const {o,routes}=fixture(144);
 const settings={...DEFAULT_BOT_SETTINGS,economyWeight:0.25,territoryWeight:0.25,maxSimulations:32,maxElapsedMs:60000};
 const blocked=planBot(o,routes,{settings:{...settings,minActionGain:20}});
 const active=planBot(o,routes,{settings:{...settings,minActionGain:1}});
 assert.equal(blocked.selected.kind,'hold');
 assert.ok(active.selected.captureTargets?.includes('target'));
 assert.equal(active.parameters.minActionGain,1);
 assert.deepEqual(active.utilityScale,BOT_UTILITY_SCALE);
});


test('attack preferences rise continuously with total force occupancy and remain bounded',()=>{
  const {o}=fixture(144),policy=resolveBotSettings(),before=structuredClone(policy);
  for(const [ratio,gainMultiplier,commitmentMultiplier] of [[0,1,1],[0.5,1,1],[0.75,0.625,0.75],[1,0.25,0.5],[1.5,0.25,0.5]]){
    o.view.self.capacity=100;o.view.self.drillers=100*ratio!;
    const pressure=botAttackPressure(o);
    assert.equal(pressure.gainMultiplier,gainMultiplier);
    assert.equal(pressure.commitmentMultiplier,commitmentMultiplier);
    assert.equal(botActionGainThreshold(policy,{captureTargets:['target']},o),1);
    assert.equal(botActionGainThreshold(policy,{},o),1);
    assert.equal(botActionGainThreshold({...policy,minCaptureGain:0},{captureTargets:['target']},o),1);
  }
  o.view.self.capacity=0;o.view.self.drillers=0;
  assert.equal(botAttackPressure(o).gainMultiplier,1);
  o.view.self.drillers=10;
  assert.equal(botAttackPressure(o).gainMultiplier,0.25);
  // Use authoritative total force, even when most troops are not stationed.
  o.view.self.capacity=100;o.view.self.drillers=100;
  assert.equal(o.view.outposts.find(p=>p.id==='home')!.drillers,10);
  assert.equal(botAttackPressure(o).forceRatio,1);
  assert.deepEqual(policy,before);
});

test('capacity pressure retains one uniform threshold in both tactical planner entry points',()=>{
 for(const planner of [planBot,planTactical]){
  const {o}=fixture(144);
  const settings={...DEFAULT_BOT_SETTINGS,economyWeight:0.25,territoryWeight:0.25,maxSimulations:32,maxElapsedMs:60000};
  for(const capacity of [100,o.view.self.drillers]){
   o.view.self.capacity=capacity;
   const result=planner(o,attackRoutes(o),{settings});
   const pressure=result.policyDiagnostics!.attackPressure as {effectiveCaptureGain:number};
   assert.equal(pressure.effectiveCaptureGain,1);
   assert.equal(result.parameters.minActionGain,1);
  }
 }
});


test('valid v1 settings and their canonical v2 representation produce identical decisions',()=>{
  const {o,routes}=fixture();
  const legacy={economyWeight:0.25,territoryWeight:0.3,maxSimulations:32,maxElapsedMs:60000,aggression:2,actionMargin:2,attackForceMargin:0};
  const before=planBot(o,routes,{settings:legacy}),after=planBot(o,routes,{settings:resolveBotSettings(legacy)});
  assert.deepEqual(after,before);
  assert.equal(after.parameters.schemaVersion,2);
  assert.equal(after.parameters.forceBufferRatio,0);
});

test('utility anchor is executable and fixed while selected asset preferences change',()=>{
  const {o}=fixture(),base=evaluateBotFrame(o,o.view);
  const weighted=evaluateBotFrame(o,o.view,null,{...DEFAULT_BOT_SETTINGS,economyWeight:2,defenseWeight:3,territoryWeight:4});
  assert.equal(BOT_UTILITY_SCALE.drillerValue,1);
  assert.equal(base.components.troops,o.view.self.drillers*BOT_UTILITY_SCALE.drillerValue);
  assert.equal(weighted.components.troops,base.components.troops);
  assert.equal(weighted.components.territory,base.components.territory!*4);
  assert.equal(weighted.outcome,base.outcome);
  assert.equal(weighted.utility,Object.values(weighted.components).reduce((sum,value)=>sum+value,0));
});

test('objective continuity still requires a useful old action and cannot override survival or victory',()=>{
  const score=(utility:number,outcome:BotEvaluation['outcome']=0,crossingTick:number|null=null):BotEvaluation=>({utility,outcome,crossingTick,terminalCertainty:null,components:{},unknowns:[]});
  assert.equal(canRetainBotObjective(score(4),score(0),score(8),2,6),true);
  assert.equal(canRetainBotObjective(score(2),score(0),score(8),2,6),false);
  assert.equal(canRetainBotObjective(score(4),score(0),score(11),2,6),false);
  assert.equal(canRetainBotObjective(score(100),score(0),score(0,1,10),0,50),false);
  assert.equal(canRetainBotObjective(score(100,-2),score(0),score(1),0,50),false);
});

test('AiStore returns canonical current settings on load without resetting a normal saved game',()=>{
  const store=new AiStore(':memory:');
  try{
    const initial=initialState('normal-room',0,{model:'',personality:'sentinel'});
    initial.calls=9;initial.sequence=8;initial.memory.strategy='Keep the current plan.';
    const raw={...initial,settings:{...initial.settings,bot:{aggression:1.5,actionMargin:3,attackForceMargin:0.25}}};
    store.save(raw as unknown as AiState);
    const loaded=store.load('normal-room',0)!;
    assert.deepEqual(loaded.settings.bot,resolveBotSettings(raw.settings.bot));
    assert.equal(loaded.settings.bot!.schemaVersion,2);
    assert.equal(loaded.settings.bot!.minCaptureGain,2);
    assert.equal(loaded.calls,9);assert.equal(loaded.sequence,8);assert.deepEqual(loaded.memory,initial.memory);
    assert.deepEqual({...loaded,settings:initial.settings},initial);
    store.save(loaded);
    assert.deepEqual(store.load('normal-room',0),loaded);
    assert.equal(validateSettings({model:'',personality:'sentinel'}).bot,undefined);
  }finally{store.close();}
});
