import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { generateQuantityPriorityMap, generateOriginalMap, originalMapCandidate, quantityPriorityMetrics, compareTerritoryCounts } from '../dist/packages/engine/src/index.js';
import { roomFromMap } from '../dist/packages/server/src/generated-room.js';
import { saveRoom, restoreRoom } from '../dist/packages/server/src/planning.js';

// Sequential runs keep generation timings comparable. Never touches live saves.
const seeds = [4300, 0, 20261015, 123456789, 4294966796];
const rows = [];
for (let players = 2; players <= 10; players++) {
  for (const seed of seeds) {
    const start = performance.now();
    const map = await generateQuantityPriorityMap(players, seed);
    const ms = Math.round(performance.now() - start);
    assert.equal(map.algorithm, 'quantity-priority-v1');
    assert.equal(map.players, players);
    assert.equal(map.outposts.length, players * 10);
    assert.equal(map.origins.length, players);
    assert.equal(map.startingOutposts.length, players);
    assert.ok(map.seed >= seed && map.seed <= seed + 499);
    assert.ok(Number.isFinite(map.selection.geometryScore));
    assert.deepEqual(map.selection, quantityPriorityMetrics(originalMapCandidate(players, map.seed)));
    const counts = map.selection.territoryCounts;
    assert.equal(counts.length, players);
    assert.equal(counts.reduce((a, b) => a + b, 0), players * 10);
    assert.equal(Math.max(...counts) - Math.min(...counts), map.score);
    for (let player = 0; player < players; player++) {
      const own = map.outposts.filter(o => o.owner === player);
      assert.equal(own.length, 5);
      assert.equal(own.reduce((n, o) => n + o.drillers, 0), 160);
      const starting = map.startingOutposts.filter(q => q.owner === player);
      assert.equal(starting.length, 1);
      assert.equal(map.outposts[starting[0].outpost].owner, player);
    }
    assert.equal(map.outposts.filter(o => o.owner < 0).length, players * 5);
    for (const o of map.outposts) {
      assert.ok(Number.isFinite(o.position.x) && Math.abs(o.position.x) <= map.width / 2);
      assert.ok(Number.isFinite(o.position.y) && Math.abs(o.position.y) <= map.height / 2);
      assert.ok(Number.isInteger(o.meantForPlayer) && o.meantForPlayer >= 0 && o.meantForPlayer < players);
    }
    const original = await generateOriginalMap(players, seed);
    assert.equal(map.score, original.score);
    const originalMetrics = quantityPriorityMetrics(originalMapCandidate(players, original.seed));
    assert.ok(compareTerritoryCounts(counts, originalMetrics.territoryCounts) <= 0);
    const room = roomFromMap(map);
    assert.deepEqual(restoreRoom(saveRoom(room)), room);
    rows.push({ players, requestedSeed: seed, selectedSeed: map.seed, ms, territoryCounts: counts, territoryRange: map.score, geometryScore: map.selection.geometryScore });
    console.log(`${players} players | seed ${seed} -> ${map.seed} | ${ms} ms | territories ${counts.join('/')} | range ${map.score} | PASS`);
  }
}
const summary = Array.from({ length: 9 }, (_, i) => {
  const players = i + 2, cases = rows.filter(r => r.players === players);
  return { players, passed: cases.length, defaultSeed: cases[0].selectedSeed, defaultCounts: cases[0].territoryCounts.join('/'), defaultRange: cases[0].territoryRange, meanMs: Math.round(cases.reduce((n, r) => n + r.ms, 0) / cases.length), maxRange: Math.max(...cases.map(r => r.territoryRange)) };
});
await mkdir('outputs/map-player-range', { recursive: true });
await writeFile('outputs/map-player-range/results.json', JSON.stringify({ seeds, rows, summary }, null, 2));
console.table(summary);
console.log(`PASS ${rows.length}/${rows.length}; results: outputs/map-player-range/results.json`);
