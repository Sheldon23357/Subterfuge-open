#!/usr/bin/env node
/** Limited, synthetic, loopback-only protocol teaching fixture. NOT a game rules server. */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  PLAYER_PROTOCOL_LIMITS, PROTOCOL_PLAYER_ACTIONS, canonicalProtocolJson, parseProtocolHello,
  parseProtocolCommand, parseStrictProtocolJson, protocolFields, protocolObject,
  protocolIdentifier, protocolCounter, protocolInteger, protocolCommandIntent,
} from './runtime/protocol.mjs';

export const SYNTHETIC_TOKEN = 'offline-synthetic-executor-token-not-a-real-grant';
export const MOCK_CAPABILITIES = Object.freeze(['core/2', 'actions.order/1']);
const fixture = JSON.parse(readFileSync(new URL('./protocol/player/v2/fixtures/wire-examples.json', import.meta.url), 'utf8'));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalProtocolJson(value)).digest('hex');
const fail = (code, status = 409, category = 'permanent', outcome = 'rejected') => Object.assign(new Error(code), { code, status, category, outcome });
const clone = value => structuredClone(value);

export async function createOfflineMock({ port = 0 } = {}) {
  protocolInteger(port, 0, 65535);
  const scope = { ...fixture.hello.scope, serverId: 'offline-synthetic-server', roomEpoch: 'mock-' + randomUUID() };
  const identity = { ...scope, gamePlayer: 0, lobbySeat: 0, chatPlayer: 0, chatCount: 2, roster: [{ gamePlayer: 0, chatPlayer: 0 }, { gamePlayer: 1, chatPlayer: 1 }] };
  const sessions = new Set(), receipts = new Map(), commandIds = new Map(), controlResults = new Map(), snapshots = new Map(), events = [], cursors = new Map([['mock-cursor-0', 0]]);
  const stats = { requests: 0, commands: 0, effects: 0, modelCalls: 0 };
  let document = clone(fixture.snapshotDocument), generation = 0n, owner = null, expires = 0, leaseTtl = null, fault = null, closed = false;
  const streamEpoch = 'stream-' + randomUUID();
  let baseline = 'input-' + randomUUID();
  document.observation.view.profile = 'offline-synthetic-demo/1';
  document.observation.revision = digest({ synthetic: true, view: document.observation.view });
  const cursor = () => 'mock-cursor-' + events.length;
  const emit = (type, payload) => {
    const seq = String(events.length + 1), value = { scope: clone(scope), streamEpoch, seq, cursor: 'mock-cursor-' + seq, type, schemaVersion: 1, required: true, payload };
    events.push(value); cursors.set(value.cursor, events.length);
  };
  const expire = () => { if (owner !== null && performance.now() >= expires) { owner = null; expires = 0; leaseTtl = null; generation++; emit('control.changed', {}); } };
  const lease = () => { expire(); const remainingTtlMs = owner ? Math.max(0, Math.floor(expires - performance.now())) : 0; return { scope: clone(scope), generation: String(generation), mode: owner ? 'agent' : 'manual', sessionId: owner, expiresAt: owner ? new Date(Date.now() + remainingTtlMs).toISOString() : null, ttlMs: leaseTtl, remainingTtlMs }; };
  const session = body => {
    if (body.roomEpoch !== scope.roomEpoch) throw fail('ROOM_EPOCH_CHANGED', 409, 'authorization');
    if (!sessions.has(body.sessionId)) throw fail('SERVER_RESTARTED', 409, 'ownership');
  };
  const ownership = body => { session(body); expire(); if (body.fence !== String(generation)) throw fail('FENCE_STALE', 409, 'ownership'); if (owner !== body.sessionId) throw fail('LEASE_LOST', 409, 'ownership'); };
  const coverage = epoch => ({ roomEpoch: epoch, authoritative: epoch === scope.roomEpoch, retained: epoch === scope.roomEpoch ? 'complete' : 'unavailable', queryUntil: null });
  const lookup = (epoch, key) => epoch !== scope.roomEpoch ? { status: 'history_unavailable', idempotencyKey: key, coverage: coverage(epoch) } : receipts.has(key) ? { status: 'found', receipt: clone(receipts.get(key)), coverage: coverage(epoch) } : { status: 'absent_within_retained_scope', idempotencyKey: key, coverage: coverage(epoch) };
  let origin;
  const server = createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(canonicalProtocolJson(value)); };
    try {
      stats.requests++;
      if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) throw fail('SCOPE_DENIED', 403, 'authorization');
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.headers.authorization !== 'Bearer ' + SYNTHETIC_TOKEN) throw fail('UNAUTHORIZED', 401, 'authorization');
      if (!['GET', 'POST'].includes(req.method)) throw fail('UNSUPPORTED_OPERATION', 405);
      let body;
      if (req.method === 'POST') {
        let length = 0; const chunks = [];
        for await (const chunk of req) { length += chunk.length; if (length > PLAYER_PROTOCOL_LIMITS.requestBytes) throw fail('INVALID_REQUEST', 413); chunks.push(chunk); }
        body = parseStrictProtocolJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      }
      const at = (method, suffix) => req.method === method && path === '/player/v2' + suffix;
      if (events.length > 2000 || receipts.size >= 500 || sessions.size >= 100) throw fail('RATE_LIMITED', 429, 'transient');
      if (at('GET', '/protocol')) return json({ versions: [{ major: 2, minor: 0 }], capabilities: MOCK_CAPABILITIES, requiredCapabilities: ['core/2'], limits: PLAYER_PROTOCOL_LIMITS, rulesetId: 'offline-synthetic-demo/1', rulesetVersion: '1', observationSchema: 'player-observation/2', commandSchema: 'player-command/2', actionAvailability: { actions: ['set-shields'], commands: ['order'], unavailable: PROTOCOL_PLAYER_ACTIONS.filter(action => action !== 'set-shields') }, compatibility: { current: { major: 2, minor: 0 }, previous: null, retirements: [] }, mock: { synthetic: true, completeRulesSimulator: false, volatile: true, note: 'One owned-outpost shield flag only. No combat, time progression, commander, prediction, readiness, chat, schedule or production durability.' } });
      if (at('POST', '/sessions/hello')) {
        const hello = parseProtocolHello(body);
        if (!hello.supportedVersions.some(v => v.major === 2 && v.minor === 0) || hello.requiredCapabilities.some(value => !MOCK_CAPABILITIES.includes(value))) throw fail('PROTOCOL_INCOMPATIBLE', 409);
        const sessionId = 'session-' + randomUUID(); sessions.add(sessionId);
        return json({ ...fixture.hello, scope, identity, sessionId, capabilities: MOCK_CAPABILITIES.filter(value => value === 'core/2' || [...hello.requiredCapabilities, ...hello.optionalCapabilities].includes(value)), serverTime: new Date().toISOString(), rulesetId: 'offline-synthetic-demo/1', rulesetVersion: '1' });
      }
      if (at('GET', '/snapshot')) {
        if (url.search) throw fail('INVALID_REQUEST', 400); // Only one page is implemented and advertised.
        for (const [key, value] of snapshots) if (value.deadline <= performance.now()) snapshots.delete(key);
        if (snapshots.size >= PLAYER_PROTOCOL_LIMITS.snapshotsPerPlayer) throw fail('RATE_LIMITED', 429, 'transient');
        const snapshotId = 'snapshot-' + randomUUID(), text = canonicalProtocolJson(document);
        const page = { scope, snapshotId, bootstrapExpiresAt: new Date(Date.now() + 60000).toISOString(), streamEpoch, highWatermark: String(events.length), cursor: cursor(), decisionInputVersion: baseline, snapshotDigest: digest(text), page: { index: 0, count: 1, encoding: 'json-text/1', text, nextPageToken: null } };
        snapshots.set(snapshotId, { deadline: performance.now() + 60000 }); return json(page);
      }
      if (req.method === 'POST' && /^\/player\/v2\/snapshot\/[^/]+\/complete$/.test(path)) {
        protocolFields(protocolObject(body), []);
        const id = path.split('/')[4], entry = snapshots.get(id);
        if (!entry || entry.deadline <= performance.now()) throw fail('SNAPSHOT_EXPIRED', 409, 'resync');
        snapshots.delete(id); return json({ scope, completed: true });
      }
      if (at('GET', '/events')) {
        const after = url.searchParams.get('after'), from = cursors.get(after), limit = Number(url.searchParams.get('limit') ?? 100);
        if (from === undefined) throw fail('RESYNC_REQUIRED', 409, 'resync'); protocolInteger(limit, 1, 200);
        const page = events.slice(from, from + limit), nextCursor = page.at(-1)?.cursor ?? after;
        return json({ scope, streamEpoch, inputCursor: after, nextCursor, hasMore: from + page.length < events.length, coverage: { fromExclusive: String(from), toInclusive: String(from + page.length) }, events: page });
      }
      if (at('GET', '/control')) return json(lease());
      if (req.method === 'POST' && /^\/player\/v2\/control\/(acquire|renew|release)$/.test(path)) {
        const action = path.split('/').at(-1); protocolObject(body);
        protocolFields(body, ['roomEpoch', 'sessionId', 'idempotencyKey', ...(action === 'acquire' ? [] : ['fence'])], action === 'release' ? [] : ['ttlMs']);
        protocolIdentifier(body.roomEpoch); protocolIdentifier(body.sessionId); protocolIdentifier(body.idempotencyKey); if (action !== 'acquire') protocolCounter(body.fence);
        const ttl = body.ttlMs === undefined ? 30000 : protocolInteger(body.ttlMs, 1000, 120000), key = body.idempotencyKey, input = digest({ action, body });
        session(body); expire();
        const previous = controlResults.get(key); if (previous) { if (previous.input !== input) throw fail('IDEMPOTENCY_CONFLICT'); return json({ operationResult: previous.result, current: lease() }); }
        if (controlResults.size >= 500) throw fail('RATE_LIMITED', 429, 'transient');
        if (action === 'acquire') { if (owner) throw fail('CONTROL_BUSY', 409, 'ownership'); generation++; owner = body.sessionId; leaseTtl = ttl; expires = performance.now() + ttl; }
        else { ownership(body); if (action === 'renew') { leaseTtl = ttl; expires = performance.now() + ttl; } else { owner = null; leaseTtl = null; expires = 0; generation++; } }
        emit('control.changed', {}); const result = lease(); controlResults.set(key, { input, result }); return json({ operationResult: result, current: lease() });
      }
      if (at('POST', '/commands/lookup')) {
        protocolFields(protocolObject(body), ['roomEpoch', 'idempotencyKeys']); protocolIdentifier(body.roomEpoch);
        if (!Array.isArray(body.idempotencyKeys) || body.idempotencyKeys.length < 1 || body.idempotencyKeys.length > 100) throw fail('INVALID_REQUEST', 400);
        body.idempotencyKeys.forEach(protocolIdentifier); return json({ scope: { ...scope, roomEpoch: body.roomEpoch }, results: body.idempotencyKeys.map(key => lookup(body.roomEpoch, key)) });
      }
      if (at('POST', '/commands')) {
        const request = parseProtocolCommand(body), intentDigest = digest(protocolCommandIntent(scope, request)), previous = receipts.get(request.idempotencyKey);
        if (request.roomEpoch !== scope.roomEpoch) throw fail('ROOM_EPOCH_CHANGED', 409, 'authorization');
        if (previous) { if (previous.intentDigest !== intentDigest) throw fail('IDEMPOTENCY_CONFLICT'); return json(previous); }
        ownership(request);
        if (request.authorizationVersion !== '1') throw fail('UNAUTHORIZED', 401, 'authorization');
        stats.commands++; const activeFault = fault; fault = null;
        if (activeFault === 'drop-before-commit') { req.socket.destroy(); return; }
        if (activeFault === 'server-error') throw fail('STORAGE_UNAVAILABLE', 503, 'transient', 'unknown');
        let code;
        if (request.expectedRevision !== document.observation.revision) code = 'REVISION_CONFLICT';
        else if (request.instructionsVersion !== document.instructionsVersion) code = 'INSTRUCTIONS_CHANGED';
        else if (request.kind !== 'order' || request.payload.action.kind !== 'set-shields') code = 'UNSUPPORTED_OPERATION';
        const outpost = request.kind === 'order' && document.observation.view.outposts.find(value => value.id === request.payload.action.outpostId && value.owner === identity.gamePlayer && value.visibility === 2 && !value.destroyed);
        if (!code && !outpost) code = 'SCOPE_DENIED';
        if (!code) { outpost.shieldsEnabled = request.payload.action.enabled; stats.effects++; document.observation.revision = digest({ view: document.observation.view, syntheticEffect: stats.effects }); baseline = 'input-' + randomUUID(); emit('observation.changed', {}); }
        const now = new Date().toISOString(), receipt = { scope: clone(scope), commandId: 'command-' + randomUUID(), idempotencyKey: request.idempotencyKey, clientCommandId: request.clientCommandId, intentDigest, state: code ? 'rejected' : 'applied', receiptVersion: '1', effectCommitted: !code, createdAt: now, updatedAt: now, ...(code ? { code } : { effects: {} }) };
        receipts.set(request.idempotencyKey, receipt); commandIds.set(receipt.commandId, receipt); emit('command.status.changed', { receipt });
        if (activeFault === 'drop-after-commit') { req.socket.destroy(); return; }
        return json(receipt);
      }
      throw fail('UNSUPPORTED_OPERATION', 404);
    } catch (error) {
      if (res.destroyed) return;
      const code = error.code ?? 'INVALID_REQUEST', status = error.status ?? 400;
      json({ code, category: error.category ?? 'permanent', outcome: req.method === 'GET' ? 'read-only' : error.outcome ?? 'rejected', safeMessage: 'Synthetic mock request did not complete normally. Consult the documented mock subset.', requestId: 'mock-' + randomUUID() }, status);
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 40;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    origin, identity: clone(identity), scope: clone(scope), stats, server,
    faultOnce(kind) { if (!['drop-after-commit', 'drop-before-commit', 'server-error'].includes(kind) || fault) throw Error('One known fault can be armed at a time'); fault = kind; },
    expireLease() { expires = 0; expire(); },
    restart() { sessions.clear(); owner = null; expires = 0; leaseTtl = null; generation++; snapshots.clear(); controlResults.clear(); emit('control.changed', {}); },
    async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise(accept => server.close(accept)); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--port' && /^(0|[1-9][0-9]*)$/.test(args[1]))) throw Error('Usage: node offline-mock.mjs [--port 0..65535]');
  const mock = await createOfflineMock({ port: args.length ? Number(args[1]) : 4399 });
  console.log(JSON.stringify({ origin: mock.origin, identity: mock.identity, synthetic: true, message: 'Loopback teaching mock only. Token is the SYNTHETIC_TOKEN constant in this source, never a real grant. No model, automatic order, combat or game simulation.' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void mock.close(); });
}
