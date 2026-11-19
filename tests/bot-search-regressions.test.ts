import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot,planBotAsync} from '../packages/ai/src/controller/local/bot-planner.js';
import type {BotEvaluation} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {executeBotForecast} from '../packages/ai/src/controller/analysis/tactical-forecast.js';
import {botOpponentScenarios} from '../packages/ai/src/controller/analysis/tactical-opponents.js';
import {forecastKnownPath,type KnownPredictionDraft} from '../packages/prediction/src/index.js';
import {checkPlanResources,finalizePlanResources} from '../packages/ai/src/controller/execution/plan-resource-check.js';
import type {BotCandidate} from '../packages/ai/src/controller/analysis/tactical-candidates.js';

type Post={id:string;owner:number;drillers:number;x:number;y?:number;type?:'mine'|'generator';shield?:number};
function setup(posts:Post[],tick=0):FleetSetup{
 const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,t=c.economy.outposts[0]!;
 c.size={width:80,height:80};c.match={mode:'mining',neptuniumGoal:200};c.economy.initialTick=tick;
 c.economy.players=Array.from({length:2},()=>({active:true,neptunium:0,minesCreated:0}));
 c.positions=Object.fromEntries(posts.map(p=>[p.id,{x:p.x,y:p.y??0}]));
 c.economy.outposts=posts.map(p=>({...t,id:p.id,owner:p.owner,drillers:p.drillers,type:p.type??'generator',shield:p.shield??0,shieldMax:p.shield??0,productionProgress:0,miningProgress:0}));
 return c;
}
const observe=(c:FleetSetup)=>observation({state:createFleetScenario(c),scheduled:[]},0,'search-regression');

test('force refinement retains the stronger original for the same adversarial comparison',async()=>{
 const o=observe(setup([{id:'home',owner:0,drillers:30,x:0},{id:'target',owner:1,drillers:2,x:3,type:'mine'},{id:'reserve',owner:1,drillers:10,x:3.2,shield:20}]));
 const routes=attackRoutes(o),options={maxSimulations:50,maxElapsedMs:60000},decision=planBot(o,routes,options);
 const original=decision.assessments.find(a=>a.candidate.captureTargets?.includes('target')&&a.candidate.drafts.length===1&&a.candidate.drafts[0]!.action.drillers===15)!;
 assert.ok(original?.stress,'the original must not disappear before stress');
 assert.notEqual(decision.selected.id,'hold');
 for(const scenario of botOpponentScenarios(o,routes,[decision.selected])){
  const result=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts,enemyLaunches:scenario.enemyLaunches??[]});
  assert.equal(result.forecast.status,'conditional');
  if(result.forecast.status==='conditional')assert.equal(result.forecast.result.outposts.find(p=>p.id==='target')!.owner,0);
 }
 assert.ok(decision.coverage.simulations<=50);
 assert.deepEqual(await planBotAsync(o,routes,{...options,parallelism:5},async requests=>requests.map(r=>executeBotForecast(o,r))),decision);
});



test('failed ordinary force seeds do not veto a stronger generated variant in the remaining budget',()=>{
 const posts:Post[]=[{id:'home',owner:0,drillers:90,x:0},...Array.from({length:16},(_,i)=>({id:`target${i}`,owner:1,drillers:10,x:2+i/20,type:i===0?'mine' as const:'generator' as const}))];
 const c=setup(posts);c.economy.players.forEach(p=>p.minesCreated=2);

 const o=observe(c);
 // Supply a definite failed seed explicitly; discovery/refinement ordering
 // is free to spend its remaining budget on stronger alternatives.
 const weak:BotCandidate={id:'understrength-seed',kind:'attack',objective:'capture:target0',targets:['target0'],captureTargets:['target0'],priority:1,reasons:[],drafts:[{id:'understrength-seed:0',issueTick:o.view.tick,action:{kind:'launch',source:'home',destination:'target0',drillers:3}}]};
 const decision=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:60000,skipInternal:true,preludeCandidates:[weak]});
 assert.ok(decision.assessments.some(a=>a.candidate.objective==='capture:target0'&&a.status==='invalid'&&Number(a.candidate.drafts[0]!.action.drillers)<30));
 assert.ok(decision.assessments.some(a=>a.candidate.objective==='capture:target0'&&a.status==='evaluated'&&Number(a.candidate.drafts[0]!.action.drillers)>30));
 assert.ok(decision.coverage.simulations<=50);
});

test('a verified temporary mine raid can prevent the baseline enemy crossing without endpoint ownership',()=>{
 const c=setup([{id:'home',owner:0,drillers:30,x:0},{id:'target',owner:1,drillers:11,x:.3,type:'mine'},{id:'reserve',owner:1,drillers:300,x:3}],100);
 c.economy.players[1]!.neptunium=199;c.economy.players[1]!.minesCreated=1;
 const state=submitFleetOrder(createFleetScenario(c),{id:'already-reinforcing',player:1,action:{kind:'launch',source:'reserve',destination:'target',drillers:80}}).state;
 const o=observation({state,scheduled:[]},0,'temporary-denial'),routes=attackRoutes(o);
 const hold=forecastKnownPath(o,{targetTick:o.view.tick+144});assert.equal(hold.forecast.status,'conditional');
 if(hold.forecast.status==='conditional')assert.equal(hold.forecast.result.terminalPrediction?.firstCrossing?.triggeringSeat,1);
 const decision=planBot(o,routes,{maxSimulations:50,maxElapsedMs:60000});
 assert.ok(decision.assessments.some(a=>a.candidate.captureTargets?.includes('target')&&a.status==='evaluated'&&a.reasons.some(r=>r.includes('短暂夺矿'))));
 // The same loss of endpoint control without a baseline race is still invalid.
 const quiet=structuredClone(o);quiet.intel.find(p=>p.player===1)!.neptunium=0;
 const noRace=planBot(quiet,attackRoutes(quiet),{maxSimulations:50,maxElapsedMs:60000});
 assert.equal(noRace.assessments.some(a=>a.reasons.some(r=>r.includes('短暂夺矿'))),false);
});

test('quiet local mine funding uses known payment paths without a global fog veto',()=>{
 const posts:Post[]=Array.from({length:11},(_,i)=>({id:`p${i}`,owner:i<10?0:1,drillers:i===0?20:i===1?30:0,x:i<10?i/10:30}));
 const c=setup(posts,100),state=createFleetScenario(c);
 const o=observation({state,scheduled:[]},0,'local-funding'),context={snapshot:{observation:o}};
 const drafts:KnownPredictionDraft[]=[{id:'transfer',issueTick:100,action:{kind:'launch',source:'p1',destination:'p0',drillers:30}},{id:'build',issueTick:105,action:{kind:'toggle-mine',outpostId:'p0'}}];
 const result=forecastKnownPath(o,{targetTick:244,drafts,collectResourceFrames:true}),initial=checkPlanResources(drafts,undefined,context,{deferToForecast:true});
 const forecast={...result.forecast,...result.path?{path:result.path}:{}};
 assert.equal(finalizePlanResources(initial,forecast,drafts,undefined,context).status,'satisfied');
 const future=forecast.resourceFrames!.find(f=>f.tick===105)!;
 assert.ok(!future.pathUnknownReasons?.length);
 future.pathUnknownReasons=['arrival-outcome-unknown'];
 assert.equal(finalizePlanResources(initial,forecast,drafts,undefined,context).status,'unknown');
});
