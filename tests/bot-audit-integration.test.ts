import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {forecastKnownPath,type KnownPredictionDraft,type KnownEnemyLaunch} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {checkPlanResources,finalizePlanResources} from '../packages/ai/src/controller/execution/plan-resource-check.js';

type Post={id:string;owner:number|null;drillers:number;x:number;y?:number;type?:'generator'|'factory'|'mine';shield?:number};
function setup(posts:Post[],tick=100):FleetSetup{
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const template=cfg.economy.outposts[0]!;
 cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};cfg.economy.initialTick=tick;
 cfg.economy.players=Array.from({length:Math.max(2,...posts.map(p=>(p.owner??-1)+1))},()=>({active:true,neptunium:0,minesCreated:0}));
 cfg.positions=Object.fromEntries(posts.map(p=>[p.id,{x:p.x,y:p.y??0}]));
 cfg.economy.outposts=posts.map(p=>({...template,id:p.id,owner:p.owner,type:p.type??'generator',drillers:p.drillers,shield:p.shield??0,shieldMax:p.shield??0,productionProgress:0,miningProgress:0}));

 return cfg;
}
function rescueFixture(){
 const cfg=setup([{id:'home',owner:0,drillers:0,x:0},{id:'reserve',owner:0,drillers:80,x:.1},
  {id:'forward',owner:0,drillers:20,x:.8001},{id:'raider',owner:1,drillers:70,x:.8},
  {id:'enemyrear',owner:1,drillers:0,x:2},{id:'rival2',owner:2,drillers:0,x:2,y:2},{id:'rival3',owner:3,drillers:0,x:2,y:-2}]);
 let state=createFleetScenario(cfg);
 state=submitFleetOrder(state,{id:'actual-hostile',player:1,action:{kind:'launch',delaySeconds:600,source:'raider',destination:'home',drillers:60}}).state;
 state=submitFleetOrder(state,{id:'actual-capture',player:0,action:{kind:'launch',delaySeconds:600,source:'forward',destination:'raider',drillers:15}}).state;
 state=advanceFleetScenario(state,102);
 const o=observation({state,scheduled:[]},0,'audit-integration-rescue');
 const hypothesis:KnownEnemyLaunch={id:'enemy-hypothesis',player:1,source:'raider',destination:'home',issueTick:103,drillers:6};
 const rescue:KnownPredictionDraft={id:'own-rescue',issueTick:102,action:{kind:'launch',source:'reserve',destination:'home',drillers:70}};
 return {o,hypothesis,rescue};
}

test('audit regression: a retained force variant survives the same bounded reactions rather than falling back to hold',()=>{
 const cfg=setup([{id:'home',owner:0,drillers:30,x:0},{id:'target',owner:1,drillers:2,x:3,type:'mine'},
  {id:'reserve',owner:1,drillers:10,x:3.2,shield:20}],0);
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'audit-integration-force'),before=structuredClone(o);
 assert.ok(o.view.outposts.every(p=>p.visibility===2));
 for(const economyWeight of [.5,1]){
 const d=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:30000,settings:{schemaVersion:2,economyWeight}});
 assert.ok(d.coverage.simulations<=50);assert.notEqual(d.selected.id,'hold');
 const selected=d.assessments.find(a=>a.candidate.id===d.selected.id)!,hold=d.assessments.find(a=>a.candidate.id==='hold')!;
 assert.ok(selected.stress&&hold.stress);assert.ok(selected.stress.utility>hold.stress.utility);
 for(const issueTick of [1,43]){
  const f=forecastKnownPath(o,{targetTick:144,drafts:d.selected.drafts,enemyLaunches:[{id:'same-visible-reserve',player:1,source:'reserve',destination:'target',issueTick,drillers:6}]});
  assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')continue;
  assert.equal(f.forecast.orders.some(order=>order.status==='failed'),false);
  assert.equal(f.forecast.result.outposts.find(p=>p.id==='target')!.owner,0);assert.equal(f.forecast.result.self.active,true);
 }
 }
 assert.deepEqual(o,before);
});

test('audit regression: an inapplicable enemy hypothesis does not veto rescue of a real visible attack',()=>{
 const {o}=rescueFixture(),before=structuredClone(o);
 for(const economyWeight of [.5,1]){
 const d=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:30000,settings:{schemaVersion:2,economyWeight,defenseWeight:4,territoryWeight:.25}});
 assert.ok(d.coverage.simulations<=50);assert.notEqual(d.selected.id,'hold');
 const f=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:d.selected.drafts});
 assert.equal(f.forecast.status,'conditional');if(f.forecast.status==='conditional'){
  assert.equal(f.forecast.result.self.active,true);assert.equal(f.forecast.orders.some(order=>order.status==='failed'),false);
 }
 }
 assert.deepEqual(o,before);
});

