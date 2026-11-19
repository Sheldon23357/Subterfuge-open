import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';
import {BatchTransportError} from '../packages/ai/src/controller/execution/batch-outcome.js';
import {restoreRoundWorkset,type RoundWorkset} from '../packages/ai/src/controller/execution/round-workset.js';
function fixture(){
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'batch-outcome');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState(o.roomId,0,{model:'',personality:'schemer'}),requests:unknown[]=[],audits:{kind:string;details:unknown}[]=[];
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async(_path:string,data:unknown)=>{
  requests.push(data);if(requests.length===2)throw new GameTransportError();
  return {...structuredClone(o),revision:'accepted-first'};
 }};
 const actions=Array.from({length:3},()=>({tool:'order',arguments:{action:{kind:'check-in'}}}));
 return {o,state,snapshot,requests,gateway,actions,context:{state,snapshot,gateway,id:'batch',now:o.view.tick*600+o.secondsSinceLastTick,spoken:0,audit:(kind:string,details:unknown)=>audits.push({kind,details})},audits};
}
test('unknown batch item stops once and retains accepted, unknown and untouched identities',async()=>{
 const f=fixture();
 await assert.rejects(executeTool('batch',{actions:f.actions},f.context),(error:unknown)=>{
  assert.ok(error instanceof BatchTransportError);assert.ok(error instanceof GameTransportError);
  assert.equal(error.outcome.complete,false);assert.equal(error.outcome.processed,2);assert.equal(error.outcome.requested,3);
  assert.deepEqual(error.outcome.results.map(r=>r.status),['accepted','unknown','not-executed']);
  assert.deepEqual(error.outcome.results.map(r=>r.id),['batch-item-0','batch-item-1','batch-item-2']);
  assert.equal(error.observation.revision,'accepted-first');return true;
 });
 assert.equal(f.requests.length,2);
 assert.equal(f.audits.filter(a=>a.kind==='batch-item-intent').length,2);
 assert.equal(f.audits.filter(a=>a.kind==='batch-item-unknown').length,1);
});

test('real runner durably records complete partial batch outcome and stops model work',async()=>{
 const f=fixture(),store=new AiStore(':memory:');let calls=0;
 try{
  await new SeatRunner(f.state,store,f.gateway,{step:async()=>{
   calls++;return {tokens:0,reply:{tool:'batch',arguments:{actions:f.actions},summary:'顺序登记操作'}};
  }}).poll(0,true);
  assert.equal(calls,1);assert.equal(f.requests.length,2);assert.equal(f.state.status,'error');
  const raw=store.latest<{workset:RoundWorkset}>('batch-outcome',0,'round-workset')!.workset;
  const checkpoint=restoreRoundWorkset(raw,f.o)!;assert.ok(checkpoint);
  const parent=checkpoint.receipts.find(r=>r.tool==='batch')!;
  const result=parent.result as {status:string;results:{status:string}[];complete:boolean};
  assert.equal(result.status,'unknown');assert.equal(result.complete,false);
  assert.deepEqual(result.results.map(r=>r.status),['accepted','unknown','not-executed']);
  assert.ok(store.latest('batch-outcome',0,'batch-item-result'));
  const step=store.decisionPage('batch-outcome',0).entries[0]!.payload.steps.find((s:{tool:string})=>s.tool==='batch')!;
  assert.equal(step.status,'partial');assert.equal(step.result.status,'unknown');
 }finally{store.close();}
});
