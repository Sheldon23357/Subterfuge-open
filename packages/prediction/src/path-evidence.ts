import type { PlayerObservation, PlayerForecastResult } from '../../contracts/src/index.js';
import type { FleetScenario } from '../../engine/src/index.js';

export type KnownPredicateTruth = 'true' | 'false' | 'unknown';
export interface KnownPathPredicate {
  id: string;
  kind: 'controlsThroughout' | 'controlledAtHorizon' | 'capturedWithin' | 'noMineLoss' | 'minimumDrillersAtHorizon';
  outpostId: string;
  minimumDrillers?: number;
}
export interface KnownPathEvent {
  tick: number; fraction: number; sequence: number; kind: string; subject: string;
  details: Record<string, string | number | boolean | null>;
}
export interface KnownPathPredicateResult {
  id: string; kind: KnownPathPredicate['kind']; outpostId: string; truth: KnownPredicateTruth;
  reason: string; earliestCounterexample: KnownPathEvent | null;
}
export interface KnownPathEvidence {
  format: 'known-path-evidence/1'; roomId: string; player: number; basisRevision: string; profile: string;
  observedTick: number; observedSeconds: number; requestedTargetTick: number; actualTargetTick: number;
  conditional: true; coverage: { complete: boolean; stoppedAtTerminal: boolean; unknownReasons: string[] };
  assumptions: string[]; events: KnownPathEvent[]; predicates: KnownPathPredicateResult[];
  orderFleets: { orderId: string; fleetId: string; issueTick: number; status: string }[];
  mineLosses: { count: number; totalDeduction: number; events: KnownPathEvent[] };
}

export function validateKnownPathPredicates(predicates: readonly KnownPathPredicate[]) {
  const kinds = new Set(['controlsThroughout', 'controlledAtHorizon', 'capturedWithin', 'noMineLoss', 'minimumDrillersAtHorizon']);
  if (!Array.isArray(predicates) || predicates.length > 32) throw Error('Invalid path predicates');
  const ids = new Set<string>();
  for (const p of predicates) {
    if (!p || typeof p.id !== 'string' || !p.id.trim() || p.id.length > 128 || ids.has(p.id) ||
      !kinds.has(p.kind) || typeof p.outpostId !== 'string' || !p.outpostId || p.outpostId.length > 128 ||
      Object.keys(p).some(k => !['id', 'kind', 'outpostId', 'minimumDrillers'].includes(k)) ||
      (p.kind === 'minimumDrillersAtHorizon' ? !Number.isSafeInteger(p.minimumDrillers) || p.minimumDrillers! < 0 : p.minimumDrillers !== undefined))
      throw Error('Invalid path predicate');
    ids.add(p.id);
  }
}

/** Internal projection, called only with createSession's observation-built world.
 * This is deliberately not exported by the package: no retained server world is accepted.
 * Every event is allowlisted before any predicate or resource reduction sees it. */
