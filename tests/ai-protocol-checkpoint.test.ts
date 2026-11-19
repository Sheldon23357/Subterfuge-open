import {AgentRuntime} from './helpers/scripted-controller.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createFleetScenario, type FleetSetup } from '../packages/engine/src/index.js';
import { createGameOnlyServer } from '../packages/server/src/game-server.js';
import type { GameCheckpointTimeouts } from '../packages/server/src/game-checkpoint-coordinator.js';
import type { PlayerAccessFile } from '../packages/server/src/player-access.js';import {agentStoreKey} from '../packages/ai/src/reference.js';
import { parseAgentConfig, type AgentSeatConfig } from '../packages/ai/src/controller/contracts/agent-config.js';
import type { AgentProvider } from '../packages/ai/src/controller/contracts/types.js';
import { SqliteProtocolClientStore } from '../packages/ai/src/controller/transport/protocol-store.js';
import { AiStore } from '../packages/ai/src/controller/storage/store.js';
import type { ProtocolHelloResponse } from '../packages/contracts/src/index.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const modelSecret = 'SYNTHETIC_CHECKPOINT_MODEL_SECRET_NEVER_TRANSMIT';
const localMemory = 'SYNTHETIC_PRIVATE_MEMORY_NEVER_UPLOAD';
const defaultTimeouts: GameCheckpointTimeouts = {
  prepareMs: 1000, drainMs: 100, freezeMs: 1000, publishMs: 1500, resumeMs: 500,
};
type RequestRecord = { path: string; body: string; method: string };

async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}

/** Every credential and model result in this fixture is synthetic; HTTP is loopback only. */
async function fixture(t: TestContext, timeouts = defaultTimeouts) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-protocol-checkpoint-'));
  const setup = JSON.parse(readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  const access: PlayerAccessFile = {
    format: 'player-access/1', roomId: 'synthetic-ai-checkpoint-room',
    credentials: setup.economy.players.map((_, player) => ({ player, token: hash('synthetic-owner-' + player) })),
  };
  const service = await createGameOnlyServer({
    store: join(dir, 'authority.sqlite'), access,
    initialRoom: { state: createFleetScenario(setup), scheduled: [], playerRoomId: access.roomId },
    checkpointDirectory: join(dir, 'game-checkpoints'), checkpointTimeouts: timeouts, clock: 'manual',
  });
  const requests: RequestRecord[] = [];
  service.server.on('request', req => {
    const record = { path: req.url ?? '', method: req.method ?? '', body: '' };
    requests.push(record);
    req.on('data', chunk => { record.body += String(chunk); });
  });
  const address = await service.listen(), token = hash('synthetic-checkpoint-executor');
  service.repository.registerGrant({
    grantId: 'synthetic-ai-checkpoint-grant', roomId: access.roomId,
    roomEpoch: service.repository.currentEpoch(access.roomId), player: 0,
    tokenHash: hash(token), expiresAtMs: Date.now() + 120_000,
    scopes: ['observe', 'events.read', 'commands.write', 'control.lease', 'chat.send', 'commander.worker'],
  });
  const config: AgentSeatConfig = {
    id: 'seat0', serverUrl: `http://127.0.0.1:${address.port}`,
    roomId: access.roomId, lobbySeat: 0, gamePlayer: 0, chatPlayer: 0,
    chatCount: setup.economy.players.length, tokenEnv: 'EXECUTOR_TOKEN',
    settings: { model: 'synthetic-test-model', personality: 'schemer' },
  };
  const runtimes: AgentRuntime[] = [];
  const hellos: ProtocolHelloResponse[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.shutdown();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const createRuntime = (seat = config, provider: AgentProvider = {
    step: async () => ({ reply: { tool: 'finish', arguments: {}, summary: 'synthetic finish' }, tokens: 0 }),
  }, fetcher?: typeof fetch) => {
    // The SDK captures fetch at construction. A temporary replacement injects
    // transport loss without changing process-wide behavior during the test.
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await (fetcher ?? original)(input, init);
      if (String(input).endsWith('/sessions/hello') && response.ok) hellos.push(await response.clone().json() as ProtocolHelloResponse);
      return response;
    };
    try {
      const runtime = new AgentRuntime(parseAgentConfig({ storeDirectory: join(dir, 'ai-private'), seats: [seat] }), provider,
        { EXECUTOR_TOKEN: token, OPENAI_API_KEY: modelSecret });
      runtimes.push(runtime);
      return runtime;
    } finally { globalThis.fetch = original; }
  };
  const principal = () => service.repository.authenticate('Bearer ' + token);
  const checkpoint = (id?: string) => service.checkpoints.current(principal(), id).checkpoint;
  return {
    dir, service, requests, config, token, createRuntime, checkpoint,
    hello: () => { assert.ok(hellos.length); return hellos.at(-1)!; },
    database: join(dir, 'ai-private', agentStoreKey(config) + '.sqlite'),
    acks: () => requests.filter(r => r.path === '/player/v2/checkpoints/ack').map(r => JSON.parse(r.body) as Record<string, unknown>),
  };
}

