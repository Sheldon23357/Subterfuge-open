import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { createGameOnlyServer } from "../packages/server/src/game-server.js";
import {
  GameCheckpointCoordinator,
  type GameCheckpointTimeouts,
} from "../packages/server/src/game-checkpoint-coordinator.js";
import { verifyGameOnlyCheckpoint } from "../packages/server/src/game-only-checkpoint.js";
import type { PlayerAccessFile } from "../packages/server/src/player-access.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const timeouts: GameCheckpointTimeouts = {
  prepareMs: 1000,
  drainMs: 100,
  freezeMs: 1000,
  publishMs: 1500,
  resumeMs: 500,
};
async function fixture(
  t: TestContext,
  limits: GameCheckpointTimeouts = timeouts,
) {
  const dir = mkdtempSync(join(tmpdir(), "game-checkpoint-coordination-")),
    database = join(dir, "authority.sqlite"),
    checkpointDirectory = join(dir, "checkpoints");
  const access: PlayerAccessFile = {
    format: "player-access/1",
    roomId: "synthetic-checkpoint-room",
    credentials: [0, 1].map((player) => ({
      player,
      token: hash("synthetic-checkpoint-owner-" + player),
    })),
  };
  const setup = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  let service = await createGameOnlyServer({
      store: database,
      access,
      initialRoom: {
        state: createFleetScenario(setup),
        scheduled: [],
        playerRoomId: access.roomId,
      },
      checkpointDirectory,
      checkpointTimeouts: limits,
      clock: "manual",
    }),
    address = await service.listen(),
    url = `http://127.0.0.1:${address.port}`,
    grants = 0;
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path: string, token: string, body?: unknown) =>
    fetch(url + "/player/v2" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const connect = async (player = 0, supported = true) => {
    const token = hash("synthetic-checkpoint-executor-" + ++grants);
    service.repository.registerGrant({
      grantId: "synthetic-checkpoint-grant-" + grants,
      roomId: access.roomId,
      roomEpoch: service.repository.currentEpoch(access.roomId),
      player,
      tokenHash: hash(token),
      expiresAtMs: Date.now() + 60_000,
      scopes: [
        "observe",
        "events.read",
        "commands.write",
        "control.lease",
        "commander.worker",
      ],
    });
    const response = await request("/sessions/hello", token, {
      supportedVersions: [{ major: 2, minor: 0 }],
      requiredCapabilities: ["core/2"],
      optionalCapabilities: supported ? ["checkpoints.coordinated/1"] : [],
      executorInstanceId: "synthetic-checkpoint-device-" + grants,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const hello = await response.json();
    assert.equal(
      hello.capabilities.includes("checkpoints.coordinated/1"),
      supported,
    );
    return { token, hello };
  };
  const phase = async (token: string, expected: string, id?: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await request(
        "/checkpoints/current" + (id ? "?checkpointId=" + id : ""),
        token,
      );
      assert.equal(response.status, 200, await response.clone().text());
      const value = (await response.json()).checkpoint;
      if (value?.phase === expected) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Checkpoint did not reach " + expected);
  };
  const ack = (
    client: Awaited<ReturnType<typeof connect>>,
    id: string,
    phase: "prepared" | "frozen" | "resumed",
    receipt?: { receiptId: string; sha256: string },
  ) =>
    request("/checkpoints/ack", client.token, {
      checkpointId: id,
      roomEpoch: client.hello.scope.roomEpoch,
      sessionId: client.hello.sessionId,
      authorizationVersion: client.hello.authorizationVersion,
      phase,
      ...receipt,
    });
  return {
    dir,
    database,
    checkpointDirectory,
    access,
    connect,
    request,
    phase,
    ack,
    get service() {
      return service;
    },
    async crashRestart(afterDatabaseClosed?: () => void) {
      const old = service;
      old.server.closeAllConnections();
      await new Promise<void>((resolve) => old.server.close(() => resolve()));
      old.store.close();
      afterDatabaseClosed?.();
      await old.close().catch(() => {});
      service = await createGameOnlyServer({
        store: database,
        access,
        checkpointDirectory,
        checkpointTimeouts: limits,
        clock: "manual",
      });
      address = await service.listen();
      url = `http://127.0.0.1:${address.port}`;
    },
  };
}

test("coordinated checkpoint persists idempotent HTTP acknowledgements, keeps receipts private, and supports lookup after later saves", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0),
    b = await f.connect(1),
    id = "synthetic-coordinated";
  assert.throws(
    () => f.service.checkpoints.save("synthetic-invalid\n"),
    /Invalid checkpoint identifier/,
  );
  const saving = f.service.checkpoints.save(id, "coordinated");
  void saving.catch(() => {});
  await f.phase(a.token, "preparing");
  assert.equal((await f.ack(a, id, "prepared")).status, 200);
  assert.equal((await f.ack(a, id, "prepared")).status, 200);
  assert.equal((await f.ack(b, id, "prepared")).status, 200);
  await f.phase(a.token, "freezing");
  const ar = {
      receiptId: "synthetic-private-local-a",
      sha256: hash("synthetic-local-a"),
    },
    br = {
      receiptId: "synthetic-private-local-b",
      sha256: hash("synthetic-local-b"),
    };
  assert.equal(
    (await f.ack(a, id, "frozen", { ...ar, sha256: ar.sha256 + "\n" })).status,
    400,
  );
  assert.equal(
    (await f.ack(a, id, "frozen", { ...ar, receiptId: ar.receiptId + "\n" }))
      .status,
    400,
  );
  const accepted = await f.ack(a, id, "frozen", ar);
  assert.equal(accepted.status, 200);
  await accepted.body?.cancel();
  assert.equal((await f.ack(a, id, "frozen", ar)).status, 200);
  assert.equal(
    (await f.ack(a, id, "frozen", { ...ar, sha256: hash("different") })).status,
    409,
  );
  assert.equal((await f.ack(b, id, "frozen", br)).status, 200);
  const state = await f.phase(a.token, "resuming");
  assert.equal(state.participant.sessionId, a.hello.sessionId);
  assert.equal(state.participant.frozen.receiptId, ar.receiptId);
  assert.equal(JSON.stringify(state).includes(br.receiptId), false);
  assert.equal(JSON.stringify(state).includes(br.sha256), false);
  assert.equal((await f.ack(a, id, "resumed")).status, 200);
  assert.equal((await f.ack(b, id, "resumed")).status, 200);
  const result = await saving;
  assert.equal(result.mode, "coordinated");
  assert.equal(result.participants.length, 2);
  assert.ok(result.participants.every((p) => p.frozen));
  assert.equal(f.service.checkpoints.isPaused(), false);
  assert.deepEqual(
    await verifyGameOnlyCheckpoint(join(f.checkpointDirectory, id)),
    result,
  );
  assert.deepEqual(await f.service.checkpoints.save(id, "coordinated"), result);
  await assert.rejects(
    f.service.checkpoints.save(id, "game-only"),
    /different intent/,
  );
  await f.service.checkpoints.save("synthetic-later-save");
  const historical = await f.request(
    "/checkpoints/current?checkpointId=" + id,
    a.token,
  );
  assert.equal(historical.status, 200);
  assert.equal(
    (await historical.json()).checkpoint.participant.frozen.sha256,
    ar.sha256,
  );
  assert.equal((await f.ack(a, id, "frozen", ar)).status, 200);
  assert.equal(
    (await f.ack(a, id, "frozen", { ...ar, receiptId: "conflicting" })).status,
    409,
  );
});