export function projectKnownPathEvidence(
  observation: PlayerObservation, state: FleetScenario, frame: PlayerForecastResult,
  predicates: readonly KnownPathPredicate[], plannedFleetIds: readonly string[], requestedTargetTick: number,
  orderFleets: KnownPathEvidence['orderFleets'] = [], trajectoryUnknown = false,
): KnownPathEvidence {
  const view = observation.view, player = view.player;
  if (state.forecastPlayer !== player || state.profile !== view.profile) throw Error('Path perspective mismatch');
  const knownOutposts = new Set(view.outposts.filter(o => o.visibility === 2).map(o => o.id));
  const knownFleets = new Set([...view.fleets.map(f => f.id), ...plannedFleetIds]);
  const publicOutposts = new Set(view.outposts.map(o => o.id));
  const events: KnownPathEvent[] = [];
  const pick = (details: KnownPathEvent['details'], keys: string[]) => Object.fromEntries(keys.filter(k => details[k] !== undefined).map(k => [k, details[k]! ]));
  for (const event of state.events) {
    let details: KnownPathEvent['details'] | null = null;
    switch (event.kind) {
      case 'battle':
        if (knownFleets.has(event.subject) && (knownOutposts.has(String(event.details.target)) || knownFleets.has(String(event.details.target))))
          details = pick(event.details, ['target', 'attackerOwner', 'defenderOwner', 'attackerBefore', 'defenderBefore', 'shieldBefore', 'winner', 'attacker', 'defender', 'shield']);
        break;
      case 'outpost-captured':
        if (knownOutposts.has(event.subject)) details = pick(event.details, ['before', 'owner']);
        break;
      case 'outpost-destroyed':
        if (knownOutposts.has(event.subject)) details = pick(event.details, ['owner']);
        break;
      case 'mine-loss':
        // Opponents' reconstructed inventories are NOT public economic evidence.
        if (knownOutposts.has(event.subject) && event.details.owner === player) details = pick(event.details, ['owner', 'before', 'after']);
        break;
      case 'unloaded':
        if (knownFleets.has(event.subject) && knownOutposts.has(String(event.details.outpost))) details = pick(event.details, ['outpost', 'drillers']);
        break;
      case 'departed':
        if (knownFleets.has(event.subject)) {
          details = pick(event.details, ['drillers']);
          if (knownOutposts.has(String(event.details.source)) &&
            (publicOutposts.has(String(event.details.destination)) || knownFleets.has(String(event.details.destination))))
            Object.assign(details, pick(event.details, ['source', 'destination']));
        }
        break;
      case 'launch-ordered':
        if (knownFleets.has(event.subject) && knownOutposts.has(String(event.details.source)) &&
          (publicOutposts.has(String(event.details.destination)) || knownFleets.has(String(event.details.destination))))
          details = pick(event.details, ['source', 'destination', 'drillers']);
        break;
      case 'player-eliminated':
        if (event.details.owner === player) details = pick(event.details, ['owner', 'reason']);
        break;
      case 'mine-created':
        if (knownOutposts.has(event.subject)) details = pick(event.details, ['owner']);
        break;
      case 'future-unknown-arrival':
        if (knownFleets.has(event.subject) && publicOutposts.has(String(event.details.outpost))) details = pick(event.details, ['outpost', 'owner']);
        break;
    }
    if (details) events.push({ tick: event.tick, fraction: event.fraction, sequence: event.sequence, kind: event.kind, subject: event.subject, details });
  }
  const crossing = frame.terminalPrediction?.firstCrossing;
  if (crossing) events.push({ tick: crossing.tick, fraction: 1, sequence: state.events.length, kind: 'terminal-crossing', subject: 'match',
    details: { triggeringSeat: crossing.triggeringSeat, triggeringTeam: crossing.triggeringTeam, status: frame.terminalPrediction!.status } });
  const unknownReasons = [
    ...(frame.targetTick < requestedTargetTick ? ['requested-horizon-not-covered'] : []),
    ...(state.events.some(e => e.kind === 'future-unknown-arrival') ? ['arrival-outcome-unknown'] : []),
    ...(frame.uncertainPlayers.length ? ['asset-outcome-unknown'] : []),
    ...(trajectoryUnknown ? ['fleet-trajectory-unknown'] : []),
  ];
  // Sequence is the engine's real emission order. Never sum fleets just because
  // their displayed ticks (or even movement fractions) are equal.
  const ownMineLosses = events.filter(e => e.kind === 'mine-loss');
  const coverage = { complete: frame.targetTick >= requestedTargetTick, stoppedAtTerminal: !!crossing, unknownReasons };
  const results = predicates.map(p => {
    const initial = view.outposts.find(o => o.id === p.outpostId), final = frame.outposts.find(o => o.id === p.outpostId);
    const initialEvent: KnownPathEvent = { tick: view.tick, fraction: observation.secondsSinceLastTick / 600, sequence: -1, kind: 'initial-state', subject: p.outpostId,
      details: initial ? { owner: initial.owner ?? null, destroyed: initial.destroyed ?? false } : {} };
    const result = (truth: KnownPredicateTruth, reason: string, earliestCounterexample: KnownPathEvent | null = null): KnownPathPredicateResult =>
      ({ id: p.id, kind: p.kind, outpostId: p.outpostId, truth, reason, earliestCounterexample });
    if (!initial || !knownOutposts.has(p.outpostId)) return result('unknown', 'outpost-not-fully-observed');
    const targetEvents = events.filter(e => e.subject === p.outpostId);
    if (p.kind === 'controlsThroughout') {
      if (initial.owner !== player || initial.destroyed || !view.self.active) return result('false', 'not-controlled-at-start', initialEvent);
      const lost = events.find(e => e.kind === 'player-eliminated' && e.details.owner === player || e.subject === p.outpostId && (e.kind === 'outpost-destroyed' || e.kind === 'outpost-captured' && e.details.owner !== player));
      if (lost) return result('false', 'control-lost-on-path', lost);
      // Unknown arrivals terminate at an unobserved outpost in this branch;
      // they neither move again nor establish a capture or asset loss. They
      // cannot change continuous control of this fully observed outpost under
      // the no-new-orders assumption. Keep global coverage uncertain, and
      // still reject incomplete horizons and unresolved moving trajectories.
      const controlUnknown = unknownReasons.find(reason => reason !== 'arrival-outcome-unknown' && reason !== 'asset-outcome-unknown');
      if (controlUnknown) return result('unknown', controlUnknown);
      if (!final || final.visibility !== 2 || final.owner !== player || final.destroyed) return result('unknown', 'continuous-control-not-established');
      return result('true', 'controlled-through-covered-path');
    }
    if (p.kind === 'noMineLoss') {
      const lost = targetEvents.find(e => e.kind === 'mine-loss');
      if (lost) return result('false', 'mine-loss-on-path', lost);
      if (unknownReasons.length) return result('unknown', unknownReasons[0]!);
      return result('true', 'no-own-mine-loss-on-covered-path');
    }
    if (p.kind === 'capturedWithin') {
      const captured = targetEvents.find(e => e.kind === 'outpost-captured' && e.details.owner === player && e.details.before !== player);
      if (captured) return result('true', 'capture-recorded-on-path');
      if (unknownReasons.length) return result('unknown', unknownReasons[0]!);
      return result('false', 'no-capture-on-covered-path', { tick: frame.targetTick, fraction: 1, sequence: state.events.length, kind: 'coverage-end', subject: p.outpostId, details: {} });
    }
    if (!coverage.complete) return result('unknown', 'requested-horizon-not-covered');
    if (!final || final.visibility !== 2 || final.drillers === undefined || final.owner === undefined) return result('unknown', 'endpoint-not-fully-observed');
    const endpoint: KnownPathEvent = { tick: frame.targetTick, fraction: 1, sequence: state.events.length, kind: 'endpoint-state', subject: p.outpostId,
      details: { owner: final.owner, drillers: final.drillers, destroyed: final.destroyed ?? false } };
    // Unresolved actors can change a losing endpoint as well as a winning one.
    // Never turn the placeholder branch's owner or troop deficit into a refutation.
    if (unknownReasons.includes('arrival-outcome-unknown') || unknownReasons.includes('fleet-trajectory-unknown')) return result('unknown', 'unresolved-actors-may-affect-endpoint');
    const controlled = final.owner === player && !final.destroyed && frame.self.active;
    if (!controlled) return result('false', 'not-controlled-at-horizon', endpoint);
    if (p.kind === 'minimumDrillersAtHorizon' && final.drillers < p.minimumDrillers!) return result('false', 'drillers-below-minimum-at-horizon', endpoint);
    return result('true', p.kind === 'controlledAtHorizon' ? 'controlled-at-horizon' : 'minimum-drillers-at-horizon-met');
  });
  return { format: 'known-path-evidence/1', roomId: observation.roomId, player, basisRevision: observation.revision, profile: view.profile,
    observedTick: view.tick, observedSeconds: observation.secondsSinceLastTick, requestedTargetTick, actualTargetTick: frame.targetTick, conditional: true,
    coverage, assumptions: [...frame.assumptions, 'Events and predicates describe only this observation-built conditional branch',
      'Emission sequence, not same-tick grouping, establishes battle order; projected local slots are not hidden server slots',
      'Mine-loss deductions are already included in endpoint resources and must not be subtracted again'],
    events, predicates: results, orderFleets: structuredClone(orderFleets), mineLosses: { count: ownMineLosses.length, totalDeduction: ownMineLosses.reduce((sum, e) => sum + Number(e.details.before) - Number(e.details.after), 0), events: ownMineLosses } };
}
