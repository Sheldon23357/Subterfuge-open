import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {planBot,canRetainBotObjective} from '../packages/ai/src/controller/local/bot-planner.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {botDistance,evaluateBotFrame,compareBotEvaluations,type BotEvaluation} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';

function fixture(drillers?:number){
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  if(drillers!==undefined)setup.economy.outposts[0]!.drillers=drillers;
  setup.match={mode:'mining',neptuniumGoal:200};
  const room={state:createFleetScenario(setup),scheduled:[]};
  const o=observation(room,0,'bot-test');
  return {o,routes:attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24})};
}
test('bot uses shared prediction to choose a profitable attack and leaves inputs unchanged',()=>{
  const {o,routes}=fixture(),before=structuredClone(o);
  const decision=planBot(o,routes,{maxSimulations:80,maxElapsedMs:30000});
  assert.notEqual(decision.selected.id,'hold',JSON.stringify(decision.assessments));
  assert.ok(decision.selected.drafts.some(d=>d.action.kind==='launch'));
  const replay=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(replay.forecast.status,'conditional');
  if(replay.forecast.status==='conditional'){
    assert.equal(replay.forecast.orders.some(o=>o.status==='failed'),false);
    assert.ok(replay.forecast.result.self.outpostCount>o.view.self.outpostCount);
  }
  assert.deepEqual(o,before);
  const repeated=planBot(o,routes,{maxSimulations:80,maxElapsedMs:30000});
  assert.deepEqual(repeated.selected,decision.selected);
});
test('search budget and cancellation are explicit, never claimed exhaustive',()=>{
  const {o,routes}=fixture();
  const limited=planBot(o,routes,{maxSimulations:2,maxElapsedMs:30000});
  assert.ok(limited.coverage.simulations<=2);
  assert.equal(limited.coverage.complete,false);
  assert.equal(limited.coverage.stopReason,'simulation-budget');
  const signal=AbortSignal.abort();
  const stopped=planBot(o,routes,{signal});
  assert.equal(stopped.coverage.simulations,0);
  assert.equal(stopped.coverage.stopReason,'cancelled');
  assert.equal(stopped.selected.id,'hold');
});

test('attack seeds account for shields recharging during travel instead of repeating a losing current-defense force',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  cfg.positions['红方矿场']={x:2,y:0};cfg.positions['红方后方']={x:3,y:0};
  cfg.economy.outposts[1]!.drillers=5;cfg.economy.outposts[1]!.shield=0;cfg.economy.outposts[1]!.shieldMax=10;
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'recharging-defense');
  const candidate=generateBotCandidates(o,attackRoutes(o)).find(c=>c.kind==='attack'&&c.targets.includes('红方矿场'))!;
  assert.ok(candidate);
  const forecast=(drafts:typeof candidate.drafts)=>forecastKnownPath(o,{targetTick:o.view.tick+144,drafts});
  const old=forecast([{id:'too-small',issueTick:o.view.tick,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:6}}]);
  const proposed=forecast(candidate.drafts);
  assert.equal(old.forecast.status,'conditional');assert.equal(proposed.forecast.status,'conditional');
  if(old.forecast.status==='conditional'&&proposed.forecast.status==='conditional'){
    assert.equal(old.forecast.result.outposts.find(p=>p.id==='红方矿场')!.owner,1);
    assert.equal(proposed.forecast.result.outposts.find(p=>p.id==='红方矿场')!.owner,0);
  }
});

