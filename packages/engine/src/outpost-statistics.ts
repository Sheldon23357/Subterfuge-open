import {fleetScenarioTotals,type FleetScenario} from './fleet-scenario.js';
import {factoryPeriodTicks,productionAmount,minePeriodTicks,startSpeedFactor} from './economy.js';
import {RULES} from '../../rules/src/index.js';
import {commandTime} from './command-time.js';
interface InspectionContext {totals:ReturnType<typeof fleetScenarioTotals>}
export function fleetOutpostMetrics(s: FleetScenario, id: string, prepared?: InspectionContext) {
  const stored = s.economy.outposts.find((o) => o.id === id)!;
  const currentType=commandTime.outpostType({private_type:stored.type==='mine'?0:stored.type==='factory'?1:2,
    private_secsUntilMineCreation:stored.minePending?(stored.mineSeconds??600):0},s.secondsSinceLastTick??0);
  const o={...stored,type:currentType===0?'mine':currentType===1?'factory':'generator'};
  const totals = prepared?.totals ?? fleetScenarioTotals(s),
    t = o.owner === null ? null : totals[o.owner]!;
  const active =
    !o.destroyed && !!t && (o.type !== "mine" || s.economy.players[o.owner!]!.active);
  const period =
    o.destroyed ? null : o.type === "factory"
      ? factoryPeriodTicks()
      : o.type === "mine" && t
        ? minePeriodTicks(t.outposts)
        : null;
  const nominal =
    o.destroyed ? 0 : o.type === "factory"
      ? t?productionAmount({currentDrillers:0,capacity:Number.MAX_SAFE_INTEGER,funders:t.funders}):0
      : o.type === "mine"
        ? 1
        : 0;
  const paused =
    !active || (o.type === "factory" && t!.drillers >= t!.capacity);
  let next: number | null = null;
  if (period && !paused) {
    let progress =
      o.type === "factory" ? o.productionProgress : o.miningProgress;
    for (
      let tick = s.economy.tick + 1;
      tick <= s.economy.tick + 10000;
      tick++
    ) {
      progress += o.type === "factory" ? startSpeedFactor(tick) : 1;
      if (progress >= period) {
        next = (tick - s.economy.tick) * 10;
        break;
      }
    }
  }
  return {
    active,
    paused,
    output: nominal,
    cycleMinutes:
      period === null
        ? null
        : (period * 10) /
          (o.type === "factory" ? startSpeedFactor(s.economy.tick + 1) : 1),
    nextMinutes: next === null ? null : Math.max(0, next - (s.secondsSinceLastTick ?? 0) / 60),
    progress:
      period === null || period === 0
        ? 0
        : Math.min(
            1,
            (o.type === "factory" ? o.productionProgress : o.miningProgress) /
              period,
          ),
    capacity: t?.capacity ?? null,
    used: t?.drillers ?? null,
    contribution:
      !o.destroyed && o.type === "generator"
        ? RULES.OutpostParams.GeneratorElectricalOutput
        : 0,
    neptunium: o.owner === null ? null : s.economy.players[o.owner]!.neptunium,
    mines:
      o.owner === null
        ? 0
        : s.economy.outposts.filter(
            (p) => p.owner === o.owner && !p.destroyed && p.type === "mine",
          ).length,
  };
}

export function fleetOutpostInspector(s:FleetScenario){const context:InspectionContext={totals:fleetScenarioTotals(s)};return(id:string)=>fleetOutpostMetrics(s,id,context);}
