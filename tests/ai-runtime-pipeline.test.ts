import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../packages/ai/src/reference.js';
import {resolveReferenceBotMode} from '../packages/ai/src/reference.js';
import {GameTransportError} from '../packages/ai/src/controller/transport/gateway.js';

for(const force of [false,true])test(`${force?'explicit':'automatic'} admission ${force?'revokes readiness':'starts without a readiness round trip'} and closes before reporting`,async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any,order:string[]=[];runtime.fixedController=true;
 const entry={desired:true,active:null,config:{settings:{}},gateway:{writable:true,readinessSignature:'session:tick',request:async(_path:string,body:{ready:boolean})=>{order.push(body.ready?'ready':'clear');return {ready:body.ready};}},
  runner:{state:{status:'waiting'},telemetry:{tick:1},backgroundWakeRevision:0,startReadinessTiming:()=>()=>{},poll:async(_time:number,_force:boolean,_refresh:boolean,options:{beforeDecision?:()=>Promise<void>})=>{await options.beforeDecision?.();order.push('think');},advanceReadiness:()=>({tick:1,revision:'basis',chatCursor:0}),closeForeground:()=>{order.push('close');}},store:{recordTiming:()=>{}}};
 await runtime.poll(entry,force);
 assert.deepEqual(order,force?['clear','think','close','ready']:['think','close','ready']);
});

for(const expired of [false,true])test(`${expired?'expired':'valid'} lease renewal gates only the expired seat, never its peers`,async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any,polls:string[]=[];let release!:()=>void,renewals=0;
 const gate=new Promise<void>(r=>{release=r;}),now=Date.now();
 const entries=['slow','peer'].map((id,index)=>({config:{id,settings:{}},desired:true,active:null,runner:{state:{}},commander:{tick:()=>{}},gateway:{expiresAt:now+(index===0?(expired?-1000:10000):60000),renew:async()=>{renewals++;await gate;entries[0]!.gateway.expiresAt=Date.now()+60000;}}}));
 Object.assign(runtime,{entries:new Map(entries.map(e=>[e.config.id,e])),resolveMode:resolveReferenceBotMode,pollBackground:()=>{},poll:async(e:typeof entries[number])=>{polls.push(e.config.id);}});
 const cycle=runtime.tick();
 try{
  await new Promise(r=>setImmediate(r));assert.equal(renewals,1);assert.ok(polls.includes('peer'));
  assert.equal(polls.includes('slow'),!expired);
 }finally{release();await cycle;}
 assert.ok(polls.includes('slow'));
});

for(const failure of ['TRANSPORT_UNCONFIRMED','LEASE_LOST'])test(`sync ${failure} ${failure==='LEASE_LOST'?'stops ownership':'leaves foreground work and run intent intact'}`,async()=>{
 const runtime=Object.create(AgentRuntime.prototype) as any;let halted=0,recorded=0,reads=0;
 const inFlight=Promise.resolve(),entry={desired:true,active:inFlight,runner:{running:true,state:{enabled:true}},gateway:{writable:true,waitForChange:async()=>{
  reads++;if(reads===1)throw new GameTransportError({requestId:'body-failure',method:'GET',path:'/player/v2/sync',origin:'http://127.0.0.1',timeoutMs:15000,elapsedMs:15000,stage:'read-response',failure,outcome:'read-only',status:200});
  entry.desired=false;return null;
 }}};
 Object.assign(runtime,{halt:()=>{halted++;},recordRuntimeError:()=>{recorded++;}});
 runtime.watch(entry);await (entry as any).watching;
 assert.equal(halted,failure==='LEASE_LOST'?1:0);assert.equal(recorded,failure==='LEASE_LOST'?0:1);
 assert.equal(entry.active,inFlight);assert.equal(entry.runner.running,true);assert.equal(entry.runner.state.enabled,true);
 if(failure==='TRANSPORT_UNCONFIRMED'){
  assert.equal(entry.desired,true);assert.equal((entry as any).watching,undefined);
  runtime.watch(entry);await (entry as any).watching;assert.equal(reads,2,'the existing scheduler can restart the sync lane');
 }
});
