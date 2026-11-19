import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFleetScenario, submitFleetOrder, advanceFleetScenario, type FleetScenario, type FleetSetup } from '../packages/engine/src/index.js';
import { observation } from '../packages/server/src/player-api.js';
import { createKnownPrediction, forecastKnownPath, forecastKnownObservation, compareKnownObservations, previewKnownDraftTransaction,
  searchKnownForceCandidates, compileKnownIssueTickCandidates, searchKnownSupportCandidates, compileKnownTimingCandidates,
  type KnownPredictionDraft, type KnownPathPredicate, type KnownPathEvidence } from '../packages/prediction/src/index.js';

function setup(): FleetSetup {
  return { size: { width: 20, height: 20 }, positions: { home: { x: -.05, y: 0 }, target: { x: 0, y: 0 }, other: { x: .05, y: 0 } },
    economy: { initialTick: 100, teamSize: 0, players: [{ active: true, neptunium: 100, minesCreated: 1 }, { active: true, neptunium: 0, minesCreated: 0 }],
      outposts: [['home', 0, 100, 0], ['target', 1, 20, 10], ['other', 0, 100, 0]].map(([id, owner, drillers, shield]) => ({
        id: String(id), owner: Number(owner), drillers: Number(drillers), shield: Number(shield), shieldMax: Number(shield), type: 'generator',
        shieldsEnabled: true, productionProgress: 0, miningProgress: 0, shieldProgress: 0, minePending: false, shieldDisablePending: false })) } };
}
function observe(state = createFleetScenario(setup())) { const value = observation({ state, scheduled: [] }, 0, 'programmatic-fixture'); value.view.fullMapVisible = true; return value; }
const launch = (id = 'attack', drillers = 31, issueTick = 100, source = 'home'): KnownPredictionDraft => ({ id, issueTick, action: { kind: 'launch', source, destination: 'target', drillers } });
const control: KnownPathPredicate = { id: 'target', kind: 'controlledAtHorizon', outpostId: 'target' };
function moving(state: FleetScenario, entries: [string, number, number, number, number][]) {
  state.fleets = entries.map(([id, owner, x, y, drillers], slot) => ({ id, owner, slot, position: { x, y }, previous: { x, y }, drillers,
    used: true, source: null, destination: 'target', state: 'moving', secondsUntilLaunch: 0, fractionMoved: 0, gift: false, giftSeconds: 0 }));
  return state;
}
function mineRecaptureState() {
  const cfg = setup(); cfg.economy.outposts[1] = { ...cfg.economy.outposts[1]!, owner: 0, type: 'mine', drillers: 5, shield: 0, shieldMax: 0 };
  return moving(createFleetScenario(cfg), [['e1', 1, .01, 0, 10], ['a2', 0, 0, .1, 20], ['e3', 1, -.3, 0, 40], ['a4', 0, 0, -.5, 80]]);
}

test('same-branch path records repeated mine loss, recapture and earliest counterexamples without double deduction', () => {
  const state = mineRecaptureState(), now = observe(state), saved = JSON.stringify(now);
  const { forecast, path } = forecastKnownPath(now, { targetTick: 120, predicates: [control,
    { id: 'always', kind: 'controlsThroughout', outpostId: 'target' }, { id: 'no-loss', kind: 'noMineLoss', outpostId: 'target' }] });
  assert.equal(forecast.status, 'conditional'); if (forecast.status !== 'conditional' || !path) throw Error('Expected forecast');
  assert.equal(forecast.result.outposts.find(o => o.id === 'target')!.owner, 0);
  assert.equal(forecast.result.self.neptunium, 64); assert.equal(path.mineLosses.totalDeduction, 36); assert.equal(path.mineLosses.count, 2);
  assert.deepEqual(path.mineLosses.events.map(e => [e.details.before, e.details.after]), [[100, 80], [80, 64]]);
  assert.deepEqual(path.predicates.map(p => p.truth), ['true', 'false', 'false']);
  assert.equal(path.predicates[1]!.earliestCounterexample!.tick, 101);
  assert.ok(path.predicates[2]!.earliestCounterexample!.sequence < path.predicates[1]!.earliestCounterexample!.sequence);
  assert.equal(path.actualTargetTick, 120); assert.equal(path.coverage.complete, true); assert.equal(JSON.stringify(now), saved);
  assert.equal(advanceFleetScenario(state, 120).economy.players[0]!.neptunium, 64);
});