test('waiting fleet resizing reuses its identity without spending reserved troops',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

  const state=submitFleetOrder(createFleetScenario(cfg),{id:'waiting',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:30,}}).state;
  const o=observation({state,scheduled:[]},0,'resize-bot');
  o.scheduled.push({id:'reserve',player:0,status:'pending',issueTick:o.view.tick+10,action:{kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:20}});
  const plans=generateBotCandidates(o,attackRoutes(o)).filter(c=>c.objective==='resize:waiting');
  assert.equal(plans.length,2);
  assert.deepEqual(plans.map(c=>c.drafts[0]!.action.drillers).sort((a,b)=>Number(a)-Number(b)),[15,80]);
  for(const c of plans){
    assert.equal(c.drafts[0]!.action.fleetId,'waiting');
    const result=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:c.drafts});
    assert.equal(result.forecast.status,'conditional');
    if(result.forecast.status==='conditional')assert.equal(result.forecast.orders.some(d=>d.status==='failed'),false);
  }
  o.view.fleets.find(f=>f.id==='waiting')!.canCancelLaunch=false;
  assert.equal(generateBotCandidates(o,attackRoutes(o)).some(c=>c.objective==='resize:waiting'),false);
});
test('an unchanged remote unknown arrival permits a bounded known-target attack without claiming proof',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};
  cfg.positions['红方后方']={x:7.8,y:0};cfg.positions.fog={x:9,y:0};
  cfg.economy.outposts.push({...cfg.economy.outposts[2]!,id:'fog',drillers:0});
  cfg.economy.outposts[2]!.drillers=10;
  const launched=submitFleetOrder(createFleetScenario(cfg),{id:'remote',player:1,action:{kind:'launch',delaySeconds:600,source:'红方后方',destination:'fog',drillers:5}}).state;
  const o=observation({state:launched,scheduled:[]},0,'remote-unknown');
  assert.ok(o.view.outposts.find(p=>p.id==='fog')!.visibility<2);
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(baseline.forecast.status,'conditional');
  assert.ok(baseline.path?.events.some(e=>e.kind==='future-unknown-arrival'&&e.subject==='remote'));
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  const chosen=decision.assessments.find(a=>a.candidate.id===decision.selected.id)!;
  assert.ok(decision.selected.captureTargets?.includes('红方矿场'),JSON.stringify(decision.selected));
  assert.ok(chosen.score!.unknowns.includes('bounded-attack-with-unresolved-remote-arrival'));
  assert.ok(decision.selected.drafts.reduce((n,d)=>n+Number(d.action.drillers??0),0)<=o.view.self.drillers*0.35);
  const predicted=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts,predicates:[{id:'capture',kind:'controlledAtHorizon',outpostId:'红方矿场'}]});
  assert.equal(predicted.path?.predicates[0]!.truth,'unknown','shared evidence must remain conservative');
  const overBudget=decision.assessments.filter(a=>a.candidate.captureTargets?.length
    &&a.candidate.drafts.reduce((n,d)=>n+Number(d.action.drillers??0),0)>o.view.self.drillers*0.35);
  assert.ok(overBudget.length>0,'fixture must exercise excessive force candidates');
  assert.ok(overBudget.every(a=>a.status!=='evaluated'),'remote uncertainty must not authorize excessive commitment');
  const cautious=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000,settings:{schemaVersion:2,remoteUncertaintyForceFraction:0}});
  assert.ok(cautious.assessments.every(a=>!a.score?.unknowns.includes('bounded-attack-with-unresolved-remote-arrival')),'zero risk budget disables the exception rather than merely changing its label');
});

test('unknown enemy defenses are not generated as free attacks and stale routes fail',()=>{
  const {o,routes}=fixture();
  const enemy=o.view.outposts.find(p=>p.owner===1)!;
  enemy.visibility=0;delete enemy.drillers;delete enemy.shield;
  const candidates=generateBotCandidates(o,routes);
  assert.equal(candidates.some(c=>c.objective===`capture:${enemy.id}`),false);
  assert.throws(()=>generateBotCandidates(o,{...routes,revision:'stale'}),/Stale/);
});
test('human resource protection prevents bot spending the protected source',()=>{
  const {o,routes}=fixture();
  const home=o.view.outposts.find(p=>p.owner===0)!;
  o.manualCommands={version:1,receipts:[],receiptsFromVersion:1,hasEarlierReceipts:false,
    protections:[{receiptId:'human',kind:'resources',scope:[`source:${home.id}`]}]};
  const decision=planBot(o,routes,{maxElapsedMs:30000});
  assert.equal(decision.selected.id,'hold');
  assert.ok(decision.assessments.some(a=>a.status==='protected'));
});
test('real reservations reduce candidate troops; an unknown pending mine cost blocks spending',()=>{
  const {o,routes}=fixture();const home=o.view.outposts.find(p=>p.owner===0)!;
  o.scheduled.push({id:'scheduled',player:0,issueTick:o.view.tick+5,status:'pending',action:{kind:'launch',source:home.id,destination:'红方矿场',drillers:90}});
  const candidates=generateBotCandidates(o,routes);
  for(const c of candidates)for(const d of c.drafts)if(d.action.kind==='launch'&&d.action.source===home.id)assert.ok(Number(d.action.drillers)<=10);
  o.scheduled[0]!.action={kind:'toggle-mine',outpostId:home.id};
  assert.equal(generateBotCandidates(o,routes).some(c=>c.drafts.some(d=>d.action.kind==='launch'&&Number(d.action.drillers)>0)),false);
});

