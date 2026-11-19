import {TICK_MILLISECONDS} from '../packages/server/src/realtime.js';
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
  symlink,
} from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  createFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { createGameOnlyServer } from "../packages/server/src/game-server.js";
import {
  exportGameOnlyCheckpoint,
  restoreGameOnlyCheckpoint,
  verifyGameOnlyCheckpoint,
  type CheckpointCoordinationManifest,
} from "../packages/server/src/game-only-checkpoint.js";
import { RoomStore } from "../packages/server/src/room-store.js";
import type { PlayerAccessFile } from "../packages/server/src/player-access.js";
import type { LabRoom } from "../packages/server/src/planning.js";
import type { ExecutorScope } from "../packages/contracts/src/index.js";

const access: PlayerAccessFile = {
  format: "player-access/1",
  roomId: "game-only-synthetic-room",
  credentials: [
    { player: 0, token: "1".repeat(64) },
    { player: 1, token: "2".repeat(64) },
  ],
};
function initialRoom(): LabRoom {
  const setup = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  setup.size = { width: 80, height: 80 };
  setup.positions = {
    蓝方工厂: { x: 0, y: 0 },
    红方矿场: { x: 20, y: 0 },
    红方后方: { x: 25, y: 0 },
  };
  return {
    state: createFleetScenario(setup),
    scheduled: [],
    playerRoomId: access.roomId,
  };
}
async function fixture(
  t: TestContext,
  extra: Partial<Parameters<typeof createGameOnlyServer>[0]> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "game-only-test-")),
    database = join(directory, "authority.sqlite");
  let now = 1_800_000_000_000;
  const service = await createGameOnlyServer({
    store: database,
    access,
    initialRoom: initialRoom(),
    now: () => now,
    elapsedNow: () => 100,
    checkpointDirectory: join(directory, "checkpoints"),
    ...extra,
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const metadata = (
    checkpointId = "snapshot",
  ): CheckpointCoordinationManifest => {
    const h = service.store.load()!;
    return {
      checkpointId,
      mode: "game-only",
      roomId: access.roomId,
      roomEpoch: service.authority.roomEpoch,
      tick: h.room.state.economy.tick,
      revision: h.revision,
      frozenAtMs: now,
      unsettledCommands: 0,
      participants: [],
    };
  };
  const grant = (
    name = "executor",
    player = 0,
    scopes: ExecutorScope[] = [
      "observe",
      "events.read",
      "commands.write",
      "control.lease",
      "chat.send",
    ],
  ) => {
    const token = "synthetic_only_" + name + "_" + player + "x".repeat(40);
    service.repository.registerGrant({
      grantId: name,
      roomId: access.roomId,
      roomEpoch: service.authority.roomEpoch,
      player,
      scopes,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAtMs: now + 100_000_000,
    });
    return token;
  };
  const address = await service.listen(),
    base = "http://127.0.0.1:" + address.port;
  const call = (
    path: string,
    body?: unknown,
    token = access.credentials[0]!.token,
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: "Bearer " + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    directory,
    database,
    service,
    metadata,
    grant,
    call,
    get now() {
      return now;
    },
    set now(n: number) {
      now = n;
    },
  };
}

test("game-only composition exposes the v2 owner and executor interfaces without UI, model or admin endpoints", async (t) => {
  const x = await fixture(t);
  assert.equal(x.service.server.listening, true);
  const observed = await (await x.call("/player/v2/owner/observation")).json();
  assert.equal(observed.view.player, 0);
  assert.equal(
    observed.view.outposts.find((o: { id: string }) => o.id === "红方矿场")
      .drillers,
    undefined,
  );
  const description = await (await x.call("/player/v2/protocol")).json();
  assert.ok(description.capabilities.includes("core/2"));
  assert.ok(description.capabilities.includes("chat.read/1"));
  assert.deepEqual(description.actionAvailability.uiHidden, [
    "toggle-funding",
    "resign",
  ]);
  for (const path of [
    "/",
    "/player.html",
    "/api/state",
    "/api/export",
    "/api/ai",
    "/admin",
  ])
    assert.equal((await x.call(path)).status, 404);
  const token = x.grant();
  assert.equal(
    (await x.call("/player/v2/model", undefined, token)).status,
    404,
  );
  assert.equal((await x.call("/player/v2/owner/observation", undefined, token)).status, 401);
  const snapshot = await (
    await x.call("/player/v2/snapshot", undefined, token)
  ).json();
  assert.equal(JSON.parse(snapshot.page.text).observation.view.player, 0);
  const first = await x.call("/player/v2/owner/commands", {
    kind: "order",
    clientCommandId: "owner-order",
    expectedRevision: observed.revision,
    payload: { action: { kind: "set-shields", outpostId: "蓝方工厂", enabled: false } },
  });
  assert.equal(first.status, 200);
  assert.equal(x.service.store.load()!.room.state.commands.length, 1);
  const protocolSnapshot = await (
    await x.call("/player/v2/snapshot", undefined, token)
  ).json();
  assert.notEqual(
    JSON.parse(protocolSnapshot.page.text).observation.revision,
    observed.revision,
  );
});

test("explicit existing access is mandatory and mismatch is rejected without listener or credential generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "game-only-access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing-access.json");
  await assert.rejects(
    createGameOnlyServer({
      store: join(directory, "empty.sqlite"),
      access: missing,
      initialRoom: initialRoom(),
    }),
    /ENOENT/,
  );
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(join(directory, "empty.sqlite")), false);
  await assert.rejects(
    createGameOnlyServer({
      store: join(directory, "mismatch.sqlite"),
      access: { ...access, roomId: "another-room" },
      initialRoom: initialRoom(),
    }),
    /another room/,
  );
});

