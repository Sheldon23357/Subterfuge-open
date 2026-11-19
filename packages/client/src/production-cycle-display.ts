import {formatWorldDays,formatWorldDurationFromRuleMinutes} from '../../contracts/src/index.js';
/** Economic settlement emits at most one batch per tick, even for a zero period. */
export function productionCycleDisplay(cycleMinutes:number|null,nextMinutes:number|null) {
  const raw=cycleMinutes===null?null:cycleMinutes/10;
  const known=raw!==null&&Number.isFinite(raw)&&raw>=0;
  const cycle=known?Math.max(1,raw):null;
  return {
    cycle:cycle===null?'周期未知':`${known&&raw>=1&&!Number.isInteger(raw)?'当前标称':''}每${formatWorldDays(cycle)}`,
    batchPrefix:known&&raw<1?'至多产':'产',
    next:nextMinutes!==null&&Number.isFinite(nextMinutes)
      ?nextMinutes<=0?'下一tick结算':`下次产出 ${formatWorldDurationFromRuleMinutes(nextMinutes)}后`
      :raw===0?'下一tick结算':'下次产出时间未知',
    detail:'逐tick离散结算，每天最多一批。非整数周期为当前标称节奏；下次产出单独计算，暂停、加速结束或设施变化可能改变结果。',
  };
}
