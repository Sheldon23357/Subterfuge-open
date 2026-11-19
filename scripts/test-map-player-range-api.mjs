import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
await mkdir(resolve('outputs/map-player-range'), { recursive: true });
const dir = await mkdtemp(resolve('outputs/map-player-range/api-'));
const child = spawn(process.execPath, [resolve('dist/packages/server/src/main.js')], {
  env: { ...process.env, LAB_PORT: String(port), LAB_DATA_DIR: dir, LAB_LEGACY_FIXTURE: '1', GAME_CLOCK: 'manual', PLAYER_PORT: undefined },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const rows = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Test server startup timeout')), 15000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Test server exited ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let players = 2; players <= 10; players++) {
    const start = performance.now();
    const response = await fetch(base + '/api/new', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players, seed: 4300, mapMode: 'quantity-priority' }),
      signal: AbortSignal.timeout(30000),
    });
    const view = await response.json();
    assert.equal(response.status, 200, JSON.stringify(view));
    assert.equal(view.players.length, players);
    assert.equal(view.outposts.length, players * 10);
    const snapshot = await (await fetch(base + '/api/export')).json();
    assert.equal(snapshot.map.algorithm, 'quantity-priority-v1');
    assert.equal(snapshot.map.players, players);
    assert.equal(snapshot.map.startingOrigins.length, players);
    const reloaded = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(reloaded, view);
    rows.push({ players, status: response.status, ms: Math.round(performance.now() - start), selectedSeed: snapshot.map.seed, counts: snapshot.map.selection.territoryCounts });
    console.log(`API ${players} players | HTTP 200 | ${rows.at(-1).ms} ms | PASS`);
  }
  await writeFile('outputs/map-player-range/api-results.json', JSON.stringify(rows, null, 2));
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
}