test("v1 owner takeover and v2 executor share one durable fence and real command ledger", async (t) => {
  const x = await fixture(t),
    token = x.grant();
  const hello = await (
    await x.call(
      "/player/v2/sessions/hello",
      {
        supportedVersions: [{ major: 2, minor: 0 }],
        executorInstanceId: "loopback-fixture",
        requiredCapabilities: ["core/2"],
        optionalCapabilities: [],
      },
      token,
    )
  ).json();
  assert.ok(hello.sessionId);
  const acquired = await (
    await x.call(
      "/player/v2/control/acquire",
      {
        roomEpoch: x.service.authority.roomEpoch,
        sessionId: hello.sessionId,
        idempotencyKey: "acquire",
      },
      token,
    )
  ).json();
  const observed = await (await x.call("/player/v2/owner/observation")).json(),
    command = {
      roomEpoch: x.service.authority.roomEpoch,
      sessionId: hello.sessionId,
      fence: acquired.current.generation,
      authorizationVersion: "1",
      idempotencyKey: "stale-order",
      clientCommandId: "stale-order",
      expectedRevision: observed.revision,
      instructionsVersion: "0",
      kind: "order",
      payload: {
        action: { kind: "set-shields", outpostId: "蓝方工厂", enabled: false },
      },
    };
  assert.equal((await x.call("/player/v2/owner/control/takeover", {})).status,404);
  assert.equal(
    (await x.call("/player/v2/owner/control", {action:"takeover",mode:"manual"})).status,
    200,
  );
  const refused = await (
    await x.call("/player/v2/commands", command, token)
  ).json();
  assert.equal(refused.code, "FENCE_STALE");
  assert.equal(x.service.store.load()!.room.state.commands.length, 0);
});

test("authority-only checkpoint is immutable, verified, idempotent, and ignores nearby AI/config/access files", async (t) => {
  const x = await fixture(t);
  for (const name of ["lab-ai.sqlite", "controller.json", "player-access.json"])
    await writeFile(join(x.directory, name), "must never be copied");
  await x.service.chat.sendFromSeat(
    0,
    { id: "persisted-chat", to: 1, text: "private authoritative chat" },
    2,
    0,
  );
  await x.service.commander.worker(
    access.roomId,
    0,
    { op: "notice", id: "notice", reply: "durable commander reply" },
    0,
  );
  const meta = x.metadata(),
    m = await exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      meta,
    ),
    dir = join(x.directory, "checkpoints", "snapshot");
  await assert.rejects(
    createGameOnlyServer({ store: join(dir, "authority.sqlite"), access }),
    /immutable checkpoint/,
  );
  assert.deepEqual((await readdir(dir)).sort(), [
    "authority.sqlite",
    "manifest.json",
  ]);
  assert.deepEqual(await verifyGameOnlyCheckpoint(dir), m);
  assert.deepEqual(
    await exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      meta,
    ),
    m,
  );
  await assert.rejects(
    exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      { ...meta, frozenAtMs: meta.frozenAtMs + 1 },
    ),
    /different intent/,
  );
  const payload = JSON.stringify(m);
  assert.equal(payload.includes(access.credentials[0]!.token), false);
  assert.equal(payload.includes("private authoritative chat"), false);
});

