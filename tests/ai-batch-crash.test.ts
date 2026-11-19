import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';import {AiStore,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import type {RoundWorkset} from '../packages/ai/src/controller/execution/round-workset.js';

const imports={ai:new URL('../packages/ai/src/index.js',import.meta.url).href,engine:new URL('../packages/engine/src/index.js',import.meta.url).href,api:new URL('../packages/server/src/player-api.js',import.meta.url).href};
type Phase='second-inflight'|'all-results-saved';
function crash(path:string,writes:string,phase:Phase){
 const script=`
 import {readFileSync,appendFileSync} from 'node:fs';
 import {AiStore,initialState} from ${JSON.stringify(imports.ai)};
 import {SeatRunner} from ${JSON.stringify(new URL('./helpers/scripted-controller.js',import.meta.url).href)};
 import {createFleetScenario} from ${JSON.stringify(imports.engine)};
 import {observation} from ${JSON.stringify(imports.api)};
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'batch-crash');
 const snapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState('batch-crash',0,{model:'synthetic',personality:'schemer'}),store=new AiStore(${JSON.stringify(path)});
 const phase=${JSON.stringify(phase)},save=store.saveEvents.bind(store);
 store.saveEvents=(state,events,...rest)=>{const result=save(state,events,...rest);
  if(phase==='all-results-saved'&&events.some(e=>e.kind==='batch-item-result'&&e.details.index===2))process.exit(76);
  return result;
 };
 let sent=0;
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async(path,data)=>{
  if(path!=='/tool/order')throw Error('Unexpected endpoint '+path);
  appendFileSync(${JSON.stringify(writes)},JSON.stringify({path,id:data.order.id})+'\\n');
  if(phase==='second-inflight'&&++sent===2)process.exit(75);
  return structuredClone(o);
 }};
 const actions=Array.from({length:3},()=>({tool:'order',arguments:{action:{kind:'check-in'}}}));
 await new SeatRunner(state,store,gateway,{step:async()=>({tokens:0,reply:{tool:'batch',arguments:{actions},summary:'durable batch crash'}})}).poll(0,true);
 process.exit(99);
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:20_000});
 assert.equal(child.error,undefined);assert.equal(child.status,phase==='second-inflight'?75:76,child.stderr);
}

for(const phase of ['second-inflight','all-results-saved'] as const)test(`real batch process crash ${phase} recovers exact children without replaying writes`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-batch-crash-')),path=join(dir,'state.sqlite'),writes=join(dir,'writes.jsonl');
 let store:AiStore|undefined;
 try{
  crash(path,writes,phase);store=new AiStore(path);
  const before=readFileSync(writes,'utf8'),sent=before.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(sent.length,phase==='second-inflight'?2:3);assert.equal(new Set(sent.map(r=>r.id)).size,sent.length);
  const original=store.latest<{workset:RoundWorkset}>('batch-crash',0,'round-workset')!.workset;
  const parent=original.receipts.find(r=>r.tool==='batch')!;assert.equal(parent.kind,'tool-intent');
  const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'batch-crash');
  const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
  let calls=0;
  await new SeatRunner(store.load('batch-crash',0)!,store,{snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No operation may be replayed after restart');}},{step:async request=>{
   calls++;const recovered=store!.latest<any>('batch-crash',0,'batch-recovered');assert.ok(recovered);
   assert.equal(recovered.id,parent.id);assert.equal(recovered.result.recovered,true);
   assert.deepEqual(recovered.result.results.map((r:any)=>r.status),phase==='second-inflight'?['accepted','unknown','not-executed']:['accepted','accepted','accepted']);
   assert.equal(recovered.result.complete,phase==='all-results-saved');
   assert.ok(request.prompt.includes(String(parent.id)));
   return {tokens:0,reply:{tool:'finish',arguments:{},summary:'Preserve unresolved execution; finish local review'}};
  }}).poll(1000,true);
  assert.equal(calls,1);assert.equal(readFileSync(writes,'utf8'),before);
  assert.equal(store.load('batch-crash',0)!.status,'waiting');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
