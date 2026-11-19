import {
  advanceLabBranch,
  type LabPredictionRoom,
} from "./lab-branch.js";
import {
  originalOutpostNames,
  projectGlobalDiplomacy,
  fleetDiplomacyWorld,
  fleetPublicIntel,
  projectGlobalActivity,
  fleetOutpostInspector,
  restoreGlobalPredictionActivity,
  fleetMatchOutcome,
  canCancelFleetLaunch,
  canReturnFleet,
  departureCommitted,
  type Fleet,
  type FleetScenario,
} from "../../engine/src/index.js";
import { retainPredictionCheckpoint } from "./prediction-checkpoints.js";
import type { LabView } from "../../contracts/src/index.js";
export function labRuleView(s: FleetScenario, secondsSinceLastTick = s.secondsSinceLastTick ?? 0) {
  return {
    diplomacy:projectGlobalDiplomacy(s.diplomacy,fleetDiplomacyWorld(s)),
    ...(s.initial.match
      ? {
          match: {
            ...s.initial.match,
            teamSize: s.economy.initial.teamSize,
            ended: fleetMatchOutcome(s) !== null,
          },
        }
      : {}),
  };
}

export function fleetControls(s: FleetScenario, f: Fleet) {
  const phase=s.secondsSinceLastTick??0,
    deadlineLock=s.economy.tick>=(s.initial.launchCancellationLockTick??0);
  return {
    canReturn:canReturnFleet(f),returned:!!f.returned,
    departureCommitted: departureCommitted(f,phase,deadlineLock),
    canCancelLaunch:
      canCancelFleetLaunch(f,phase,deadlineLock),
  };
}

/** Reuses bounded private checkpoints; every advance/projection yields so a
 * superseded scrub request can stop before simulating the rest of its horizon. */
export function createLabPrediction(initial: LabPredictionRoom, activity?: LabView["activity"]) {
  // Host JSON cannot carry the engine's WeakMap journals. Restore them once
  // before advancing so existing activity survives future branch clones.
  if (activity !== undefined) {
    // Never install a global-only activity journal on the caller's authoritative
    // state: a later player projection must retain/rebuild its own archive.
    initial = { ...initial, state: structuredClone(initial.state) };
    restoreGlobalPredictionActivity(initial.state, activity);
  }
  else projectGlobalActivity(initial.state);
  let working = initial;
  const checkpoints = new Map<number, LabPredictionRoom>();
  function begin(target: number) {
    if (
      !Number.isInteger(target) ||
      target < initial.state.economy.tick ||
      target - initial.state.economy.tick > 1440
    )
      throw Error("Invalid forecast horizon");
    working = initial;
    for (const [tick, frame] of checkpoints)
      if (tick <= target && tick > working.state.economy.tick) working = frame;
  }
  function step(target: number) {
    working = advanceLabBranch(
      working,
      Math.min(target, working.state.economy.tick + 8),
      true,
    );
    retainPredictionCheckpoint(checkpoints, working.state.economy.tick, working);
    return (
      working.state.economy.tick >= target ||
      fleetMatchOutcome(working.state) !== null
    );
  }
  function* result(): Generator<void, LabView> {
    const room = working,
      source = room.state,
      plans = room.scheduled,
      genericPlans = room.scheduledOrders ?? [];

    const names = originalOutpostNames(
      room.map?.seed ?? 0,
      source.economy.outposts.length,
    );
    const phase = 0, inspect = fleetOutpostInspector(source);
    return {
      realtime: false,
      activity: projectGlobalActivity(source),
      secondsSinceLastTick: phase,
      ...labRuleView(source,phase),
      orders: [...plans, ...(genericPlans ?? [])].map((p) => ({
        id: p.id,
        player: p.player,
        issueTick: p.issueTick,
        status: p.status,
        action: { ...p.action },
        ...(p.failed ? { failed: true } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
      })),
      ...(room.map ? { map: room.map } : {}),
      ...(room.scenario ? { scenario: room.scenario } : {}),
      scheduled: plans,
      tick: source.economy.tick,
      size: source.initial.size,
      players: source.economy.players,
      intel: fleetPublicIntel(source),
      funding: source.economy.funding,
      outposts: source.economy.outposts.map((o, index) => ({
        ...o,
        name: names?.[index] ?? o.id,
        metrics: inspect(o.id),
        position: source.initial.positions[o.id]!,
      })),
      fleets: source.fleets
        .filter((f) => f.used)
        .map((f) => ({
          ...f,
          departureMinutes: f.state==='waiting'?Math.max(0,(f.secondsUntilLaunch-phase)/60):0,
          arrivalMinutes:null,
          ...fleetControls(source, f),
        })),
      events: [
        ...source.events.map((e) => ({
          tick: e.tick,
          kind: e.kind,
          subject: e.subject,
          details: JSON.stringify(e.details),
        })),
      ]
        .sort((a, b) => b.tick - a.tick)
        .slice(0, 150),
    };
  }
  return { begin, step, result };
}
