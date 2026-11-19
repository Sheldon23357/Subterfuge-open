import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {createFleetScenario} from '../packages/engine/src/index.js';

function workerHarness(mode: string) {
  const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
  const room={state:createFleetScenario(setup),scheduled:[]};
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    let release;
    globalThis.fetch=async url=>{
      const revision=new URL(url,'http://test').searchParams.get('revision');
      if(workerData.mode==='delayed'&&revision==='old') {
        parentPort.postMessage({fetchPending:true});
        await new Promise(resolve=>release=resolve);
      }
      return {ok:workerData.mode!=='conflict',json:async()=>({roomId:'room',revision:workerData.mode==='mismatch'?'unexpected':revision,room:workerData.room})};
    };
    globalThis.postMessage=reply=>parentPort.postMessage(reply);
    import(workerData.module).then(()=>{
      parentPort.on('message',data=>{if(data.release)release();else globalThis.onmessage({data});});
      parentPort.postMessage({ready:true});
    });
  `,{eval:true,workerData:{mode,room,module:new URL('../packages/client/src/global-prediction-worker.js',import.meta.url).href}});
  return {worker,startTick:room.state.economy.tick};
}
for(const mode of ['mismatch','conflict']) test(`global worker rejects ${mode} source at the same tick`,async()=>{
  const {worker,startTick}=workerHarness(mode);
  try {
    const reply=await new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Timed out')),10000);
      worker.on('error',reject);
      worker.on('message',message=>{
        if(message.ready)worker.postMessage({kind:'predict',id:1,source:{roomId:'room',revision:'expected',startTick},targetTick:startTick+1});
        else {clearTimeout(timer);resolve(message);}
      });
    });
    assert.equal(reply.id,1);assert.ok(reply.error);assert.equal(reply.frame,undefined);
  } finally {await worker.terminate();}
});
test('late old-source fetch cannot initialize or publish into a newer source',async()=>{
  const {worker,startTick}=workerHarness('delayed');
  try {
    const replies:any[]=[];
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Timed out')),10000);
      worker.on('error',reject);
      worker.on('message',message=>{
        if(message.ready)worker.postMessage({kind:'predict',id:1,source:{roomId:'room',revision:'old',startTick},targetTick:startTick+1});
        else if(message.fetchPending)worker.postMessage({kind:'predict',id:2,source:{roomId:'room',revision:'new',startTick},targetTick:startTick+2});
        else {
          replies.push(message);
          if(message.id===2){worker.postMessage({release:true});setTimeout(()=>{clearTimeout(timer);resolve();},50);}
        }
      });
    });
    assert.equal(replies.length,1);assert.equal(replies[0].id,2);
    assert.equal(replies[0].frame?.tick,startTick+2,replies[0].error);
  } finally {await worker.terminate();}
});