test("clone restores canonical private domains, forks offline once, revokes old grants and preserves source", async (t) => {
  const x = await fixture(t),
    oldToken = x.grant();
  await x.service.chat.sendFromSeat(
    0,
    { id: "clone-chat", to: 1, text: "canonical saved chat" },
    2,
    0,
  );
  await x.service.commander.worker(
    access.roomId,
    0,
    { op: "notice", id: "clone-note", reply: "canonical saved reply" },
    0,
  );
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata(),
  );
  const source = join(x.directory, "checkpoints", "snapshot"),
    before = await readFile(join(source, "authority.sqlite"));
  const restored = await restoreGameOnlyCheckpoint(
    source,
    join(x.directory, "clone"),
    { now: () => x.now + 50_000 },
  );
  assert.notEqual(restored.roomEpoch, x.service.authority.roomEpoch);
  assert.equal(
    existsSync(join(restored.directory, "player-access.json")),
    false,
  );
  const clone = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 60_000,
  });
  try {
    assert.equal(clone.authority.roomEpoch, restored.roomEpoch);
    assert.equal(clone.chat.listForSeat(1)[0]!.text, "canonical saved chat");
    assert.equal(
      clone.commander.read(access.roomId, 0).messages[0]!.text,
      "canonical saved reply",
    );
    const address = await clone.listen();
    const response = await fetch(
      "http://127.0.0.1:" + address.port + "/player/v2/snapshot",
      { headers: { Authorization: "Bearer " + oldToken } },
    );
    assert.equal(response.status, 401);
  } finally {
    await clone.close();
  }
  const reopened = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 70_000,
  });
  try {
    assert.equal(reopened.authority.roomEpoch, restored.roomEpoch);
  } finally {
    await reopened.close();
  }
  assert.deepEqual(await readFile(join(source, "authority.sqlite")), before);
  assert.doesNotThrow(() =>
    x.service.repository.authenticate("Bearer " + oldToken),
  );
  await assert.rejects(
    restoreGameOnlyCheckpoint(source, restored.directory, {
      now: () => x.now + 80_000,
    }),
    /already exists/,
  );
});

test("realtime restore rebases saved phase and activation downtime exactly once", async (t) => {
  const x = await fixture(t, { clock: "realtime" });
  x.now += TICK_MILLISECONDS*123/600; // 123 rule seconds at 10 wall seconds per world day.
  await x.service.sync();
  const original = x.service.store.load()!,
    phase = (await (await x.call("/player/v2/owner/observation")).json())
      .secondsSinceLastTick;
  assert.equal(phase, 123);
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata(),
  );
  const restored = await restoreGameOnlyCheckpoint(
    join(x.directory, "checkpoints", "snapshot"),
    join(x.directory, "clock-clone"),
    { now: () => x.now + 5_000_000 },
  );
  const clone = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 10_000_000,
  });
  const expectedAnchor = original.room.clock!.anchorMs + 10_000_000;
  try {
    assert.equal(
      clone.store.load()!.room.state.economy.tick,
      original.room.state.economy.tick,
    );
    assert.equal(clone.store.load()!.room.clock!.anchorMs, expectedAnchor);
    const address = await clone.listen();
    const response = await (
      await fetch("http://127.0.0.1:" + address.port + "/player/v2/owner/observation", {
        headers: { Authorization: "Bearer " + access.credentials[0]!.token },
      })
    ).json();
    assert.equal(response.secondsSinceLastTick, phase);
  } finally {
    await clone.close();
  }
  const reopened = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 10_001_000,
  });
  try {
    assert.equal(reopened.store.load()!.room.clock!.anchorMs, expectedAnchor);
  } finally {
    await reopened.close();
  }
});

