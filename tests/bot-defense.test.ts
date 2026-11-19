import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';

function setup():FleetSetup{
  const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  c.size={width:80,height:80};c.match={mode:'mining',neptuniumGoal:200};
  c.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
  const template=c.economy.outposts[0]!;
  c.positions={home:{x:0,y:0},reserve:{x:0.1,y:0},enemy:{x:0.8,y:0},rival2:{x:30,y:30},rival3:{x:-30,y:30}};
  c.economy.outposts=Object.keys(c.positions).map((id,i)=>({...template,id,owner:[0,0,1,2,3][i]!,
    type:'generator',drillers:[0,80,70,100,100][i]!,shield:0,shieldMax:0}));
  return c;
}

for(const reserve of [90,52])test(`six-player bot evaluates feasible ${reserve}-troop allocations across three simultaneous mine attacks`,()=>{
  const c=setup();c.economy.players=Array.from({length:6},()=>({active:true,neptunium:0,minesCreated:0}));
  const template=c.economy.outposts[0]!;
  const entries=[
    ['reserve',0,reserve,0,0],['mine-a',0,0,0.1,0],['mine-b',0,0,0,0.1],['mine-c',0,0,-0.1,0],
    ['enemy-a',1,25,1,0],['enemy-b',2,25,0,1],['enemy-c',3,25,-1,0],
    ['rival4',4,100,30,30],['rival5',5,100,-30,30],
  ] as const;
  c.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x,y])=>[id,{x,y}]));
  c.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:id.startsWith('mine-')?'mine':'generator',shield:0,shieldMax:0}));
  c.economy.players[0]!.neptunium=100;c.economy.players[0]!.minesCreated=3;
  let state=createFleetScenario(c);
  for(const [i,suffix] of ['a','b','c'].entries())state=submitFleetOrder(state,{id:`incoming-${suffix}`,player:i+1,
    action:{kind:'launch',source:`enemy-${suffix}`,destination:`mine-${suffix}`,drillers:25}}).state;
  const o=observation({state,scheduled:[]},0,'six-player-three-fronts');
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(baseline.path!.mineLosses.count,3);
  // Exercise the tactical search after the independent transfer phase.
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000,skipInternal:true});
  const selected=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  if(reserve===90)assert.equal(selected.path!.mineLosses.count,0,JSON.stringify(decision.selected));
  else{
    // Saving two barely defended mines can leave them exposed to the third
    // captured mine's surviving force. Require that joint option to be found
    // and evaluated, without dictating that it beats a more durable defense.
    const joint=decision.assessments.filter(a=>a.status==='evaluated'&&a.candidate.targets.length>=2&&a.candidate.drafts.length>=2);
    assert.ok(joint.some(a=>forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:a.candidate.drafts}).path!.mineLosses.count===1),'Feasible two-front defense was omitted');
    assert.ok(selected.path!.mineLosses.count<=2,JSON.stringify(decision.selected));
  }
  assert.equal(selected.forecast.status,'conditional');
  if(selected.forecast.status==='conditional')assert.equal(selected.forecast.orders.some(order=>order.status==='failed'),false);
});

test('four-player bot defends an existing mine and prevents the actual loss deduction',()=>{
  const c=setup();c.economy.outposts[0]!.type='mine';
  c.economy.players[0]!.neptunium=100;c.economy.players[0]!.minesCreated=1;
  const state=submitFleetOrder(createFleetScenario(c),{id:'incoming',player:1,action:{kind:'launch',source:'enemy',destination:'home',drillers:60}}).state;
  const o=observation({state,scheduled:[]},0,'four-player-mine-defense');
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.ok(baseline.path!.mineLosses.count>0);
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  const selected=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(selected.forecast.status,'conditional');
  assert.equal(selected.path!.mineLosses.count,0,JSON.stringify(decision.selected));
  if(selected.forecast.status==='conditional')assert.equal(selected.forecast.result.outposts.find(p=>p.id==='home')!.owner,0);
});

test('four-player search tries its arrival-strength seed before a smaller force that cannot beat the current defense',()=>{
  const c=setup();c.economy.outposts[0]!.drillers=63;c.economy.outposts[1]!.drillers=0;
  c.economy.outposts[2]!.type='factory';c.economy.outposts[2]!.drillers=39;
  c.economy.outposts[2]!.shield=10;c.economy.outposts[2]!.shieldMax=10;
  const o=observation({state:createFleetScenario(c),scheduled:[]},0,'four-player-force-order');
  const candidates=generateBotCandidates(o,attackRoutes(o)).filter(c=>c.kind==='attack'&&c.drafts.length===1
    &&c.drafts[0]!.action.source==='home'&&c.drafts[0]!.action.destination==='enemy');
  assert.ok(candidates.length>1);
  assert.ok(Number(candidates[0]!.drafts[0]!.action.drillers)>=50);
  assert.ok(candidates.some(c=>c.drafts[0]!.action.drillers===32),'the smaller alternative is retained, not prohibited');
});

test('a player with another owned outpost survives losing a threatened outpost',()=>{
  const c=setup();c.positions.enemy={x:0.0001,y:0};
  c.economy.outposts[1]!.drillers=0;

  const state=submitFleetOrder(createFleetScenario(c),{id:'incoming',player:1,action:{kind:'launch',source:'enemy',destination:'home',drillers:60}}).state;
  const o=observation({state,scheduled:[]},0,'four-player-succession');
  const baseline=forecastKnownPath(o,{targetTick:o.view.tick+144});
  assert.equal(baseline.forecast.status,'conditional');
  if(baseline.forecast.status==='conditional'){
    assert.equal(baseline.forecast.result.self.active,true);

  }
  const decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  const selected=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:decision.selected.drafts});
  assert.equal(selected.forecast.status,'conditional');
  if(selected.forecast.status==='conditional')assert.equal(selected.forecast.result.self.active,true,JSON.stringify(decision.selected));
});
