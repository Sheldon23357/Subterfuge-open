import test from 'node:test';
import assert from 'node:assert/strict';
import {shieldRecoveryDisplay} from '../packages/client/src/shield-recovery-display.js';
import {RULES} from '../packages/rules/src/index.js';
const visible={shield:1,shieldMax:30,shieldsEnabled:true,owner:0};
test('normal visible shield capacity yields integer one-shield cycle, not fractional shield',()=>{
  const display=shieldRecoveryDisplay(visible,100);
  assert.equal(display.summary,'正常每9天恢复1盾');
  assert.match(display.detail,/不是下次恢复时间/);
  assert.match(display.detail,/战斗或护盾开关变化/);
});
test('accelerated rhythm is average only and crosses the speed boundary on next tick',()=>{
  const before=shieldRecoveryDisplay(visible,RULES.GameParams.GameStartSpeedupTicks-1);
  assert.equal(before.summary,'当前平均每6天恢复1盾');
  assert.match(before.detail,/间隔可能交替/);
  assert.equal(shieldRecoveryDisplay(visible,RULES.GameParams.GameStartSpeedupTicks).summary,'正常每9天恢复1盾');
  assert.equal(shieldRecoveryDisplay(visible,RULES.GameParams.GameStartSpeedupTicks+1).summary,'正常每9天恢复1盾');
});
test('zero capacity, zero period, full disabled and neutral states never promise an unavailable recharge',()=>{
  assert.equal(shieldRecoveryDisplay({...visible,shieldMax:0},0).summary,'无护盾容量');
  assert.equal(shieldRecoveryDisplay({...visible,shieldMax:500},0).summary,'每1天最多恢复1盾');
  assert.equal(shieldRecoveryDisplay({...visible,shield:30},0).summary,'护盾已满');
  assert.equal(shieldRecoveryDisplay({...visible,shieldsEnabled:false},0).summary,'护盾已关闭');
  assert.equal(shieldRecoveryDisplay({...visible,owner:null},0).summary,'中立据点不恢复');
  assert.equal(shieldRecoveryDisplay({...visible,shieldMax:NaN},0).summary,'恢复节奏未知');
});