test("export fails closed for changed source head, cancellation, superseded publication, and corrupt/unlisted files", async (t) => {
  const x = await fixture(t),
    meta = x.metadata("changed");
  await assert.rejects(
    exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      { ...meta, revision: meta.revision + 1 },
    ),
    /source changed/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      x.metadata("cancelled"),
      { signal: abort.signal },
    ),
  );
  assert.equal(
    existsSync(join(x.directory, "checkpoints", "cancelled")),
    false,
  );
  await assert.rejects(
    exportGameOnlyCheckpoint(
      x.service.store,
      join(x.directory, "checkpoints"),
      x.metadata("superseded"),
      {
        beforePublish: () => {
          throw Error("superseded authority");
        },
      },
    ),
    /superseded authority/,
  );
  assert.equal(
    existsSync(join(x.directory, "checkpoints", "superseded")),
    false,
  );
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata(),
  );
  const source = join(x.directory, "checkpoints", "snapshot");
  await writeFile(join(source, "credentials.json"), "unexpected");
  await assert.rejects(verifyGameOnlyCheckpoint(source), /unexpected/);
  await rm(join(source, "credentials.json"));
  await writeFile(join(source, "authority.sqlite"), "corrupt");
  await assert.rejects(verifyGameOnlyCheckpoint(source), /checksum/);
});

test("restore rejects manifest traversal, symlinks and destinations inside source before cloning", async (t) => {
  const x = await fixture(t);
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata(),
  );
  const source = join(x.directory, "checkpoints", "snapshot");
  await assert.rejects(
    restoreGameOnlyCheckpoint(source, join(source, "inside"), {
      now: () => x.now + 1000,
    }),
    /inside/,
  );
  const bad = join(x.directory, "bad");
  await mkdir(bad);
  await copyFile(join(source, "manifest.json"), join(bad, "manifest.json"));
  await symlink(
    process.platform==="win32"?source:join(source, "authority.sqlite"),
    join(bad, "authority.sqlite"),
    process.platform==="win32"?"junction":"file",
  );
  await assert.rejects(verifyGameOnlyCheckpoint(bad), /regular/);
  const m = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  m.files[0].path = "../outside.sqlite";
  await writeFile(join(bad, "manifest.json"), JSON.stringify(m));
  await assert.rejects(verifyGameOnlyCheckpoint(bad), /authority file/);
});

test("game-only CLI starts a real server with only explicit synthetic database and access", async (t) => {
  const x = await fixture(t);
  await x.service.close();
  const accessFile = join(x.directory, "synthetic-access.json");
  await writeFile(accessFile, JSON.stringify(access));
  const entry = fileURLToPath(
    new URL("../packages/server/src/game-server.js", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      entry,
      "serve",
      "--database",
      x.database,
      "--access",
      accessFile,
      "--port",
      "0",
    ],
    {
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    stderr = "";
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const ready = await new Promise<{ port: number }>((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(Error("CLI start timeout: " + stderr)),
      15_000,
    );
    child.stdout.on("data", (part) => {
      output += part;
      const line = output.split("\n").find((s) => s.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        try {
          resolveReady(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!output) {
        clearTimeout(timer);
        reject(Error("CLI exited " + code + ": " + stderr));
      }
    });
  });
  const result = await fetch(
    "http://127.0.0.1:" + ready.port + "/player/v2/owner/observation",
    { headers: { Authorization: "Bearer " + access.credentials[0]!.token } },
  );
  assert.equal(result.status, 200);
  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  if(process.platform==="win32")assert.equal(child.signalCode,"SIGTERM");else assert.equal(code,0);
  assert.equal(existsSync(join(x.directory, "lab-ai.sqlite")), false);
});

test("entire game-server runtime import graph is independent of AI, SDK, client and legacy linked checkpoints", () => {
  const start = resolve("packages/server/src/game-server.ts"),
    visited = new Set<string>();
  function inspect(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.doesNotMatch(
      file,
      /packages\/(ai|client|player-sdk)\/|\/(main|lifecycle-main|linked-checkpoints|controller-bindings)\.ts$/,
    );
    const source = readFileSync(file, "utf8");
    const imports = [
      ...source.matchAll(
        /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g,
      ),
    ].map((m) => m[1]!);
    for (const spec of imports) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) inspect(target);
    }
  }
  inspect(start);
  assert.ok(visited.size > 20);
});

test("coordinator publication restores with no inherited freeze and records absent executors honestly", async (t) => {
  const x = await fixture(t, {
    clock: "realtime",
    checkpointTimeouts: {
      prepareMs: 10,
      drainMs: 10,
      freezeMs: 10,
      publishMs: 5000,
      resumeMs: 10,
    },
  });
  const token = x.grant("inspect-checkpoint");
  const saved = await x.service.checkpoints.save(
    "coordinator-clone",
    "coordinated",
  );
  assert.equal(saved.mode, "coordinated");
  assert.equal(saved.participants.length, 2);
  assert.ok(
    saved.participants.every(
      (p) => !p.supported && p.missing === "unsupported",
    ),
  );
  assert.equal(x.service.checkpoints.isPaused(), false);
  const history = await (
    await x.call(
      "/player/v2/checkpoints/current?checkpointId=coordinator-clone",
      undefined,
      token,
    )
  ).json();
  assert.equal(history.checkpoint.phase, "completed");
  const restored = await restoreGameOnlyCheckpoint(
    join(x.directory, "checkpoints", "coordinator-clone"),
    join(x.directory, "coordinator-clone"),
    { now: () => x.now + 50_000 },
  );
  const clone = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 80_000,
  });
  try {
    assert.equal(clone.checkpoints.isPaused(), false);
    const state = JSON.parse(
      clone.repository
        .domainDocument(clone.authority.roomEpoch, "checkpoint", "coordinator")
        .read()!,
    );
    assert.equal(state.activeId, null);
    assert.equal(state.records["coordinator-clone"].phase, "aborted");
    assert.equal(state.records["coordinator-clone"].reason, "restored_clone");
  } finally {
    await clone.close();
  }
});

