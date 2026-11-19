import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LocalGlobalPrediction, type GlobalPredictionWorker, type GlobalPredictionRequest, type GlobalPredictionReply} from '../packages/client/src/local-global-prediction.js';
import {globalDecisionRevision} from '../packages/client/src/prediction-source.js';
import type {LabView} from '../packages/contracts/src/index.js';
class FakeWorker implements GlobalPredictionWorker {
  onmessage: GlobalPredictionWorker['onmessage'] = null;
  onerror: GlobalPredictionWorker['onerror'] = null;
  messages: GlobalPredictionRequest[] = [];
  terminated = false;
  postMessage(message: GlobalPredictionRequest) {this.messages.push(message);}
  terminate() {this.terminated = true;}
  reply(id: number, tick: number) {this.onmessage?.({data:{id,frame:{tick} as LabView}} as MessageEvent<GlobalPredictionReply>);}
}
const source = {roomId:'room-a',revision:'digest-a',startTick:10};
test('clock-only views retain context; tick, command digest and room changes invalidate it', () => {
  const view = {tick:10,predictionSource:{roomId:'room-a',revision:'digest-a'},secondsSinceLastTick:0};
  const key = globalDecisionRevision(view);
  for(let seconds = 2; seconds <= 60; seconds += 2)
    assert.equal(globalDecisionRevision({...view,secondsSinceLastTick:seconds}),key);
  for(const changed of [{...view,tick:11},{...view,predictionSource:{roomId:'room-a',revision:'digest-b'}},{...view,predictionSource:{roomId:'room-b',revision:'digest-a'}}])
    assert.notEqual(globalDecisionRevision(changed),key);
  const unsupported = {tick:10};
  assert.equal(globalDecisionRevision(unsupported),unsupported);
});
test('30 display refreshes reuse one worker; same-tick commands and new games rebuild', async () => {
  const workers: FakeWorker[] = [];
  const client = new LocalGlobalPrediction(() => {const worker=new FakeWorker();workers.push(worker);return worker;});
  for(let i=0;i<30;i++) {
    const promise=client.predict(20+i,{...source});
    const worker=workers.at(-1)!;
    const message=worker.messages.at(-1)!;
    worker.reply(message.id,20+i); await promise;
  }
  assert.equal(workers.length,1);
  const pending=client.predict(80,source); const rejected=assert.rejects(pending,{name:'AbortError'});
  const old=workers[0]!, oldId=old.messages.at(-1)!.id;
  const next=client.predict(80,{...source,revision:'digest-b'});
  await rejected; assert.equal(old.terminated,true); assert.equal(workers.length,2);
  old.reply(oldId,999); old.onerror?.({} as ErrorEvent);
  const current=workers[1]!;assert.equal(current.terminated,false);
  current.reply(current.messages.at(-1)!.id,80); assert.equal((await next).tick,80);
  const newRoom=client.predict(20,{...source,roomId:'room-b'});
  assert.equal(workers.length,3);
  workers[2]!.reply(workers[2]!.messages.at(-1)!.id,20);await newRoom;
  client.dispose();assert.equal(workers[2]!.terminated,true);
});
test('cancelled frames never resolve or overwrite a subsequent selection', async () => {
  const worker=new FakeWorker(), client=new LocalGlobalPrediction(()=>worker);
  const controller=new AbortController();
  const first=client.predict(90,source,controller.signal);
  const rejected=assert.rejects(first,{name:'AbortError'});
  const oldId=worker.messages.at(-1)!.id;controller.abort();await rejected;
  const next=client.predict(22,source);
  worker.reply(oldId,90);worker.reply(worker.messages.at(-1)!.id,22);
  assert.equal((await next).tick,22);
  assert.ok(worker.messages.some(m=>m.kind==='cancel'&&m.id===oldId));
  client.dispose();
});
