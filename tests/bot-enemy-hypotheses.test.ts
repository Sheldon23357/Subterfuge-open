import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {createKnownPrediction,forecastKnownPath,type KnownEnemyLaunch} from '../packages/prediction/src/index.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
import {checkPlanResources,finalizePlanResources} from '../packages/ai/src/controller/execution/plan-resource-check.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.economy.outposts[0]!.drillers=10;cfg.economy.outposts[1]!.drillers=100;
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'hypotheses');
  const hypothesis:KnownEnemyLaunch={id:'enemy-test',player:1,source:'红方矿场',destination:'蓝方工厂',issueTick:o.view.tick+1,drillers:70};
  return {o,hypothesis};
}
test('visible counterfactual changes the branch and is labelled without mutating observation',()=>{
  const {o,hypothesis}=fixture(),before=structuredClone(o);
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+24});
  const counter=forecastKnownPath(o,{targetTick:o.view.tick+24,enemyLaunches:[hypothesis]});
  assert.equal(baseline.forecast.status,'conditional');assert.equal(counter.forecast.status,'conditional');
  if(baseline.forecast.status==='conditional'&&counter.forecast.status==='conditional'){
    assert.equal(baseline.forecast.result.outposts.find(p=>p.id===hypothesis.destination)!.owner,0);
    assert.equal(counter.forecast.result.outposts.find(p=>p.id===hypothesis.destination)!.owner,1);
    assert.ok(counter.forecast.result.assumptions.some(a=>a.includes('Counterfactual')));
    assert.equal(counter.forecast.orders.find(p=>p.id===hypothesis.id)!.status,'executed');
  }
  assert.deepEqual(o,before);
});
test('hypotheses cannot fabricate hidden troops, duplicate budgets, or override own identity',()=>{
  const {o,hypothesis}=fixture(),run=(hs:KnownEnemyLaunch[])=>forecastKnownPath(o,{targetTick:o.view.tick+24,enemyLaunches:hs});
  assert.throws(()=>run([{...hypothesis,player:0}]));
  assert.throws(()=>run([{...hypothesis,drillers:101}]));
  assert.throws(()=>run([hypothesis,{...hypothesis,id:'second',destination:'红方后方'}]));
  assert.throws(()=>run([{...hypothesis,issueTick:o.view.tick+145}]));
  o.view.outposts.find(p=>p.id===hypothesis.source)!.visibility=0;
  assert.throws(()=>run([hypothesis]));
});
test('ordinary own draft schema still rejects actor overrides and hypotheses respect forecast horizon',()=>{
  const {o,hypothesis}=fixture();
  assert.throws(()=>forecastKnownPath(o,{targetTick:o.view.tick+24,drafts:[{id:'forged',issueTick:o.view.tick,player:1,action:{kind:'check-in'}} as never]}));
  assert.throws(()=>forecastKnownPath(o,{targetTick:o.view.tick+2,enemyLaunches:[{...hypothesis,issueTick:o.view.tick+3}]}));
});

test('validated enemy order identities cannot collide with own drafts or accepted schedules',()=>{
 const {o,hypothesis}=fixture();
 const draft={id:hypothesis.id,issueTick:o.view.tick,action:{kind:'check-in'}};
 assert.throws(()=>forecastKnownPath(o,{targetTick:o.view.tick+24,drafts:[draft],enemyLaunches:[hypothesis]}),/Duplicate hypothetical order identity/);
 o.scheduled.push({id:hypothesis.id,player:o.view.player,issueTick:o.view.tick+2,status:'pending',action:{kind:'check-in'}});
 assert.throws(()=>forecastKnownPath(o,{targetTick:o.view.tick+24,enemyLaunches:[hypothesis]}),/Duplicate hypothetical order identity/);
});
test('generated reaction scenarios use one visible opponent per branch and never manufacture allied coordination',()=>{
  const {o}=fixture(),scenarios=botOpponentScenarios(o,attackRoutes(o),[]);
  assert.ok(scenarios.some(s=>s.id==='counterattack'));
  for(const scenario of scenarios){
    assert.ok(new Set(scenario.enemyLaunches?.map(h=>h.player)).size<=1);
    assert.doesNotThrow(()=>forecastKnownPath(o,{targetTick:o.view.tick+24,enemyLaunches:scenario.enemyLaunches??[]}));
  }
});

