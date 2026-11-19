import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createFleetScenario,
  advanceFleetScenario,
  submitFleetOrder,
  projectPlayerNotifications,
  saveFleetSnapshot,
  restoreFleetSnapshot,
  type FleetSetup,

} from "../packages/engine/src/index.js";
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import type {LabRoom} from '../packages/server/src/planning.js';
function setup(): FleetSetup {
  return {
    size: { width: 80, height: 80 },
    positions: {
      a: { x: 0, y: 0 },
      b: { x: 1, y: 0 },
      c: { x: 30, y: 0 },
      d: { x: 2, y: 0 },
    },
    economy: {
      initialTick: 100,
      teamSize: 0,
      players: Array.from({ length: 4 }, () => ({
        active: true,
        neptunium: 0,
        minesCreated: 0,
      })),
      outposts: ["a", "b", "c", "d"].map((id, i) => ({
        id,
        owner: i,
        type: "generator",
        drillers: i === 0 ? 100 : 3,
        shield: 0,
        shieldMax: 0,
        shieldsEnabled: true,
        productionProgress: 0,
        miningProgress: 0,
        shieldProgress: 0,
        minePending: false,
        shieldDisablePending: false,
      })),
    },
  };
}

function attack(cfg = setup()) {
  return submitFleetOrder(createFleetScenario(cfg), {
    id: "attack",
    player: 0,
    action: {
      kind: "launch",delaySeconds:600,
      source: "a",
      destination: "b",
      drillers: 20,

    },
  }).state;
}

test("attack warnings go to target owner; ordinary observers and allies are excluded", () => {
  const base = attack(),
    departed = advanceFleetScenario(base, 102);
  assert.deepEqual(projectPlayerNotifications(base, 1), []);
  assert.equal(
    projectPlayerNotifications(departed, 1).filter((n) => n.kind === "departed")
      .length,
    1,
  );
  for (const seat of [0, 2, 3])
    assert.equal(
      projectPlayerNotifications(departed, seat).some(
        (n) => n.kind === "departed",
      ),
      false,
    );
  const cfg=setup();
  cfg.economy.teamSize = 2;
  cfg.economy.outposts[1]!.owner = 2;
  cfg.economy.outposts[2]!.owner = 1;
  const allied = advanceFleetScenario(attack(cfg), 102);
  assert.equal(
    projectPlayerNotifications(allied, 1).some((n) => n.kind === "departed"),
    false,
  );
  assert.equal(
    projectPlayerNotifications(allied, 2).some((n) => n.kind === "departed"),
    true,
  );
});
test("battle details stay with participants; mine takeover is public without combat data or troop counts", () => {
  const cfg = setup();
  cfg.economy.outposts[1]!.type = "mine";

  const state = advanceFleetScenario(attack(cfg), 150),
    before = JSON.stringify(state);
  for (const seat of [0, 1]) {
    const battle = projectPlayerNotifications(state, seat).find(
      (n) => n.kind === "battle",
    )!;
    assert.ok(battle.battle);
    assert.equal(battle.battle.attacker.before, 20);
    assert.equal(battle.battle.defender.before, 3);

    assert.equal(battle.location?.id, "b");
  }
  for (const seat of [2, 3]) {
    const list = projectPlayerNotifications(state, seat);
    assert.equal(
      list.some((n) => n.battle),
      false,
    );
    assert.ok(list.some((n) => n.kind === "mine-captured"));
    for (const key of [
      "secret-hero",
      "WarHero",
      "attackerBefore",
      "drillers",
      "shield",
    ])
      assert.equal(JSON.stringify(list).includes(key), false);
  }
  assert.equal(JSON.stringify(state), before);
  const clone = projectPlayerNotifications(state, 1);
  clone[0]!.text = "mutated";
  assert.notEqual(projectPlayerNotifications(state, 1)[0]!.text, "mutated");
  assert.deepEqual(
    projectPlayerNotifications(
      restoreFleetSnapshot(saveFleetSnapshot(state)),
      1,
    ),
    projectPlayerNotifications(state, 1),
  );
  assert.deepEqual(
    projectPlayerNotifications(structuredClone(state), 1),
    projectPlayerNotifications(state, 1),
  );
});
test("historical recipients and positions survive later captures and player elimination", () => {
  const cfg = setup();
  cfg.match = { mode: "mining", neptuniumGoal: 200 };
  let state = advanceFleetScenario(attack(cfg), 102);
  const original = projectPlayerNotifications(state, 1).filter(
    (n) => n.kind === "departed",
  );
  state = advanceFleetScenario(state, 150);
  assert.equal(state.economy.players[1]!.active,false);
  assert.deepEqual(
    projectPlayerNotifications(state, 1).filter((n) => n.kind === "departed"),
    original,
  );
  assert.equal(original[0]!.location!.kind, "fleet");
  assert.equal(original[0]!.location!.position.x, 0); // eF notifies before fractional movement.
  assert.equal(
    projectPlayerNotifications(state, 2).some((n) => n.kind === "battle"),
    false,
  );
});




