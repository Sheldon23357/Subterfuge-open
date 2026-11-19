import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,fleetMatchOutcome,type FleetSetup,type FleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {evaluateBotFrame,compareBotEvaluations} from '../packages/ai/src/controller/analysis/tactical-evaluation.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {DEFAULT_BOT_SETTINGS} from '../packages/contracts/src/index.js';

function fixture(ownCount=10,existingMine=true){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};cfg.size={width:80,height:80};
  cfg.economy.players=[{active:true,neptunium:existingMine?160:0,minesCreated:Number(existingMine)},
    {active:true,neptunium:existingMine?170:0,minesCreated:Number(existingMine)}];
  const template=cfg.economy.outposts[0]!;
  cfg.economy.outposts=Array.from({length:ownCount+10},(_,i)=>({...template,id:`p${i}`,owner:i<ownCount?0:1,
    type:existingMine&&(i===0||i===ownCount)?'mine':'generator',drillers:i===1?(existingMine?100:50):0,
    shield:0,shieldMax:0,productionProgress:0,miningProgress:0}));
  cfg.positions=Object.fromEntries(cfg.economy.outposts.map((p,i)=>[p.id,{x:i<ownCount?i/10:30+(i-ownCount)/10,y:i<ownCount?0:30}]));

  const state=createFleetScenario(cfg);
  return state;
}
function advanceChecked(state:FleetScenario,target:number){
  for(let next=state.economy.tick+1;next<=target;next++){
    if(next%100===0)for(let player=0;player<2;player++)state=submitFleetOrder(state,{id:`check-${player}-${next}`,player,action:{kind:'check-in'}}).state;
    state=advanceFleetScenario(state,next);if(fleetMatchOutcome(state))break;
  }
  return state;
}
for(const tick of [100,352,370])test(`second-mine completion value does not miss the static race at tick ${tick}`,()=>{
  const state=advanceChecked(fixture(),tick),o=observation({state,scheduled:[]},0,'mining-race');
  const decision=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:10000,horizonTicks:144});
  assert.ok(decision.selected.drafts.some(d=>d.action.kind==='toggle-mine'),JSON.stringify(decision.selected));
  const build=submitFleetOrder(state,{id:'mine',player:0,action:{kind:'toggle-mine',outpostId:'p1'}}).state;
  const built=advanceChecked(build,700),held=advanceChecked(state,700);
  assert.equal(fleetMatchOutcome(built)?.triggeringSeat,0);assert.equal(fleetMatchOutcome(held)?.triggeringSeat,1);
  assert.ok(fleetMatchOutcome(built)!.tick<fleetMatchOutcome(held)!.tick);
});
for(const owned of [2,5,7])for(const troops of [50,500])test(`first mine with ${owned} safe posts and ${troops} troops respects the army investment share`,()=>{
  const state=fixture(owned,false);state.economy.outposts.find(p=>p.id==='p1')!.drillers=troops;
  const o=observation({state,scheduled:[]},0,'first-mine');
  const decision=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:10000,horizonTicks:144});
  assert.equal(decision.selected.drafts.some(d=>d.action.kind==='toggle-mine'),troops===500,JSON.stringify(decision.selected));
});

test('new-mine scoring penalizes current army share without discounting real income or double-charging troops',()=>{
  const samples=[50,100,160,500].map(troops=>{
    const state=fixture(5,false);state.economy.outposts.find(p=>p.id==='p1')!.drillers=troops;
    const o=observation({state,scheduled:[]},0,'mine-force-share');
    const result=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:[{id:'build',issueTick:o.view.tick,action:{kind:'toggle-mine',outpostId:'p1'}}]});
    assert.equal(result.forecast.status,'conditional');if(result.forecast.status!=='conditional')throw Error('forecast failed');
    const evaluation=evaluateBotFrame(o,result.forecast.result,result.path),hold=evaluateBotFrame(o,o.view);
    assert.equal(hold.components.mineForceCommitment,0);
    assert.equal(evaluation.components.troops,troops-50);
    assert.ok(evaluation.components.neptunium!>0);
    assert.ok(evaluation.components.mineForceCommitment!<0);
    assert.ok(evaluation.components.miningPotential!+evaluation.components.mineForceCommitment!>=0);
    if(troops===50)assert.equal(evaluation.components.miningPotential!+evaluation.components.mineForceCommitment!,0);
    return evaluation.components.mineForceCommitment!;
  });
  for(let i=1;i<samples.length;i++)assert.ok(samples[i]!>samples[i-1]!,JSON.stringify(samples));
});

