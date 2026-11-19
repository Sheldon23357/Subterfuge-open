import test from 'node:test';
import assert from 'node:assert/strict';
import { knownOutpostSonarRange } from '../packages/client/src/known-sonar.js';
import type { GameView } from '../packages/client/src/game-view.js';
import { RULES } from '../packages/rules/src/index.js';

function fixture() {
  return {
    outposts: [{ id: 'a', owner: 1, position: { x: 0, y: 0 } },
      { id: 'b', owner: 1, position: { x: 2, y: 0 } }],
    fleets: [{ id: 'docked', owner: 1, state: 'waiting', departureMinutes: 10,
      position: { x: 0, y: 0 } }],
  } as unknown as GameView;
}
const base = RULES.OutpostParams.VisibilityRange;

test('ordinary outposts use the same base sonar range', () => {
  const view = fixture();

  assert.equal(knownOutpostSonarRange(view, 'a'), base);
  assert.equal(knownOutpostSonarRange(view, 'b'), base);
});

test('sonar range does not reveal unknown ownership', () => {
  const view = fixture();

  assert.equal(knownOutpostSonarRange(view, 'a'), base);
  view.outposts[0]!.owner = null;
  assert.equal(knownOutpostSonarRange(view, 'a'), base);
});

test('waiting and moving ordinary fleets do not modify outpost sonar', () => {
  const view = fixture();

  assert.equal(knownOutpostSonarRange(view, 'a'), base);
  view.fleets[0]!.state = 'moving';
  assert.equal(knownOutpostSonarRange(view, 'a'), base);
});
