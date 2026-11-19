
import {productionCycleDisplay} from '../packages/client/src/production-cycle-display.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {minutes,tickTime,countdown,clockTime,worldMinutes,worldCountdown,worldDailyRate,worldFleetProductionEstimate} from '../packages/client/src/time.js';
import {parseWorldDepartureDays,nextIntegerDepartureDay} from '../packages/client/src/WorldDepartureInput.js';

test('wall clock lobby and chat formatting stays unchanged',()=>{
  assert.equal(minutes(null),'—');
  assert.equal(minutes(-1),'0h 00m');
  assert.equal(minutes(9),'0h 09m');
  assert.equal(minutes(1505),'25h 05m');
  assert.equal(countdown(-1),'0h 00m');
  assert.equal(countdown(1),'0h 01m');
  assert.equal(countdown(61),'0h 02m');
  assert.equal(clockTime(new Date(2026,9,16,9,5).getTime()),'9h 05m');
});
test('world day origin is tick zero and durations are decimal days',()=>{
  assert.equal(tickTime(0),'第0天');
  assert.equal(tickTime(2.25),'第2.25天');
  assert.equal(tickTime(1440),'第1440天');
  assert.equal(worldMinutes(null),'—');
  assert.equal(worldMinutes(10),'1天');
  assert.equal(worldCountdown(300),'0.5天');
  assert.equal(worldCountdown(1),'≈0.001667天');
  assert.equal(worldCountdown(600),'1天');
  assert.equal(worldCountdown(86400),'144天');
});
test('production rates divide the old 144 tick day without hiding small rates',()=>{
  assert.equal(worldDailyRate(144),'1');
  assert.equal(worldDailyRate(1),'0.006944');
  assert.notEqual(worldDailyRate(0.001),'0');
});
test('departure booking accepts only absolute integer days without rounding',()=>{
  assert.equal(parseWorldDepartureDays('3',3,145),3);
  assert.equal(parseWorldDepartureDays('145',3,145),145);
  for(const value of ['2.25','3.25','0.001667','2','146','-1','NaN','Infinity','','2foo']) assert.throws(()=>parseWorldDepartureDays(value,3,145));
  assert.equal(nextIntegerDepartureDay(1.25),2);
  assert.equal(nextIntegerDepartureDay(1),2);
  assert.equal(nextIntegerDepartureDay(1.25,4),4);
  assert.equal(nextIntegerDepartureDay(1.25,4.25),5);
});

test('world game countdown preserves sub-rule-second precision before formatting',()=>{
  assert.equal(worldCountdown(0.5),'≈0.000833天');
  assert.equal(worldCountdown(150),'0.25天');
});

test('fractional theoretical fleet estimates remain visible with integer one-ship numerator',()=>{
  assert.equal(worldFleetProductionEstimate(144),'144舰 / 144天');
  assert.equal(worldFleetProductionEstimate(0),'0舰 / 144天');
  assert.equal(worldFleetProductionEstimate(0.4),'平均每360天1舰（估计）');
  assert.equal(worldFleetProductionEstimate(2.3),'平均每≈62.608696天1舰（估计）');
});

test('production cycles respect the one-batch-per-tick floor and keep next output separate',()=>{
  for(const days of [0,0.5]) {
    const display=productionCycleDisplay(days*10,null);
    assert.equal(display.cycle,'每1天');
    assert.equal(display.batchPrefix,'至多产');
  }
  assert.equal(productionCycleDisplay(0,null).next,'下一tick结算');
  assert.equal(productionCycleDisplay(10,0).next,'下一tick结算');
  assert.equal(productionCycleDisplay(10,5).cycle,'每1天');
  assert.equal(productionCycleDisplay(320,5).cycle,'每32天');
  assert.equal(productionCycleDisplay(320,5).next,'下次产出 0.5天后');
  assert.equal(productionCycleDisplay(15,10).cycle,'当前标称每1.5天');
  assert.equal(productionCycleDisplay(null,null).cycle,'周期未知');
});
