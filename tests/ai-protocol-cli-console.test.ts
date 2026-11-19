import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createFleetScenario, type FleetSetup } from '../packages/engine/src/index.js';
import { createGameOnlyServer } from '../packages/server/src/game-server.js';
import type { PlayerAccessFile } from '../packages/server/src/player-access.js';

const cli = fileURLToPath(new URL('../packages/ai/src/application/agent-cli.js', import.meta.url));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type WireRequest = { path: string; authorization: string; body: string };
type ConsoleSeat = {
  id: string; protocol?: string; enabled: boolean; owned: boolean; calls: number;
  telemetry?:{round:number}; tokens: number; busy?:boolean; status: string; bound?: boolean; roomId: string; error: string | null;
};
type ConsoleStatus = {
  fixedSlots: boolean; connectionMode: 'configured' | 'local'; seats: ConsoleSeat[];
  jobs: { id: string; status: 'running' | 'completed' | 'failed'; error?: string }[];
};
type ConsoleConfig = {
  seats: {
    id: string; protocol: string;
    settings: { model: string; personality: string };
    providerConfig: { kind: string; hasKey: boolean };
  }[];
};

async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}

function assertStopped(child:ChildProcess,output:string){
 assert.equal(child.exitCode,0,output);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  // Windows kill(SIGTERM) bypasses Node signal handlers. The synthetic preload
  // bridges IPC to the same handler so this test verifies actual durable close.
  if(process.platform==='win32'&&child.connected)child.send({type:'synthetic-stop'});else child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(force); }
}