test("coordinated checkpoint records unsupported and absent participants without waiting indefinitely", async (t) => {
  const f = await fixture(t, {
      prepareMs: 50,
      drainMs: 50,
      freezeMs: 50,
      publishMs: 1000,
      resumeMs: 50,
    }),
    a = await f.connect(0),
    b = await f.connect(1, false);
  const coreCursor = f.service.repository.stream(
    f.service.repository.authenticate("Bearer " + b.token),
  ).cursor;
  const result = await f.service.checkpoints.save(
    "synthetic-partial",
    "coordinated",
  );
  const eventResponse = await f.request("/events?after=" + coreCursor, b.token);
  assert.equal(eventResponse.status, 200);
  const checkpointEvents = (await eventResponse.json()).events.filter(
    (e: { type: string }) => e.type.startsWith("checkpoint."),
  );
  assert.ok(checkpointEvents.length > 0);
  assert.ok(
    checkpointEvents.every((e: { required: boolean }) => e.required === false),
  );
  assert.equal(result.participants[0]!.missing, "prepare_timeout");
  assert.equal(result.participants[1]!.missing, "unsupported");
  assert.equal(
    result.participants.some((p) => p.frozen),
    false,
  );
  assert.equal(f.service.checkpoints.isPaused(), false);
  const response = await f.request(
    "/checkpoints/current?checkpointId=synthetic-partial",
    a.token,
  );
  assert.equal(response.status, 200);
  const saved = (await response.json()).checkpoint;
  assert.equal(saved.phase, "completed");
  assert.equal(saved.summary.missing, 2);
  assert.equal((await f.ack(a, "synthetic-partial", "prepared")).status, 409);
  assert.equal((await f.ack(b, "synthetic-partial", "prepared")).status, 403);
});

