import test from 'node:test';
import assert from 'node:assert/strict';
import {ruleNotificationWorldTime} from '../packages/contracts/src/index.js';

test('rule notification world days distinguish movement intervals from current tick phases',()=>{
  for(const kind of ['departed','battle','mine-captured','dormant-arrival']){
    for(const fraction of [0,.25,1]){
      const input={kind,tick:108,seconds:fraction*600},before=structuredClone(input);
      assert.deepEqual(ruleNotificationWorldTime(input),{eventWorldDay:107+fraction,eventTimeBasis:'settlement-tick-interval',eventTimePrecision:'rounded-rule-second'});
      assert.deepEqual(input,before);
    }
  }
  assert.equal(ruleNotificationWorldTime({kind:'battle',tick:108,seconds:270}).eventWorldDay,107.45);
  for(const kind of ['funding-toggled','player-resigned']){
    assert.deepEqual(ruleNotificationWorldTime({kind,tick:108,seconds:150}),{eventWorldDay:108.25,eventTimeBasis:'tick-phase',eventTimePrecision:'rounded-rule-second'});
  }
  for(const kind of ['mine-created','funding-expired','inactivity-warning','player-eliminated','game-ended']){
    assert.equal(ruleNotificationWorldTime({kind,tick:108,seconds:0}).eventWorldDay,108);
  }
  assert.equal(ruleNotificationWorldTime({kind:'mine-created',tick:0,seconds:0}).eventWorldDay,0);
});

test('unknown notification kinds and invalid or missing phases never fabricate a world day',()=>{
  for(const input of [
    {},{kind:'unknown-old-kind',tick:108,seconds:270},{kind:'battle',tick:0,seconds:150},
    {kind:'battle',tick:108},{kind:'battle',tick:108,seconds:null},
    {kind:'battle',tick:108,seconds:601},{kind:'battle',tick:108,seconds:-1},
    {kind:'battle',tick:108,seconds:NaN},{kind:'battle',tick:Infinity,seconds:0},
    {kind:'battle',tick:108.5,seconds:0},{kind:'battle',tick:108,seconds:.25},
    {kind:'mine-created',tick:108,seconds:600},
  ])assert.deepEqual(ruleNotificationWorldTime(input),{eventWorldDay:null,eventTimeBasis:'unknown',eventTimePrecision:'unknown'});
});