test('existing forecast and comparison APIs attach same-branch default mine predicates', () => {
  const now = observe(mineRecaptureState()); const emitted: { value?: KnownPathEvidence } = {};
  const result = createKnownPrediction(now, { onPathEvidence: path => { emitted.value = path; } }).predict(120);
  assert.ok(emitted.value); assert.equal(result.path!.predicates.length, 2); assert.equal(result.path, emitted.value);
  assert.equal(forecastKnownObservation(now, 120).path!.mineLosses.count, 2);
  const compared = compareKnownObservations(now, [{ id: 'hold', targetTick: 120, drafts: [] }, { id: 'other', targetTick: 120, drafts: [] }]);
  assert.deepEqual(compared.scenarios[0]!.result.path, compared.scenarios[1]!.result.path);
});

test('unknown outposts and hidden runtime never enter path combat or resource certificates', () => {
  const cfg = setup(); cfg.size = { width: 80, height: 80 }; cfg.positions.target = { x: 20, y: 20 };
  const state = createFleetScenario(cfg), now = observe(state); now.view.fullMapVisible = false;
  const request = { targetTick: 244, drafts: [launch()], predicates: [control] };
  const a = forecastKnownPath(now, request); assert.equal(a.path!.predicates[0]!.truth, 'unknown');
  assert.equal(a.path!.events.some(e => e.kind === 'battle' && e.details.target === 'target'), false);
  state.economy.outposts[1]!.shieldProgress = 99999; state.economy.outposts[1]!.miningProgress = 99999;
   state.subCounters[1] = 77;
  const other = observe(state); other.view.fullMapVisible = false;
  assert.deepEqual(other, now); assert.deepEqual(forecastKnownPath(other, request), a);
  for (const forbidden of ['retainedWorld', 'specialistSlots', 'subCounters', 'recruitmentSeed', '99999']) assert.ok(!JSON.stringify(a.path).includes(forbidden));
});

test('unknown arrival produces unknown positive predicates instead of fabricated conquest', () => {
  const now = observe(); now.view.outposts.find(o => o.id === 'target')!.visibility = 0;
  for (const key of ['drillers', 'shield', 'shieldMax', 'type'] as const) delete now.view.outposts.find(o => o.id === 'target')![key];
  const { path } = forecastKnownPath(now, { targetTick: 110, drafts: [launch()], predicates: [control] });
  assert.equal(path!.predicates[0]!.truth, 'unknown'); assert.ok(path!.events.some(e => e.kind === 'future-unknown-arrival'));
  assert.ok(!path!.events.some(e => e.kind === 'outpost-captured' && e.subject === 'target'));
});

test('terminal cutoff reports actual coverage and does not prove the requested future endpoint', () => {
  const cfg = setup(); cfg.match = { mode: 'mining', neptuniumGoal: 100 }; cfg.economy.players[0]!.neptunium = 99;
  cfg.economy.outposts[0]!.type = 'mine'; cfg.economy.outposts[0]!.miningProgress = 71;
  const now = observe(createFleetScenario(cfg));
  const { path } = forecastKnownPath(now, { targetTick: 120, predicates: [{ id: 'home', kind: 'controlledAtHorizon', outpostId: 'home' }] });
  assert.ok(path!.actualTargetTick < 120); assert.equal(path!.coverage.complete, false); assert.equal(path!.predicates[0]!.truth, 'unknown');
  assert.ok(path!.events.some(e => e.kind === 'terminal-crossing'));
});

test('force search verifies the ordinary tie boundary with the engine and reports a proved domain minimum', () => {
  const now = observe(), saved = JSON.stringify(now);
  const result = searchKnownForceCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 29, maximumDrillers: 33, predicates: [control] });
  assert.deepEqual(result.candidates.map(c => [c.value, c.truth]), [[29, 'false'], [30, 'false'], [31, 'true'], [32, 'true'], [33, 'true']]);
  assert.equal(result.smallestFoundValue, 31); assert.equal(result.smallestProvenValue, 31); assert.equal(result.coverage.complete, true);
  assert.equal(result.method, 'ascending-enumeration'); assert.equal(JSON.stringify(now), saved);
});

test('compound source-defense force predicates are non-monotonic and are never binary searched', () => {
  const result = searchKnownForceCandidates(observe(), { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 29, maximumDrillers: 35,
    predicates: [control, { id: 'reserve', kind: 'minimumDrillersAtHorizon', outpostId: 'home', minimumDrillers: 68 }] });
  assert.deepEqual(result.candidates.map(c => c.truth), ['false', 'false', 'true', 'true', 'false', 'false', 'false']);
  assert.equal(result.coverage.testedCount, 7); assert.equal(result.smallestProvenValue, 31);
});

