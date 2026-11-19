import test from "node:test";
import assert from "node:assert/strict";
import {
  generateOriginalMap,
  originalMapCandidate,
  clientDistance,
  advanceFleetScenario,
} from "../packages/engine/src/index.js";
import { roomFromMap } from "../packages/server/src/generated-room.js";
import { saveRoom, restoreRoom } from "../packages/server/src/planning.js";

for (let players = 2; players <= 10; players++)
  test(`original map initializes ${players} seats and survives gameplay/restoration`, async () => {
    const map = await generateOriginalMap(players, 4300);
    assert.equal(map.outposts.length, players * 10);
    assert.equal(map.startingOutposts.length, players);
    assert.ok(map.score <= 3);
    assert.equal(
      map.height,
      Math.fround(Math.sqrt((players * 200) / (players <= 4 ? 0.75 : 1))),
    );
    assert.equal(map.width, Math.fround((players * 200) / map.height));
    const initialTypes = [];
    for (let i = 0; i < players; i++) {
      const owned = map.outposts.filter((o) => o.owner === i);
      assert.equal(owned.length, 5);
      assert.equal(
        owned.reduce((n, o) => n + o.drillers, 0),
        160,
      );
      const starting = map.startingOutposts.find((q) => q.owner === i)!;
      assert.equal(map.outposts[starting.outpost]!.drillers, 0);
      assert.equal(map.outposts[starting.outpost]!.owner, i);
      initialTypes.push(owned.filter((o) => o.type === 2).length);
    }
    assert.equal(new Set(initialTypes).size, 1);
    for (let i = 0; i < map.outposts.length; i++)
      for (let j = 0; j < i; j++)
        assert.ok(
          clientDistance(
            map.outposts[i]!.position,
            map.outposts[j]!.position,
            map,
          ) >= 3,
        );
    const territory = Array.from(
      { length: players },
      (_, i) => map.outposts.filter((o) => o.meantForPlayer === i).length,
    );
    assert.equal(Math.max(...territory) - Math.min(...territory), map.score);
    const candidate = originalMapCandidate(players, map.seed);
    assert.deepEqual(candidate.outposts, map.outposts);
    const room = roomFromMap(map);
    assert.equal(room.state.economy.tick, 0);
    assert.ok(room.state.economy.players.every((p) => p.neptunium === 0));
    assert.deepEqual(restoreRoom(saveRoom(room)), room);
    const advanced = { ...room, state: advanceFleetScenario(room.state, 12) };
    assert.deepEqual(restoreRoom(saveRoom(advanced)), advanced);

  });
test("map rejects invalid counts/seeds rather than falling back to grid", async () => {
  for (const count of [0, 1, 11, 2.5, NaN])
    await assert.rejects(generateOriginalMap(count, 4300));
  for (const seed of [-1, 1.5, 4294966797, NaN])
    await assert.rejects(generateOriginalMap(8, seed));
  const a = originalMapCandidate(8, 1),
    b = originalMapCandidate(8, 2);
  assert.notDeepEqual(a.outposts, b.outposts);
});
