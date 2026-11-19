import {emptyReceiptObservations,reduceReceiptJournal} from '../packages/ai/src/controller/execution/receipt-observation.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiStore,SeatRunner,initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {PROFILE_ID,RULES} from '../packages/rules/src/index.js';
import {mechanicalKeepaliveEligibility,KEEPALIVE_POLICY} from '../packages/ai/src/controller/runtime/mechanical-keepalive.js';
import {GameRequestError,GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';
import {parseAgentConfig} from '../packages/ai/src/controller/contracts/agent-config.js';
const enabled={mechanicalKeepalive:true,canMaintain:()=>true};
function fixture(path=':memory:'){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'maintenance');
 o.view.profile=PROFILE_ID;o.view.tick=RULES.GameParams.MinutesOfInactivityBeforeFirstWarning/10-1;o.secondsSinceLastTick=450;o.realtime=true;
 o.view.self.activity={lastCheckinTime:0,inactivityWarningCount:0,autoResigned:false};
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState(o.roomId,0,{model:'',personality:'sentinel'}),store=new AiStore(path);state.lastThought=o.view.tick*600;store.save(state);store.save(state,'observation-baseline',o);
 const requests:{path:string;data:any}[]=[],contexts:unknown[]=[];let calls=0;
 const gateway:GameGateway={snapshot:async()=>structuredClone(snapshot),writeContext:c=>contexts.push(c),request:async(path,data)=>{
  requests.push({path,data});const result=structuredClone(snapshot.observation);result.revision+='-maintenance';result.view.self.activity!.lastCheckinTime=result.view.tick*600+result.secondsSinceLastTick;
  if((data as any).order.action.kind==='cancel-inactivity-warning')result.view.self.activity!.inactivityWarningCount=0;
  snapshot.observation=result;return structuredClone(result);
 }};
 const provider={step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{},summary:'checked'}};}};
 return {snapshot,state,store,requests,contexts,gateway,provider,calls:()=>calls,runner:(options=enabled)=>new SeatRunner(state,store,gateway,provider,1000,options)};
}

