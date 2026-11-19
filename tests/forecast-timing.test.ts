import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createFleetScenario,
  submitFleetOrder,
  advanceFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { fleetCountdowns } from "../packages/server/src/planning.js";
function setup(): FleetSetup {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.size = { width: 80, height: 80 };
  cfg.economy.initialTick = 100;
  cfg.positions = { a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, c: { x: 9, y: 0 } };
  cfg.economy.outposts.forEach((o, i) => {
    o.id = ["a", "b", "c"][i]!;
    o.owner = i === 0 ? 0 : 1;
    o.drillers = 100;
  });
  return cfg;
}
test("web ETA includes the original tick fraction and launch countdown subtracts the command phase", () => {
  const cfg = setup();
  cfg.positions.b = { x: 0.275, y: 0 };
  let s = createFleetScenario(cfg);
  s = submitFleetOrder(s, {
    id: "eta",
    player: 0,
    action: { kind: "launch",delaySeconds:600, source: "a", destination: "b", drillers: 10 },
  }).state;
  const before = JSON.stringify(s),
    timing = fleetCountdowns({ state: s, scheduled: [] }).get("eta")!;
  const end = advanceFleetScenario(s, 110),
    arrival = end.events.find(
      (e) => e.subject === "eta" && e.kind === "battle",
    )!;
  const original = (arrival.tick - s.economy.tick - 1 + arrival.fraction) * 10;
  assert.ok(Math.abs(timing.arrivalMinutes! - original) < 1e-8);
  assert.ok(Math.abs(timing.arrivalMinutes! - 65) < 1e-4);
  assert.equal(JSON.stringify(s), before);
  const late = submitFleetOrder(
    createFleetScenario(cfg),
    {
      id: "late",
      player: 0,
      action: { kind: "launch",delaySeconds:600, source: "a", destination: "b", drillers: 10 },
    },
    17,
  ).state;
  assert.equal(
    fleetCountdowns({ state: late, scheduled: [] }).get("late")!
      .departureMinutes,
    10,
  );
  assert.equal(
    fleetCountdowns({ state: late, scheduled: [] }, 77).get("late")!
      .departureMinutes,
    9,
  );
  assert.ok(
    Math.abs(
      fleetCountdowns({ state: s, scheduled: [] }, 60).get("eta")!
        .arrivalMinutes! -
        (original - 1),
    ) < 1e-8,
  );
});