test("a checkpoint from an activated restored clone can itself be restored with fresh activation metadata", async (t) => {
  const x = await fixture(t);
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata("first-generation"),
  );
  const first = await restoreGameOnlyCheckpoint(
    join(x.directory, "checkpoints", "first-generation"),
    join(x.directory, "first-clone"),
    { now: () => x.now + 1000 },
  );
  const clone = await createGameOnlyServer({
    store: first.database,
    access,
    now: () => x.now + 2000,
  });
  try {
    const head = clone.store.load()!;
    await exportGameOnlyCheckpoint(
      clone.store,
      join(x.directory, "next-checkpoints"),
      {
        checkpointId: "second-generation",
        mode: "game-only",
        roomId: access.roomId,
        roomEpoch: clone.authority.roomEpoch,
        tick: head.room.state.economy.tick,
        revision: head.revision,
        frozenAtMs: x.now + 2000,
        unsettledCommands: 0,
        participants: [],
      },
    );
  } finally {
    await clone.close();
  }
  const second = await restoreGameOnlyCheckpoint(
    join(x.directory, "next-checkpoints", "second-generation"),
    join(x.directory, "second-clone"),
    { now: () => x.now + 3000 },
  );
  const next = await createGameOnlyServer({
    store: second.database,
    access,
    now: () => x.now + 4000,
  });
  try {
    assert.notEqual(next.authority.roomEpoch, first.roomEpoch);
    assert.equal(next.authority.roomEpoch, second.roomEpoch);
  } finally {
    await next.close();
  }
});

test("superseded factory closes listener and owned database even after authority fencing", async (t) => {
  const x = await fixture(t),
    replacement = await createGameOnlyServer({
      store: x.database,
      access,
      now: () => x.now,
    });
  try {
    await x.service.close();
    assert.equal(x.service.server.listening, false);
    await x.service.close();
    assert.throws(() => x.service.store.load());
  } finally {
    await replacement.close();
  }
});

test("checkpoint synchronizes realtime across a tick boundary before pausing", async (t) => {
  const x = await fixture(t, { clock: "realtime", pulseMs: 60_000 }),
    initial = x.service.store.load()!.room.state.economy.tick;
  x.now += TICK_MILLISECONDS*(1+12/600); // One tick and 12 rule seconds.
  const saved = await x.service.checkpoints.save("boundary", "game-only");
  assert.equal(saved.tick, initial + 1);
  const restored = await restoreGameOnlyCheckpoint(
    join(x.directory, "checkpoints", "boundary"),
    join(x.directory, "boundary-clone"),
    { now: () => x.now + 5_000_000 },
  );
  const clone = await createGameOnlyServer({
    store: restored.database,
    access,
    now: () => x.now + 5_000_000,
  });
  try {
    assert.equal(clone.store.load()!.room.state.economy.tick, saved.tick);
    const address = await clone.listen(),
      observed = await (
        await fetch("http://127.0.0.1:" + address.port + "/player/v2/owner/observation", {
          headers: { Authorization: "Bearer " + access.credentials[0]!.token },
        })
      ).json();
    assert.equal(observed.secondsSinceLastTick, 12);
  } finally {
    await clone.close();
  }
});

