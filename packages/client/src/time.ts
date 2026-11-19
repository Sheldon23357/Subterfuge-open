export const minutes = (v: number | null) =>
  v === null
    ? "—"
    : `${Math.floor(Math.max(0, v) / 60)}h ${String(Math.floor(Math.max(0, v) % 60)).padStart(2, "0")}m`;

export const countdown = (seconds: number) =>
  minutes(Math.ceil(Math.max(0, seconds) / 60));

export const clockTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return minutes(date.getHours() * 60 + date.getMinutes());
};

// Game time is deliberately separate from wall-clock lobby/chat time above.
export { formatWorldTimestampFromTick as tickTime } from '../../contracts/src/index.js';
import {
  formatWorldDurationFromRuleSeconds,
  formatWorldDurationFromRuleMinutes,
  legacyDailyRateToWorldDailyRate,
  formatWorldDays,
} from '../../contracts/src/index.js';
export const worldMinutes = formatWorldDurationFromRuleMinutes;
export const worldCountdown = formatWorldDurationFromRuleSeconds;
export const arrivalWorldDays = (ruleMinutes: number | null) =>
  ruleMinutes === null || !Number.isFinite(ruleMinutes)
    ? '—'
    : `${(Math.max(0, ruleMinutes) / 10).toFixed(1)}天`;
/** Keep small positive production rates visible rather than rounding to zero. */
export const worldDailyRate = (legacyRate: number) => {
  const rate = legacyDailyRateToWorldDailyRate(legacyRate);
  return Number.isFinite(rate) ? Number(rate.toPrecision(4)).toString() : '—';
};

/** Preserve public estimates without rounding a fractional ship to zero or inventing batches. */
export function worldFleetProductionEstimate(legacyRate:number):string {
  if(!Number.isFinite(legacyRate)||legacyRate<0)return '—';
  if(Number.isInteger(legacyRate))return `${legacyRate}舰 / 144天`;
  return `平均每${formatWorldDays(144/legacyRate)}1舰（估计）`;
}
