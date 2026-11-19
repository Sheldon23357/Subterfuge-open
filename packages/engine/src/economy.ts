import { RULES, TICKS_PER_DAY, shieldChargePeriod } from '../../rules/src/index.js';
import { integer, nonnegative } from './numeric.js';

export interface ProductionInput {
  funders: number;
  capacity: number; currentDrillers: number;
}
/** Ordinary production, including existing funding and capacity rules. */
export function productionAmount(input: ProductionInput, capKnown = true): number {
  for (const key of ['funders','currentDrillers'] as const) integer(input[key], key);
  nonnegative(input.capacity, 'capacity');
  const { GameParams: g, OutpostParams: o } = RULES;
  const nominal = o.DrillersPerProduction + g.FundingDrillerProductionBonus * input.funders;
  return capKnown ? Math.min(nominal, Math.max(0, input.capacity - input.currentDrillers)) : nominal;
}

export function factoryPeriodTicks(): number {
  return Math.trunc(RULES.OutpostParams.MinutesBetweenDrillerProductions / 10);
}
export function minePeriodTicks(outposts: number): number {
  integer(outposts, 'outposts');
  if (outposts === 0) throw new RangeError('A producing mine requires at least one owned outpost');
  return TICKS_PER_DAY / outposts;
}
/** Cost only; economic-scenario applies pending-order validation and payment. */
export function mineCreationCost(teamCreated: number, teamHasPending: boolean): number {
  integer(teamCreated, 'teamCreated');
  const n = teamCreated + Number(teamHasPending);
  return RULES.OutpostParams.BaseMineCreationCostInDrillers * (n === 0 ? 1 : 2 * n);
}
export function neptuniumAfterMineLoss(amount: number): number {
  integer(amount, 'neptunium');
  return Math.round(amount * (1 - RULES.GameParams.NeptuniumPercentLostWithMine));
}
export function giftRemaining(drillers: number, totalAfter: number, capacity: number): number {
  integer(drillers, 'drillers'); nonnegative(totalAfter, 'totalAfter'); nonnegative(capacity, 'capacity');
  return drillers - Math.min(drillers, Math.max(0, Math.ceil(totalAfter - capacity)));
}
export function shieldPeriodTicks(maxCharge: number): number | null {
  integer(maxCharge, 'maxCharge');
  return shieldChargePeriod(maxCharge);
}
/** Caller supplies the already incremented world tick, matching ut.updateTick. */
export function startSpeedFactor(worldTick: number): number {
  integer(worldTick, 'worldTick');
  return worldTick > RULES.GameParams.GameStartSpeedupTicks ? 1 : RULES.GameParams.GameStartSpeedupFactor;
}
