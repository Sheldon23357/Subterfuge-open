import test from 'node:test';
import assert from 'node:assert/strict';
import {generateOriginalMap} from '../../packages/engine/src/index.js';
const reference = await import(new URL('../../../scripts/reference-map.mjs', import.meta.url).href);
for (const players of [2, 7, 8, 10]) test(`map matches locked reference for ${players} seats`, async () => {
 const map = await generateOriginalMap(players, 4300);

      const original = await reference.referenceBestMap(players, 4300);
      assert.equal(map.seed, original.seed);
      assert.equal(map.width, original.map.width);
      assert.equal(map.height, original.map.height);
      assert.equal(map.score, original.map.score);
      assert.deepEqual(map.outposts, original.map.outposts);
      assert.deepEqual(map.origins, original.map.origins);
      assert.deepEqual(map.startingOutposts, original.map.queens.map(({owner,outpost}: {owner:number;outpost:string})=>({owner,outpost})));

});
