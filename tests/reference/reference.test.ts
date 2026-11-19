import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { factoryPeriodTicks, minePeriodTicks } from '../../packages/engine/src/index.js';
const adapterUrl = new URL('../../../scripts/reference-functions.mjs',import.meta.url);
const adapter = await import(adapterUrl.href);

test('original client numerical methods agree across valid counts',  () => {
  const reference = adapter.readReference();
  const factory = adapter.extractReferenceMethod(reference,'calculateTicksBetweenDrillerProductions');
  const mine = adapter.extractReferenceMethod(reference,'calculateTicksBetweenNpProductions');
  assert.equal(factoryPeriodTicks(),adapter.runReference(factory,{tycoons:0}));
  for(let outposts=1;outposts<=100;outposts++) assert.equal(minePeriodTicks(outposts),adapter.runReference(mine,{outposts}),`outposts=${outposts}`);
});
test('unreviewed reference functions cannot be executed',  () => {
  assert.throws(()=>adapter.extractReferenceMethod(adapter.readReference(),'updateTick'),/not reviewed/);
});