test("freeze timeout and late acknowledgement cannot mutate the next checkpoint", async (t) => {
  const f = await fixture(t, {
      prepareMs: 500,
      drainMs: 50,
      freezeMs: 70,
      publishMs: 1000,
      resumeMs: 50,
    }),
    a = await f.connect(0);
  const saving = f.service.checkpoints.save(
    "synthetic-freeze-timeout",
    "coordinated",
  );
  void saving.catch(() => {});
  await f.phase(a.token, "preparing");
  assert.equal(
    (await f.ack(a, "synthetic-freeze-timeout", "prepared")).status,
    200,
  );
  const result = await saving;
  assert.equal(result.participants[0]!.missing, "freeze_timeout");
  const next = f.service.checkpoints.save(
    "synthetic-next-attempt",
    "coordinated",
  );
  void next.catch(() => {});
  await f.phase(a.token, "preparing");
  assert.equal(
    (
      await f.ack(a, "synthetic-freeze-timeout", "frozen", {
        receiptId: "synthetic-too-late",
        sha256: hash("late"),
      })
    ).status,
    409,
  );
  const state = await f.phase(a.token, "preparing");
  assert.equal(state.checkpointId, "synthetic-next-attempt");
  assert.equal(state.participant.prepared, false);
  await next;
});

test("all accepted operations count toward drain; coordinated timeout aborts while game-only preserves unresolved authoritative ledger", async (t) => {
  const f = await fixture(t, {
      prepareMs: 50,
      drainMs: 50,
      freezeMs: 50,
      publishMs: 1000,
      resumeMs: 50,
    }),
    a = await f.connect(0, false),
    principal = f.service.repository.authenticate("Bearer " + a.token);
  const receipt = f.service.repository.acceptCommand(principal, {
    roomEpoch: a.hello.scope.roomEpoch,
    sessionId: a.hello.sessionId,
    authorizationVersion: a.hello.authorizationVersion,
    idempotencyKey: "synthetic-still-accepted",
    clientCommandId: "synthetic-still-accepted",
    instructionsVersion: "0",
    kind: "commander-worker",
    payload: {
      op: "notice",
      id: "synthetic-pending-notice",
      reply: "Synthetic pending local discussion",
    },
  });
  assert.equal(receipt.state, "accepted");
  assert.equal(f.service.repository.pendingCommands(f.access.roomId), 1);
  await assert.rejects(
    f.service.checkpoints.save("synthetic-undrained", "coordinated"),
    /drain deadline/,
  );
  assert.equal(f.service.checkpoints.isPaused(), false);
  assert.equal(
    existsSync(join(f.checkpointDirectory, "synthetic-undrained")),
    false,
  );
  const saved = await f.service.checkpoints.save(
    "synthetic-game-only-unresolved",
  );
  assert.equal(saved.unsettledCommands, 1);
  assert.equal(saved.mode, "game-only");
  assert.equal(f.service.repository.pendingCommands(f.access.roomId), 1);
});