test('existing, captured and already-paid pending mines do not incur new construction commitment',()=>{
  const o=observation({state:fixture(5,false),scheduled:[]},0,'mine-sunk-cost');
  for(const kind of ['existing','captured','pending'] as const){
    const basis=structuredClone(o),post=basis.view.outposts[0]!;
    if(kind==='pending')post.minePending=true;
    else post.type='mine';
    if(kind==='captured')post.owner=1;
    const frame=structuredClone(basis.view);frame.outposts[0]!.type='mine';frame.outposts[0]!.owner=0;frame.outposts[0]!.minePending=false;
    assert.equal(evaluateBotFrame(basis,frame).components.mineForceCommitment,0,kind);
  }
});
test('completion capital does not invent a mine, ignore holding credit, or book NP',()=>{
  const o=observation({state:fixture(5,false),scheduled:[]},0,'completion-controls');
  const before=structuredClone(o);
  assert.equal(evaluateBotFrame(o,o.view).components.miningPotential,0);
  assert.deepEqual(o,before);
  const mine=structuredClone(o.view);mine.outposts[0]!.type='mine';
  const safe=evaluateBotFrame(o,mine);
  assert.ok(safe.components.miningPotential!>0);assert.equal(safe.components.neptunium,0);
  const hostile=mine.outposts.find(p=>p.owner===1)!;
  Object.assign(hostile,{visibility:2,position:{x:0.01,y:0},drillers:200,shield:0});
  const threatened=evaluateBotFrame(o,mine);
  assert.ok(threatened.components.miningPotential!>=0&&threatened.components.miningPotential!<safe.components.miningPotential!, 'discounted nearby support can retain partial holding credit under pressure');
  assert.equal(threatened.components.neptunium,0);
  assert.ok(threatened.utility<safe.utility);
});
test('capacity has no productive value without factories; existing over-cap troops remain assets',()=>{
  const o=observation({state:fixture(2,false),scheduled:[]},0,'capacity-controls');
  o.view.self.drillers=200;o.view.self.capacity=200;
  const a=evaluateBotFrame(o,o.view);o.view.self.capacity=150;
  const b=evaluateBotFrame(o,o.view);
  assert.equal(a.components.capacity,0);assert.equal(b.components.capacity,0);
  assert.equal(a.components.troops,200);assert.equal(b.components.troops,200);
});
test('real terminal crossing and its timing outrank all static completion value',()=>{
  const state=fixture(),o=observation({state,scheduled:[]},0,'terminal-priority');
  o.view.self.neptunium=199;
  const f=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(f.forecast.status,'conditional');if(f.forecast.status!=='conditional')return;
  const winner=evaluateBotFrame(o,f.forecast.result,f.path),ongoing=evaluateBotFrame(o,o.view);
  assert.equal(winner.outcome,1);ongoing.utility=1e9;
  assert.ok(compareBotEvaluations(winner,ongoing)>0);
  const later={...winner,crossingTick:winner.crossingTick!+1,utility:winner.utility+1e9};
  assert.ok(compareBotEvaluations(winner,later)>0);
});

