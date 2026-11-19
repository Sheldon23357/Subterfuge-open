import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createRoomHub,
  generateRoomCode,
} from "../packages/server/src/room-hub.js";
import {
  joinAgentRoom,
  probeAgentConnection,
  startAgentConsole,
} from "../packages/ai/src/application/agent-console.js";
import { AgentRuntime } from "../packages/ai/src/reference.js";
import { parseAgentConfig } from "../packages/ai/src/controller/contracts/agent-config.js";
import { controllerSynchronizer } from "../packages/ai/src/application/controller-sync.js";
import type { AddressInfo } from "node:net";
test("room codes contain exactly six uppercase letters and digits, with both represented", () => {
  for (let i = 0; i < 1000; i++) {
    const code = generateRoomCode();
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.match(code, /[A-Z]/);
    assert.match(code, /[0-9]/);
  }
});
test(
  "room creation, concurrent admission, AI identity, start, isolation and restart recovery",
  { timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "subterfuge-hub-"));
    let hub = await createRoomHub({
      directory,
      webRoot: resolve("packages/client/public"),
    });
    const listen = async () => {
      await new Promise<void>((r) => hub.server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
    };
    let origin = await listen();
    const post = (path: string, body: unknown) =>
      fetch(origin + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const create = { key: "a".repeat(64), name: "测试舰队", capacity: 3 };
      const created = await post("/api/rooms", create);
      assert.equal(created.status, 200);
      const host = await created.json();
      assert.equal(host.player, 0);
      assert.equal(host.players, 1);
      assert.match(host.code, /^[A-Z0-9]{6}$/);
      const duplicate = await (await post("/api/rooms", create)).json();
      assert.equal(duplicate.playerToken, host.playerToken);
      assert.equal(duplicate.code, host.code);
      const token = await joinAgentRoom(
        origin,
        host.code.toLowerCase(),
        "b".repeat(64),
      );
      const ai = await probeAgentConnection(origin, token);
      assert.equal(ai.lobbySeat, 1);
      assert.equal(ai.roomId, host.roomId);
      const retries = await Promise.all([
        post(`/api/rooms/${host.code}/join`, { key: "b".repeat(64) }),
        post(`/api/rooms/${host.code}/join`, { key: "b".repeat(64) }),
      ]);
      for (const response of retries)
        assert.equal((await response.json()).playerToken, token);
      const concurrent = await Promise.all(
        ["c", "d"].map((c) =>
          post(`/api/rooms/${host.code}/join`, { key: c.repeat(64) }),
        ),
      );
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (await post("/api/rooms/ZZZ999/join", { key: "e".repeat(64) })).status,
        404,
      );
      assert.equal(
        (await post(`/api/rooms/${host.code}/join`, { key: "invalid" })).status,
        400,
      );
      assert.equal((await fetch(origin + "/lobby/v2")).status, 401);
      const listing = await (await fetch(origin + "/api/rooms")).json();
      assert.equal(listing.rooms[0].players, 3);
      assert.ok(!JSON.stringify(listing).includes(host.playerToken));
      const second = await (
        await post("/api/rooms", {
          key: "f".repeat(64),
          name: "另一海域",
          capacity: 4,
        })
      ).json();
      const runtime = new AgentRuntime(
        parseAgentConfig({
          storeDirectory: join(directory, "private-ai"),
          seats: [],
        }),
        {
          step: async () => {
            throw Error("Unexpected model call");
          },
        },
        {},
        { fixedSlots: true },
      );
      const consoleServer = await startAgentConsole(runtime, {
        webRoot: resolve("packages/client/agent-console-public"),
        provider: "offline",
        connectionMode: "local",
      });
      try {
        const departing = await (
          await post(`/api/rooms/${second.code}/join`, { key: "8".repeat(64) })
        ).json();
        const page = await fetch(consoleServer.url),
          cookie = page.headers.get("set-cookie")!.split(";")[0]!;
        const boot = await (
          await fetch(consoleServer.url + "api/agent/bootstrap", {
            headers: { cookie, "X-Agent-Console": "1" },
          })
        ).json();
        const consolePost = (path: string, body: unknown) =>
          fetch(consoleServer.url + "api/agent/" + path, {
            method: "POST",
            headers: {
              cookie,
              "X-Agent-CSRF": boot.csrf,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const probeResponse = await consolePost("connections/probe", {
          serverUrl: origin,
          roomCode: second.code,
          key: "9".repeat(64),
        });
        assert.equal(probeResponse.status, 200);
        const draft = await probeResponse.json();
        const added = await consolePost("instances", {
          probeId: draft.probeId,
          roomCode:second.code,
          botName:'AI 01',
          settings: { model: "", personality: "schemer" },
        });
        assert.equal(added.status, 201);
        assert.equal((await added.json()).id, "ai-01");
        assert.equal(runtime.status()[0]!.bound, true);
        assert.equal(runtime.status()[0]!.enabled, false);
        assert.equal(runtime.status()[0]!.roomId, second.roomId);
        const links=await (await fetch(origin+`/api/rooms/${second.code}/bots`)).json();
        assert.equal(links.connections.length,1);
        assert.equal(links.connections[0].name,'AI 01');
        assert.equal(links.connections[0].seat,draft.identity.lobbySeat);
        const browserEntryResponse=await consolePost('browser-entry',{id:'ai-01'});
        assert.equal(browserEntryResponse.status,200);
        const browserEntry=await browserEntryResponse.json();
        assert.equal(browserEntry.roomId,second.roomId);assert.equal(browserEntry.code,second.code);
        assert.equal(browserEntry.serverUrl,origin);assert.match(browserEntry.playerToken,/^[a-f0-9]{64}$/);
        const verified=await fetch(origin+`/api/rooms/${second.code}/identity`,{headers:{Authorization:`Bearer ${browserEntry.playerToken}`}});
        assert.equal(verified.status,200);assert.equal((await verified.json()).seat,draft.identity.lobbySeat);
        assert.equal((await fetch(consoleServer.url+'api/agent/browser-entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'ai-01'})})).status,401);
        const synchronize = controllerSynchronizer(runtime, directory, 14311);
        await synchronize();
        assert.equal(
          runtime.status()[0]!.bound,
          true,
          "local polling must preserve manually connected room seats",
        );
        const departingHeaders = {
          Authorization: `Bearer ${departing.playerToken}`,
          "Content-Type": "application/json",
        };
        const departingLobby = await (
          await fetch(origin + "/lobby/v2", { headers: departingHeaders })
        ).json();
        assert.equal(
          (
            await fetch(origin + "/lobby/v2/commands", {
              method: "POST",
              headers: departingHeaders,
              body: JSON.stringify({
                id: "leave-before-start",
                kind: "leave",
                revision: departingLobby.revision,
              }),
            })
          ).status,
          200,
        );
        const starting = runtime.start("ai-01");
        assert.equal(runtime.status()[0]!.calls, 0);
        const secondHeaders = {
          Authorization: `Bearer ${second.playerToken}`,
          "Content-Type": "application/json",
        };
        const secondLobby = await (
          await fetch(origin + "/lobby/v2", { headers: secondHeaders })
        ).json();
        const secondStart = await fetch(origin + "/lobby/v2/commands", {
          method: "POST",
          headers: secondHeaders,
          body: JSON.stringify({
            id: "partial-start",
            kind: "start",
            revision: secondLobby.revision,
          }),
        });
        assert.equal(secondStart.status, 200);
        await starting;
        assert.equal(runtime.status()[0]!.owned, true);
        assert.equal(runtime.status()[0]!.calls, 0);
        assert.equal(runtime.status()[0]!.lobbySeat, 2);
        assert.equal(runtime.status()[0]!.gamePlayer, 1);
        assert.equal(
          (
            await probeAgentConnection(
              origin,
              await joinAgentRoom(origin, second.code, "9".repeat(64)),
            )
          ).chatCount,
          4,
        );
        await runtime.pause("ai-01");
      } finally {
        await consoleServer.close();
        await runtime.shutdown();
      }
      assert.notEqual(second.roomId, host.roomId);
      const headers = {
        Authorization: `Bearer ${host.playerToken}`,
        "Content-Type": "application/json",
      };
      const lobby = await (
        await fetch(origin + "/lobby/v2", { headers })
      ).json();
      const foreign = await (
        await fetch(origin + "/lobby/v2", {
          headers: { Authorization: `Bearer ${second.playerToken}` },
        })
      ).json();
      assert.equal(foreign.roomId, second.roomId);
      const start = await fetch(origin + "/lobby/v2/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "start-hub-test",
          kind: "start",
          revision: lobby.revision,
        }),
      });
      assert.equal(start.status, 200);
      assert.equal(
        (await post(`/api/rooms/${host.code}/join`, { key: "e".repeat(64) }))
          .status,
        409,
      );
      assert.equal(
        (
          await (
            await post(`/api/rooms/${host.code}/join`, { key: "b".repeat(64) })
          ).json()
        ).playerToken,
        token,
      );
      await hub.close();
      hub = await createRoomHub({
        directory,
        webRoot: resolve("packages/client/public"),
      });
      origin = await listen();
      await hub.ready;
      const recovered = await (
        await post(`/api/rooms/${host.code}/join`, { key: "b".repeat(64) })
      ).json();
      assert.equal(recovered.playerToken, token);
      assert.equal(
        (await probeAgentConnection(origin, token)).roomId,
        host.roomId,
      );
      assert.equal(
        (await (await fetch(origin + "/api/rooms")).json()).rooms.length,
        2,
      );
    } finally {
      await hub.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
