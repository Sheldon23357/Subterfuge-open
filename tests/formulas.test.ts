import { test } from 'node:test';
import assert from 'node:assert/strict';
import cases from '../docs/rules/data/acceptance-cases.json' with { type: 'json' };
import { productionAmount, factoryPeriodTicks, mineCreationCost, neptuniumAfterMineLoss, minePeriodTicks,
  giftRemaining,
  shieldPeriodTicks, resolveDrillerPhase, torusDistance, torusDelta, insideSonar, startSpeedFactor } from '../packages/engine/src/index.js';
import { RULES } from '../packages/rules/src/index.js';

for (const example of cases.filter(c=>["production","factory_period","mine_cost","mine_loss","mine_period","gift","shield_period","battle"].includes(c.kind)&&(!("F"in c.input)||c.input.F===0)&&(!("T"in c.input)||c.input.T===0)&&(!("M"in c.input)||c.input.M===0)&&(!("tycoons"in c.input)||c.input.tycoons===0)&&(!("attacker_specs"in c.input)||c.input.attacker_specs===0)&&(!("defender_specs"in c.input)||c.input.defender_specs===0))) test(`documented example ${example.id}: ${example.kind}`, () => {
  const i = example.input as Record<string, number | boolean>;
  const n = (key: string) => { const value = i[key]; assert.equal(typeof value, 'number'); return value as number; };
  let actual: unknown;
  switch (example.kind) {
    case 'production': actual = productionAmount({ funders:n('U'),capacity:n('capacity'),currentDrillers:n('current') }); break;
    case 'factory_period': actual = factoryPeriodTicks(); break;
    case 'mine_cost': actual = mineCreationCost(n('team_created'), Boolean(i.pending)); break;
    case 'mine_loss': actual = neptuniumAfterMineLoss(n('np')); break;
    case 'mine_period': actual = minePeriodTicks(n('outposts')); break;
    case 'gift': actual = giftRemaining(n('gift_drillers'),n('total_after'),n('capacity')); break;
    case 'shield_period': actual = shieldPeriodTicks(n('max_charge')); break;
    case 'battle': {
      const result = resolveDrillerPhase({ attackerDrillers:n('A'),defenderDrillers:n('D'),shield:n('S'),isOutpost:Boolean(i.outpost) });
      actual = { A:result.attacker,D:result.defender,S:result.shield,winner:result.winner }; break;
    }
    default: assert.fail(`Unimplemented case ${example.kind}`);
  }
  assert.deepEqual(actual, example.expected);
});

test('current gameplay profile cannot be mutated', () => {
  assert.throws(() => { RULES.GameParams.BaseElectricalOutput = 1; }, TypeError);
});
test('zero shield has no recharge period; invalid numerical states fail explicitly', () => {
  assert.equal(shieldPeriodTicks(0), null);
  assert.throws(() => minePeriodTicks(0), RangeError);
  assert.throws(() => resolveDrillerPhase({attackerDrillers:0,defenderDrillers:0,shield:1,isOutpost:false}), RangeError);
});
test('gift overflow rounds upward, and can remove only the gifted drillers', () => {
  assert.equal(giftRemaining(10,150.1,150),9);
  assert.equal(giftRemaining(10,1000,150),0);
});
test('future nominal output does not assume unknown enemy electrical cap', () => {
  const input = {funders:0,capacity:150,currentDrillers:160};
  assert.equal(productionAmount(input),0);
  assert.equal(productionAmount(input,false),6);
});
test('start speed boundary uses incremented tick; mining does not use effective ticks', () => {
  assert.equal(startSpeedFactor(72),1.5);
  assert.equal(startSpeedFactor(73),1);
  assert.equal(minePeriodTicks(5),28.8);
});
test('toroidal geometry wraps both axes and negative/out-of-range coordinates', () => {
  const size={width:20,height:20};
  assert.equal(torusDistance({x:1,y:1},{x:19,y:19},size),Math.sqrt(8));
  assert.deepEqual(torusDelta({x:-1,y:41},{x:1,y:1},size),{x:2,y:0});
  assert.equal(insideSonar({x:1,y:1},{x:19,y:1},2,size),true);
  assert.equal(insideSonar({x:1,y:1},{x:19,y:1},1.99,size),false);
  assert.throws(() => torusDistance({x:0,y:0},{x:1,y:1},{width:0,height:20}),RangeError);
});