test('one bounded reinforcement branch combines distinct sources of the same defending player',()=>{
 const {o}=fixture(),source=o.view.outposts.find(p=>p.id==='红方后方')!;source.drillers=30;
 const copy=structuredClone(source);copy.id='second-source';copy.position={x:1.8,y:.1};o.view.outposts.push(copy);
 const candidate={id:'attack',kind:'attack' as const,objective:'capture:红方矿场',targets:['红方矿场'],captureTargets:['红方矿场'],drafts:[],priority:0,reasons:[]};
 const scenarios=botOpponentScenarios(o,attackRoutes(o),[candidate]);
 const reinforcement=scenarios.find(s=>s.id==='reinforcement:红方矿场')!;
 assert.equal(reinforcement.enemyLaunches!.length,2);
 assert.equal(new Set(reinforcement.enemyLaunches!.map(h=>h.source)).size,2);
 assert.equal(new Set(reinforcement.enemyLaunches!.map(h=>h.player)).size,1);
 assert.ok(scenarios.length<=4);
 assert.doesNotThrow(()=>forecastKnownPath(o,{targetTick:o.view.tick+144,enemyLaunches:reinforcement.enemyLaunches!}));
});

test('counterfactual enemy actions never publish baseline departure confirmation evidence',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  cfg.economy.outposts[2]!.drillers=30;

  const world=submitFleetOrder(createFleetScenario(cfg),{id:'pending',player:1,action:{kind:'launch',delaySeconds:600,source:'红方矿场',destination:'蓝方工厂',drillers:10,}}).state;
  const o=observation({state:world,scheduled:[]},0,'hypothesis-evidence');
  const baseline:unknown[]=[],counterfactual:unknown[]=[];
  createKnownPrediction(o,{onDepartureEvidence:e=>baseline.push(e)}).predict(112);
  assert.ok(baseline.length>0,'fixture must actually produce ordinary baseline evidence');
  createKnownPrediction(o,{enemyLaunches:[{id:'reaction',player:1,source:'红方后方',destination:'红方矿场',issueTick:101,drillers:20}],onDepartureEvidence:e=>counterfactual.push(e)}).predict(112);
  assert.deepEqual(counterfactual,[]);
});

test('four-player target competition is a separate visible third-party branch',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  for(const player of [2,3]){
    cfg.economy.players.push({active:true,neptunium:0,minesCreated:0});
    const id=`rival-${player}`;cfg.positions[id]={x:player*0.5,y:0.5};
    cfg.economy.outposts.push({...cfg.economy.outposts[2]!,id,owner:player,drillers:80});
  }
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'four-player-contest'),before=structuredClone(o);
  assert.equal(o.view.playerCount,4);
  const routes=attackRoutes(o),candidate=generateBotCandidates(o,routes).find(c=>c.captureTargets?.includes('红方矿场'))!;
  assert.ok(candidate);
  const scenarios=botOpponentScenarios(o,routes,[candidate]),contest=scenarios.find(s=>s.id==='third-party-contest');
  assert.ok(contest?.enemyLaunches?.length);
  assert.ok(contest.enemyLaunches.every(h=>h.player!==0&&h.player!==1&&h.destination==='红方矿场'));
  assert.equal(new Set(contest.enemyLaunches.map(h=>h.player)).size,1);
  const result=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:candidate.drafts,enemyLaunches:contest.enemyLaunches});
  assert.equal(result.forecast.status,'conditional');
  if(result.forecast.status==='conditional')assert.ok(result.forecast.orders.some(p=>p.id===contest.enemyLaunches![0]!.id&&p.status==='executed'));
  assert.deepEqual(o,before);
});


