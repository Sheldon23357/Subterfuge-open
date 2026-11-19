import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createFleetScenario,
  fleetMatchOutcome,
  fleetStandings,
  projectPlayerView,
  projectPlayerHistory,
  submitFleetOrder,
  saveFleetSnapshot,
  restoreFleetSnapshot,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import type {LabRoom} from '../packages/server/src/planning.js';
function setup(): FleetSetup {
  return {
    match: { mode: "mining", neptuniumGoal: 200 },
    size: { width: 80, height: 80 },
    positions: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
    economy: {
      initialTick: 100,
      teamSize: 0,
      players: [
        { active: true, neptunium: 0, minesCreated: 0 },
        { active: true, neptunium: 0, minesCreated: 0 },
      ],
      outposts: ["a", "b"].map((id, i) => ({
        id,
        owner: i,
        type: "generator",
        drillers: 10,
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
test("authenticated final standings remain sealed before game end and use original winner ranking after it", async t => {
  let room:LabRoom = { state: createFleetScenario(setup()), scheduled: [] };
  const h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`,
    headers = { Authorization: `Bearer ${h.ownerCredentials.credentials[0]!.token}` };
  try {
    assert.equal((await fetch(url + "/player/v2/owner/standings")).status, 401);
    assert.equal(projectPlayerView(room.state, 0).outposts[1]!.visibility, 0);
    const original = await (
      await fetch(url + "/player/v2/owner/standings", { headers })
    ).json();
    assert.deepEqual(original, { roomId: h.roomId, ended: false });
    const mutate=h.store.load()!,hidden=setup();hidden.economy.players[1]!.neptunium=99;hidden.economy.outposts[1]!.drillers=999;room={state:createFleetScenario(hidden),scheduled:[],playerRoomId:h.roomId};h.store.commit(room,mutate.revision,true);
    assert.deepEqual(
      await (await fetch(url + "/player/v2/owner/standings", { headers })).json(),
      original,
    );
    const cfg = setup();
    cfg.economy.players[0]!.neptunium = 200;
    cfg.economy.players[1]!.neptunium = 250;
    room = { state: createFleetScenario(cfg), scheduled: [],playerRoomId:h.roomId };
    assert.equal(fleetMatchOutcome(room.state)!.triggeringSeat, 0);
    const current=h.store.load()!;h.store.commit(room,current.revision,true);
    const before = JSON.stringify(room);
    const result = await (
      await fetch(url + "/player/v2/owner/standings", { headers })
    ).json();
    assert.deepEqual(result, {
      roomId: h.roomId,
      ...fleetStandings(room.state),
    });
    assert.deepEqual(result.winners, [1]);
    assert.equal(result.players[0]!.seat, 1);
    assert.equal(JSON.stringify(room), before);
    const observation = await (
      await fetch(url + "/player/v2/owner/observation", { headers })
    ).json();
    assert.equal(observation.view.outposts[1].visibility, 2);
    assert.equal(observation.view.outposts[1].drillers, 10);
    assert.equal(
      (await fetch(url + "/player/v2/owner/standings?player=1", { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/player/v2/owner/standings", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("postgame replay opens historical fog only after the present game ends, including restored games", () => {
  let state = createFleetScenario(setup());
  assert.equal(
    projectPlayerHistory(state, 0, 100).view.outposts[1]!.visibility,
    0,
  );
  state = submitFleetOrder(
    state,
    { id: "resign", player: 1, action: { kind: "resign" } },
    30,
  ).state;
  assert.ok(fleetMatchOutcome(state));
  const history = projectPlayerHistory(state, 0, 100, 0);
  assert.equal(history.view.match!.ended, false);
  assert.equal(history.view.fullMapVisible, true);
  assert.equal(history.view.outposts[1]!.visibility, 2);
  const historicalOutpost = history.view.outposts[1]!;
  assert.ok("drillers" in historicalOutpost);
  assert.equal(historicalOutpost.drillers, 10);
  assert.equal(history.view.self.active, true);
  assert.deepEqual(
    projectPlayerHistory(
      restoreFleetSnapshot(saveFleetSnapshot(state)),
      0,
      100,
      0,
    ),
    history,
  );
});