test('Official checkpoint participation is off by default and never starts a model or checkpoint polling', async t => {
  const f = await fixture(t), runtime = f.createRuntime();
  await runtime.tick();
  await until(() => f.requests.some(r => r.path === '/player/v2/sessions/hello'), 'paused discussion did not establish identity');
  const hellos = f.requests.filter(r => r.path === '/player/v2/sessions/hello').map(r => JSON.parse(r.body));
  assert.ok(hellos.every(hello => !hello.optionalCapabilities?.includes('checkpoints.coordinated/1')));
  assert.ok(f.requests.every(r => !r.path.startsWith('/player/v2/checkpoints/')));
  assert.equal(runtime.status()[0]!.enabled, false);
  assert.equal(runtime.status()[0]!.calls, 0);
  assert.deepEqual(f.acks(), []);
});

test('Official checkpoint opt-in is explicit and rejected for legacy transport', async t => {
  const f = await fixture(t);
  assert.throws(() => parseAgentConfig({ storeDirectory: f.dir, seats: [{ ...f.config, protocol: 'v1', coordinatedCheckpoints: true } as any] }), /checkpoint|v2/i);
  assert.throws(() => parseAgentConfig({ storeDirectory: f.dir, seats: [{ ...f.config, coordinatedCheckpoints: 'yes' }] }), /checkpoint|boolean/i);
  assert.equal(parseAgentConfig({ storeDirectory: f.dir, seats: [{ ...f.config, coordinatedCheckpoints: true }] }).seats[0]!.coordinatedCheckpoints, true);
});

test('Opted-in paused runtime saves and restores a local SQLite snapshot, sends only opaque receipts, and stays paused', async t => {
  const f = await fixture(t); let calls = 0;
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async () => { calls++; throw Error('Checkpoint must not call a provider'); } });
  await runtime.pollCheckpoints();
  assert.ok(f.hello().capabilities.includes('checkpoints.coordinated/1'));
  const original = new DatabaseSync(f.database);
  original.exec('PRAGMA journal_mode=WAL; CREATE TABLE synthetic_checkpoint_private_memory(body TEXT NOT NULL)');
  original.prepare('INSERT INTO synthetic_checkpoint_private_memory(body) VALUES(?)').run(localMemory);
  original.close();
  const id = 'synthetic-paused-local-save'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'coordinated checkpoint did not finish');
  const gameManifest = await saving;
  await runtime.pollCheckpoints();
  const participant = gameManifest.participants.find(p => p.supported)!;
  assert.ok(participant?.prepared); assert.ok(participant.frozen,JSON.stringify({participant,checkpoint:(runtime.status()[0] as {checkpoint?:unknown}|undefined)?.checkpoint}));
  assert.deepEqual(f.acks().map(a => a.phase), ['prepared', 'frozen', 'resumed']);
  const receipt = participant.frozen;
  const localDirectory = join(f.dir, 'ai-private', 'protocol-checkpoints', receipt.receiptId);
  assert.deepEqual(readdirSync(localDirectory).sort(), ['manifest.json', 'state.sqlite']);
  const manifest = JSON.parse(readFileSync(join(localDirectory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.checkpointId, id); assert.equal(manifest.receiptId, receipt.receiptId);
  const database = readFileSync(join(localDirectory, 'state.sqlite'));
  assert.equal(manifest.sha256, hash(database)); assert.equal(manifest.bytes, database.byteLength);
  assert.equal(receipt.sha256, manifest.sha256);
  assert.ok(!database.includes(Buffer.from(modelSecret))); assert.ok(!database.includes(Buffer.from(f.token)));
  const backup = new DatabaseSync(join(localDirectory, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT body FROM synthetic_checkpoint_private_memory').get()!.body, localMemory);
    assert.ok(backup.prepare('SELECT document FROM player_protocol_client WHERE singleton=1').get());
  } finally { backup.close(); }
  for (const ack of f.acks()) {
    assert.deepEqual(Object.keys(ack).sort(), (ack.phase === 'frozen'
      ? ['authorizationVersion', 'checkpointId', 'phase', 'receiptId', 'roomEpoch', 'sessionId', 'sha256']
      : ['authorizationVersion', 'checkpointId', 'phase', 'roomEpoch', 'sessionId']).sort());
  }
  for (const serialized of [JSON.stringify(f.requests), JSON.stringify(gameManifest)]) {
    assert.ok(!serialized.includes(localMemory)); assert.ok(!serialized.includes(modelSecret));
    assert.ok(!serialized.includes(f.database)); assert.ok(!serialized.includes(localDirectory));
  }
  assert.ok(f.requests.some(r => r.path === '/player/v2/checkpoints/' + id));
  assert.ok(f.requests.every(r => r.path.startsWith('/player/v2/')));
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.owned, false);
  assert.equal(calls, 0);
  // Restore only to an independent local directory. No server or model is started.
  const restoredDirectory = join(f.dir, 'restored-ai-private'); mkdirSync(restoredDirectory);
  const restoredPath = join(restoredDirectory, 'state.sqlite'); copyFileSync(join(localDirectory, 'state.sqlite'), restoredPath);
  const restored = new AiStore(restoredPath), restoredProtocol = new SqliteProtocolClientStore(restoredPath);
  try {
    assert.equal(restored.load(f.config.roomId, 0)!.enabled, false);
    assert.equal(restored.load(f.config.roomId, 0)!.calls, 0);
    assert.deepEqual(restoredProtocol.load().scope, f.hello().scope);
  } finally { restoredProtocol.close(); restored.close(); }
});

