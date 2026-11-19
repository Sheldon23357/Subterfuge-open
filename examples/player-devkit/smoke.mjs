#!/usr/bin/env node
/** Offline distribution check. Never reads model keys or real executor credentials. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createOfflineMock, SYNTHETIC_TOKEN } from './offline-mock.mjs';
import { canonicalProtocolJson, parseStrictProtocolJson } from './runtime/protocol.mjs';
import { plan } from './custom-planner.mjs';

const root = dirname(fileURLToPath(import.meta.url)), options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i], value = process.argv[i + 1];
  if (!['--python', '--go'].includes(option) || options[option] || !value || value.startsWith('--')) throw Error('Usage: node smoke.mjs [--python PYTHON_EXECUTABLE] [--go GO_EXECUTABLE]');
  options[option] = value;
}
const directory = await mkdtemp(join(tmpdir(), 'player-devkit-smoke-'));
const children = new Set(), checks = [];
const cleanEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: directory, USERPROFILE: directory, TMPDIR: directory, TEMP: directory, TMP: directory, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', PYTHONDONTWRITEBYTECODE: '1', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOCACHE: join(directory, 'go-cache') };
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function until(fn, timeout = 10000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(20); } throw Error('Timed out waiting for an offline fixture'); }
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { await ended; } finally { clearTimeout(timeout); }
}
async function run(program, args, cwd, extraEnv = {}) {
  const child = spawn(program, args, { cwd, env: { ...cleanEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
  try { const [code] = await once(child, 'exit'); assert.equal(code, 0, output); return output; } finally { clearTimeout(timer); children.delete(child); }
}
const mock = await createOfflineMock();
const headers = { Authorization: 'Bearer ' + SYNTHETIC_TOKEN, 'Content-Type': 'application/json' };
async function request(path, body, expected = 200, token = SYNTHETIC_TOKEN) {
  const response = await fetch(mock.origin + '/player/v2' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, Authorization: 'Bearer ' + token }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: 'error' });
  const text = await response.text(); assert.equal(response.status, expected, text); return parseStrictProtocolJson(text, 300000);
}
const helloRequest = { supportedVersions: [{ major: 2, minor: 0 }], requiredCapabilities: ['core/2'], optionalCapabilities: ['actions.order/1'], executorInstanceId: 'synthetic-smoke' };
let hello, owned;
async function observe() { const page = await request('/snapshot'); const text = page.page.text; assert.equal(createHash('sha256').update(text).digest('hex'), page.snapshotDigest); const value = parseStrictProtocolJson(text, 300000); assert.equal(canonicalProtocolJson(value), text); await request('/snapshot/' + page.snapshotId + '/complete', {}); return value; }
async function acquire() { owned = (await request('/control/acquire', { roomEpoch: mock.scope.roomEpoch, sessionId: hello.sessionId, idempotencyKey: randomUUID() })).current; }
async function intent(action) { const snapshot = await observe(); return { roomEpoch: mock.scope.roomEpoch, sessionId: hello.sessionId, fence: owned.generation, authorizationVersion: '1', idempotencyKey: randomUUID(), clientCommandId: randomUUID(), expectedRevision: snapshot.observation.revision, instructionsVersion: snapshot.instructionsVersion, kind: 'order', payload: { action: action ?? { kind: 'set-shields', outpostId: '蓝方工厂', enabled: false } } }; }
const lookup = async key => (await request('/commands/lookup', { roomEpoch: mock.scope.roomEpoch, idempotencyKeys: [key] })).results[0];
try {
  const discovery = await request('/protocol'); assert.deepEqual(discovery.capabilities, ['core/2', 'actions.order/1']); assert.equal(discovery.mock.completeRulesSimulator, false);
  await request('/protocol', undefined, 401, 'invalid-synthetic-token');
  await request('/sessions/hello', { ...helloRequest, supportedVersions: [{ major: 99, minor: 0 }] }, 409);
  await request('/sessions/hello', { ...helloRequest, requiredCapabilities: ['core/2', 'commander.worker/1'] }, 409);
  await request('/sessions/hello', '{"executorInstanceId":"a","executorInstanceId":"b"}', 400);
  await request('/queries/forecast', {}, 404);
  check('limited discovery, authentication, major/capability refusal, strict duplicate-key rejection');
  hello = await request('/sessions/hello', helloRequest);
  const first = await observe(), original = canonicalProtocolJson(first), planned = plan(first); assert.ok(planned); assert.equal(canonicalProtocolJson(first), original); assert.equal(mock.stats.effects, 0);
  assert.deepEqual(planned, { kind: 'order', payload: { action: { kind: 'set-shields', outpostId: '蓝方工厂', enabled: false } } });
  await acquire();
  const command = { ...await intent(), ...planned }, receipt = await request('/commands', command); assert.equal(receipt.state, 'applied'); assert.equal(mock.stats.effects, 1);
  assert.deepEqual(await request('/commands', command), receipt); assert.equal(mock.stats.effects, 1);
  assert.deepEqual((await lookup(receipt.idempotencyKey)).receipt, receipt);
  assert.equal((await lookup(command.idempotencyKey)).status, 'found');
  await request('/commands', { ...command, payload: { action: { ...planned.payload.action, enabled: true } } }, 409);
  const changed = await observe(); assert.equal(plan(changed), null); assert.notEqual(changed.observation.revision, first.observation.revision);
  check('pure planner, verified complete snapshot, explicit lease, one synthetic operation, immutable idempotent receipts');
  const foreign = await request('/commands', await intent({ kind: 'set-shields', outpostId: 'not-owned-synthetic-target', enabled: false })); assert.equal(foreign.state, 'rejected'); assert.equal(foreign.code, 'SCOPE_DENIED'); assert.equal(mock.stats.effects, 1); assert.ok(!JSON.stringify(foreign).includes('not-owned-synthetic-target'));
  const unsupported = await request('/commands', await intent({ kind: 'resign' })); assert.equal(unsupported.code, 'UNSUPPORTED_OPERATION');
  const stale = await request('/commands', { ...await intent(), expectedRevision: '0'.repeat(64) }); assert.equal(stale.code, 'REVISION_CONFLICT');
  check('foreign target, unsupported action, and stale observation fail closed without effects');
  const before = mock.stats.effects, lost = await intent({ kind: 'set-shields', outpostId: '蓝方工厂', enabled: true });
  mock.faultOnce('drop-after-commit'); await assert.rejects(() => request('/commands', lost));
  const recovered = await lookup(lost.idempotencyKey); assert.equal(recovered.status, 'found'); assert.equal(recovered.receipt.state, 'applied'); assert.equal(mock.stats.effects, before + 1);
  assert.deepEqual(await request('/commands', lost), recovered.receipt); assert.equal(mock.stats.effects, before + 1);
  for (const failure of ['drop-before-commit', 'server-error']) {
    const unknown = await intent(), effects = mock.stats.effects; mock.faultOnce(failure);
    if (failure === 'server-error') { const response = await request('/commands', unknown, 503); assert.equal(response.outcome, 'unknown'); }
    else await assert.rejects(() => request('/commands', unknown));
    assert.equal((await lookup(unknown.idempotencyKey)).status, 'absent_within_retained_scope'); assert.equal(mock.stats.effects, effects);
  }
  check('lost response after commit reconciles once; pre-commit disconnect and 503 never imply success or automatic replay');
  const old = await intent(); mock.expireLease(); await request('/commands', old, 409); await acquire();
  const newFence = owned.generation; assert.notEqual(newFence, old.fence); await request('/commands', old, 409);
  mock.restart(); await request('/control/acquire', { roomEpoch: mock.scope.roomEpoch, sessionId: hello.sessionId, idempotencyKey: randomUUID() }, 409);
  assert.equal((await lookup(lost.idempotencyKey)).status, 'found');
  const unavailable = await request('/commands/lookup', { roomEpoch: 'different-synthetic-epoch', idempotencyKeys: [lost.idempotencyKey] }); assert.equal(unavailable.results[0].status, 'history_unavailable');
  await request('/events?after=invalid-synthetic-cursor', undefined, 409);
  let after = 'mock-cursor-0', count = 0, page;
  do { page = await request('/events?after=' + after + '&limit=2'); for (const event of page.events) assert.equal(event.seq, String(++count)); after = page.nextCursor; } while (page.hasMore);
  const empty = await request('/events?after=' + after); assert.equal(empty.nextCursor, after); assert.equal(empty.events.length, 0);
  check('lease expiry, stale fencing, process-incarnation invalidation, retained lookup and exclusive event pagination');

  if (existsSync(join(root, 'sdk/dist/index.js'))) {
    const { PlayerProtocolClient, MemoryProtocolClientStore } = await import('./sdk/dist/index.js');
    const store = new MemoryProtocolClientStore(), settings = { serverUrl: mock.origin, token: SYNTHETIC_TOKEN, store, expectedIdentity: { roomId: mock.scope.roomId, gamePlayer: 0 }, optionalCapabilities: ['actions.order/1'] };
    const client = new PlayerProtocolClient(settings); assert.equal(client.writable, false); await client.connect(); const snapshot = await client.snapshot(); await client.acquire();
    const key = randomUUID(); mock.faultOnce('drop-after-commit');
    await assert.rejects(() => client.command({ ...plan(snapshot), idempotencyKey: key, clientCommandId: randomUUID(), expectedRevision: snapshot.observation.revision, instructionsVersion: snapshot.instructionsVersion }), error => error.outcome === 'unknown');
    assert.equal(client.writable, false); const restarted = new PlayerProtocolClient(settings); await restarted.connect(); await restarted.reconcile();
    assert.equal(Object.values(restarted.state.outbox)[0].receipt.state, 'applied'); assert.equal(restarted.writable, false); mock.expireLease();
    check('optional packed SDK stays paused and reconciles unknown outcome after client reconstruction');
  }

  // Real official configured CLI + real static assets. Block outbound fetch and audit
  // any attempted game handoff reads in a decoy runtime directory.
  const audit = join(directory, 'audit.jsonl'), preload = join(directory, 'guard.cjs'), config = join(directory, 'console.json');
  await writeFile(audit, '');
  await writeFile(preload, `const fs=require('node:fs');const p=require('node:fs/promises');const append=fs.appendFileSync.bind(fs);const audit=process.env.DEVKIT_SMOKE_AUDIT;const denied=/(controller-bindings|player-access|ai-controller-slots|checkpoint-request|checkpoint-response)\\.json$/;for(const obj of [fs,p])for(const name of Object.keys(obj)){if(!/^(readFile|open|stat|lstat|access|writeFile)(Sync)?$/.test(name)||typeof obj[name]!=='function')continue;const original=obj[name];obj[name]=function(...args){if(denied.test(String(args[0]))){append(audit,'binding-access\\n');throw Error('Local game binding access is forbidden in the devkit smoke');}return Reflect.apply(original,this,args);};}require('node:module').syncBuiltinESMExports();const original=globalThis.fetch;globalThis.fetch=function(input,init){const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==process.env.DEVKIT_SMOKE_ORIGIN){append(audit,'unexpected-fetch\\n');return Promise.reject(Error('Only this synthetic loopback mock is allowed'));}return original(input,init);};`);
  const configValue = { storeDirectory: join(directory, 'official-private'), pollMs: 1000, seats: [{ id: 'synthetic-paused-seat', serverUrl: mock.origin, roomId: mock.scope.roomId, gamePlayer: 0, lobbySeat: 0, chatPlayer: 0, chatCount: 2, tokenEnv: 'DEVKIT_SYNTHETIC_TOKEN', settings: { model: '', personality: 'schemer' } }] };
  await writeFile(config, JSON.stringify(configValue));
  const child = spawn(process.execPath, ['--require', preload, join(root, 'runtime/agent-cli.mjs'), '--config', config, '--console', '0', '--console-mode', 'configured', '--console-web-root', join(root, 'web'), '--provider', 'offline'], { cwd: directory, env: { ...cleanEnv, DEVKIT_SYNTHETIC_TOKEN: SYNTHETIC_TOKEN, DEVKIT_SMOKE_AUDIT: audit, DEVKIT_SMOKE_ORIGIN: mock.origin }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const url = await until(() => { if (child.exitCode !== null) throw Error(stdout + stderr); return stdout.split(/\r?\n/).find(line => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)); });
  const pageResponse = await fetch(url), html = await pageResponse.text(); assert.equal(pageResponse.status, 200); assert.match(html, /id="root"/); assert.match(html, /agent-console\.js/);
  const cookie = pageResponse.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  for (const file of ['agent-console.js', 'agent-console.css']) { const response = await fetch(url + file); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(join(root, 'web', file))); }
  const boot = await fetch(url + 'api/agent/bootstrap', { headers: { cookie, 'x-agent-console': '1' } }); assert.equal(boot.status, 200); const { csrf } = await boot.json();
  const api = (path, body) => fetch(url + 'api/agent/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'x-agent-csrf': csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const status = async () => { const response = await api('status'); assert.equal(response.status, 200); return response.json(); };
  const firstStatus = await status(); assert.equal(firstStatus.connectionMode, 'configured'); assert.equal(firstStatus.fixedSlots, false); assert.equal(firstStatus.seats.length, 1); assert.equal(firstStatus.seats[0].status, 'paused'); assert.equal(firstStatus.seats[0].calls, 0); assert.equal(firstStatus.seats[0].owned, false);
  const calls = mock.stats.commands; await delay(2200); assert.equal(mock.stats.commands, calls); assert.equal((await status()).seats[0].calls, 0);
  const local = await api('connections/local', {}); assert.equal(local.status, 409);
  // Missing official advanced capabilities MUST NOT be fabricated by this mock.
  const response = await api('action', { id: 'synthetic-paused-seat', action: 'start' }); assert.equal(response.status, 202); const { job } = await response.json();
  const outcome = await until(async () => { const value = (await status()).jobs.find(value => value.id === job.id); return value && value.status !== 'running' ? value : false; }); assert.equal(outcome.status, 'failed');
  assert.equal((await status()).seats[0].calls, 0); assert.equal(mock.stats.commands, calls);
  await stop(child); children.delete(child); assert.equal(await readFile(audit, 'utf8'), ''); assert.ok(!(stdout + stderr).includes(SYNTHETIC_TOKEN));
  check('official configured console serves actual packaged assets, stays paused, never reads local bindings or calls a model, and refuses missing capabilities');
  const launcher = spawn(process.execPath, [join(root, 'launch-console.mjs')], { cwd: directory, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(launcher);
  let launcherOutput = '', launcherErrors = ''; launcher.stdout.on('data', data => launcherOutput += data); launcher.stderr.on('data', data => launcherErrors += data);
  const launcherUrl = await until(() => { if (launcher.exitCode !== null) throw Error(launcherOutput + launcherErrors); return launcherOutput.split(/\r?\n/).find(line => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(line)); });
  assert.equal((await fetch(launcherUrl)).status, 200); await stop(launcher); children.delete(launcher);
  check('default launcher boots from an unrelated working directory without secrets or repository paths');

  const identity = join(directory, 'identity.json'); await writeFile(identity, JSON.stringify(mock.identity));
  const operation = join(directory, 'operation.json'); await writeFile(operation, JSON.stringify({ kind: 'order', payload: { action: { kind: 'set-shields', outpostId: '蓝方工厂', enabled: true } } }));
  for (const language of ['python', 'go']) if (options['--' + language]) {
    let program = options['--' + language], prefix = [];
    if (language === 'go') { const version = await run(program, ['version'], directory); assert.match(version, /^go version go/); const binary = join(directory, 'independent-player'); await run(program, ['build', '-trimpath', '-buildvcs=false', '-o', binary, './cmd/player-client'], join(root, 'examples/player-clients/go')); program = binary; }
    else prefix = [join(root, 'examples/player-clients/python/client.py')];
    const args = [...prefix, '--origin', mock.origin, '--identity', identity, '--state', join(directory, language + '-private-state' + (language === 'python' ? '.sqlite' : '.json'))], env = { PLAYER_EXECUTOR_TOKEN: SYNTHETIC_TOKEN };
    const effects = mock.stats.effects; await run(program, args, directory, env); assert.equal(mock.stats.effects, effects);
    await run(program, [...args, '--allow-write', '--command', operation], directory, env); assert.equal(mock.stats.effects, effects + 1);
    await run(program, [...args, '--resume-only'], directory, env); assert.equal(mock.stats.effects, effects + 1);
    check('independent ' + language + ' source runs read-only, explicit one-step write, and reconnect from the extracted package');
  }
  assert.equal(mock.stats.modelCalls, 0);
  console.log(JSON.stringify({ ok: true, checks, scope: 'Limited synthetic offline devkit smoke, not full rules, all protocol conformance, browser interaction or native Windows/macOS execution.', runtime: process.version, platform: process.platform }));
} finally { await Promise.all([...children].map(stop)); await mock.close(); await rm(directory, { recursive: true, force: true }); }