test("publication timeout aborts and invalidates the late publication guard", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0, false);
  let guard: (() => void) | undefined, signal: AbortSignal | undefined;
  const coordinator = new GameCheckpointCoordinator({
    repository: f.service.repository,
    roomId: () => f.access.roomId,
    serial: f.service.serial,
    head: () => {
      const head = f.service.store.load()!;
      return { tick: head.room.state.economy.tick, revision: head.revision };
    },
    timeouts: {
      prepareMs: 20,
      drainMs: 20,
      freezeMs: 20,
      publishMs: 40,
      resumeMs: 20,
    },
    publish: async (_metadata, abort, beforePublish) => {
      signal = abort;
      guard = beforePublish;
      return await new Promise<never>(() => {});
    },
  });
  await assert.rejects(
    coordinator.save("synthetic-stalled-publication"),
    /publication deadline/,
  );
  assert.equal(signal?.aborted, true);
  assert.throws(() => guard!(), /no longer active/);
  assert.equal(coordinator.isPaused(), false);
  const state = coordinator.current(
    f.service.repository.authenticate("Bearer " + a.token),
    "synthetic-stalled-publication",
  );
  assert.equal(state.checkpoint?.phase, "aborted");
  await coordinator.close();
});

test("shutdown is bounded, releases the write barrier and retains failed checkpoint status", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0),
    saving = f.service.checkpoints.save("synthetic-shutdown", "coordinated");
  void saving.catch(() => {});
  await f.phase(a.token, "preparing");
  assert.throws(
    () => f.service.checkpoints.assertMutationAllowed("order", "admit"),
    /barrier/,
  );
  assert.doesNotThrow(() =>
    f.service.checkpoints.assertMutationAllowed("order", "settle"),
  );
  assert.doesNotThrow(() =>
    f.service.checkpoints.assertMutationAllowed("control-renew", "admit"),
  );
  assert.doesNotThrow(() =>
    f.service.checkpoints.assertMutationAllowed("control-release", "admit"),
  );
  await f.service.checkpoints.close();
  await assert.rejects(saving, /interrupted|no longer active/);
  assert.equal(f.service.checkpoints.isPaused(), false);
  const response = await f.request(
    "/checkpoints/current?checkpointId=synthetic-shutdown",
    a.token,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).checkpoint.reason, "shutdown");
});

test("process restart clears an interrupted SQL freeze before serving and retains the old acknowledgement", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0),
    saving = f.service.checkpoints.save("synthetic-crashed", "coordinated");
  void saving.catch(() => {});
  await f.phase(a.token, "preparing");
  assert.equal((await f.ack(a, "synthetic-crashed", "prepared")).status, 200);
  await f.phase(a.token, "freezing");
  await f.crashRestart();
  await assert.rejects(saving);
  const next = await f.connect(0),
    response = await f.request(
      "/checkpoints/current?checkpointId=synthetic-crashed",
      next.token,
    );
  assert.equal(response.status, 200);
  const state = (await response.json()).checkpoint;
  assert.equal(state.phase, "aborted");
  assert.equal(state.reason, "server_restart");
  assert.equal(state.participant.prepared, true);
  assert.equal(f.service.checkpoints.isPaused(), false);
  assert.equal(
    (
      await f.ack(a, "synthetic-crashed", "frozen", {
        receiptId: "synthetic-old-process",
        sha256: hash("old"),
      })
    ).status,
    409,
  );
});

