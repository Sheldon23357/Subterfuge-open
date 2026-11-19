import {
  fleetScenarioTotals,
  canReturnFleet,
  canCancelFleetLaunch,
  departureCommitted,
  type Fleet,
  productionAmount,
  factoryPeriodTicks,
  minePeriodTicks,
  startSpeedFactor,
  type FleetScenario,
} from "../../engine/src/index.js";
import { RULES } from "../../rules/src/index.js";
import {basicRouteTicks} from '../../prediction/src/index.js';
export {fleetOutpostMetrics as outpostMetrics} from '../../engine/src/index.js';
/** Kinematic estimate only: basic fleet, no combat or future target movement. */
export function routeEstimate(
  s: FleetScenario,
  input: { source: string; point: { x: number; y: number }; issueTick: number },
) {
  const origin = s.initial.positions[input.source];
  if (
    !origin ||
    !Number.isInteger(input.issueTick) ||
    input.issueTick < s.economy.tick ||
    input.issueTick > s.economy.tick + 1440
  )
    throw Error("无效航线起点或时间");
  if (
    !input.point ||
    !Number.isFinite(input.point.x) ||
    !Number.isFinite(input.point.y)
  )
    throw Error("无效航线坐标");
  const offset=basicRouteTicks(origin,input.point,s.initial.size,input.issueTick,1440);
  return {arrivalTick:offset===null?null:input.issueTick+offset,minutes:offset===null?null:offset*10};
}

/** Mirror navigation/cancellation prerequisites without offering impossible commands. */
export function fleetControls(s: FleetScenario, f: Fleet) {
  const phase=s.secondsSinceLastTick??0,
    deadlineLock=s.economy.tick>=(s.initial.launchCancellationLockTick??0);
  return {
    canReturn:canReturnFleet(f),
    returned:!!f.returned,
    departureCommitted: departureCommitted(f,phase,deadlineLock),
    canCancelLaunch:
      canCancelFleetLaunch(f,phase,deadlineLock),
  };
}
