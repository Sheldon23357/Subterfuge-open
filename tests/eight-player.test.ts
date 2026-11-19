import test from "node:test";
import assert from "node:assert/strict";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import {
  submitFleetOrder,
  advanceFleetScenario,
  saveFleetSnapshot,
  restoreFleetSnapshot,
} from "../packages/engine/src/index.js";
test("eight-seat map has symmetric resources and every seat can deploy and replay", () => {
  let state = createEightPlayerScenario();
  assert.equal(state.economy.players.length, 8);
  assert.equal(state.economy.outposts.length, 32);

  for (let seat = 0; seat < 8; seat++) {
    const own = state.economy.outposts.filter((o) => o.owner === seat);
    assert.equal(own.length, 2);
    assert.equal(
      own.reduce((sum, o) => sum + o.drillers, 0),
      200,
    );
    const source = own.find((o) => o.type === "factory")!;
    state = submitFleetOrder(state, {
      id: `launch-${seat}`,
      player: seat,
      action: {
        kind: "launch",
        source: source.id,
        destination: own.find((o) => o.type === "generator")!.id,
        drillers: 20,
      },
    }).state;
  }
  assert.equal(state.fleets.filter((f) => f.used).length, 8);
  state = advanceFleetScenario(state, 120);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(state)), state);
});
