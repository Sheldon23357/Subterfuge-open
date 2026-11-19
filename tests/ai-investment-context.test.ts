import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {investmentContext} from '../packages/ai/src/controller/presentation/investment-context.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';

function fixture(){
  const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  c.match={mode:'mining',neptuniumGoal:200};
  c.economy.outposts[0]!.drillers=48;
  c.economy.outposts[2]!.owner=0;c.economy.outposts[2]!.drillers=2;c.economy.outposts[2]!.type='generator';
  return observation({state:createFleetScenario(c),scheduled:[]},0,'investment-test');
}

test('first-mine facts reveal a 48+2 funding option without inventing production, safety or incoming troops',()=>{
  const o=fixture(),before=structuredClone(o),facts=investmentContext(o)!;
  assert.equal(facts.cost,50);assert.equal(facts.knownAvailable,50);
  const plan=facts.candidates.find(p=>p.outpost==='蓝方工厂')!;
  assert.equal(plan.missing,2);assert.equal(plan.unfunded,0);
  assert.deepEqual(plan.transfers,[{source:'红方后方',drillers:2}]);
  assert.ok(!('safe' in plan)&&!('arrivalTick' in plan)&&!('income' in plan));
  assert.deepEqual(o,before);
});

test('mine funding excludes accepted reservations and does not spend unknown commitments',()=>{
  const o=fixture();
  o.scheduled.push({id:'reserve',player:0,status:'pending',issueTick:o.view.tick+5,action:{kind:'launch',source:'红方后方',destination:'红方矿场',drillers:2}});
  const reserved=investmentContext(o)!;
  assert.equal(reserved.knownAvailable,48);
  assert.equal(reserved.candidates.find(p=>p.outpost==='蓝方工厂')!.unfunded,2);
  o.scheduled.push({id:'unknown-cost',player:0,status:'pending',issueTick:o.view.tick+8,action:{kind:'toggle-mine',outpostId:'蓝方工厂'}});
  const unknown=investmentContext(o)!;
  assert.ok(unknown.unknownSources.includes('蓝方工厂'));
  assert.equal(unknown.candidates.some(p=>p.outpost==='蓝方工厂'),false);
});

test('mine investment continues with other candidates after construction and is absent outside mining',()=>{
  const o=fixture();o.view.outposts[0]!.minePending=true;
  assert.equal(investmentContext(o)!.firstMine,false);
  assert.equal(investmentContext(o)!.candidates.some(p=>p.outpost===o.view.outposts[0]!.id),false);
  o.view.outposts[0]!.minePending=false;o.view.outposts[0]!.type='mine';
  assert.equal(investmentContext(o)!.firstMine,false);
  assert.equal(investmentContext(o)!.candidates.some(p=>p.outpost===o.view.outposts[0]!.id),false);
  o.view.outposts[0]!.type='factory';o.view.match!.mode='domination';
  assert.equal(investmentContext(o),null);
});