test('Checkpoint preparing drains the in-flight fake model turn and preserves its completed wake without an extra call', async t => {
  const f = await fixture(t); let calls = 0, entered = false;
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async request => {
    calls++; entered = true;
    await Promise.race([gate, new Promise<void>(resolve => { request.signal.addEventListener('abort', () => resolve(), { once: true }); })]);
    return { reply: { tool: 'finish', arguments: {}, summary: 'synthetic in-flight finish' }, tokens: 0 };
  } });
  t.after(release);
  await runtime.start('seat0');
  const turn = runtime.tick();
  await until(() => entered, 'fake model turn did not start');
  const id = 'synthetic-inflight-drain'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(() => f.checkpoint()?.phase === 'preparing', 'server did not begin preparing');
  const preparing = runtime.pollCheckpoints();
  await delay(35);
  assert.equal(f.checkpoint(id)!.participant!.prepared, false);
  assert.equal(f.acks().length, 0, 'must not acknowledge while a model request is in flight');
  assert.equal(calls, 1);
  release(); await turn; await preparing;
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'drained participant did not finish its checkpoint');
  await saving; await runtime.pollCheckpoints();
  assert.equal(runtime.status()[0]!.enabled, true); assert.equal(runtime.status()[0]!.owned, true);
  await runtime.tick(); assert.equal(calls, 1, 'checkpoint completion must not synthesize a new model wake');
});

test('Unresolved same-session worker write never becomes a prepared checkpoint acknowledgement or a replacement command', async t => {
  const f = await fixture(t, { ...defaultTimeouts, prepareMs: 120, freezeMs: 80, resumeMs: 80 });
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true });
  await runtime.pollCheckpoints();
  const hello = f.hello(), transport = new SqliteProtocolClientStore(f.database), key = 'synthetic-unknown-worker';
  transport.transaction(state => {
    state.outbox[JSON.stringify([hello.scope.roomEpoch, key])] = {
      scope: hello.scope,
      request: { roomEpoch: hello.scope.roomEpoch, sessionId: hello.sessionId, authorizationVersion: hello.authorizationVersion,
        idempotencyKey: key, clientCommandId: key, instructionsVersion: '0', kind: 'commander-worker',
        payload: { op: 'notice', id: key, reply: 'Synthetic unknown write' } },
      intentDigest: hash('synthetic-intent'), attempts: 1, state: 'unknown', receipt: null, reason: 'synthetic-lost-response',
    };
  });
  const id = 'synthetic-unknown-not-prepared'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'unknown-write checkpoint did not terminate');
  const result = await saving; await runtime.pollCheckpoints();
  assert.equal(result.participants.find(p => p.supported)!.prepared, false);
  assert.equal(result.participants.find(p => p.supported)!.missing, 'prepare_timeout');
  assert.deepEqual(f.acks(), []);
  assert.equal(Object.values(transport.load().outbox)[0]!.state, 'unknown'); transport.close();
  assert.ok(!f.requests.some(r => r.method === 'POST' && r.path === '/player/v2/commander/worker'));
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.calls, 0);
});

