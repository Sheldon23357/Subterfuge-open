import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,neptuniumAfterMineLoss,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {mineInvestmentValue} from '../packages/ai/src/controller/analysis/mine-value.js';
import {attackScreeningConfig} from '../packages/ai/src/controller/analysis/attack-screening-config.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  const o:PlayerObservation=observation({state:createFleetScenario(cfg),scheduled:[]},0,'mine-value');
  return {o,target:o.view.outposts.find(p=>p.type==='mine')!,c:attackScreeningConfig()};
}
test('existing mine values replacement cost, public income and rounded loss under the shared rule',()=>{
  const {o,target,c}=fixture(),before=JSON.stringify(o);
  const result=mineInvestmentValue(o,target,12,c)!;
  const owner=o.intel.find(p=>p.player===target.owner)!;
  assert.equal(result.replacementCost,o.view.self.mineCreationCost);
  assert.equal(result.remainingTicks,132);
  assert.equal(result.ownMineIncomePerDay,o.view.self.outpostCount+1);
  assert.equal(result.estimatedEnemyBalanceLoss,owner.neptunium-neptuniumAfterMineLoss(owner.neptunium));
  assert.equal(result.enemyIncomePerDay,owner.npPerDay-(owner.outposts.mine-1)*(owner.numOutposts-1));
  assert.ok(result.total>0);assert.equal(JSON.stringify(o),before);
});
test('higher replacement cost and larger own territory increase bounded mine value',()=>{
  const {o,target,c}=fixture();
  const base=mineInvestmentValue(o,target,12,c)!;
  o.view.self.mineCreationCost*=2;
  const costly=mineInvestmentValue(o,target,12,c)!;
  assert.ok(costly.replacement>base.replacement);assert.equal(costly.income,base.income);
  o.view.self.outpostCount+=4;
  assert.ok(mineInvestmentValue(o,target,12,c)!.income>costly.income);
  o.view.self.mineCreationCost=1000000;o.view.self.outpostCount=1000000;
  const capped=mineInvestmentValue(o,target,12,c)!;
  assert.ok(capped.replacement<=c.mineValue.replacementCap);assert.equal(capped.income,c.mineValue.incomeCap);
});
test('rich enemy and lost production raise denial value without inventing future balances',()=>{
  const {o,target,c}=fixture(),owner=o.intel.find(p=>p.player===target.owner)!;
  owner.neptunium=0;
  const poor=mineInvestmentValue(o,target,12,c)!;
  owner.neptunium=40;
  const rich=mineInvestmentValue(o,target,12,c)!;
  assert.ok(rich.denial>poor.denial);
  assert.equal(rich.enemyBalance,40);assert.equal(rich.estimatedEnemyBalanceLoss,8);
  owner.neptunium=1000000;
  assert.equal(mineInvestmentValue(o,target,12,c)!.denial,c.mineValue.denialCap);
});
test('travel reduces the same present-time benefit window; beyond it investment bonuses vanish',()=>{
  const {o,target,c}=fixture();
  const near=mineInvestmentValue(o,target,12,c)!,far=mineInvestmentValue(o,target,108,c)!;
  assert.ok(near.replacement>far.replacement);assert.ok(near.income>far.income);assert.ok(near.denial>far.denial);
  const late=mineInvestmentValue(o,target,c.mineValue.incomeHorizonTicks+1,c)!;
  assert.equal(late.remainingTicks,0);assert.equal(late.total,0);
});
test('non-mines, pending construction and domination do not receive existing-mine investment bonuses',()=>{
  const {o,target,c}=fixture();
  for(const type of ['factory','generator',undefined])assert.equal(mineInvestmentValue(o,{...target,type} as typeof target,12,c),null);
  assert.equal(mineInvestmentValue(o,{...target,minePending:true},12,c),null);
  o.view.match!.mode='domination';assert.equal(mineInvestmentValue(o,target,12,c),null);
});
test('unknown or neutral owners do not fabricate enemy losses; local hidden clocks cannot change value',()=>{
  const {o,target,c}=fixture();
  const baseline=mineInvestmentValue(o,target,12,c);
  const hidden={...target,metrics:{...target.metrics!,nextMinutes:999,progress:.9}};
  assert.deepEqual(mineInvestmentValue(o,hidden,12,c),baseline);
  o.intel=o.intel.filter(p=>p.player!==target.owner);
  const unknown=mineInvestmentValue(o,target,12,c)!;
  assert.equal(unknown.enemyBalance,null);assert.equal(unknown.estimatedEnemyBalanceLoss,null);assert.equal(unknown.denial,0);
  const neutral=mineInvestmentValue(o,{...target,owner:null},12,c)!;
  assert.equal(neutral.denial,0);assert.ok(neutral.income>0);
});
test('mine valuation horizon is strictly bounded and fractional horizons are rejected',()=>{
  for(const incomeHorizonTicks of [0,.5,1441])assert.throws(()=>attackScreeningConfig({mineValue:{incomeHorizonTicks}}));
  assert.equal(attackScreeningConfig({mineValue:{incomeHorizonTicks:72}}).mineValue.incomeHorizonTicks,72);
});
