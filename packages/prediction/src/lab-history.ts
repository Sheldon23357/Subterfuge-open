import {
  replayFleetScenario, projectPlayerView, projectPlayerActivity, projectGlobalActivity,
  fleetPublicIntel, fleetMatchOutcome, fleetOutpostInspector, originalOutpostNames,
  createFleetReplaySession, departureCommitted, type FleetReplay, type FleetScenario,
} from '../../engine/src/index.js';
import type { LabView, MapInitialization, PlayerMapView, PlayerIntelStatistics, PlayerActivityEvent } from '../../contracts/src/index.js';

/** Human-only laboratory replay. Never supply this export to a player AI or
 * the known-observation future predictor. Multiplayer history is queried through the v2 player protocol. */
export interface LabHistoryInput { replay: FleetReplay; map?: MapInitialization }
export type LabHistoryFrame = { global: LabView } | {
  player: PlayerMapView; intel: PlayerIntelStatistics[]; activity: PlayerActivityEvent[];
};
export function replayLabHistory(input: LabHistoryInput, targetTick: number, player: number): LabHistoryFrame {
  const replay = input.replay;
  if (!Number.isInteger(targetTick) || targetTick < replay.initial.economy.initialTick || targetTick > replay.targetTick)
    throw Error('该时刻不在本局已保存的历史范围内。');
  const {targetSeconds,...cut}=replay;
  const commands=replay.commands.filter(c=>c.tick<=targetTick);
  const state = replayFleetScenario({ ...cut, targetTick, commands,
    ...(replay.phaseSettlements?{phaseSettlements:replay.phaseSettlements.filter(p=>p.tick<=targetTick&&p.afterCommand<=commands.length)}:{}),
  }, { trustedLocalStorage: true });
  return projectLabHistory(state, input, player);
}
function projectLabHistory(state: FleetScenario, input: LabHistoryInput, player: number): LabHistoryFrame {
  if (player !== -1) {
    return { player: projectPlayerView(state, player), intel: fleetPublicIntel(state), activity: projectPlayerActivity(state, player) };
  }
  const inspectOutpost = fleetOutpostInspector(state);
  const names = originalOutpostNames(input.map?.seed ?? 0, state.economy.outposts.length);
  return { global: {
    tick: state.economy.tick, size: state.initial.size, realtime: false, secondsSinceLastTick: 0,
    players: state.economy.players, funding: state.economy.funding,
    intel: fleetPublicIntel(state), scheduled: [], orders: [],
    ...(input.map ? { map: input.map } : {}),
    ...(state.initial.match ? { match: { ...state.initial.match, teamSize: state.economy.initial.teamSize, ended: !!fleetMatchOutcome(state) } } : {}),
    outposts: state.economy.outposts.map((o, i) => ({ ...o, name: names?.[i] ?? o.id, position: state.initial.positions[o.id]!, metrics: inspectOutpost(o.id) })),
    fleets: state.fleets.filter(f => f.used).map(f => ({ ...f, canReturn:false,returned:!!f.returned,canCancelLaunch: false, departureCommitted: departureCommitted(f,0,state.economy.tick >= (state.initial.launchCancellationLockTick??0)), departureMinutes: f.secondsUntilLaunch / 60, arrivalMinutes: null })),
    activity: projectGlobalActivity(state),
    events: state.events.slice(-150).reverse().map(e => ({ tick: e.tick, kind: e.kind, subject: e.subject, details: JSON.stringify(e.details) })),
  } };
}

/** Sparse replay checkpoints plus a bounded LRU of completed projections. */
export function createLabHistory(input: LabHistoryInput) {
  const session = createFleetReplaySession(input.replay, { trustedLocalStorage: true });
  const frames = new Map<string, LabHistoryFrame>();
  let key = '', player = -1, target = input.replay.initial.economy.initialTick, cached: LabHistoryFrame | undefined, cacheHits = 0;
  return {
    begin(targetTick: number, seat: number) {
      key = `${seat}:${targetTick}`; player = seat; target = targetTick; cached = frames.get(key);
      if (cached) { frames.delete(key); frames.set(key, cached); cacheHits++; }
      else session.begin(targetTick);
    },
    step: () => !!cached || session.step(),
    progress: () => cached || target === input.replay.initial.economy.initialTick ? 1 : Math.max(0, Math.min(1, (session.stats().workingTick - input.replay.initial.economy.initialTick) / (target - input.replay.initial.economy.initialTick))),
    result() {
      const frame = cached ?? projectLabHistory(session.snapshot(), input, player);
      frames.set(key, frame);
      if (frames.size > 32) frames.delete(frames.keys().next().value!);
      return structuredClone(frame);
    },
    stats: () => ({ ...session.stats(), frames: frames.size, cacheHits }),
  };
}