test('A lost frozen acknowledgement is recovered from authoritative history without a second backup or replacement receipt', async t => {
  const f = await fixture(t), network = globalThis.fetch; let dropped = false;
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, undefined, async (input, init) => {
    const response = await network(input, init);
    if (!dropped && String(input).endsWith('/checkpoints/ack') && JSON.parse(String(init?.body)).phase === 'frozen') {
      dropped = true; await response.arrayBuffer(); throw Error('Synthetic response lost after accepted frozen acknowledgement');
    }
    return response;
  });
  await runtime.pollCheckpoints();
  const id = 'synthetic-frozen-ack-lost'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'lost frozen response did not recover');
  const manifest = await saving; await runtime.pollCheckpoints();
  assert.equal(dropped, true);
  const frozen = f.acks().filter(a => a.phase === 'frozen'); assert.equal(frozen.length, 1);
  assert.deepEqual(readdirSync(join(f.dir, 'ai-private', 'protocol-checkpoints')), [String(frozen[0]!.receiptId)]);
  assert.equal(manifest.participants.find(p => p.supported)!.frozen!.receiptId, frozen[0]!.receiptId);
  const transport = new SqliteProtocolClientStore(f.database);
  try {
    const outbox = Object.values(transport.load().checkpointOutbox ?? {});
    assert.equal(outbox.length, 3); assert.ok(outbox.every(row => row.state === 'confirmed'));
  } finally { transport.close(); }
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.calls, 0);
});

test('Resuming acknowledges readiness but cannot reacquire gameplay until a later authoritative terminal query', async t => {
  const f = await fixture(t); let calls = 0;
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async () => {
    calls++; return { reply: { tool: 'finish', arguments: {}, summary: 'synthetic finished before checkpoint' }, tokens: 0 };
  } });
  await runtime.start('seat0'); await runtime.tick(); assert.equal(calls, 1);
  const id = 'synthetic-resuming-no-acquire', saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.catch(() => {});
  await until(() => f.checkpoint()?.phase === 'preparing', 'checkpoint did not prepare');
  await runtime.pollCheckpoints();
  await until(() => f.checkpoint(id)?.phase === 'freezing', 'checkpoint did not freeze');
  await runtime.pollCheckpoints();
  await until(() => f.checkpoint(id)?.phase === 'resuming', 'checkpoint did not enter resuming');
  const acquiredBefore = f.requests.filter(r => r.path === '/player/v2/control/acquire').length;
  await runtime.pollCheckpoints();
  assert.ok(f.acks().some(ack => ack.phase === 'resumed'));
  assert.equal(f.requests.filter(r => r.path === '/player/v2/control/acquire').length, acquiredBefore);
  assert.equal(runtime.status()[0]!.owned, false); assert.equal(calls, 1);
  await saving;
  const beforeTerminalQuery = f.requests.length; await runtime.pollCheckpoints();
  const terminalRequests = f.requests.slice(beforeTerminalQuery);
  const queryIndex = terminalRequests.findIndex(r => r.path === '/player/v2/checkpoints/' + id);
  const acquireIndex = terminalRequests.findIndex(r => r.path === '/player/v2/control/acquire');
  assert.ok(queryIndex >= 0 && acquireIndex > queryIndex, 'reacquisition must follow a fresh authoritative terminal history response');
  assert.equal(runtime.status()[0]!.enabled, true); assert.equal(runtime.status()[0]!.owned, true);
  await runtime.tick(); assert.equal(calls, 1);
});