test('audit control: failed own orders remain resource conflicts even alongside a failed enemy hypothesis',()=>{
 const {o,hypothesis}=rescueFixture();
 const own:KnownPredictionDraft={id:'invalid-own-order',issueTick:o.view.tick,action:{kind:'launch',source:'home',destination:'reserve',drillers:10}};
 const f=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:[own],enemyLaunches:[hypothesis],collectResourceFrames:true});
 assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')return;
 assert.equal(f.forecast.orders.find(order=>order.id===own.id)!.status,'failed');
 assert.equal(f.forecast.orders.find(order=>order.id===hypothesis.id)!.status,'failed');
 const context={snapshot:{observation:o}},initial=checkPlanResources([own],undefined,context,{deferToForecast:true});
 const resources=finalizePlanResources(initial,{...f.forecast,...f.path?{path:f.path}:{}},[own],undefined,context);
 assert.equal(resources.status,'conflict');assert.ok(resources.conflicts.some(c=>c.code==='engine-order-failed'&&c.draftIds?.includes(own.id)));
});

test('audit control: missing or genuinely unknown future queue facts never become proven resources',()=>{
 const {o,rescue}=rescueFixture(),draft={...rescue,issueTick:103};
 const f=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:[draft],collectResourceFrames:true});
 assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')return;
 const context={snapshot:{observation:o}},initial=checkPlanResources([draft],undefined,context,{deferToForecast:true});
 const response={...f.forecast,...f.path?{path:f.path}:{}};
 assert.ok(response.resourceFrames?.length);
 const missing=structuredClone(response);missing.resourceFrames=[];
 assert.equal(finalizePlanResources(initial,missing,[draft],undefined,context).status,'unknown');
 const uncertain=structuredClone(response);uncertain.resourceFrames![0]!.unknownReasons=['source-resource-unknown'];
 assert.equal(finalizePlanResources(initial,uncertain,[draft],undefined,context).status,'unknown');
 const captured=structuredClone(response);captured.resourceFrames![0]!.sources.find(source=>source.source==='reserve')!.owner=1;
 const rejected=finalizePlanResources(initial,captured,[draft],undefined,context);
 assert.equal(rejected.status,'conflict');assert.ok(rejected.conflicts.some(c=>c.code==='future-source-not-controlled'));
});

test('audit control: candidate discovery never converts fog targets or dispatch-locked sources into attacks',()=>{
 const cfg=setup([{id:'home',owner:0,drillers:0,x:0},{id:'target',owner:1,drillers:10,x:.3},{id:'enemyrear',owner:1,drillers:0,x:2}]);

 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'audit-integration-capability');
 o.dispatchGuard={tick:o.view.tick,lockedSources:['home']};
 assert.equal(generateBotCandidates(o,attackRoutes(o)).some(c=>c.drafts.some(d=>d.action.kind==='launch'&&d.action.source==='home')),false);
 delete o.dispatchGuard;const hidden=o.view.outposts.find(p=>p.id==='target')!;hidden.visibility=0;delete hidden.drillers;delete hidden.shield;
 const routes=attackRoutes(o),candidates=generateBotCandidates(o,routes);
 assert.equal(candidates.some(c=>c.captureTargets?.includes('target')),false);
 assert.throws(()=>generateBotCandidates(o,{...routes,revision:'stale'}),/Stale/);
});

test('audit control: fixed search budget and cancellation remain binding for richer candidate generation',()=>{
 const {o}=rescueFixture(),routes=attackRoutes(o),before=structuredClone(o);
 const d=planBot(o,routes,{maxSimulations:2,maxElapsedMs:30000});assert.ok(d.coverage.simulations<=2);assert.equal(d.coverage.complete,false);
 const stopped=planBot(o,routes,{signal:AbortSignal.abort(),maxSimulations:50,maxElapsedMs:30000});
 assert.equal(stopped.coverage.simulations,0);assert.equal(stopped.coverage.stopReason,'cancelled');assert.equal(stopped.selected.id,'hold');
 assert.deepEqual(o,before);
});

