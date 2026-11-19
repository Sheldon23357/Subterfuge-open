import test from 'node:test';
import assert from 'node:assert/strict';
import {PipelineTiming} from '../packages/ai/src/controller/runtime/pipeline-timing.js';

test('pipeline timing accumulates repeated operations and reports live elapsed time without idle time',()=>{
 let now=0;const timing=new PipelineTiming(()=>now);
 assert.equal(timing.read(),undefined);
 const end=timing.start('search',10);now=12;
 assert.equal(timing.read()?.milliseconds.search,12);
 end();now=100;
 assert.equal(timing.read()?.milliseconds.search,12);
 const again=timing.start('search',10);now=105;again();again();
 assert.equal(timing.read()?.milliseconds.search,17);
});
test('new tick resets timing and excludes an old in-flight operation',()=>{
 let now=0;const timing=new PipelineTiming(()=>now);
 const old=timing.start('execution',10);now=10;
 const fresh=timing.start('sync',11);now=20;old();fresh();
 assert.equal(timing.read()?.tick,11);
 assert.equal(timing.read()?.milliseconds.execution,0);
 assert.equal(timing.read()?.milliseconds.sync,10);
});
test('snapshot read belongs to its returned tick and failed operations still count',async()=>{
 let now=0;const timing=new PipelineTiming(()=>now);
 await timing.measure('sync',null,async()=>{now=15;return {tick:12};},v=>v.tick);
 assert.equal(timing.read()?.tick,12);assert.equal(timing.read()?.milliseconds.sync,15);
 await assert.rejects(timing.measure('readiness',12,async()=>{now=25;throw Error('transport');}));
 assert.equal(timing.read()?.milliseconds.readiness,10);
});
