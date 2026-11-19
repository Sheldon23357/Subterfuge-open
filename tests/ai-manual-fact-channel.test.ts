import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import type {ManualCommandReceipt,PlayerObservation} from '../packages/contracts/src/index.js';
import {ActivityFacts} from '../packages/ai/src/controller/observation/activity-facts.js';import {AiStore,initialState,type GameGateway} from '../packages/ai/src/index.js';

const receipt=(version:number):ManualCommandReceipt=>({id:`manual:0:${version}`,version,player:0,tick:100,seconds:0,kind:'order',outcome:'applied',action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},affectedFleetIds:[],cancelledScheduleIds:[]});
function snapshot(upper:number,tail=10):PlayerObservation{
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const current=observation({state:createFleetScenario(setup),scheduled:[]},0,'manual-facts');
 const rows=Array.from({length:upper},(_,i)=>receipt(i+1)).slice(-tail);
 current.manualCommands={version:upper,receipts:rows,protections:[{receiptId:`manual:0:${upper}`,kind:'outpost',scope:['outpost:蓝方工厂']}],receiptsFromVersion:rows[0]?.version??0,hasEarlierReceipts:rows.length<upper};
 return current;
}
const baseline=(current:PlayerObservation,version=0)=>({roomId:current.roomId,player:current.view.player,activityCursor:current.activityCursor,manualVersion:version});

test('manual pages catch up past the snapshot tail at a fixed cut even if the server has advanced',async()=>{
 const current=snapshot(235),original=structuredClone(current),facts=new ActivityFacts();
 facts.baseline=()=>baseline(current);
 const calls:{after:number;limit:number}[]=[];
 const result=await facts.hydrate(current,async()=>{throw Error('No activity catch-up');},async(after,limit)=>{
  calls.push({after,limit});
  const rows=Array.from({length:limit},(_,i)=>receipt(after+i+1));
  return {version:250,receipts:rows,nextCursor:after+rows.length,hasMore:after+rows.length<250};
 });
 assert.deepEqual(calls,[{after:0,limit:100},{after:100,limit:100},{after:200,limit:35}]);
 assert.equal(result.manualCommands!.version,235);assert.equal(result.manualCommands!.receipts.length,235);
 assert.deepEqual(result.manualCommands!.receipts.map(r=>r.version),Array.from({length:235},(_,i)=>i+1));
 assert.deepEqual(result.manualCommands!.protections,original.manualCommands!.protections);
 assert.equal(result.manualCommands!.hasEarlierReceipts,false);assert.deepEqual(current,original);
});

test('manual fact gaps, future rows, changed identities and foreign players fail closed',async()=>{
 const current=snapshot(12,2),facts=new ActivityFacts();facts.baseline=()=>baseline(current);
 const page=(rows:ManualCommandReceipt[],extra={})=>({version:12,receipts:rows,nextCursor:rows.at(-1)?.version??0,hasMore:(rows.at(-1)?.version??0)<12,...extra});
 for(const invalid of [page([]),page([receipt(2)]),page([receipt(1)],{version:11}),
  page(Array.from({length:13},(_,i)=>receipt(i+1)),{version:13,hasMore:false}),
  page([{...receipt(1),player:1}]),page([receipt(1)],{hasMore:false}),
  page(Array.from({length:12},(_,i)=>({...receipt(i+1),...(i===10?{seconds:1}:{})})))]){
  await assert.rejects(facts.hydrate(current,async()=>{throw Error('No activity');},async()=>invalid));
 }
 await assert.rejects(facts.hydrate(current,async()=>{throw Error('No activity');}),/history channel/);
});

test('runner retains only unreviewed stored facts alongside the latest tail without refetching reviewed history',async()=>{
 const store=new AiStore(':memory:'),state=initialState('manual-facts',0,{model:'synthetic',personality:'sentinel'}),facts=new ActivityFacts();
 try{
  const earlier=snapshot(5,5);store.save(state);store.observeManualCommands(state.roomId,0,earlier);
  const current=snapshot(25,1);store.observeManualCommands(state.roomId,0,current);
  store.save(state,'decision-observation',current);
  store.save(state,'manual-intent-reconciled',{version:25,receiptIds:[receipt(2).id,receipt(3).id,receipt(4).id,receipt(5).id,receipt(25).id],reason:'Reviewed'});
  const gateway:GameGateway={factBaseline:read=>{facts.baseline=read;},snapshot:async()=>{throw Error('Not polled');},request:async()=>{throw Error('No game writes');}};
  new SeatRunner(state,store,gateway,{step:async()=>{throw Error('No model');}});
  const hydrate=()=>facts.hydrate(current,async()=>{throw Error('No activity');},async()=>{throw Error('Already provided; no archive refetch');});
  assert.deepEqual((await hydrate()).manualCommands!.receipts.map(r=>r.version),[1,25]);
  store.save(state,'manual-intent-reconciled',{version:25,receiptIds:[receipt(1).id],reason:'Now reviewed'});
  assert.deepEqual((await hydrate()).manualCommands!.receipts.map(r=>r.version),[25]);
  assert.deepEqual(store.pendingManualFacts(state.roomId,0),[]);
 }finally{store.close();}
});

