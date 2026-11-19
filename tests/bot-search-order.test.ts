import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {generateBotCandidates} from '../packages/ai/src/controller/analysis/tactical-candidates.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';
import {compareBotDiscovery,canCombineBotCandidates,botDiscoveryObjective} from '../packages/ai/src/controller/analysis/tactical-search-order.js';

function setup(){
  const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  c.size={width:40,height:40};c.match={mode:'mining',neptuniumGoal:200};
  c.economy.players=Array.from({length:4},()=>({active:true,neptunium:0,minesCreated:0}));
  const entries=[['small',0,3,0],['reserve',0,30,-0.1],['target',1,10,0.3],['rival2',2,0,15],['rival3',3,0,-15]] as const;
  const template=c.economy.outposts[0]!;
  c.positions=Object.fromEntries(entries.map(([id,_owner,_drillers,x])=>[id,{x,y:0}]));
  c.economy.outposts=entries.map(([id,owner,drillers])=>({...template,id,owner,drillers,type:'generator',shield:0,shieldMax:0}));
  return c;
}

test('limited discovery tests a funded attack before a nearer source that cannot cover the ordinary estimate',()=>{
  const o=observation({state:createFleetScenario(setup()),scheduled:[]},0,'discovery-order'),routes=attackRoutes(o);
  const plans=generateBotCandidates(o,routes).filter(c=>c.objective==='capture:target');
  assert.ok(plans.some(c=>c.forceEstimate&&c.forceEstimate.committed<c.forceEstimate.required),'undersized alternatives remain available');
  const decision=planBot(o,routes,{maxSimulations:12,maxElapsedMs:30000});
  const first=decision.assessments.find(a=>a.candidate.objective==='capture:target')!;
  assert.ok(first.candidate.forceEstimate!.committed>=first.candidate.forceEstimate!.required);
  assert.equal(first.status,'evaluated',JSON.stringify(first));
  assert.ok(decision.coverage.simulations<=12);
});