test("borrowed RoomStore clone needs its explicit marker before first activation", async (t) => {
  const x = await fixture(t);
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata(),
  );
  const restored = await restoreGameOnlyCheckpoint(
      join(x.directory, "checkpoints", "snapshot"),
      join(x.directory, "borrowed-clone"),
      { now: () => x.now + 1000 },
    ),
    store = new RoomStore(restored.database, { wallNow: () => x.now + 2000 });
  try {
    await assert.rejects(
      createGameOnlyServer({ store, access, now: () => x.now + 2000 }),
      /explicit restore marker/,
    );
    const service = await createGameOnlyServer({
      store,
      access,
      restoreMarker: restored.marker,
      now: () => x.now + 2000,
    });
    await service.close();
    assert.ok(store.load());
  } finally {
    store.close();
  }
});

test("checkpoint capability is not advertised without a configured publication directory", async (t) => {
  const x = await fixture(t, { checkpointDirectory: "" }),
    token = x.grant();
  const description = await (await x.call("/player/v2/protocol")).json();
  assert.equal(
    description.capabilities.includes("checkpoints.coordinated/1"),
    false,
  );
  const hello = await x.call(
    "/player/v2/sessions/hello",
    {
      supportedVersions: [{ major: 2, minor: 0 }],
      requiredCapabilities: ["core/2"],
      optionalCapabilities: ["checkpoints.coordinated/1"],
      executorInstanceId: "synthetic-no-checkpoint-directory",
    },
    token,
  );
  assert.equal(hello.status, 200);
  assert.equal(
    (await hello.json()).capabilities.includes("checkpoints.coordinated/1"),
    false,
  );
  const current = await x.call(
    "/player/v2/checkpoints/current",
    undefined,
    token,
  );
  assert.equal(current.status, 200);
  assert.equal((await current.json()).checkpoint, null);
});

test("E03 restoring one checkpoint into two clones forks distinct epochs before either listener and denies the source executor on both", async (t) => {
  const x = await fixture(t),
    token = x.grant();
  await exportGameOnlyCheckpoint(
    x.service.store,
    join(x.directory, "checkpoints"),
    x.metadata("synthetic-e03"),
  );
  const source = join(x.directory, "checkpoints", "synthetic-e03"),
    first = await restoreGameOnlyCheckpoint(
      source,
      join(x.directory, "e03-clone-one"),
      { now: () => x.now + 1000 },
    ),
    second = await restoreGameOnlyCheckpoint(
      source,
      join(x.directory, "e03-clone-two"),
      { now: () => x.now + 1000 },
    );
  assert.notEqual(first.roomEpoch, second.roomEpoch);
  assert.notEqual(first.roomEpoch, x.service.authority.roomEpoch);
  assert.notEqual(second.roomEpoch, x.service.authority.roomEpoch);
  const clones: Awaited<ReturnType<typeof createGameOnlyServer>>[] = [];
  try {
    for (const restored of [first, second]) {
      const clone = await createGameOnlyServer({
        store: restored.database,
        access,
        now: () => x.now + 2000,
      });
      clones.push(clone);
      assert.equal(clone.server.listening, false);
      assert.equal(clone.authority.roomEpoch, restored.roomEpoch);
    }
    for (const clone of clones) {
      const address = await clone.listen(),
        response = await fetch(
          "http://127.0.0.1:" + address.port + "/player/v2/snapshot",
          { headers: { authorization: "Bearer " + token } },
        );
      assert.equal(response.status, 401);
    }
    assert.doesNotThrow(() =>
      x.service.repository.authenticate("Bearer " + token),
    );
  } finally {
    await Promise.all(clones.map((clone) => clone.close()));
  }
});