test("restart after committed publication preserves the result and frozen acknowledgement without claiming participant resume", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0),
    id = "synthetic-published-before-restart",
    serial = f.service.serial,
    run = serial.run.bind(serial);
  let releaseResume!: () => void,
    resumeBarrierEntered = false,
    resumeBarrierTimedOut = false;
  const resumeBarrier = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resumeBarrierTimedOut = true;
      reject(Error("Synthetic crash barrier timed out before database close"));
    }, 10_000);
    releaseResume = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  // Crash at a committed phase, not within a 500ms polling window. Hold only
  // this save's continuation after the real serial job has committed resuming;
  // the shared queue, HTTP, publication and database remain fully operational.
  serial.run = async <T>(job: () => Promise<T> | T): Promise<T> => {
    const result = await run(job);
    if (
      result !== null &&
      typeof result === "object" &&
      "checkpointId" in result &&
      result.checkpointId === id &&
      "phase" in result &&
      result.phase === "resuming"
    ) {
      assert.ok("result" in result && result.result);
      resumeBarrierEntered = true;
      await resumeBarrier;
    }
    return result;
  };
  try {
    const saving = f.service.checkpoints.save(id, "coordinated");
    void saving.catch(() => {});
    await f.phase(a.token, "preparing");
    assert.equal((await f.ack(a, id, "prepared")).status, 200);
    await f.phase(a.token, "freezing");
    const receipt = {
      receiptId: "synthetic-durable-local-state",
      sha256: hash("synthetic-durable-local-state"),
    };
    assert.equal((await f.ack(a, id, "frozen", receipt)).status, 200);
    const committed = await f.phase(a.token, "resuming");
    assert.equal(resumeBarrierEntered, true);
    assert.deepEqual(committed.participant.frozen, receipt);
    assert.equal(committed.participant.resumed, false);
    // A phase-shaped return is insufficient: real immutable publication must
    // already verify before the database is closed and recovery is exercised.
    const published = await verifyGameOnlyCheckpoint(join(f.checkpointDirectory, id));
    assert.equal(published.checkpointId, id);
    assert.deepEqual(published.participants.find((p) => p.frozen)?.frozen, receipt);
    await f.crashRestart(releaseResume);
    await assert.rejects(saving);
    assert.equal(resumeBarrierTimedOut, false);
    const recovered = await f.connect(0),
      state = await f.phase(recovered.token, "completed", id);
    assert.equal(state.reason, "server_restart");
    assert.equal(state.participant.sessionId, a.hello.sessionId);
    assert.notEqual(state.participant.sessionId, recovered.hello.sessionId);
    assert.deepEqual(state.participant.frozen, receipt);
    assert.equal(state.participant.resumed, false);
    assert.equal(state.participant.missing, "resume_timeout");
    const replay = await f.service.checkpoints.save(id, "coordinated");
    assert.equal(replay.checkpointId, id);
    assert.deepEqual(replay, published);
    assert.deepEqual(
      replay,
      await verifyGameOnlyCheckpoint(join(f.checkpointDirectory, id)),
    );
    assert.equal(f.service.checkpoints.isPaused(), false);
  } finally {
    releaseResume();
    serial.run = run;
  }
});

test("outer SQL rollback publishes neither checkpoint acknowledgement nor its event and retry reads authority", async (t) => {
  const f = await fixture(t),
    a = await f.connect(0),
    id = "synthetic-ack-rollback",
    saving = f.service.checkpoints.save(id, "coordinated");
  void saving.catch(() => {});
  await f.phase(a.token, "preparing");
  const repository = f.service.repository,
    principal = repository.authenticate("Bearer " + a.token),
    input = {
      checkpointId: id,
      roomEpoch: a.hello.scope.roomEpoch,
      sessionId: a.hello.sessionId,
      authorizationVersion: a.hello.authorizationVersion,
      phase: "prepared",
    };
  const cursor = repository.stream(principal).cursor;
  assert.throws(
    () =>
      repository.atomic(() => {
        f.service.checkpoints.ack(principal, input);
        throw Error("synthetic external rollback");
      }),
    /synthetic external rollback/,
  );
  assert.equal(repository.stream(principal).cursor, cursor);
  assert.equal(
    (await f.phase(a.token, "preparing")).participant.prepared,
    false,
  );
  assert.equal((await f.ack(a, id, "prepared")).status, 200);
  await f.phase(a.token, "freezing");
  const receipt = {
      receiptId: "synthetic-rollback-receipt",
      sha256: hash("synthetic-rollback-receipt"),
    },
    freezeCursor = repository.stream(principal).cursor;
  assert.throws(
    () =>
      repository.atomic(() => {
        f.service.checkpoints.ack(principal, {
          ...input,
          phase: "frozen",
          ...receipt,
        });
        throw Error("synthetic frozen rollback");
      }),
    /synthetic frozen rollback/,
  );
  assert.equal(repository.stream(principal).cursor, freezeCursor);
  assert.equal((await f.phase(a.token, "freezing")).participant.frozen, null);
  assert.equal((await f.ack(a, id, "frozen", receipt)).status, 200);
  await f.phase(a.token, "resuming");
  assert.equal((await f.ack(a, id, "resumed")).status, 200);
  assert.equal((await saving).checkpointId, id);
});