test('budget exhaustion and cancellation are inconclusive, never no-solution or a guessed minimum', () => {
  const request = { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 20, maximumDrillers: 50, predicates: [control], maxSimulations: 2 };
  const limited = searchKnownForceCandidates(observe(), request);
  assert.equal(limited.coverage.complete, false); assert.equal(limited.coverage.stopReason, 'simulation-budget'); assert.equal(limited.conclusion, 'inconclusive');
  assert.equal(limited.smallestProvenValue, null);
  const abort = new AbortController(); abort.abort(); const cancelled = searchKnownForceCandidates(observe(), { ...request, signal: abort.signal });
  assert.equal(cancelled.coverage.testedCount, 0); assert.equal(cancelled.coverage.stopReason, 'cancelled');
});

test('issue tick compilation searches only the explicit set and retains each real arrival sequence', () => {
  const result = compileKnownIssueTickCandidates(observe(), { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', issueTicks: [104, 100, 102, 102], predicates: [control] });
  assert.deepEqual(result.domain.values, [100, 102, 104]); assert.equal(result.coverage.requestedCount, 3);
  assert.ok(result.candidates.every(c => c.arrivals.some(a => a.target === 'target')));
  assert.ok(result.candidates[0]!.arrivals[0]!.tick < result.candidates[2]!.arrivals[0]!.tick);
});

test('immediate draft preview honors waiting edits and preserves the existing countdown with no time advance', () => {
  const live = submitFleetOrder(createFleetScenario(setup()), { id: 'waiting', player: 0, action: { kind: 'launch', source: 'home', destination: 'target', drillers: 20, delaySeconds: 1200 } }).state;
  const now = observe(live), before = JSON.stringify(now), result = previewKnownDraftTransaction(now, [launch('edit', 35)]);
  assert.equal(result.status, 'conditional'); assert.ok(result.observation);
  assert.equal(result.observation.view.tick, 100); assert.equal(result.observation.view.outposts.find(o => o.id === 'home')!.drillers, 65);
  assert.equal(result.sourceEffects.find(e => e.outpostId === 'home')!.netCommitted, 15);
  assert.equal(result.observation.view.fleets.length, 1); assert.equal(result.observation.view.fleets[0]!.id, 'waiting');
  assert.equal(result.observation.view.fleets[0]!.secondsUntilLaunch, now.view.fleets[0]!.secondsUntilLaunch);
  assert.equal(JSON.stringify(now), before); assert.throws(() => previewKnownDraftTransaction(now, [launch('future', 10, 101)]));
});

test('immediate preview returns all order failures without inventing successful writes', () => {
  const result = previewKnownDraftTransaction(observe(), [launch('too-large', 1000), { id: 'wrong-source', issueTick: 100, action: { kind: 'launch', source: 'target', destination: 'other', drillers: 3 } }]);
  assert.equal(result.orders.length, 2); assert.ok(result.orders.every(o => o.status === 'failed'));
  assert.equal(result.observation!.view.outposts.find(o => o.id === 'home')!.drillers, 100);
});

test('fixed subsets preserve hold and independently verify same-source direct departures', () => {
  const cfg = setup(); cfg.economy.outposts[1]!.shield = 0; cfg.economy.outposts[1]!.shieldMax = 0;
  const now = observe(createFleetScenario(cfg));
  const result = searchKnownSupportCandidates(now, { targetTick: 110, drafts: [launch('left', 15), launch('right', 15, 100, 'other')], predicates: [control] });
  assert.equal(result.coverage.testedCount, 4); assert.deepEqual(result.candidates.map(c => c.truth), ['false', 'false', 'false', 'true']);
  const edited = searchKnownSupportCandidates(now, { targetTick: 110, drafts: [launch('left', 15), launch('right', 15)], predicates: [control] });
  assert.equal(edited.candidates[3]!.truth, 'true');
});

test('synchronization uses shared single-route and joint budgets and preserves sequential same-tick battles', () => {
  const cfg = setup(); cfg.economy.outposts[1]!.shield = 0; cfg.economy.outposts[1]!.shieldMax = 0;
  const request = { targetTick: 110, drafts: [launch('left', 15), launch('right', 15, 100, 'other')], predicates: [control],
    timing: [{ draftId: 'left', issueTicks: [100] }, { draftId: 'right', issueTicks: [100] }] };
  const result = compileKnownTimingCandidates(observe(createFleetScenario(cfg)), request);
  assert.equal(result.coverage.simulations, 3); assert.equal(result.candidates.length, 1); assert.equal(result.conclusion, 'synchronized-candidate-found');
  const battles = result.candidates[0]!.path!.events.filter(e => e.kind === 'battle');
  assert.equal(battles.length, 2); assert.equal(battles[0]!.tick, battles[1]!.tick); assert.ok(battles[0]!.sequence < battles[1]!.sequence);
  assert.equal(battles[0]!.details.attackerBefore, 15); assert.equal(battles[0]!.details.winner, 'defender'); assert.equal(battles[1]!.details.winner, 'attacker');
  const limited = compileKnownTimingCandidates(observe(createFleetScenario(cfg)), { ...request, maxSimulations: 2 });
  assert.equal(limited.coverage.complete, false); assert.equal(limited.candidates.length, 0); assert.equal(limited.conclusion, 'inconclusive');
});

test('same-route immediate departures form two independent reinforcements', () => {
  const result = compileKnownTimingCandidates(observe(), { targetTick: 110, drafts: [launch('first', 40), launch('edit', 50)], predicates: [control],
    timing: [{ draftId: 'first', issueTicks: [100] }, { draftId: 'edit', issueTicks: [100] }] });
  assert.equal(result.candidates[0]!.synchronized, 'true'); assert.notEqual(result.candidates[0]!.path!.orderFleets[0]!.fleetId, result.candidates[0]!.path!.orderFleets[1]!.fleetId);
});

test('candidate validation rejects oversized domains, invalid budgets and malformed predicates', () => {
  const base = { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 1, maximumDrillers: 2, predicates: [control] };
  assert.throws(() => searchKnownForceCandidates(observe(), { ...base, targetTick: 245 }), /144/);
  assert.throws(() => searchKnownForceCandidates(observe(), { ...base, maxSimulations: 129 }), /budget/);
  assert.throws(() => searchKnownForceCandidates(observe(), { ...base, minimumDrillers: -1 }), /interval/);
  assert.throws(() => forecastKnownPath(observe(), { targetTick: 110, predicates: [{ ...control, kind: 'minimumDrillersAtHorizon' }] }), /predicate/);
});

test('unknown regions never become a proved force minimum or a complete-domain failure', () => {
  const now = observe(); now.view.outposts.find(o => o.id === 'target')!.visibility = 0;
  const result = searchKnownForceCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 30, maximumDrillers: 32, predicates: [control] });
  assert.ok(result.candidates.every(c => c.truth === 'unknown')); assert.equal(result.coverage.complete, true);
  assert.equal(result.smallestProvenValue, null); assert.equal(result.conclusion, 'inconclusive');
});

