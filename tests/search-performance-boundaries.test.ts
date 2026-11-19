import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,beginEconomicTick,beginOwnedEconomicTick,
  fleetScenarioSpeed,fleetSpeed,type FleetSetup} from '../packages/engine/src/index.js';

function fixture(){
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  setup.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:8,y:0},'红方后方':{x:-8,y:0}};
  setup.economy.outposts[2]!.owner=0;

  let s=createFleetScenario(setup);
  for(const id of ['friendly','hostile'])s=submitFleetOrder(s,{id,player:0,action:{kind:'launch',source:'蓝方工厂',destination:id==='friendly'?'红方后方':'红方矿场',drillers:10,}}).state;
  return s;
}

test('ordinary fleets share world-time speed without mutating their state',()=>{
  const s=advanceFleetScenario(fixture(),103),before=structuredClone(s);
  for(const fleet of s.fleets.filter(f=>f.used))assert.equal(fleetScenarioSpeed(s,fleet),fleetSpeed(s.economy.tick));
  assert.deepEqual(s,before);
});

test('economic ownership optimization preserves immutable public phases and forecast branches',()=>{
  const s=fixture(),before=structuredClone(s),next=advanceFleetScenario(s,110);
  assert.deepEqual(s,before);assert.notDeepEqual(next,s);
  assert.deepEqual(advanceFleetScenario(s,110),next,'running a sibling branch cannot contaminate the starting state');
  const economic=structuredClone(s.economy),original=structuredClone(economic),owned=structuredClone(economic);
  const immutable=beginEconomicTick(economic,[20,0]),result=beginOwnedEconomicTick(owned,[20,0]);
  assert.equal(result,owned);assert.deepEqual(result,immutable);assert.deepEqual(economic,original);
});
