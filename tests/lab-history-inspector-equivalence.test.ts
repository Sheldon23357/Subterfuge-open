import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createFleetScenario, submitFleetOrder, advanceFleetScenario, exportFleetReplay,
  replayFleetScenario, projectPlayerView, projectPlayerActivity, projectGlobalActivity,
  fleetPublicIntel, fleetMatchOutcome, fleetOutpostMetrics, originalOutpostNames,
  departureCommitted, type FleetScenario, type FleetSetup,
} from '../packages/engine/src/index.js';
import { createLabHistory, replayLabHistory, type LabHistoryInput, type LabHistoryFrame } from '../packages/prediction/src/index.js';
import type { LabView } from '../packages/contracts/src/index.js';

// Independent pre-optimization projection: deliberately rebuild the economic
// context for each outpost rather than comparing two callers of the new helper.
function legacyGlobal(state: FleetScenario): LabView {
  const names = originalOutpostNames(0, state.economy.outposts.length);
  return {
    tick: state.economy.tick, size: state.initial.size, realtime: false, secondsSinceLastTick: 0,
    players: state.economy.players, funding: state.economy.funding,
    intel: fleetPublicIntel(state), scheduled: [], orders: [],
    ...(state.initial.match ? { match: { ...state.initial.match, teamSize: state.economy.initial.teamSize, ended: !!fleetMatchOutcome(state) } } : {}),
    outposts: state.economy.outposts.map((o, i) => ({ ...o, name: names?.[i] ?? o.id,
      position: state.initial.positions[o.id]!, metrics: fleetOutpostMetrics(state, o.id) })),
    fleets: state.fleets.filter(f => f.used).map(f => ({ ...f, canReturn:false,returned:!!f.returned,
      canCancelLaunch: false, departureCommitted: departureCommitted(f, 0, state.economy.tick >= (state.initial.launchCancellationLockTick ?? 0)),
      departureMinutes: f.secondsUntilLaunch / 60, arrivalMinutes: null })),
    activity: projectGlobalActivity(state),
    events: state.events.slice(-150).reverse().map(e => ({ tick: e.tick, kind: e.kind, subject: e.subject, details: JSON.stringify(e.details) })),
  };
}

function fixture() {
  const setup = JSON.parse(fs.readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;

  // Neutral, destroyed, and distant hidden outposts exercise inactive metrics
  // and prove that the global optimization cannot relax player fog filtering.
  for (const [id, owner, type, destroyed] of [
    ['neutral-factory', null, 'factory', false],
    ['destroyed-generator', 1, 'generator', true],
    ['hidden-factory', 1, 'factory', false],
  ] as const) {
    setup.economy.outposts.push({ ...setup.economy.outposts[0]!, id, owner, type, destroyed, drillers: 3 });
    setup.positions[id] = { x: 9, y: 9 };
  }
  let state = createFleetScenario(setup);
  const source = setup.economy.outposts[0]!.id;
  state = submitFleetOrder(state, { id: 'history-equivalence-launch', player: 0,
    action: { kind: 'launch', source, destination: setup.economy.outposts[1]!.id, drillers: 27 } }).state;
  state = advanceFleetScenario(state, 120);
  state = submitFleetOrder(state, { id: 'history-equivalence-shields', player: 0,
    action: { kind: 'set-shields', outpostId: source, enabled: false } }).state;
  state = advanceFleetScenario(state, 150);
  return { state, input: { replay: exportFleetReplay(state) } satisfies LabHistoryInput };
}


  test('history shared inspector preserves complete ordinary projections and fog', () => {
    const { state: live, input } = fixture();
    const originalInput = JSON.stringify(input), originalLive = JSON.stringify(live);
    const history = createLabHistory(input);
    let sawHidden = false, sawEvents = false;
    // Include cold seeks, backward scrubbing, cache hits, and both sides of orders.
    for (const targetTick of [150, 100, 101, 106, 119, 120, 121, 140, 101, 150]) {
      const state = replayFleetScenario({ ...input.replay, targetTick,
        commands: input.replay.commands.filter(c => c.tick <= targetTick) });
      const beforeState = JSON.stringify(state);
      for (const seat of [-1, ...state.economy.players.map((_, player) => player)]) {
        const expected: LabHistoryFrame = seat === -1 ? { global: legacyGlobal(state) } : {
          player: projectPlayerView(state, seat), intel: fleetPublicIntel(state), activity: projectPlayerActivity(state, seat),
        };
        assert.deepEqual(replayLabHistory(input, targetTick, seat), expected, `direct ${targetTick}/${seat}`);
        history.begin(targetTick, seat);
        let steps = 0;
        while (!history.step()) assert.ok(++steps < 1000);
        const actual = history.result();
        assert.deepEqual(actual, expected, `session ${targetTick}/${seat}`);
        if ('player' in actual) {
          for (const outpost of actual.player.outposts.filter(o => o.visibility !== 2)) {
            sawHidden = true;
            assert.ok(!('drillers' in outpost));
            assert.ok(!('metrics' in outpost));
          }
        } else {
          sawEvents ||= actual.global.events.length > 0;
          // Returned mutable frames cannot poison the session's cached result.
          actual.global.outposts[0]!.metrics.output = -999;
          assert.deepEqual(history.result(), expected);
        }
      }
      assert.equal(JSON.stringify(state), beforeState);
    }
    assert.ok(sawHidden);
    assert.ok(sawEvents);
    assert.ok(history.stats().cacheHits > 0);
    assert.equal(JSON.stringify(input), originalInput);
    assert.equal(JSON.stringify(live), originalLive);
  });