for(const mode of ['own-win','later-loss'] as const)test(`audit terminal control: a verified temporary raid can produce ${mode} despite terminal horizon truncation`,()=>{
 const posts:Post[]=[{id:'home',owner:0,drillers:30,type:'generator',x:0},{id:'target',owner:1,drillers:11,type:'mine',x:.3},{id:'reserve',owner:1,drillers:300,type:'generator',x:3}];
 if(mode==='own-win')for(let i=0;i<19;i++)posts.push({id:`own${i}`,owner:0,drillers:0,type:i<12?'mine':'generator',x:-1-i*.01});
 else for(let i=0;i<8;i++)posts.push({id:`enemy${i}`,owner:1,drillers:0,type:'generator',x:4+i*.01});
 const cfg=setup(posts);cfg.match={mode:'mining',neptuniumGoal:mode==='own-win'?200:10};
 cfg.economy.players[0]!.minesCreated=mode==='own-win'?12:0;cfg.economy.players[1]!.minesCreated=1;cfg.economy.players[1]!.neptunium=mode==='own-win'?199:9;
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'known-reinforcement',player:1,action:{kind:'launch',delaySeconds:600,source:'reserve',destination:'target',drillers:80}}).state;
 const o=observation({state,scheduled:[]},0,`terminal-denial-${mode}`),hold=forecastKnownPath(o,{targetTick:244});
 assert.equal(hold.forecast.status,'conditional');if(hold.forecast.status!=='conditional')return;
 const baseline=hold.forecast.result.terminalPrediction!.firstCrossing!;assert.equal(baseline.triggeringSeat,1);
 const d=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:30000,settings:{schemaVersion:2,economyWeight:.5}});
 assert.ok(d.coverage.simulations<=50);
 const raid=d.assessments.find(a=>a.status==='evaluated'&&a.score&&a.candidate.drafts.length===1&&a.candidate.drafts[0]!.action.source==='home'&&a.candidate.drafts[0]!.action.destination==='target');
 assert.ok(raid,'strict terminal improvement must be eligible, not rejected solely for endpoint ownership');
 const f=forecastKnownPath(o,{targetTick:244,drafts:raid.candidate.drafts,predicates:[{id:'capture',kind:'controlledAtHorizon',outpostId:'target'}]});
 assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')return;
 assert.equal(f.forecast.result.self.active,true);assert.equal(f.forecast.result.outposts.find(p=>p.id==='target')!.owner,1);
 assert.equal(f.path!.coverage.stoppedAtTerminal,true);assert.deepEqual(f.path!.coverage.unknownReasons,['requested-horizon-not-covered']);
 assert.equal(f.forecast.result.terminalPrediction!.firstCrossing!.triggeringSeat,mode==='own-win'?0:1);
 assert.ok(f.forecast.result.terminalPrediction!.firstCrossing!.tick>baseline.tick);
 assert.equal(raid.score!.outcome,mode==='own-win'?1:-1);
});

test('audit D2: two legal reinforcement donors overturn the same 45-driller capture that one donor cannot',()=>{
 const cfg=setup([{id:'home',owner:0,drillers:90,x:0},{id:'target',owner:1,drillers:10,x:3},
  {id:'r1',owner:1,drillers:30,x:3.2},{id:'r2',owner:1,drillers:30,x:3,y:.2}]);
 const state=createFleetScenario(cfg);
 const o=observation({state,scheduled:[]},0,'audit-reinforcement-concentration'),routes=attackRoutes(o);
 const candidate=generateBotCandidates(o,routes).find(c=>c.drafts.length===1&&c.captureTargets?.includes('target')&&c.drafts[0]!.action.drillers===45)!;assert.ok(candidate);
 const reinforcement=botOpponentScenarios(o,routes,[candidate]).find(s=>s.id==='reinforcement:target')!;
 assert.deepEqual(reinforcement.enemyLaunches!.map(h=>h.drillers),[19,19]);assert.equal(new Set(reinforcement.enemyLaunches!.map(h=>h.source)).size,2);
 for(const [count,expectedOwner] of [[1,0],[2,1]] as const){
  const f=forecastKnownPath(o,{targetTick:244,drafts:candidate.drafts,enemyLaunches:reinforcement.enemyLaunches!.slice(0,count)});
  assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')continue;
  assert.equal(f.forecast.orders.some(order=>order.status==='failed'),false);assert.equal(f.forecast.result.outposts.find(p=>p.id==='target')!.owner,expectedOwner);
 }
});
