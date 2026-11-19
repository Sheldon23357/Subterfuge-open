/** Presentation-only world time. Never use these constants to advance the engine.
 * Protocol *Seconds fields remain internal rule seconds; one tick is 600 rule
 * seconds and is displayed as one world day. UTC/wall milliseconds are unrelated.
 */
export const RULE_SECONDS_PER_WORLD_DAY = 600;
export const WORLD_SECONDS_PER_DAY = 86_400;
export const WORLD_SECONDS_PER_RULE_SECOND = 144;
export const LEGACY_RULE_DAYS_PER_WORLD_DAY = 1 / 144;
export const WORLD_DAY_ORIGIN: 0 | 1 = 0;
export interface WorldTimeFormatOptions {
  dayOrigin?: 0 | 1;
  precision?: 'second' | 'minute';
  style?: 'composite' | 'decimal';
}
export const ruleSecondsToWorldDays = (seconds: number): number => seconds / RULE_SECONDS_PER_WORLD_DAY;
export const ruleMinutesToWorldDays = (minutes: number): number => minutes / 10;
export const legacyDailyRateToWorldDailyRate = (rate: number): number => rate / 144;
export const ruleMinutesRateToWorldDailyRate = (rate: number): number => rate * 10;
/** Reject unrepresentable input rather than silently moving an order boundary. */
export function worldDaysToRuleSeconds(days: number): number {
  const seconds = days * RULE_SECONDS_PER_WORLD_DAY;
  const rounded = Math.round(seconds);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(rounded) || Math.abs(seconds - rounded) > 1e-8) throw new RangeError('世界天数必须可精确表示为整数规则秒（步长为1/600天）');
  return rounded;
}
export const worldHoursToRuleSeconds = (hours: number): number => worldDaysToRuleSeconds(hours / 24);
export const worldMinutesToRuleSeconds = (minutes: number): number => worldDaysToRuleSeconds(minutes / 1440);
/** Six fractional digits distinguish every representable integer-rule-second input.
 * A leading approximation mark prevents rounded display values being mistaken
 * for exact order times; input validation always uses the original value.
 */
export function formatWorldDays(days: number): string {
  if (!Number.isFinite(days)) return '—';
  if (days > 0 && days < 0.0000005) return '<0.000001天';
  if (days < 0 && days > -0.0000005) return '>−0.000001天';
  const rounded = Number(days.toFixed(6));
  const approximate = Math.abs(rounded - days) > 1e-10;
  return `${approximate ? '≈' : ''}${rounded}天`;
}
export function formatWorldDurationFromRuleSeconds(seconds: number | null, _options: WorldTimeFormatOptions = {}): string {
  return seconds === null ? '—' : formatWorldDays(seconds / RULE_SECONDS_PER_WORLD_DAY);
}
export const formatWorldDurationFromRuleMinutes = (minutes: number | null, options: WorldTimeFormatOptions = {}): string => formatWorldDurationFromRuleSeconds(minutes === null ? null : minutes * 60, options);
export function formatWorldTimestampFromRuleSeconds(seconds: number, options: WorldTimeFormatOptions = {}): string {
  if (!Number.isFinite(seconds)) return '—';
  const formatted = formatWorldDays(seconds / RULE_SECONDS_PER_WORLD_DAY + (options.dayOrigin ?? WORLD_DAY_ORIGIN));
  return formatted.startsWith('≈') ? `≈第${formatted.slice(1)}` : `第${formatted}`;
}
export const formatWorldTimestampFromTick = (tick: number, options: WorldTimeFormatOptions = {}): string => formatWorldTimestampFromRuleSeconds(tick * 600, options);

/** Exact captured observation clock in rule seconds; unrelated to wall time. */
export function observationRuleSeconds(observation:{view:{tick:number};secondsSinceLastTick:number}):number {
  return observation.view.tick * RULE_SECONDS_PER_WORLD_DAY + observation.secondsSinceLastTick;
}