test('gathered troops become attack candidates only after actual donor arrival',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  cfg.positions={hub:{x:0,y:0},donor:{x:0.1,y:0},target:{x:0.6,y:0}};
  cfg.economy.outposts.forEach((p,i)=>{
    p.id=['hub','donor','target'][i]!;p.owner=i<2?0:1;p.type='generator';
    p.drillers=[20,40,45][i]!;p.shield=0;p.shieldMax=0;
  });
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'gather-test');
  const candidates=generateBotCandidates(o,attackRoutes(o));
  assert.ok(candidates.every(c=>c.drafts.every(d=>d.issueTick===o.view.tick)));
  assert.ok(!candidates.some(c=>c.drafts.some(d=>d.action.source==='hub'&&Number(d.action.drillers)>20)), 'unarrived donor troops cannot fund a current attack');
  let state=submitFleetOrder(createFleetScenario(cfg),{id:'gather-now',player:0,action:{kind:'launch',delaySeconds:600,source:'donor',destination:'hub',drillers:40}}).state;
  state=advanceFleetScenario(state,o.view.tick+10);
  const after=observation({state,scheduled:[]},0,o.roomId);
  const plans=generateBotCandidates(after,attackRoutes(after));
  assert.ok(plans.some(c=>c.drafts.some(d=>d.action.source==='hub'&&d.action.destination==='target'&&Number(d.action.drillers)>45)), 'a later observation can use actually delivered troops');
});
test('objective continuity cannot resurrect an action rejected by the stress comparison',()=>{
  const waiting:BotEvaluation={outcome:0,crossingTick:null,terminalCertainty:null,utility:100,components:{},unknowns:[]};
  // The old goal can win ordinary evaluation but lose after an enemy response.
  // Being only one point worse than waiting is not permission to keep it.
  assert.equal(canRetainBotObjective({...waiting,utility:99},waiting,waiting),false);
  assert.equal(canRetainBotObjective({...waiting,utility:101},waiting,waiting),false);
  assert.equal(canRetainBotObjective({...waiting,utility:105},waiting,{...waiting,utility:110}),true);
  assert.equal(canRetainBotObjective({...waiting,utility:105},waiting,{...waiting,utility:112}),false);
  const victory={...waiting,outcome:1 as const,crossingTick:120,utility:0};
  assert.equal(canRetainBotObjective({...waiting,utility:200},waiting,victory),false);
  assert.equal(canRetainBotObjective(victory,waiting,{...victory,crossingTick:110}),false);
});