test("funding and activity notices stay private; invalid funding reports both affected players", () => {
  const cfg = setup();
  cfg.match = { mode: "mining", neptuniumGoal: 200 };
  cfg.economy.players[0]!.neptunium = 20;
  cfg.economy.outposts[1]!.type = "mine";
  cfg.economy.outposts[1]!.miningProgress = 143;
  let state = submitFleetOrder(createFleetScenario(cfg), {
    id: "fund",
    player: 0,
    action: { kind: "toggle-funding", recipient: 1 },
  }).state;
  assert.ok(
    projectPlayerNotifications(state, 0).some(
      (n) => n.kind === "funding-toggled" && !n.sendNotification,
    ),
  );
  assert.ok(
    projectPlayerNotifications(state, 1).some(
      // Hne keeps the donor's false push flag in the later recipient iteration.
      (n) => n.kind === "funding-toggled" && !n.sendNotification,
    ),
  );
  assert.equal(
    projectPlayerNotifications(state, 2).some((n) =>
      n.kind.startsWith("funding"),
    ),
    false,
  );
  state = advanceFleetScenario(state, 101);
  for (const seat of [0, 1])
    assert.ok(
      projectPlayerNotifications(state, seat).some(
        (n) => n.kind === "funding-expired",
      ),
    );
  state = advanceFleetScenario(state, 196);
  const own = projectPlayerNotifications(state, 0).filter(
    (n) => n.kind === "inactivity-warning",
  );
  assert.equal(own.length, 1);
  assert.equal(own[0]!.urgent, false);
  assert.match(own[0]!.text, /16 hours/);
  assert.equal(
    projectPlayerNotifications(state, 1).filter(
      (n) => n.kind === "inactivity-warning",
    ).length,
    1,
  );
  assert.equal(own[0]!.text.includes("P1"), false);
});
test("Asset loss broadcasts elimination to then-active seats and final results use native winners for every seat", () => {
  const cfg = setup();
  cfg.match = { mode: "mining", neptuniumGoal: 200 };

  let state = advanceFleetScenario(attack(cfg), 150);
  for (const seat of [0, 2, 3])
    assert.ok(
      projectPlayerNotifications(state, seat).some(
        (n) => n.kind === "player-eliminated",
      ),
    );
  assert.equal(
    projectPlayerNotifications(state, 1).some(
      (n) => n.kind === "player-eliminated",
    ),
    false,
  );
  for (const seat of [2, 3])
    state = submitFleetOrder(state, {
      id: "resign-" + seat,
      player: seat,
      action: { kind: "resign" },
    }).state;
  for (const seat of [0, 1, 2, 3])
    assert.ok(
      projectPlayerNotifications(state, seat).some(
        (n) => n.kind === "game-ended" && n.text.includes("P0 wins"),
      ),
    );
  assert.deepEqual(
    projectPlayerNotifications(
      restoreFleetSnapshot(saveFleetSnapshot(state)),
      2,
    ),
    projectPlayerNotifications(state, 2),
  );
});


test("native Pc delivery gate retains pre-death archive, suppresses new private events, and allows final results", () => {
  const cfg = setup();
  cfg.match = { mode: "mining", neptuniumGoal: 200 };
  let state = submitFleetOrder(createFleetScenario(cfg), {
    id: "resign1",
    player: 1,
    action: { kind: "resign" },
  }).state;
  const previous = projectPlayerNotifications(state, 1);
  state = submitFleetOrder(state, {
    id: "after-death",
    player: 0,
    action: { kind: "launch",delaySeconds:600, source: "a", destination: "b", drillers: 20 },
  }).state;
  state = advanceFleetScenario(state, 150);
  assert.deepEqual(projectPlayerNotifications(state, 1), previous);
  assert.ok(projectPlayerNotifications(state, 0).some((n) => n.battle));
  for (const seat of [2, 3])
    state = submitFleetOrder(state, {
      id: "resign-" + seat,
      player: seat,
      action: { kind: "resign" },
    }).state;
  assert.ok(
    projectPlayerNotifications(state, 1).some((n) => n.kind === "game-ended"),
  );
  assert.deepEqual(
    projectPlayerNotifications(
      restoreFleetSnapshot(saveFleetSnapshot(state)),
      1,
    ),
    projectPlayerNotifications(state, 1),
  );
});
test("notification v2 owner endpoint filters before pagination and forbids identity spoofing and writes", async t => {
  let room:LabRoom = { state: advanceFleetScenario(attack(), 150), scheduled: [] };
  const h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/player/v2/owner/notifications`;
  const get = (seat: number, query = "") =>
    fetch(base + query, {
      headers: {
        Authorization: `Bearer ${h.ownerCredentials.credentials[seat]!.token}`,
      },
    });
  try {
    assert.equal((await fetch(base)).status, 401);
    const first = await (await get(1, "?after=0&limit=1")).json();
    assert.equal(first.notifications.length, 1);
    assert.equal(first.notifications[0].id, 0);
    assert.equal(first.nextCursor, 1);
    assert.equal(first.hasMore, true);
    const next = await (await get(1, "?after=1")).json();
    assert.equal(next.notifications[0].id, 1);
    assert.ok(next.notifications[0].battle);
    const spectator = await (await get(2)).json();
    assert.deepEqual(spectator.notifications, []);
    assert.equal(spectator.nextCursor, 0);
    assert.equal(spectator.hasMore, false);
    assert.deepEqual((await (await get(2, "?after=0")).json()).notifications, []);
    for (const query of [
      "?player=1",
      "?after=0&after=0",
      "?after=99999",
      "?limit=0",
      "?limit=201",
      "?after=1.5",
      "?after=-1",
    ])
      assert.equal((await get(1, query)).status, 400);
    assert.equal(
      (
        await fetch(base, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${h.ownerCredentials.credentials[1]!.token}`,
          },
          body: "{}",
        })
      ).status,
      404,
    );
    const before = JSON.stringify(h.store.load()!.room);
    await get(1);
    assert.equal(JSON.stringify(h.store.load()!.room), before);
    const current=h.store.load()!;
    room = {
      ...current.room,
      state: submitFleetOrder(current.room.state, {
        id: "private-shield",
        player: 3,
        action: { kind: "set-shields", outpostId: "d", enabled: false },
      }).state,
    };
    h.store.commit(room,current.revision);
    assert.deepEqual(await (await get(2)).json(), spectator);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