test('completion option is bounded, monotone in credited income, and does not count mines twice',()=>{
  const o=observation({state:fixture(),scheduled:[]},0,'capital-monotonicity');
  const one=evaluateBotFrame(o,o.view),two=structuredClone(o.view);two.outposts[1]!.type='mine';
  const faster=evaluateBotFrame(o,two);
  assert.ok(faster.components.miningPotential!>one.components.miningPotential!);
  const equalRate=structuredClone(two);
  equalRate.outposts=equalRate.outposts.filter(p=>p.owner!==0||Number(p.id.slice(1))<5);
  assert.equal(evaluateBotFrame(o,equalRate).components.miningPotential,one.components.miningPotential);
  const richer=structuredClone(o.view);richer.self.neptunium+=1;
  assert.ok(evaluateBotFrame(o,richer).utility>one.utility);
  assert.ok(Object.values(faster.components).every(Number.isFinite));
  // The configured execution baseline multiplies this utility, not its ETA.
  const low=evaluateBotFrame(o,two,null,{...DEFAULT_BOT_SETTINGS,economyWeight:0.5});
  assert.equal(faster.components.miningPotential,2*low.components.miningPotential!);
  assert.ok(low.components.miningPotential!<=200*(2+4*two.self.neptunium/200));
});
test('pending or lost mines do not invent completed mining capital; unknown holding stays discounted',()=>{
  const o=observation({state:fixture(5,false),scheduled:[]},0,'capital-knowledge');
  o.view.outposts[0]!.minePending=true;
  assert.equal(evaluateBotFrame(o,o.view).components.miningPotential,0);
  const held=structuredClone(o.view);held.outposts[0]!.minePending=false;held.outposts[0]!.type='mine';
  const safe=evaluateBotFrame(o,held),uncertain=structuredClone(held);
  const foreign=uncertain.outposts.find(p=>p.owner===1)!;
  foreign.position={x:0.1,y:0};foreign.visibility=0;delete foreign.drillers;delete foreign.shield;
  const unknown=evaluateBotFrame(o,uncertain);
  assert.ok(unknown.components.miningPotential!>0);assert.ok(unknown.components.miningPotential!<safe.components.miningPotential!);
  assert.ok(unknown.unknowns.some(x=>x.startsWith('mine-holding:')));
  held.outposts[0]!.owner=1;
  assert.equal(evaluateBotFrame(o,held).components.miningPotential,0);
});
test('a new mine that cannot advance a real imminent win loses to keeping its drillers',()=>{
  const state=fixture();state.economy.players[0]!.neptunium=199;
  const o=observation({state,scheduled:[]},0,'late-investment');
  const hold=forecastKnownPath(o,{targetTick:244}),build=forecastKnownPath(o,{targetTick:244,drafts:[{id:'mine',issueTick:100,action:{kind:'toggle-mine',outpostId:'p1'}}]});
  assert.equal(hold.forecast.status,'conditional');assert.equal(build.forecast.status,'conditional');
  if(hold.forecast.status!=='conditional'||build.forecast.status!=='conditional')return;
  const a=evaluateBotFrame(o,hold.forecast.result,hold.path),b=evaluateBotFrame(o,build.forecast.result,build.path);
  assert.equal(a.outcome,1);assert.equal(b.outcome,1);assert.equal(a.crossingTick,b.crossingTick);
  assert.equal(a.components.miningPotential,0);assert.equal(b.components.miningPotential,0);
  assert.ok(compareBotEvaluations(a,b)>0);
  const selected=planBot(o,attackRoutes(o),{maxSimulations:50,maxElapsedMs:10000,horizonTicks:144}).selected;
  assert.ok(!selected.drafts.some(d=>d.action.kind==='toggle-mine'),JSON.stringify(selected));
});
test('completion duration uses a common observation origin, not each candidate endpoint',()=>{
  const o=observation({state:fixture(),scheduled:[]},0,'completion-clock');
  const f=forecastKnownPath(o,{targetTick:244});assert.equal(f.forecast.status,'conditional');
  if(f.forecast.status!=='conditional')return;
  const early=evaluateBotFrame(o,f.forecast.result,f.path),later=structuredClone(f.forecast.result);
  later.targetTick+=20;
  const late=evaluateBotFrame(o,later);
  assert.ok(late.components.miningPotential!<early.components.miningPotential!);
  assert.equal(late.components.neptunium,early.components.neptunium);
});