test('late reinforcement is retained and can prove recapture while continuous mine control fails', () => {
  const cfg = setup(); cfg.economy.outposts[1] = { ...cfg.economy.outposts[1]!, owner: 0, type: 'mine', drillers: 5, shield: 0, shieldMax: 0 };
  const now = observe(moving(createFleetScenario(cfg), [['enemy-wave', 1, .01, 0, 10]]));
  const result = searchKnownSupportCandidates(now, { targetTick: 110, drafts: [launch('late-recapture', 20, 102)], predicates: [control, { id: 'recapture', kind: 'capturedWithin', outpostId: 'target' }] });
  assert.equal(result.candidates[0]!.truth, 'false'); assert.equal(result.candidates[1]!.truth, 'true');
  assert.equal(result.candidates[1]!.path!.mineLosses.count, 1);
  assert.ok(result.candidates[1]!.arrivals.find(a => a.fleetId === 'late-recapture')!.tick > 101);
});

test('single-axis timing validates mine funding after real transport arrival rather than tick guessing', () => {
  const cfg = setup(); cfg.economy.outposts[0]!.drillers = 30;
  const now = observe(createFleetScenario(cfg));
  const result = compileKnownIssueTickCandidates(now, { targetTick: 110,
    drafts: [{ id: 'fund', issueTick: 100, action: { kind: 'launch', source: 'other', destination: 'home', drillers: 80 } },
      { id: 'mine', issueTick: 100, action: { kind: 'toggle-mine', outpostId: 'home' } }], varyDraftId: 'mine', issueTicks: [100, 101, 102, 103, 104, 105],
    predicates: [{ id: 'mine-owned', kind: 'controlledAtHorizon', outpostId: 'home' }] });
  assert.equal(result.candidates[0]!.truth, 'false'); assert.ok(result.candidates.some(c => c.truth === 'true'));
  const funded = result.candidates.find(c => c.truth === 'true')!;
  const arrival = funded.arrivals.find(a => a.fleetId === 'fund')!;
  assert.ok(funded.value >= arrival.tick); assert.equal(funded.orders.find(o => o.id === 'mine')!.status, 'executed');
});