test('same-version fact backfill records missing evidence and rejects mutation without advancing manual authority',()=>{
 const store=new AiStore(':memory:'),state=initialState('manual-facts',0,{model:'synthetic',personality:'sentinel'});
 try{
  store.save(state);store.observeManualCommands(state.roomId,0,snapshot(5,1));
  const version=store.latest(state.roomId,0,'manual-commands-observed');
  assert.equal(store.observeManualCommands(state.roomId,0,snapshot(5,5)),true);
  assert.equal(store.pendingManualFacts(state.roomId,0).length,5);
  assert.deepEqual(store.latest(state.roomId,0,'manual-commands-observed'),version);
  assert.equal(store.observeManualCommands(state.roomId,0,snapshot(5,5)),false);
  const changed=snapshot(5,5);changed.manualCommands!.receipts[0]!.seconds=1;
  assert.throws(()=>store.observeManualCommands(state.roomId,0,changed),/identity conflict/);
  assert.equal(store.manualReceipt(state.roomId,0,receipt(1).id)!.seconds,0);
 }finally{store.close();}
});

test('invalid first manual snapshot cannot poison the durable origin before a provider call',async()=>{
 const store=new AiStore(':memory:'),state=initialState('manual-facts',0,{model:'synthetic',personality:'sentinel'}),facts=new ActivityFacts();
 try{
  const current=snapshot(5);current.manualCommands!.receipts[0]!.version=-1;
  const gateway:GameGateway={factBaseline:read=>{facts.baseline=read;},snapshot:async()=>({observation:await facts.hydrate(current,async()=>null),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2}),request:async()=>{throw Error('No game writes');}};
  const runner=new SeatRunner(state,store,gateway,{step:async()=>{throw Error('Must not dispatch');}});
  await runner.poll(0,true);
  assert.equal(store.latest(state.roomId,0,'activity-facts-origin'),null);
  assert.equal(store.latest(state.roomId,0,'provider-dispatch-decision'),null);
 }finally{store.close();}
});

test('an isolated old protection receipt does not backfill the whole match on a fresh binding',async()=>{
 const store=new AiStore(':memory:'),state=initialState('manual-facts',0,{model:'synthetic',personality:'sentinel'}),facts=new ActivityFacts();
 try{
  const current=snapshot(300,100);current.manualCommands!.receipts.unshift(receipt(1));current.manualCommands!.receiptsFromVersion=1;
  current.manualCommands!.protections.push({receiptId:receipt(1).id,kind:'outpost',scope:['outpost:蓝方工厂']});
  const gateway:GameGateway={factBaseline:read=>{facts.baseline=read;},snapshot:async()=>{throw Error('Not polled');},request:async()=>{throw Error('No game writes');}};
  new SeatRunner(state,store,gateway,{step:async()=>{throw Error('No model');}});
  const result=await facts.hydrate(current,async()=>{throw Error('No old activity');},async()=>{throw Error('Fresh binding must not fetch the omitted earlier match');});
  assert.equal(store.latest<{manualVersion:number}>(state.roomId,0,'activity-facts-origin')!.manualVersion,200);
  assert.deepEqual(result.manualCommands!.receipts,current.manualCommands!.receipts);
 }finally{store.close();}
});

test('activity and manual fact reads run in parallel at their original observation cut',async()=>{
 const current=snapshot(1);current.manualCommands!.receipts=[];current.manualCommands!.receiptsFromVersion=0;current.manualCommands!.hasEarlierReceipts=true;current.activityCursor=1;current.activity=[];const facts=new ActivityFacts();facts.baseline=()=>({...baseline(current),activityCursor:0});
 const started=new Set<string>();let both!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{both=r;}),gate=new Promise<void>(r=>{release=r;});
 const wait=async(name:string)=>{started.add(name);if(started.size===2)both();await gate;};
 const pending=facts.hydrate(current,async()=>{await wait('activity');return {events:[{id:0,tick:100,kind:'arrived',subject:'蓝方工厂'}],nextCursor:1,through:1,hasMore:false};},async()=>{await wait('manual');return {version:1,receipts:[receipt(1)],nextCursor:1,hasMore:false};});
 let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Fact reads were serialized')),3000);})]);}finally{if(timer)clearTimeout(timer);release();}
 const result=await pending;assert.equal(result.activity!.length,1);assert.equal(result.manualCommands!.receipts.length,1);assert.equal(current.activity!.length,0);assert.equal(current.manualCommands!.receipts.length,0);
});