test('Freeze timeout plus disconnected history keeps a formerly running seat blocked until terminal status can be verified', async t => {
  const f = await fixture(t, { ...defaultTimeouts, freezeMs: 80, resumeMs: 80 }), network = globalThis.fetch;
  let disconnected = false, calls = 0, attemptedCheckpointReads = 0;
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async () => {
    calls++; return { reply: { tool: 'finish', arguments: {}, summary: 'synthetic waiting state' }, tokens: 0 };
  } }, async (input, init) => {
    if (String(input).includes('/checkpoints/')) attemptedCheckpointReads++;
    if (disconnected) throw Error('Synthetic disconnected participant');
    return network(input, init);
  });
  await runtime.start('seat0'); await runtime.tick(); assert.equal(calls, 1);
  const id = 'synthetic-timeout-disconnected', saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.catch(() => {});
  await until(() => f.checkpoint()?.phase === 'preparing', 'checkpoint did not prepare');
  await runtime.pollCheckpoints();
  assert.equal(f.checkpoint(id)!.participant!.prepared, true);
  disconnected = true;
  const manifest = await saving;
  assert.equal(manifest.participants.find(p => p.supported)!.missing, 'freeze_timeout');
  const readsBefore = attemptedCheckpointReads, acquireBefore = f.requests.filter(r => r.path === '/player/v2/control/acquire').length;
  await runtime.pollCheckpoints(); await runtime.tick(); await runtime.pollCheckpoints();
  assert.ok(attemptedCheckpointReads > readsBefore, 'timeout recovery must attempt an authoritative read');
  assert.equal(f.requests.filter(r => r.path === '/player/v2/control/acquire').length, acquireBefore);
  assert.equal(runtime.status()[0]!.owned, false); assert.equal(calls, 1);
  disconnected = false;
  const beforeRecovery = f.requests.length; await runtime.pollCheckpoints();
  assert.equal(f.requests[beforeRecovery]!.path, '/player/v2/checkpoints/' + id);
  assert.equal(runtime.status()[0]!.enabled, true); assert.equal(runtime.status()[0]!.owned, true);
  await runtime.tick(); assert.equal(calls, 1);
});

test('Authoritative aborted history releases the checkpoint barrier without starting a previously paused seat', async t => {
  const f = await fixture(t), runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true });
  await runtime.pollCheckpoints();
  const id = 'synthetic-aborted-paused', saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.catch(() => {});
  await until(() => f.checkpoint()?.phase === 'preparing', 'checkpoint did not prepare');
  await runtime.pollCheckpoints();
  await f.service.checkpoints.close(); await assert.rejects(saving, /interrupted|active|checkpoint/i);
  assert.equal(f.checkpoint(id)!.phase, 'aborted');
  const beforeRecovery = f.requests.length; await runtime.pollCheckpoints();
  assert.equal(f.requests[beforeRecovery]!.path, '/player/v2/checkpoints/' + id);
  assert.ok(!f.requests.slice(beforeRecovery).some(r => r.path === '/player/v2/control/acquire'));
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.owned, false);
  assert.equal(runtime.status()[0]!.calls, 0);
});

for (const kind of ['provider-dispatch-commander']) {
  test(`A durable pending ${kind} blocks prepared even with an empty protocol outbox`, async t => {
    const f = await fixture(t, { ...defaultTimeouts, prepareMs: 120, freezeMs: 80, resumeMs: 80 });
    const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true });
    await runtime.pollCheckpoints();
    const privateStore = new AiStore(f.database);
    privateStore.save(privateStore.load(f.config.roomId, 0)!, kind, { status: 'pending', id: 'synthetic-model-result-unknown' });
    privateStore.close();
    const id = 'synthetic-' + kind; let finished = false;
    const saving = f.service.checkpoints.save(id, 'coordinated');
    void saving.then(() => { finished = true; }, () => { finished = true; });
    await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'pending provider checkpoint did not terminate');
    const manifest = await saving; await runtime.pollCheckpoints();
    assert.equal(manifest.participants.find(p => p.supported)!.prepared, false);
    assert.equal(manifest.participants.find(p => p.supported)!.missing, 'prepare_timeout');
    assert.deepEqual(f.acks(), []);
    const protocolStore = new SqliteProtocolClientStore(f.database);
    try { assert.deepEqual(protocolStore.load().outbox, {}); } finally { protocolStore.close(); }
    assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.owned, false);
    assert.equal(runtime.status()[0]!.calls, 0);
  });
}

test('An explicit user pause during coordination wins over the remembered running state and configuration remains locked', async t => {
  const f = await fixture(t); let calls = 0;
  const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async () => {
    calls++; return { reply: { tool: 'finish', arguments: {}, summary: 'synthetic settled before pause' }, tokens: 0 };
  } });
  await runtime.start('seat0'); await runtime.tick(); assert.equal(calls, 1);
  const id = 'synthetic-user-pause-wins'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(() => f.checkpoint()?.phase === 'preparing', 'checkpoint did not prepare');
  await runtime.pollCheckpoints();
  assert.throws(() => runtime.removeSeat('seat0'), /checkpoint|存档/i);
  assert.throws(() => runtime.configureSeat('seat0', undefined, f.config.settings), /checkpoint|存档/i);
  await runtime.pause('seat0');
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'checkpoint with explicit pause did not finish');
  await saving; await runtime.pollCheckpoints(); await runtime.tick();
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.owned, false);
  assert.equal(calls, 1);
  assert.equal(f.requests.filter(r => r.path === '/player/v2/control/acquire').length, 1);
});

