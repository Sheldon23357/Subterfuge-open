import test from 'node:test';
import assert from 'node:assert/strict';
import {formatWorldDays,formatWorldDurationFromRuleSeconds,formatWorldDurationFromRuleMinutes,formatWorldTimestampFromTick,formatWorldTimestampFromRuleSeconds,worldDaysToRuleSeconds,ruleSecondsToWorldDays,legacyDailyRateToWorldDailyRate} from '../packages/contracts/src/index.js';

test('world days follow tick zero without changing rule seconds',()=>{
  assert.equal(formatWorldTimestampFromTick(0),'第0天');
  assert.equal(formatWorldTimestampFromTick(144),'第144天');
  assert.equal(formatWorldTimestampFromTick(1440),'第1440天');
  assert.equal(formatWorldTimestampFromRuleSeconds(1350),'第2.25天');
  assert.equal(formatWorldDurationFromRuleSeconds(1350),'2.25天');
  assert.equal(formatWorldDurationFromRuleSeconds(300),'0.5天');
  assert.equal(formatWorldDurationFromRuleMinutes(10),'1天');
  assert.equal(formatWorldDurationFromRuleSeconds(0),'0天');
  assert.equal(formatWorldDurationFromRuleSeconds(null),'—');
  assert.equal(formatWorldDurationFromRuleSeconds(-150),'-0.25天');
  assert.equal(formatWorldDays(Infinity),'—');
  assert.equal(formatWorldDays(1e-9),'<0.000001天');
});
test('world decimal display discloses inexact values and does not round input into orders',()=>{
  assert.equal(formatWorldDurationFromRuleSeconds(1),'≈0.001667天');
  assert.equal(formatWorldDurationFromRuleSeconds(599),'≈0.998333天');
  assert.equal(formatWorldDurationFromRuleSeconds(601),'≈1.001667天');
  assert.equal(worldDaysToRuleSeconds(2.25),1350);
  assert.equal(worldDaysToRuleSeconds(1/600),1);
  assert.throws(()=>worldDaysToRuleSeconds(0.001667),RangeError);
  assert.throws(()=>worldDaysToRuleSeconds(NaN),RangeError);
  assert.throws(()=>worldDaysToRuleSeconds(Infinity),RangeError);
  for(let seconds=0;seconds<=86400;seconds++) assert.equal(worldDaysToRuleSeconds(ruleSecondsToWorldDays(seconds)),seconds);
});
test('world daily rates use one original tick and retain small nonzero rates',()=>{
  assert.equal(legacyDailyRateToWorldDailyRate(144),1);
  assert.equal(legacyDailyRateToWorldDailyRate(1),1/144);
  assert.equal(legacyDailyRateToWorldDailyRate(0),0);
  assert.equal(legacyDailyRateToWorldDailyRate(288),2);
});