/** Isolated real CLI processes, fake credentials, a real game-only authority, and no model keys. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-v2-cli-console-'));
  const localDirectory = join(directory, 'runtime'), webRoot = join(directory, 'web');
  await mkdir(localDirectory); await mkdir(webRoot);
  await Promise.all([
    writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Synthetic console fixture</title>'),
    writeFile(join(webRoot, 'agent-console.js'), '// Synthetic fixture; API tests do not need a bundle.\n'),
    writeFile(join(webRoot, 'agent-console.css'), 'body { color: black; }\n'),
  ]);
  const setup = JSON.parse(readFileSync('examples/fleet-lab.json', 'utf8')).initial as FleetSetup;
  const access: PlayerAccessFile = {
    format: 'player-access/1', roomId: 'synthetic-configured-cli-room',
    credentials: setup.economy.players.map((_, player) => ({ player, token: hash('synthetic-cli-owner-' + player) })),
  };
  let elapsed = 0;
  const service = await createGameOnlyServer({
    store: join(directory, 'authority.sqlite'), access, clock: 'manual', elapsedNow: () => elapsed,
    initialRoom: { state: createFleetScenario(setup), scheduled: [], playerRoomId: access.roomId },
  });
  elapsed = 31_000;
  const requests: WireRequest[] = [];
  service.server.on('request', req => {
    const record = { path: req.url ?? '', authorization: String(req.headers.authorization ?? ''), body: '' };
    requests.push(record); req.on('data', chunk => { record.body += String(chunk); });
  });
  const address = await service.listen();
  const tokens = access.credentials.map((_, player) => {
    const token = hash('synthetic-cli-executor-' + player);
    service.repository.registerGrant({
      grantId: 'synthetic-cli-grant-' + player, roomId: access.roomId,
      roomEpoch: service.authority.roomEpoch, player, tokenHash: hash(token),
      expiresAtMs: Date.now() + 300_000,
      scopes: ['observe', 'events.read', 'commands.write', 'control.lease', 'chat.send', 'commander.worker'],
    });
    return token;
  });
  const trapRequests: string[] = [];
  const trap = createServer((req, res) => {
    trapRequests.push(JSON.stringify({ path: req.url, authorization: req.headers.authorization }));
    req.resume(); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"synthetic local trap"}');
  });
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
  const trapAddress = trap.address(); assert.ok(trapAddress && typeof trapAddress === 'object');

  // Observe reads as well as writes. This preload does not change the filesystem
  // results; it records access to only this test's synthetic local handoff folder.
  const auditPath = join(directory, 'local-access.jsonl'), preload = join(directory, 'audit-local.cjs');
  await writeFile(auditPath, '');
  await writeFile(preload, `
process.on('message', message => { if(message && message.type==='synthetic-stop') process.emit('SIGTERM'); });
process.channel?.unref();
const fs = require('node:fs');
const promises = require('node:fs/promises');
const { resolve, relative, isAbsolute } = require('node:path');
const { fileURLToPath } = require('node:url');
const append = fs.appendFileSync.bind(fs);
// Node resolves the working directory through symlinks (for example macOS /var).
const root = fs.realpathSync(process.env.SYNTHETIC_LOCAL_ROOT);
function record(operation, value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const path = resolve(value), rel = relative(root, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    append(process.env.SYNTHETIC_LOCAL_AUDIT, JSON.stringify({ operation, path }) + '\\n');
}
for (const [object, suffix] of [[fs, 'Sync'], [promises, '']]) {
  for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'readdir', 'open', 'access', 'mkdir', 'rename', 'unlink', 'rm']) {
    const key = name + suffix, original = object[key];
    if (typeof original !== 'function') continue;
    object[key] = function (...args) {
      record(key, args[0]);
      if (name === 'rename') record(key, args[1]);
      return Reflect.apply(original, this, args);
    };
  }
}
require('node:module').syncBuiltinESMExports();
// Old broken CLI versions must not contact an actual default local game port.
const fetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!process.env.SYNTHETIC_ALLOWED_ORIGINS.split(',').includes(url.origin)) {
    append(process.env.SYNTHETIC_LOCAL_AUDIT, JSON.stringify({ operation: 'unexpected-fetch', origin: url.origin }) + '\\n');
    return Promise.reject(new Error('Synthetic test forbids non-fixture HTTP origins'));
  }
  return fetch(input, init);
};
`);
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(stop));
    trap.closeAllConnections(); await new Promise<void>(resolve => trap.close(() => resolve()));
    await service.close(); await rm(directory, { recursive: true, force: true });
  });
  const start = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = spawn(process.execPath, ['--require', preload, cli, ...args], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
        SYNTHETIC_LOCAL_ROOT: localDirectory, SYNTHETIC_LOCAL_AUDIT: auditPath,
        SYNTHETIC_ALLOWED_ORIGINS: `http://127.0.0.1:${address.port},http://127.0.0.1:${trapAddress.port}`,
        SYNTHETIC_EXECUTOR_0: tokens[0], SYNTHETIC_EXECUTOR_1: tokens[1], ...extraEnv,
      },
    });
    children.push(child);
    let stdout = '', stderr = '', spawnError: Error | undefined;
    child.stdout!.on('data', value => { stdout += String(value); });
    child.stderr!.on('data', value => { stderr += String(value); });
    child.on('error', error => { spawnError = error; });
    return {
      child, output: () => stdout + stderr,
      console: async () => {
        let url = '';
        await until(() => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null) throw Error('CLI exited before console startup: ' + stdout + stderr);
          url = stdout.split(/\r?\n/).find(line => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)) ?? '';
          return !!url;
        }, 'CLI did not announce its console URL').catch(error=>{throw new Error(`${error.message}; child output: ${stdout}${stderr}`,{cause:error});});
        const page = await fetch(url); assert.equal(page.status, 200);
        const cookie = page.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
        const bootstrap = await fetch(url + 'api/agent/bootstrap', { headers: { cookie, 'x-agent-console': '1' } });
        assert.equal(bootstrap.status, 200); const { csrf } = await bootstrap.json() as { csrf: string };
        const api = (path: string, body?: unknown) => fetch(url + 'api/agent/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { cookie, 'x-agent-csrf': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const status = async () => {
          const response = await api('status'); assert.equal(response.status, 200);
          return response.json() as Promise<ConsoleStatus>;
        };
        const action = async (id: string, action: 'start' | 'pause') => {
          const response = await api('action', { id, action });
          assert.equal(response.status, 202, await response.clone().text());
          const { job } = await response.json() as { job: { id: string } };
          await until(async () => {
            const result = (await status()).jobs.find(item => item.id === job.id); assert.ok(result);
            assert.notEqual(result.status, 'failed', JSON.stringify(result));
            return result.status === 'completed';
          }, `CLI ${action} did not complete for ${id}`);
        };
        return { url, api, status, action };
      },
    };
  };
  const configPath = join(directory, 'configured.json');
  const seats = ['arbitrary-v2-seat', 'ai-01'].map((id, player) => ({
    id, serverUrl: `http://127.0.0.1:${address.port}`, roomId: access.roomId,
    lobbySeat: player, gamePlayer: player, chatPlayer: player, chatCount: access.credentials.length,
    tokenEnv: `SYNTHETIC_EXECUTOR_${player}`, settings: { model: 'synthetic-initial-model', personality: 'schemer' },
  }));
  await writeFile(configPath, JSON.stringify({ storeDirectory: join(directory, 'private'), pollMs: 1000, seats }));
  const consoleArgs = ['--console', '0', '--console-web-root', webRoot];
  return { directory, localDirectory, auditPath, service, access, requests, tokens, trapRequests, trapPort: trapAddress.port, configPath, seats, start, consoleArgs };
}

test('CLI --config --console keeps arbitrary and ai-01 v2 seats visible, paused, isolated, and controllable across restart', { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const originalConfigBytes = await readFile(f.configPath);
  const localToken = hash('synthetic-decoy-local-owner-never-read');
  const sentinels: Record<string, string> = {
    'controller-bindings.json': JSON.stringify({ format: 'controller-bindings/1', roomId: 'synthetic-local-decoy', bindings: [{ seat: 0, slot: 0 }] }),
    'player-access.json': JSON.stringify({ format: 'player-access/1', roomId: 'synthetic-local-decoy', credentials: [{ player: 0, token: localToken }, { player: 1, token: hash('synthetic-decoy-other-owner') }] }),
    'ai-controller-slots.json': '{"synthetic":"must not publish over local slot manifest"}',
    'checkpoint-request.json': JSON.stringify({ format: 'linked-checkpoint-request/1', id: '11111111-1111-4111-8111-111111111111', roomId: 'synthetic-local-decoy', bindings: [], expiresAt: Date.now() + 60_000, phase: 'release' }),
    'checkpoint-response.json': '{"synthetic":"must not acknowledge local checkpoint"}',
  };
  for (const [name, contents] of Object.entries(sentinels)) await writeFile(join(f.localDirectory, name), contents);
  const args = ['--config', f.configPath, ...f.consoleArgs];
  const first = f.start(args), browser = await first.console();
  const initial = await browser.status();
  assert.equal(initial.fixedSlots, false, 'configured mode must not hide seats behind the local eight-slot controller');
  assert.equal(initial.connectionMode, 'configured');
  assert.deepEqual(initial.seats.map(seat => seat.id).sort(), ['ai-01', 'arbitrary-v2-seat']);
  for (const seat of initial.seats) {
    assert.equal(seat.protocol, 'v2'); assert.equal(seat.enabled, false); assert.equal(seat.owned, false);
    assert.equal(seat.status, 'paused'); assert.equal(seat.calls, 0);
  }
  // Wait through both old local timers and trigger the former local-import API.
  await delay(2200);
  const local = await browser.api('connections/local', {}); assert.equal(local.status, 409);
  assert.deepEqual((await browser.status()).seats.map(seat => seat.id).sort(), ['ai-01', 'arbitrary-v2-seat']);
  assert.ok((await browser.status()).seats.every(seat => !seat.enabled && seat.calls === 0));
  const savedCalls = new Map<string, number>();
  for (const id of ['arbitrary-v2-seat', 'ai-01']) {
    const configured = await browser.api('configuration', {
      id, provider: { kind: 'offline', model: 'synthetic-console-offline' }, settings: { model: '', personality: 'merchant' },
    });
    assert.equal(configured.status, 200, await configured.clone().text());
    const value = await configured.json() as { settings: { model: string; personality: string }; providerConfig: { kind: string; hasKey: boolean } };
    assert.equal(value.settings.model, ''); assert.equal(value.settings.personality, 'merchant');
    assert.equal(value.providerConfig.kind, 'offline'); assert.equal(value.providerConfig.hasKey, false);
    await browser.action(id, 'start');
    await until(async () => (await browser.status()).seats.some(seat => seat.id === id && (seat.telemetry?.round??0)>0 && !seat.busy), 'Autonomous local round did not complete for ' + id);
    await browser.action(id, 'pause');
    const paused = (await browser.status()).seats.find(seat => seat.id === id)!;
    assert.equal(paused.enabled, false); assert.equal(paused.owned, false); assert.equal(paused.status, 'paused'); assert.equal(paused.tokens, 0);
    savedCalls.set(id, paused.calls);
  }
  const appliedResponse = await browser.api('config'); assert.equal(appliedResponse.status, 200);
  const applied = await appliedResponse.json() as ConsoleConfig;
  assert.equal(applied.seats.length, 2);
  for (const seat of applied.seats) {
    assert.equal(seat.protocol, 'v2'); assert.equal(seat.settings.model, '');
    assert.equal(seat.settings.personality, 'merchant'); assert.equal(seat.providerConfig.kind, 'offline'); assert.equal(seat.providerConfig.hasKey, false);
  }
  assert.deepEqual(await readFile(f.configPath), originalConfigBytes, 'Applying settings must not rewrite the supplied config file');
  // An enabled process must also restart paused; never infer permission to resume.
  await browser.action('ai-01', 'start'); await stop(first.child); assertStopped(first.child,first.output());
  // Read the final durable counters after shutdown, so a timer racing the last
  // explicit start cannot be mistaken for a model call caused by restart.
  const persistedCalls = new Map<string, number>();
  for (const filename of (await readdir(join(f.directory, 'private'))).filter(name => name.endsWith('.sqlite'))) {
    const database = new DatabaseSync(join(f.directory, 'private', filename), { readOnly: true });
    try {
      for (const row of database.prepare('SELECT seat, payload FROM seats WHERE room = ?').all(f.access.roomId)) {
        const configuredSeat = f.seats.find(seat => seat.lobbySeat === row.seat); assert.ok(configuredSeat);
        const state = JSON.parse(String(row.payload)) as { calls: number };
        assert.ok(state.calls >= savedCalls.get(configuredSeat.id)!); persistedCalls.set(configuredSeat.id, state.calls);
      }
    } finally { database.close(); }
  }
  assert.equal(persistedCalls.size, 2);
  const restarted = f.start([...args, '--console-mode', 'configured']), restored = await restarted.console();
  // Configured console edits apply only to this process. On a fresh invocation,
  // the supplied file and startup provider are authoritative, not the old UI edit.
  const restoredResponse = await restored.api('config'); assert.equal(restoredResponse.status, 200);
  const restoredConfig = await restoredResponse.json() as ConsoleConfig;
  assert.equal(restoredConfig.seats.length, 2);
  for (const seat of restoredConfig.seats) {
    assert.equal(seat.protocol, 'v2'); assert.equal(seat.settings.model, '');
    assert.equal(seat.settings.personality, 'schemer'); assert.equal(seat.providerConfig.kind, 'offline'); assert.equal(seat.providerConfig.hasKey, false);
  }
  for (const seat of (await restored.status()).seats) assert.equal(seat.calls, persistedCalls.get(seat.id), 'Restart must not invoke a model');
  await delay(1100);
  const final = await restored.status(); assert.equal(final.fixedSlots, false); assert.equal(final.connectionMode, 'configured');
  assert.deepEqual(final.seats.map(seat => seat.id).sort(), ['ai-01', 'arbitrary-v2-seat']);
  for (const seat of final.seats) {
    assert.equal(seat.protocol, 'v2'); assert.equal(seat.enabled, false); assert.equal(seat.owned, false); assert.equal(seat.status, 'paused');
    assert.equal(seat.calls, persistedCalls.get(seat.id), 'Restored paused seats must not invoke a model'); assert.equal(seat.tokens, 0);
  }
  const callsAfterRestart = final.seats.map(seat => seat.calls); await delay(1100);
  assert.deepEqual((await restored.status()).seats.map(seat => seat.calls), callsAfterRestart);
  await stop(restarted.child); assertStopped(restarted.child,restarted.output());
  assert.deepEqual(await readFile(f.configPath), originalConfigBytes, 'Restart must leave every supplied config byte unchanged');
  assert.equal(await readFile(f.auditPath, 'utf8'), '', 'configured CLI must not even read local bindings, owner credentials, slot manifests, or checkpoint files');
  assert.deepEqual(f.trapRequests, [], 'configured CLI must not probe the local owner endpoint');
  assert.deepEqual((await readdir(f.localDirectory)).sort(), Object.keys(sentinels).sort());
  for (const [name, contents] of Object.entries(sentinels)) assert.equal(await readFile(join(f.localDirectory, name), 'utf8'), contents);
  assert.ok(f.requests.length > 0); assert.ok(f.requests.every(request => request.path.startsWith('/player/v2/')));
  assert.ok(f.requests.some(request => request.path === '/player/v2/control/acquire'));
  assert.ok(f.requests.some(request => request.path === '/player/v2/control/release'));
  assert.ok(f.requests.every(request => !request.authorization.includes(localToken)));
  assert.ok(f.service.store.load()!.room.state.commands.every(c=>c.action.kind!=='resign'), 'Autonomous orders remain within the allowed action set');
  const visible = JSON.stringify([initial, final, first.output(), restarted.output()]);
  for (const secret of [...f.tokens, localToken]) assert.ok(!visible.includes(secret));
});

test('CLI without --config keeps eight paused local slots and imports only explicit synthetic legacy bindings', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const address = f.service.server.address(); assert.ok(address && typeof address === 'object');
  const process = f.start([...f.consoleArgs, '--store-directory', join(f.directory, 'local-private'), '--local-player-port', String(address.port)]);
  const browser = await process.console();
  const initial = await browser.status(); assert.equal(initial.fixedSlots, true); assert.equal(initial.connectionMode, 'local'); assert.equal(initial.seats.length, 8);
  assert.deepEqual(initial.seats.map(seat => seat.id), Array.from({ length: 8 }, (_, index) => `ai-${String(index + 1).padStart(2, '0')}`));
  assert.ok(initial.seats.every(seat => seat.bound === false && !seat.enabled && !seat.owned && seat.status === 'paused'));
  await writeFile(join(f.localDirectory, 'player-access.json'), JSON.stringify(f.access));
  await writeFile(join(f.localDirectory, 'controller-bindings.json'), JSON.stringify({ format: 'controller-bindings/1', roomId: f.access.roomId, bindings: [{ seat: 0, slot: 3 }] }));
  await until(async () => {
    const response = await browser.api('connections/local', {}); assert.equal(response.status, 200);
    return (await browser.status()).seats.find(seat => seat.id === 'ai-04')?.bound === true;
  }, 'Local controller did not apply its synthetic legacy binding');
  const bound = await browser.status(); assert.equal(bound.seats.length, 8);
  const seat = bound.seats.find(item => item.id === 'ai-04')!;
  assert.equal(seat.protocol, 'v2'); assert.equal(seat.roomId, f.access.roomId); assert.equal(seat.enabled, false); assert.equal(seat.owned, false);
  assert.ok(bound.seats.filter(item => item.id !== 'ai-04').every(item => item.bound === false));
  assert.ok(f.requests.some(request => request.path === '/player/v2/protocol' && request.authorization === 'Bearer ' + f.access.credentials[0]!.token));
  assert.match(await readFile(f.auditPath, 'utf8'), /controller-bindings\.json/);
  assert.match(await readFile(f.auditPath, 'utf8'), /player-access\.json/);
  await stop(process.child); assertStopped(process.child,process.output());
  // The legacy demo launcher supplies an empty config. Its inferred local mode
  // must keep working, including persisted slots and the explicit handoff files.
  const emptyConfig = join(f.directory, 'empty-local-config.json');
  await writeFile(emptyConfig, JSON.stringify({ storeDirectory: join(f.directory, 'local-private'), seats: [] }));
  const restarted = f.start(['--config', emptyConfig, ...f.consoleArgs, '--local-player-port', String(address.port)]);
  const restored = await restarted.console();
  await until(async () => (await restored.status()).seats.find(item => item.id === 'ai-04')?.bound === true, 'Empty legacy config did not restore its local slot');
  const final = await restored.status(); assert.equal(final.fixedSlots, true); assert.equal(final.connectionMode, 'local'); assert.equal(final.seats.length, 8);
  assert.ok(final.seats.every(item => !item.enabled && !item.owned && item.status === 'paused'));
  await stop(restarted.child); assertStopped(restarted.child,restarted.output());
});

// Six cold process starts each retain the ten-second bound in until(). The
// enclosing test also includes authority setup and process/module startup.
test('CLI rejects ambiguous or incomplete console mode selections before opening the console or local files', { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  for (const args of [
    ['--config', f.configPath, ...f.consoleArgs, '--console-mode', 'local'],
    [...f.consoleArgs, '--console-mode', 'configured'],
    ['--config', f.configPath, ...f.consoleArgs, '--console-mode', 'automatic'],
    ['--config', f.configPath, ...f.consoleArgs, '--local-player-port', String(f.trapPort)],
    ['--config', f.configPath, ...f.consoleArgs, '--local-game-directory', f.localDirectory],
    ['--config', f.configPath, ...f.consoleArgs, '--store-directory', join(f.directory, 'ignored-store-must-not-be-used')],
  ]) {
    const process = f.start(args); await until(() => process.child.exitCode !== null || process.child.signalCode !== null, 'Invalid CLI mode did not exit');
    assert.equal(process.child.exitCode, 1, process.output()); assert.ok(!process.output().includes('http://127.0.0.1:'));
    assert.match(process.output(), /config|console-mode|local/i);
  }
  assert.equal(await readFile(f.auditPath, 'utf8'), ''); assert.deepEqual(f.trapRequests, []); assert.deepEqual(f.requests, []);
});

test('Two configured CLI consoles isolate ports, stores and seats; duplicate stores, ports and active seat ownership are rejected', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const configuration = async (name: string, seat: typeof f.seats[number], storeName = name) => {
    const path = join(f.directory, name + '.json');
    await writeFile(path, JSON.stringify({ storeDirectory: join(f.directory, storeName), pollMs: 1000, seats: [seat] }));
    return path;
  };
  const firstConfig = await configuration('first-private', f.seats[0]!);
  const secondConfig = await configuration('second-private', f.seats[1]!);
  const first = f.start(['--config', firstConfig, ...f.consoleArgs]);
  const second = f.start(['--config', secondConfig, ...f.consoleArgs]);
  const [a, b] = await Promise.all([first.console(), second.console()]);
  assert.notEqual(a.url, b.url);
  for (const [browser, id] of [[a, f.seats[0]!.id], [b, f.seats[1]!.id]] as const) {
    const status = await browser.status(); assert.equal(status.connectionMode, 'configured'); assert.equal(status.fixedSlots, false);
    assert.deepEqual(status.seats.map(seat => seat.id), [id]); assert.equal(status.seats[0]!.enabled, false);
  }
  await a.action(f.seats[0]!.id, 'start');
  assert.equal((await a.status()).seats[0]!.owned, true);
  assert.equal((await b.status()).seats[0]!.enabled, false, 'Starting one console must not activate the other');
  await b.action(f.seats[1]!.id, 'start');
  assert.equal((await b.status()).seats[0]!.owned, true);
  await a.action(f.seats[0]!.id, 'pause');
  assert.equal((await a.status()).seats[0]!.owned, false);
  assert.equal((await b.status()).seats[0]!.owned, true, 'Pausing one console must not release the other seat');

  const locked = f.start(['--config', firstConfig, ...f.consoleArgs]);
  await until(() => locked.child.exitCode !== null || locked.child.signalCode !== null, 'Duplicate private store did not reject startup');
  assert.equal(locked.child.exitCode, 1, locked.output()); assert.match(locked.output(), /EEXIST|lock/i);
  assert.deepEqual((await a.status()).seats.map(seat => seat.id), [f.seats[0]!.id]);

  const occupiedPortConfig = await configuration('occupied-port-private', f.seats[0]!);
  const occupied = f.start(['--config', occupiedPortConfig, '--console', new URL(a.url).port, ...f.consoleArgs.slice(2)]);
  await until(() => occupied.child.exitCode !== null || occupied.child.signalCode !== null, 'Duplicate console port did not reject startup');
  assert.equal(occupied.child.exitCode, 1, occupied.output()); assert.match(occupied.output(), /EADDRINUSE|address already in use/i);
  assert.equal((await a.status()).seats.length, 1); assert.equal((await b.status()).seats[0]!.owned, true);

  const competingConfig = await configuration('competing-private', f.seats[0]!);
  const competing = f.start(['--config', competingConfig, ...f.consoleArgs]);
  const c = await competing.console();
  await a.action(f.seats[0]!.id, 'start');
  const competingStart = await c.api('action', { id: f.seats[0]!.id, action: 'start' });
  assert.equal(competingStart.status, 202);
  const { job } = await competingStart.json() as { job: { id: string } };
  // The contender may wait for a stale lease to expire. It must not steal or
  // silently share control, and the first renewal proves the owner remains live.
  await until(async () => {
    const owner = (await a.status()).seats[0]!, contender = await c.status();
    assert.equal(owner.enabled, true,first.output()+JSON.stringify(owner));
    assert.equal(contender.seats[0]!.owned, false); assert.equal(contender.seats[0]!.enabled, false);
    const result = contender.jobs.find(item => item.id === job.id); assert.ok(result);
    assert.notEqual(result.status, 'completed', 'Two configured processes must not own the same game seat');
    return result.status === 'failed' && owner.owned;
  }, 'Active owner renewal did not reject the competing console start', 20_000);
  assert.equal((await b.status()).seats[0]!.owned, true);
  await a.action(f.seats[0]!.id, 'pause'); await b.action(f.seats[1]!.id, 'pause');
  await Promise.all([stop(first.child), stop(second.child), stop(competing.child)]);
  for (const process of [first, second, competing]) assertStopped(process.child,process.output());
  assert.equal(await readFile(f.auditPath, 'utf8'), ''); assert.deepEqual(f.trapRequests, []);
  assert.ok(f.requests.every(request => request.path.startsWith('/player/v2/')));
  assert.ok(f.service.store.load()!.room.state.commands.every(command=>command.player===0||command.player===1));
});
