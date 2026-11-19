import test from "node:test";
import assert from "node:assert/strict";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import { previewLaunch, saveRoom } from "../packages/server/src/planning.js";

test("draft battle updates outcome with troops without mutating live room", () => {
  const room = { state: createEightPlayerScenario(), scheduled: [] };
  const before = saveRoom(room);
  const draft = (drillers: number) =>
    previewLaunch(room, {
      order: {
        id: "preview-test",
        player: 0,
        action: {
          kind: "launch",
          source: "织女星",
          destination: "暮光",
          drillers,
        },
      },
      departureTick: room.state.economy.tick + 1,
    });
  const lost = draft(1),
    won = draft(80);
  assert.equal(lost.outcome, "lost");
  assert.equal(lost.target?.owner, null);
  assert.equal(won.outcome, "won");
  assert.equal(won.target?.owner, 0);
  assert.ok(won.target!.drillers > 0);
  assert.equal(saveRoom(room), before);
});
test("friendly draft previews reinforcement and rejects invalid armies", () => {
  const room = { state: createEightPlayerScenario(), scheduled: [] };
  const input = {
    order: {
      id: "preview-friendly",
      player: 0,
      action: {
        kind: "launch" as const,
        source: "织女星",
        destination: "回声",
        drillers: 20,
      },
    },
    departureTick: room.state.economy.tick + 1,
  };
  const result = previewLaunch(room, input);
  assert.equal(result.outcome, "reinforced");
  assert.equal(result.target?.owner, 0);
  assert.ok(result.target!.drillers >= 120);
  assert.throws(() =>
    previewLaunch(room, {
      ...input,
      order: {
        ...input.order,
        action: { ...input.order.action, drillers: 100000 },
      },
    }),
  );
});
