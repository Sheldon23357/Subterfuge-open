import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BOT_SETTINGS_SCHEMA_VERSION,BOT_SETTING_LIMITS,DEFAULT_BOT_SETTINGS,resolveBotSettings,botEffectiveWeights} from '../packages/contracts/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {evaluateBotFrame,compareBotEvaluations,type BotEvaluation} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {mineHoldingAssessment} from '../packages/ai/src/controller/analysis/mine-strategy.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,t=cfg.economy.outposts[0]!;
 cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};
 cfg.economy.players=[{active:true,neptunium:100,minesCreated:1},{active:true,neptunium:0,minesCreated:0}];
 cfg.positions={home:{x:0,y:0},enemy:{x:.5,y:0}};
 cfg.economy.outposts=[{...t,id:'home',owner:0,type:'mine',drillers:10,shield:0,shieldMax:0},{...t,id:'enemy',owner:1,type:'generator',drillers:100,shield:0,shieldMax:0}];

 return observation({state:createFleetScenario(cfg),scheduled:[]},0,'execution-weight-baseline');
}

test('execution economy baseline preserves schema, accepted ranges, defaults and saved preference numbers',()=>{
 assert.equal(BOT_SETTINGS_SCHEMA_VERSION,2);
 for(const key of ['economyWeight','defenseWeight','territoryWeight'] as const)assert.deepEqual(BOT_SETTING_LIMITS[key],{min:.25,max:4});
 assert.equal(DEFAULT_BOT_SETTINGS.economyWeight,1);assert.deepEqual(resolveBotSettings({schemaVersion:2}),resolveBotSettings());
 for(const economyWeight of [.25,1,2,4]){
  const raw={schemaVersion:2 as const,economyWeight,defenseWeight:2.5,territoryWeight:.5},before=structuredClone(raw),canonical=resolveBotSettings(raw);
  assert.equal(canonical.economyWeight,economyWeight);assert.equal(canonical.defenseWeight,2.5);assert.deepEqual(raw,before);
  assert.deepEqual(resolveBotSettings(JSON.parse(JSON.stringify(canonical))),canonical);
  assert.deepEqual(botEffectiveWeights(canonical),{economyWeight:economyWeight*2,defenseWeight:2.5,territoryWeight:.5});
 }
 for(const value of [.125,4.01,NaN,Infinity])assert.throws(()=>resolveBotSettings({schemaVersion:2,economyWeight:value}));
 assert.throws(()=>resolveBotSettings({schemaVersion:3,economyWeight:1}));
 const state=initialState('stored-weights',0,{model:'',personality:'sentinel',provider:'offline',bot:resolveBotSettings({schemaVersion:2,economyWeight:2,defenseWeight:3,territoryWeight:.5})}),store=new AiStore(':memory:');
 try{store.save(state);const restored=store.load('stored-weights',0)!;assert.equal(restored.settings.bot!.schemaVersion,2);assert.equal(restored.settings.bot!.economyWeight,2);assert.deepEqual(restored.settings,state.settings);}finally{store.close();}
});

test('execution economy baseline is applied once to assets and to the economy-times-defense mine risk',()=>{
 const o=fixture(),before=structuredClone(o),holding=mineHoldingAssessment(o)!;
 assert.ok(holding.inventoryExposure>0,'fixture must exercise the cross-weight risk term');
 const npWeight=2+4*o.view.self.neptunium/200;
 for(const [economyWeight,defenseWeight] of [[1,1],[.5,2.5],[2,3]] as const){
  const preferences=resolveBotSettings({schemaVersion:2,economyWeight,defenseWeight,territoryWeight:1});
  const score=evaluateBotFrame(o,o.view,null,preferences);
  assert.equal(score.components.neptunium,o.view.self.neptunium*npWeight*economyWeight*2);
  assert.ok(Math.abs(score.components.mineHoldingRisk!-(-holding.inventoryExposure*npWeight*economyWeight*2*defenseWeight))<1e-9);
  assert.equal(score.components.troops,o.view.self.drillers,'the economic baseline must not scale the troop anchor');
  assert.equal(preferences.economyWeight,economyWeight,'execution must not rewrite the saved display value');
 }
 assert.deepEqual(o,before);
});

test('execution economy baseline cannot override actual survival or terminal victory ordering',()=>{
 const neutral:BotEvaluation={outcome:0,crossingTick:null,terminalCertainty:'conditional',utility:1e12,components:{},unknowns:[]};
 const loss:BotEvaluation={...neutral,outcome:-2,utility:1e20};
 const victory:BotEvaluation={...neutral,outcome:1,crossingTick:130,utility:-1e12};
 assert.ok(compareBotEvaluations(neutral,loss)>0);assert.ok(compareBotEvaluations(victory,neutral)>0);
 assert.ok(compareBotEvaluations({...victory,crossingTick:120},victory)>0);
 const preferences=resolveBotSettings({schemaVersion:2,economyWeight:4,defenseWeight:4,territoryWeight:4});
 assert.deepEqual(botEffectiveWeights(preferences),{economyWeight:8,defenseWeight:4,territoryWeight:4});
});
