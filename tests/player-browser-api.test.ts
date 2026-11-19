import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFleetScenario,submitFleetOrder,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import {observation} from '../packages/server/src/player-observation.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {
  PlayerAccess,
  SerialExecutor,
} from "../packages/server/src/player-access.js";
import type { LabRoom } from "../packages/server/src/planning.js";
test("player browser serves only its public assets and accepts authenticated same-origin writes", async t => {
  const root = await mkdtemp(join(tmpdir(), "subterfuge-player-web-"));
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.match = { mode: "mining", neptuniumGoal: 99999 };

  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] },
    seconds = 17;
  const h=protocolHarness(t,{room}),access=h.ownerCredentials;
  const api=await createOwnerPlayerApi(h,{webRoot:root,publicOrigin:'https://public-player.example',seconds:()=>seconds});
  try {
    await writeFile(join(root, "player.html"), "<title>Player entry</title>");
    await writeFile(join(root, "player.js"), "/* player bundle */");
    await writeFile(join(root, "prediction-worker.js"), "/* observation-only worker */");
    await writeFile(join(root, "fleet-arrival-worker.js"), "/* selected-fleet worker */");
    await writeFile(join(root, "app.js"), "SECRET LAB");
    await writeFile(join(root, "player-access.json"), "SECRET CREDENTIALS");
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const headers = {
      Authorization: `Bearer ${access.credentials[0]!.token}`,
      Origin: url,
      "Content-Type": "application/json",
    };
    assert.match(await (await fetch(url + "/")).text(), /Player entry/);
    assert.equal((await fetch(url + "/player.js")).status, 200);
    const worker = await fetch(url + '/prediction-worker.js');
    assert.equal(worker.status, 200);
    assert.equal((await fetch(url+'/fleet-arrival-worker.js')).status,200);
    assert.match(worker.headers.get('content-security-policy')!, /worker-src 'self'/);
    assert.equal((await fetch(url + "/player/v2/owner/observation")).status, 401);
    assert.equal((await fetch(url + '/player/v2/owner/observation', {headers: {Origin:'https://public-player.example'}})).status,401);
    assert.equal((await fetch(url + '/player/v2/owner/observation', {headers: {...headers,Origin:'https://public-player.example'}})).status,200);
    assert.equal((await fetch(url + '/player/v2/owner/queries/preview', {method:'POST',headers:{...headers,Origin:'https://public-player.example'},body:'{}'})).status,404);
    assert.equal((await fetch(url + '/player/v2/owner/observation', {headers:{...headers,Origin:'https://foreign.example','X-Forwarded-Proto':'https','X-Forwarded-Host':'public-player.example'}})).status,403);
    for (const path of [
      "/app.js",
      "/player-access.json",
      "/api/state",
      "/api/chat/observer",
      "/api/prediction-source?roomId=global&revision=1",
      "/assets/%2e%2e%2fplayer-access.json",
    ])
      assert.notEqual((await fetch(url + path, { headers })).status, 200);
    assert.equal(
      (
        await fetch(url + "/player/v2/owner/observation", {
          headers: { ...headers, Origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    let observed = await (
      await fetch(url + "/player/v2/owner/observation", { headers })
    ).json();
    const revision = observed.revision;
    seconds = 27;
    const later = await (
      await fetch(url + "/player/v2/owner/observation", { headers })
    ).json();
    assert.equal(later.revision, revision);
    assert.notEqual(
      later.secondsSinceLastTick,
      observed.secondsSinceLastTick,
    );
    const response = await fetch(url + "/player/v2/owner/commands", {
      method: "POST",
      headers: {...headers, Origin:'https://public-player.example'},
      body: JSON.stringify({
        kind:'order',clientCommandId:'browser-check-in',payload:{action:{kind:'check-in'}},expectedRevision:revision,
      }),
    });
    assert.equal(response.status, 200);
    observed = await response.json();
    assert.equal(
      observed.view.self.activity.lastCheckinTime,
      h.store.load()!.room.state.economy.tick * 600 + 27,
    );
    assert.equal(observed.realtime, false);
    assert.equal(observed.historyStartTick, 100);
    assert.ok(
      !(await (await fetch(url + "/")).text()).includes(
        access.credentials[0]!.token,
      ),
    );
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("allied pending orders are shared while enemy plans and allied cancellation remain private", async t => {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.economy.teamSize = 2;
  cfg.economy.players.push(
    { ...cfg.economy.players[0]! },
    { ...cfg.economy.players[0]! },
  );
  let room: LabRoom = { state: createFleetScenario(cfg), scheduled: [] };
  const h=protocolHarness(t,{room}),access=h.ownerCredentials,api=await createOwnerPlayerApi(h);
  try {
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const request = (player: number, path: string, data?: unknown) =>
      fetch(url + path, {
        headers: {
          Authorization: `Bearer ${access.credentials[player]!.token}`,
        },
        ...(data ? { method: "POST", body: JSON.stringify(data) } : {}),
      });
    for (const player of [1, 2]) {
      const seen = await (await request(player, "/player/v2/owner/observation")).json();
      assert.equal(
        (
          await request(player, "/player/v2/owner/commands", {
            kind:'schedule',clientCommandId:`plan-${player}`,expectedRevision:seen.revision,issueTick:102,payload:{action:{kind:'toggle-funding',recipient:0}},
          })
        ).status,
        200,
      );
    }
    const own = await (await request(0, "/player/v2/owner/observation")).json();
    assert.equal(own.scheduled.length, 1);
    assert.equal(own.scheduled[0].player, 1);
    assert.equal(
      (
        await request(0, "/player/v2/owner/commands", {
          kind:'cancel-schedule',clientCommandId:'cancel-ally',expectedRevision:own.revision,payload:{id:own.scheduled[0].id},
        })
      ).status,
      400,
    );
    const inactive=structuredClone(h.store.load()!.room);inactive.state.economy.players[1]!.active=false;
    assert.equal(observation(inactive,0,h.roomId).scheduled.length,0);
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});