test('terminal outcome and earlier victory outrank arbitrary material; geometry wraps',()=>{
  const base:BotEvaluation={outcome:0,crossingTick:null,terminalCertainty:null,utility:1e9,components:{},unknowns:[]};
  const victory:BotEvaluation={...base,outcome:1,crossingTick:120,terminalCertainty:'conditional',utility:0};
  assert.ok(compareBotEvaluations(victory,base)>0);
  assert.ok(compareBotEvaluations({...victory,crossingTick:110},victory)>0);
  assert.ok(compareBotEvaluations(base,{...base,outcome:-2})>0);
  assert.ok(Math.abs(botDistance({x:0.1,y:0},{x:19.9,y:0},{width:20,height:20})-0.2)<1e-9);
});
test('mining bot invests idle surplus in victory income when expansion is unavailable',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};
  const template=cfg.economy.outposts[0]!;
  cfg.economy.outposts=Array.from({length:11},(_,i)=>({...template,id:`post-${i}`,owner:i<10?0:1,type:i%3===0?'factory':'generator',drillers:i<10?60:100,shield:0,shieldMax:0}));
  cfg.positions=Object.fromEntries(cfg.economy.outposts.map((p,i)=>[p.id,{x:i<10?i/10:40,y:i<10?0:40}]));
  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'investment');
  const result=planBot(o,attackRoutes(o),{maxSimulations:48,maxElapsedMs:30000});
  assert.ok(result.selected.drafts.some(d=>d.action.kind==='toggle-mine'),JSON.stringify(result.assessments.map(a=>({id:a.candidate.id,status:a.status,score:a.score?.utility,reasons:a.reasons}))));
});
test('a mining finish preserves a real income crossing instead of trading victory for material',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  cfg.positions={mine:{x:0,y:0},reserve:{x:0.1,y:0},enemy:{x:3,y:0}};
  cfg.economy.outposts.forEach((p,i)=>{p.id=['mine','reserve','enemy'][i]!;p.owner=i<2?0:1;p.type=i===0?'mine':'generator';p.drillers=80;p.shield=0;p.shieldMax=0;});
  cfg.economy.players[0]!.neptunium=199;cfg.economy.players[0]!.minesCreated=1;

  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'mining-finish');
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(baseline.forecast.status,'conditional');
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  assert.equal(decision.situation.phase,'finish');
  const chosen=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(chosen.forecast.status,'conditional');
  if(baseline.forecast.status==='conditional'&&chosen.forecast.status==='conditional'){
    assert.equal(baseline.forecast.result.terminalPrediction?.firstCrossing?.triggeringSeat,0);
    assert.equal(chosen.forecast.result.terminalPrediction?.firstCrossing?.triggeringSeat,0);
    assert.ok(chosen.forecast.result.terminalPrediction!.firstCrossing!.tick<=baseline.forecast.result.terminalPrediction!.firstCrossing!.tick);
    assert.ok(chosen.forecast.result.self.neptunium>=200);
  }
});

test('bot prevents an imminent enemy mining victory by taking its mine before the crossing',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  cfg.economy.players[1]!.neptunium=199;
  cfg.economy.outposts[2]!.drillers=200;

  const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'deny-mining');
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(baseline.forecast.status,'conditional');
  if(baseline.forecast.status==='conditional')assert.equal(baseline.forecast.result.terminalPrediction?.firstCrossing?.triggeringSeat,1);
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  assert.equal(decision.situation.phase,'deny-victory');
  assert.notEqual(decision.selected.id,'hold');
  const result=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(result.forecast.status,'conditional');
  if(result.forecast.status==='conditional'){
    assert.equal(result.forecast.result.outposts.find(p=>p.id==='红方矿场')!.owner,0);
    assert.notEqual(result.forecast.result.terminalPrediction?.firstCrossing?.triggeringSeat,1);
    assert.equal(result.forecast.result.self.active,true);
  }
});



test('fog probing is a bounded one-troop attempt, never a predicted capture or repeated blind attack',()=>{
  // Isolate the probe policy from a separately profitable immediate mine.
  const {o,routes}=fixture(40);
  for(const p of o.view.outposts.filter(p=>p.owner!==0)){p.visibility=0;delete p.drillers;delete p.shield;}
  const decision=planBot(o,routes,{maxSimulations:48,maxElapsedMs:30000});
  assert.equal(decision.selected.kind,'scout',JSON.stringify(decision.assessments));
  assert.equal(decision.selected.drafts.length,1);assert.equal(decision.selected.drafts[0]!.action.drillers,1);
  const assessed=decision.assessments.find(a=>a.candidate.id===decision.selected.id)!;
  assert.ok(assessed.score!.unknowns.includes('scout-target-outcome-unknown'));
  const attempted=o.view.outposts.filter(p=>p.owner!==0).map(p=>p.id);
  assert.equal(generateBotCandidates(o,routes,attempted).some(c=>c.kind==='scout'),false);
  for(const p of o.view.outposts.filter(p=>p.owner!==0)){p.visibility=2;p.drillers=10;p.shield=0;}
  assert.equal(generateBotCandidates(o,routes).some(c=>c.kind==='scout'),false);
});