test('A restarted participant reads the previous checkpoint history but cannot acknowledge on behalf of its old session', async t => {
  const f = await fixture(t, { ...defaultTimeouts, freezeMs: 250, resumeMs: 80 });
  const seat = { ...f.config, coordinatedCheckpoints: true };
  let runtime = f.createRuntime(seat); await runtime.pollCheckpoints();
  const previousSession = f.hello().sessionId, id = 'synthetic-restart-old-session'; let finished = false;
  const saving = f.service.checkpoints.save(id, 'coordinated');
  void saving.then(() => { finished = true; }, () => { finished = true; });
  await until(() => f.checkpoint()?.phase === 'preparing', 'checkpoint did not prepare');
  await runtime.pollCheckpoints(); assert.equal(f.acks().length, 1);
  await runtime.shutdown();
  runtime = f.createRuntime(seat);
  await runtime.pollCheckpoints(); assert.notEqual(f.hello().sessionId, previousSession);
  assert.equal(f.acks().length, 1, 'new session must not impersonate the selected old participant');
  await until(async () => { await runtime.pollCheckpoints(); return finished; }, 'restarted participant did not reach terminal history');
  const manifest = await saving; await runtime.pollCheckpoints();
  assert.equal(manifest.participants.find(p => p.supported)!.missing, 'freeze_timeout');
  assert.equal(f.acks().length, 1);
  assert.equal(runtime.status()[0]!.enabled, false); assert.equal(runtime.status()[0]!.owned, false);
  assert.equal(runtime.status()[0]!.calls, 0);
  assert.ok(!f.requests.some(r => r.path === '/player/v2/control/acquire'));
});

for (const wasRunning of [true, false]) {
  test(`Game-only coordination preserves the ${wasRunning ? 'running' : 'paused'} seat without participant acknowledgements`, async t => {
    const f = await fixture(t, { ...defaultTimeouts, drainMs: 250 }); let calls = 0;
    const runtime = f.createRuntime({ ...f.config, coordinatedCheckpoints: true }, { step: async () => {
      calls++; return { reply: { tool: 'finish', arguments: {}, summary: 'synthetic settled game-only state' }, tokens: 0 };
    } });
    if (wasRunning) { await runtime.start('seat0'); await runtime.tick(); }
    else await runtime.pollCheckpoints();
    const hello = f.hello(), key = 'synthetic-game-only-held-worker';
    // An unrelated authoritative accepted operation makes the real game-only
    // drain observable; this client's durable outbox remains empty.
    const receipt = f.service.repository.acceptCommand(f.service.repository.authenticate('Bearer ' + f.token), {
      roomEpoch: hello.scope.roomEpoch, sessionId: hello.sessionId, authorizationVersion: hello.authorizationVersion,
      idempotencyKey: key, clientCommandId: key, instructionsVersion: '0', kind: 'commander-worker',
      payload: { op: 'notice', id: key, reply: 'Synthetic accepted operation for game-only drain' },
    });
    assert.equal(receipt.state, 'accepted');
    const id = 'synthetic-game-only-' + (wasRunning ? 'running' : 'paused'), saving = f.service.checkpoints.save(id, 'game-only');
    void saving.catch(() => {});
    await until(() => f.checkpoint()?.phase === 'draining', 'game-only checkpoint did not remain in drain');
    await runtime.pollCheckpoints(); await runtime.tick();
    const manifest = await saving, beforeRecovery = f.requests.length;
    await runtime.pollCheckpoints();
    assert.equal(f.requests[beforeRecovery]!.path, '/player/v2/checkpoints/' + id);
    assert.equal(manifest.mode, 'game-only'); assert.deepEqual(manifest.participants, []);
    assert.deepEqual(f.acks(), []);
    assert.equal(runtime.status()[0]!.enabled, wasRunning); assert.equal(runtime.status()[0]!.owned, wasRunning);
    assert.equal(f.requests.filter(r => r.path === '/player/v2/control/acquire').length, wasRunning ? 1 : 0,
      'game-only completion must reuse the same valid lease, not wait on or reacquire itself');
    await runtime.tick(); assert.equal(calls, wasRunning ? 1 : 0);
  });
}