test('maintenance has separate explicit seat and exact-room opt-ins; existing configuration is unchanged',()=>{
 const s={id:'a',serverUrl:'http://localhost:1',roomId:'r',lobbySeat:0,gamePlayer:0,chatPlayer:0,chatCount:2,tokenEnv:'T',settings:{model:'',personality:'sentinel'}};
 assert.equal(parseAgentConfig({storeDirectory:'/tmp/unused',seats:[s]}).seats[0]!.mechanicalKeepalive,undefined);
 assert.throws(()=>parseAgentConfig({storeDirectory:'/tmp/unused',seats:[{...s,mechanicalKeepalive:'true'}]}),/mechanicalKeepalive/);
 for(const policy of [{roomId:'another',allowMechanicalKeepalive:true},{roomId:'r',allowMechanicalKeepalive:'yes'},{roomId:'r',allowMechanicalKeepalive:true,extra:true}])assert.throws(()=>parseAgentConfig({storeDirectory:'/tmp/unused',seats:[{...s,roomMaintenancePolicy:policy}]}),/roomMaintenancePolicy/);
 assert.equal(parseAgentConfig({storeDirectory:'/tmp/unused',seats:[{...s,mechanicalKeepalive:true,roomMaintenancePolicy:{roomId:'r',allowMechanicalKeepalive:true}}]}).seats[0]!.roomMaintenancePolicy!.allowMechanicalKeepalive,true);
});
test('eligibility uses the room profile and next game tick, never wall clock or frequent commands',()=>{
 const f=fixture();try{
  assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,false).eligible,false);
  assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true).eligible,true);
  f.snapshot.observation.realtime=false;assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true).eligible,false);
  assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true,true).eligible,true);
  f.snapshot.observation.view.tick--;assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true,true).eligible,false);
  f.snapshot.observation.view.self.activity!.inactivityWarningCount=1;
  const due=mechanicalKeepaliveEligibility(f.snapshot.observation,true);assert.ok(due.eligible);assert.equal(due.intent.action.kind,'cancel-inactivity-warning');
  f.snapshot.observation.view.profile='unknown';assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true).eligible,false);
  f.snapshot.observation.view.profile=PROFILE_ID;f.snapshot.observation.view.self.active=false;assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true).eligible,false);
  f.snapshot.observation.view.self.active=true;f.snapshot.observation.view.self.activity!.autoResigned=true;assert.equal(mechanicalKeepaliveEligibility(f.snapshot.observation,true).eligible,false);
 }finally{f.store.close();}
});
test('idle maintenance is serialized, durable, receipt-confirmed and performs no model call or repeat poll write',async()=>{
 const f=fixture();try{
  const runner=f.runner();await runner.poll(0);assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.path,'/tool/order');assert.equal(f.requests[0]!.data.order.action.kind,'check-in');
  assert.equal(f.calls(),0);assert.equal(f.state.status,'waiting');assert.equal(f.store.latest<any>('maintenance',0,'mechanical-keepalive-state').status,'confirmed');
  assert.equal(f.store.latest<any>('maintenance',0,'tool-result').result.revision,f.snapshot.observation.revision);
  assert.ok((f.contexts[0] as any).signal instanceof AbortSignal);assert.equal(f.contexts.at(-1),null);
  await runner.poll(1000);await runner.poll(900000000);assert.equal(f.requests.length,1);assert.equal(f.calls(),0);
  const records=f.store.latest<any>('maintenance',0,'receipt-observation-state').records;
  assert.deepEqual(records,[],'completed idle maintenance has no active recovery dependency');
  const originalIntent=f.store.latest<any>('maintenance',0,'tool-intent');
  const originalReceipt=f.store.queryResult('maintenance',0,originalIntent.id) as {id:string;result:AiSnapshot['observation']};
  const originalObserver=f.store.latest<any>('maintenance',0,'receipt-observation-set');
  assert.equal(originalReceipt.id,originalIntent.id);assert.equal(originalObserver.commandId,originalIntent.id);
  let evidence=reduceReceiptJournal(emptyReceiptObservations('maintenance'),'tool-intent',originalIntent,originalReceipt.result);
  evidence=reduceReceiptJournal(evidence,'receipt-observation-set',originalObserver);
  evidence=reduceReceiptJournal(evidence,'tool-result',originalReceipt);
  assert.ok(evidence.records.some(r=>r.fact==='command-accepted'));assert.ok(evidence.records.some(r=>r.fact==='activity-current'));
 }finally{f.store.close();}
});
test('default-off, missing lifecycle permission, pause and inactive seats never perform maintenance',async()=>{
 for(const mode of ['default','lease','paused','inactive','ended']){
  const f=fixture();try{
   if(mode==='paused')f.state.enabled=false;
   if(mode==='inactive')f.snapshot.observation.view.self.active=false;
   if(mode==='ended')f.snapshot.observation.view.match={mode:'mining',neptuniumGoal:200,ended:true};
   const runner=new SeatRunner(f.state,f.store,f.gateway,f.provider,1000,mode==='default'?{}:{...enabled,canMaintain:()=>mode!=='lease'});
   await runner.poll(0);assert.equal(f.requests.length,0,mode);
  }finally{f.store.close();}
 }
});
test('warning maintenance cannot discard reminders, messages, military signals, or first/manual analysis',async()=>{
 const f=fixture();try{
  const old=f.store.baseline('maintenance',0)!;old.view.self.activity!.inactivityWarningCount=0;f.store.save(f.state,'observation-baseline',old);
  f.snapshot.observation.view.self.activity!.inactivityWarningCount=1;
  f.snapshot.chat=[{id:'new-message',from:1,to:0,text:'A new agreement needs review',tick:f.snapshot.observation.view.tick,sentAt:0}];f.snapshot.chatCursor=1;
  const runner=f.runner();await runner.poll(0,true);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0]!.data.order.action.kind,'cancel-inactivity-warning');assert.equal(f.calls(),0);
  assert.ok(f.store.latest<any>('maintenance',0,'mode-hybrid-state').chat.some((m:{id:string})=>m.id==='new-message'));
 }finally{f.store.close();}
});
test('unknown write is durable and restart/manual resume cannot resubmit, even after disabling maintenance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'maintenance-unknown-')),path=join(dir,'seat.sqlite'),f=fixture(path);
 try{
  f.gateway.request=async(path,data)=>{f.requests.push({path,data});throw new GameTransportError();};
  const runner=f.runner();await runner.poll(0);assert.equal(f.requests.length,1);assert.equal(f.state.status,'error');assert.equal(runner.recovering,false);assert.equal(f.calls(),0);
  assert.equal(f.store.latest<any>('maintenance',0,'mechanical-keepalive-state').status,'unknown');f.store.close();
  const store=new AiStore(path);try{
   const state=store.load('maintenance',0)!;state.enabled=true;state.status='waiting';
   await new SeatRunner(state,store,f.gateway,f.provider,1000,{}).poll(1000);
   assert.equal(f.requests.length,1);assert.equal(state.status,'error');assert.equal(f.calls(),0);
  }finally{store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a confirmed acceptance with unchanged activity is not reported as applied and is never retried',async()=>{
 const f=fixture();try{
  f.gateway.request=async(path,data)=>{f.requests.push({path,data});return structuredClone(f.snapshot.observation);};
  await f.runner().poll(0);assert.equal(f.state.status,'error');assert.equal(f.calls(),0);assert.equal(f.requests.length,1);
  assert.equal(f.store.latest<any>('maintenance',0,'mechanical-keepalive-state').status,'accepted');
  assert.equal(f.store.latest<any>('maintenance',0,'receipt-observation-state').records.find((r:any)=>r.predicate.kind==='activity').state,'contradiction');
  f.state.status='waiting';await f.runner().poll(1000);assert.equal(f.requests.length,1);assert.equal(f.state.status,'error');
 }finally{f.store.close();}
});
test('one explicit no-write CAS conflict refresh reuses the same ID and action; a second conflict stops',async()=>{
 for(const always of [false,true]){
  const f=fixture();try{
   const success=f.gateway.request;f.gateway.request=async(path,data)=>{
    if(always||!f.requests.length){f.requests.push({path,data});const fresh=structuredClone(f.snapshot.observation);fresh.revision+='-fresh';f.snapshot.observation=fresh;throw new GameRequestError(409,fresh);}
    return success(path,data);
   };
   await f.runner().poll(0);assert.equal(f.requests.length,2);assert.equal(f.requests[0]!.data.order.id,f.requests[1]!.data.order.id);assert.deepEqual(f.requests[0]!.data.order.action,f.requests[1]!.data.order.action);
   assert.equal(f.state.status,always?'error':'waiting');assert.equal(f.calls(),0);
  }finally{f.store.close();}
 }
});
test('confirmed directive changes before send prevent maintenance and do not overwrite private memory',async()=>{
 const f=fixture();try{
  f.gateway.commanderCheck=async()=>{f.state.memory.strategy='new directive';f.state.commanderDirectives={version:1,text:'优先保留当前资源'};f.store.save(f.state,'synthetic-private-write');};
  await f.runner().poll(0);assert.equal(f.requests.length,0);assert.equal(f.store.load('maintenance',0)!.memory.strategy,'new directive');assert.equal(f.calls(),0);
 }finally{f.store.close();}
});
test('pause while accepted request is in flight drains its receipt and never enters model work',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 try{
  const send=f.gateway.request;f.gateway.request=async(path,data)=>{entered();await gate;return send(path,data);};
  const runner=f.runner(),poll=runner.poll(0);await started;assert.equal(runner.settling,true);assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),false);
  runner.pause();release();await poll;
  assert.equal(f.requests.length,1);assert.equal(f.state.status,'paused');assert.equal(f.calls(),0);assert.equal(f.store.latest<any>('maintenance',0,'mechanical-keepalive-state').status,'confirmed');assert.equal(runner.settling,false);
 }finally{release();f.store.close();}
});
test('checkpoint/lifecycle gate closing during commander check prevents any new intent or write',async()=>{
 const f=fixture();let allowed=true;try{
  f.gateway.commanderCheck=async()=>{allowed=false;};
  await f.runner({mechanicalKeepalive:true,canMaintain:()=>allowed}).poll(0);
  assert.equal(f.requests.length,0);assert.equal(f.store.latest('maintenance',0,'mechanical-keepalive-state'),null);
 }finally{f.store.close();}
});
test('an unresolved earlier ordinary remote write suppresses mechanical mutation',async()=>{
 const f=fixture();try{
  f.store.save(f.state,'tool-intent',{id:'previous-unknown-order',tool:'order',arguments:{action:{kind:'check-in'}}});
  await f.runner().poll(0);assert.equal(f.requests.length,0);assert.equal(f.store.latest('maintenance',0,'mechanical-keepalive-state'),null);
 }finally{f.store.close();}
});
test('a warning-only poll consumes only the exact resolved warning and needs no model call',async()=>{
 const f=fixture();try{
  f.snapshot.observation.view.self.activity!.inactivityWarningCount=1;
  f.snapshot.notifications=[{id:0,kind:'inactivity-warning',tick:f.snapshot.observation.view.tick,seconds:0,text:'check in',details:null,urgent:true,sendNotification:true,location:null}];f.snapshot.notificationCursor=1;
  const runner=f.runner();await runner.poll(0);assert.equal(f.requests.length,1);assert.equal(f.calls(),0);
  assert.ok(!f.store.latest<any>('maintenance',0,'wake-state').signals.some((s:any)=>s.key==='activity'));
  assert.ok(!f.store.latest<any>('maintenance',0,'wake-state').notices.some((n:any)=>n.id===0));
 }finally{f.store.close();}
});
test('a durable acceptance survives a failure immediately after COMMIT without resubmission',async()=>{
 const f=fixture();try{
  const save=f.store.saveEvents.bind(f.store);let injected=false;
  f.store.saveEvents=(state,events,id,basis)=>{const result=save(state,events,id,basis);if(!injected&&events.some(e=>e.kind==='tool-result')){injected=true;throw Error('after COMMIT');}return result;};
  await f.runner().poll(0);assert.equal(f.requests.length,1);assert.equal(f.state.status,'error');
  f.store.saveEvents=save;f.state.status='waiting';f.state.enabled=true;
  await f.runner().poll(1000);assert.equal(f.requests.length,1);assert.equal(f.state.status,'waiting');assert.equal(f.calls(),0);
 }finally{f.store.close();}
});
test('a private change during dispatch preserves newer memory while committing the accepted receipt',async()=>{
 const f=fixture();try{
  const send=f.gateway.request;f.gateway.request=async(path,data)=>{const result=await send(path,data);const fresh={...f.state,memory:{...f.state.memory,strategy:'new concurrent directive'}};f.store.save(fresh,'synthetic-private-update');return result;};
  await f.runner().poll(0);assert.equal(f.requests.length,1);assert.equal(f.state.memory.strategy,'new concurrent directive');assert.equal(f.store.latest<any>('maintenance',0,'mechanical-keepalive-state').status,'confirmed');
 }finally{f.store.close();}
});