test('each ordinary target gets all visible reinforcement sources and an independent post-capture retake',()=>{
 const {o}=fixture();
 const target=o.view.outposts.find(p=>p.id==='红方矿场')!;target.type='generator';
 const source=o.view.outposts.find(p=>p.id==='红方后方')!;source.drillers=30;
 for(let i=0;i<7;i++){const p=structuredClone(source);p.id=`support-${i}`;o.view.outposts.push(p);}
 const second=structuredClone(target);second.id='second-target';o.view.outposts.push(second);
 const routes=attackRoutes(o);
 for(const t of [target.id,second.id]){
   routes.postTicks['蓝方工厂']![t]=10;
   for(const id of [source.id,'support-0','support-1'])routes.postTicks[id]![t]=90;
 }
 const candidates=[target.id,second.id].map(id=>({id:`attack:${id}`,kind:'attack' as const,objective:`capture:${id}`,targets:[id],captureTargets:[id],priority:0,reasons:[],
   drafts:[{id:`launch:${id}`,issueTick:o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:id,drillers:25}}]}));
 const before=structuredClone(o),scenarios=botOpponentScenarios(o,routes,candidates,144);
 for(const t of [target.id,second.id]){
   const reinforcement=scenarios.find(s=>s.id===`reinforcement:${t}`)!;
   assert.ok(reinforcement);assert.ok(reinforcement.enemyLaunches!.length>6);
   assert.doesNotThrow(()=>forecastKnownPath(o,{targetTick:o.view.tick+144,enemyLaunches:reinforcement.enemyLaunches!}));
   assert.ok([source.id,'support-0','support-1'].every(id=>reinforcement.enemyLaunches!.some(h=>h.source===id)));
   const retake=scenarios.find(s=>s.holdingTarget===t)!;
   assert.ok(retake);assert.equal(retake.enemyLaunches![0]!.issueTick,o.view.tick+11);
   assert.ok(retake.enemyLaunches!.every(h=>h.destination===t&&h.source!==t));
 }
 const short=botOpponentScenarios(o,routes,candidates,72);
 assert.ok(!short.some(s=>s.enemyLaunches?.some(h=>['support-0','support-1',source.id].includes(h.source)&&h.destination===target.id)));
 assert.deepEqual(o,before);
});

test('post-capture retake is resolved with actual own follow-up relief rather than a static force sum',()=>{
 const {o}=fixture();
 const target=o.view.outposts.find(p=>p.id==='红方矿场')!;target.type='generator';target.drillers=0;target.shield=0;target.shieldMax=0;
 const enemy=o.view.outposts.find(p=>p.id==='红方后方')!;enemy.drillers=80;
 const home=o.view.outposts.find(p=>p.id==='蓝方工厂')!;home.drillers=200;home.type='generator';
 const draft={id:'claim',issueTick:o.view.tick,action:{kind:'launch',source:home.id,destination:target.id,drillers:10}};
 const candidate={id:'claim',kind:'attack' as const,objective:`capture:${target.id}`,targets:[target.id],captureTargets:[target.id],priority:0,reasons:[],drafts:[draft]};
 const reaction=botOpponentScenarios(o,attackRoutes(o),[candidate]).find(s=>s.holdingTarget===target.id)!;
 assert.ok(reaction);
 const run=(relief:boolean)=>forecastKnownPath(o,{targetTick:o.view.tick+144,enemyLaunches:reaction.enemyLaunches!,drafts:[draft,...relief?[{id:'relief',issueTick:o.view.tick+2,action:{kind:'launch',source:home.id,destination:target.id,drillers:100}}]:[]]});
 const weak=run(false),strong=run(true);
 assert.equal(weak.forecast.status,'conditional');assert.equal(strong.forecast.status,'conditional');
 if(weak.forecast.status==='conditional'&&strong.forecast.status==='conditional'){
   assert.equal(weak.forecast.result.outposts.find(p=>p.id===target.id)!.owner,1);
   assert.equal(strong.forecast.result.outposts.find(p=>p.id===target.id)!.owner,0);
 }
});


test('a captured visible source blocks its delayed enemy launch without hiding own resource failures',()=>{
 const {o}=fixture();const source=o.view.outposts.find(p=>p.id==='红方矿场')!;source.drillers=1;source.shield=0;source.shieldMax=0;
 const drafts=[{id:'take-source',issueTick:o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:source.id,drillers:10}}];
 const response=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts,enemyLaunches:[{id:'late-retake',player:1,source:source.id,destination:'红方后方',issueTick:o.view.tick+60,drillers:1}],collectResourceFrames:true});
 assert.ok(response.forecast.hypotheticalEnemySourceLossIds?.includes('late-retake'));
 const context={snapshot:{observation:o}},initial=checkPlanResources(drafts,undefined,context,{deferToForecast:true});
 const finalized=finalizePlanResources(initial,{...response.forecast,...response.path?{path:response.path}:{}},drafts,undefined,context);
 assert.equal(finalized.status,'satisfied');
 const ownFailure=structuredClone(response.forecast);
 if(ownFailure.status==='conditional')ownFailure.orders.push({id:'take-source',issueTick:o.view.tick,status:'failed',certainty:'conditional',code:'invalid-route',reason:'test'});
 const rejected=finalizePlanResources(initial,{...ownFailure,...response.path?{path:response.path}:{}},drafts,undefined,context);
 assert.equal(rejected.status,'conflict');
});