test('future existing appointments stay pending without blocking an otherwise proved bounded candidate', () => {
  const now = observe(); now.scheduled.push({ id: 'old-future', player: 0, issueTick: 120, status: 'pending', action: { kind: 'launch', source: 'other', destination: 'target', drillers: 10 } });
  const result = searchKnownForceCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 31, maximumDrillers: 31, predicates: [control] });
  assert.equal(result.candidates[0]!.truth, 'true'); assert.equal(result.candidates[0]!.orders.find(o => o.id === 'old-future')!.status, 'pending');
});

test('empty success predicates cannot turn an unresolved arrival into a successful candidate', () => {
  const now = observe(); now.view.outposts.find(o => o.id === 'target')!.visibility = 0;
  const result = searchKnownForceCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 31, maximumDrillers: 31, predicates: [] });
  assert.equal(result.candidates[0]!.truth, 'unknown'); assert.equal(result.smallestProvenValue, null);
});

test('unresolved trajectories invalidate losing endpoint ownership and troop-deficit refutations', () => {
  const now = observe(); now.view.fleets.push({ id: 'uncertain-reinforcement', owner: 0, position: { x: -.02, y: 0 }, drillers: 200,
    state: 'moving', gift: false, destination: null });
  const { path } = forecastKnownPath(now, { targetTick: 110, predicates: [control,
    { id: 'too-few', kind: 'minimumDrillersAtHorizon', outpostId: 'home', minimumDrillers: 200 }] });
  assert.ok(path!.coverage.unknownReasons.includes('fleet-trajectory-unknown'));
  assert.deepEqual(path!.predicates.map(p => p.truth), ['unknown', 'unknown']);
  assert.ok(path!.predicates.every(p => p.earliestCounterexample === null));
});

test('complete enumeration never upgrades an uncertain branch counterexample into no feasible domain', () => {
  const now = observe(); now.view.fleets.push({ id: 'unknown-course', owner: 0, position: { x: -.02, y: 0 }, drillers: 200,
    state: 'moving', gift: false, destination: null });
  // This initial-state predicate has a real branch-local false witness. Global
  // candidate feasibility nevertheless remains unknown when coverage is uncertain.
  const predicates: KnownPathPredicate[] = [{ id: 'always', kind: 'controlsThroughout', outpostId: 'target' }];
  const force = searchKnownForceCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', minimumDrillers: 1, maximumDrillers: 2, predicates });
  assert.ok(force.candidates.every(c => c.path!.predicates[0]!.truth === 'false' && c.truth === 'unknown'));
  assert.equal(force.coverage.complete, true); assert.equal(force.conclusion, 'inconclusive'); assert.equal(force.smallestProvenValue, null);
  const timing = compileKnownIssueTickCandidates(now, { targetTick: 110, drafts: [launch()], varyDraftId: 'attack', issueTicks: [100, 101], predicates });
  assert.equal(timing.coverage.complete, true); assert.equal(timing.conclusion, 'inconclusive');
  const support = searchKnownSupportCandidates(now, { targetTick: 110, drafts: [launch()], predicates });
  assert.equal(support.coverage.complete, true); assert.equal(support.conclusion, 'inconclusive');
  const sync = compileKnownTimingCandidates(now, { targetTick: 110, drafts: [launch()], timing: [{ draftId: 'attack', issueTicks: [100] }], predicates });
  assert.equal(sync.coverage.complete, true); assert.equal(sync.conclusion, 'inconclusive');
});

test('unknown arrivals prevent negative endpoint conclusions about a separate known target', () => {
  const now = observe(); const hidden = now.view.outposts.find(o => o.id === 'other')!; hidden.owner = 1; hidden.visibility = 0;
  const { path } = forecastKnownPath(now, { targetTick: 110, drafts: [{ id: 'blind', issueTick: 100,
    action: { kind: 'launch', source: 'home', destination: 'other', drillers: 20 } }], predicates: [control] });
  assert.ok(path!.coverage.unknownReasons.includes('arrival-outcome-unknown')); assert.equal(path!.predicates[0]!.truth, 'unknown');
});
