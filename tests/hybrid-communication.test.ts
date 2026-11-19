import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/controller/contracts/types.js';
import {sendCommunication,type CommunicationWrite} from '../packages/ai/src/controller/runtime/communication.js';
import {communicateHybrid} from '../plugins/hybrid/src/communication.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {basisOf,initialHybridState,type HybridState,type DiplomacyMessage} from '../plugins/hybrid/src/contracts.js';
import {foregroundInputKey} from '../plugins/hybrid/src/foreground-input.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {ControllerSeatRunner} from '../packages/ai/src/controller/runtime/runner.js';
import type {BotMode} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {guardHybridExecution} from '../plugins/hybrid/src/execution-guard.js';
import {DEFAULT_BOT_SETTINGS} from '../packages/contracts/src/index.js';

function fixture(){
 const state=initialState('communication',0,{mode:'hybrid',provider:'offline',model:'',personality:'schemer'});state.enabled=true;
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,state.roomId);
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const saved=initialHybridState();saved.directive={version:1,basis:basisOf(o),summary:'',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],commanderVersion:0,commanderConstraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},agreements:[]};
 const message:DiplomacyMessage={id:'diplomacy-test',conversation:'1',to:[1],text:'收到。',basis:basisOf(o),messageIds:[],status:'pending',agreement:{conversation:'1',players:[1],status:'none',summary:'仅消息',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null,evidence:[],tick:o.view.tick}};
 saved.messages=[message];
 return {state,snapshot,saved,message};
}

test('a communication send is durable and replay reads its result without a second POST',async()=>{
 const f=fixture();let write:CommunicationWrite|undefined,calls=0;
 const gateway:GameGateway={snapshot:async()=>f.snapshot,request:async()=>{assert.equal(write?.status,'unknown');calls++;return {accepted:true,status:'sent'};}};
 const host={...f,gateway,signal:new AbortController().signal,latest:()=>write,save:(w:CommunicationWrite)=>{write=structuredClone(w);},guard:()=>{}};
 const args={to:1,text:'收到。'};
 assert.equal((await sendCommunication(host,'stable',args)).status,'accepted');
 assert.equal((await sendCommunication(host,'stable',args)).status,'accepted');assert.equal(calls,1);
 await assert.rejects(sendCommunication(host,'stable',{...args,text:'different'}),/identity reused/);
});

test('unknown communication reconciles the original identity and does not reissue the message',async()=>{
 const f=fixture();let write:CommunicationWrite|undefined,calls=0,lookups=0;
 const gateway:GameGateway={snapshot:async()=>f.snapshot,request:async()=>{calls++;throw Error('lost response');},reconcileWrites:async requests=>{lookups++;assert.equal(requests[0]!.id,'stable');return [{id:'stable',tool:'say',status:'committed',reason:'receipt'}];}};
 const host={...f,gateway,signal:new AbortController().signal,latest:()=>write,save:(w:CommunicationWrite)=>{write=structuredClone(w);},guard:()=>{}};
 assert.equal((await sendCommunication(host,'stable',{to:1,text:'收到。'})).status,'unknown');
 assert.equal((await sendCommunication(host,'stable',{to:1,text:'收到。'})).status,'accepted');assert.equal(calls,1);assert.equal(lookups,1);
});

test('failed receipt lookup preserves unknown without failing the tactical seat',async()=>{
 const f=fixture(),write:CommunicationWrite={requestId:'stable',status:'unknown',arguments:{to:1,text:'收到。'},basisRevision:f.snapshot.observation.revision,result:{}};
 const gateway:GameGateway={snapshot:async()=>f.snapshot,request:async()=>assert.fail('No resend'),reconcileWrites:async()=>{throw Error('offline');}};
 const result=await sendCommunication({...f,gateway,signal:new AbortController().signal,latest:()=>write,save:()=>assert.fail('No new write'),guard:()=>{}},'stable',write.arguments);
 assert.equal(result.status,'unknown');
});

test('pause and stale commander guards prevent dispatch',async()=>{
 const f=fixture();let write:CommunicationWrite|undefined;
 const gateway:GameGateway={snapshot:async()=>f.snapshot,request:async()=>assert.fail('Guarded send')};
 const host={...f,gateway,signal:new AbortController().signal,latest:()=>write,save:(w:CommunicationWrite)=>{write=w;},guard:()=>{throw Error('stale commander');}};
 assert.equal((await sendCommunication(host,'stale',{to:1,text:'收到。'})).status,'rejected');
 f.state.enabled=false;assert.equal((await sendCommunication(host,'paused',{to:1,text:'收到。'})).status,'rejected');
});

test('message-only communication neither changes tactical input nor wakes tactical search',async()=>{
 const f=fixture(),records=new Map<string,unknown>([['state',f.saved]]),before=foregroundInputKey(f.saved,f.snapshot.observation);let sends=0;
 await communicateHybrid({state:f.state,snapshot:f.snapshot,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k,v)=>records.set(k,structuredClone(v)),wake:()=>assert.fail('Message-only tactical wake'),send:async id=>{sends++;return {requestId:id,status:'accepted',result:{}};}});
 const after=records.get('state') as HybridState;
 assert.equal(sends,1);assert.equal(after.messages[0]!.status,'accepted');assert.equal(foregroundInputKey(after,f.snapshot.observation),before);
});

test('pending diplomatic replies do not replace a tactical search with say',async()=>{
 const f=fixture();f.state.settings.bot={...DEFAULT_BOT_SETTINGS,maxSimulations:2};
 const records=new Map<string,unknown>([['state',f.saved]]);let assessed=0;
 const result=await hybridMode.prepare({state:f.state,snapshot:f.snapshot,history:[],feedback:[],efficiency:{cacheReports:true,cacheRoutes:true},suffix:'',routes:attackRoutes(f.snapshot.observation)}).run({model:'',prompt:'',signal:new AbortController().signal},{model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},local:async(r,compute)=>compute(r),latest:<T>(k:string)=>records.get(k) as T|undefined,
  record:(k,v)=>{records.set(k,structuredClone(v));},markAssessed:()=>{assessed++;},
 });
 assert.notEqual(result.reply.tool,'say');assert.equal(assessed,1);
 assert.equal((records.get('state') as HybridState).messages[0]!.status,'pending');
});

test('send guard rejects changed conversation material and changed message content',()=>{
 const f=fixture(),latest=<T>(k:string)=>(k==='state'?f.saved:k==='message-attempt'?{id:f.message.id}:undefined) as T|undefined;
 const input={state:f.state,snapshot:f.snapshot,tool:'say',arguments:{to:1,text:f.message.text},latest};
 guardHybridExecution(input);
 assert.throws(()=>guardHybridExecution({...input,arguments:{to:1,text:'替换消息'}}),/内容/);
 f.snapshot.chat.push({id:'new-material',from:1,to:0,text:'新条件',tick:f.snapshot.observation.view.tick,sentAt:0});
 assert.throws(()=>guardHybridExecution(input),/新材料/);
});

test('accepted chat recovery cannot sign a server agreement or activate military constraints',async()=>{
 const f=fixture();f.message.agreement.status='confirmed';f.message.agreement.fulfillment='tasks';f.message.agreement.expiresWorldDay=f.snapshot.observation.view.tick+50;
 f.message.intentEdits={upsert:[{id:null,task:{kind:'avoid',target:f.snapshot.observation.view.outposts[0]!.id,until:f.snapshot.observation.view.tick+40,reason:'约定'}}],cancel:[]};
 f.message.status='unknown';f.message.requestId=f.message.id;
 const write:CommunicationWrite={requestId:f.message.id,status:'accepted',arguments:{to:1,text:f.message.text},basisRevision:f.snapshot.observation.revision,result:{accepted:true}};
 const records=new Map<string,unknown>([['state',f.saved],['communication-write',write]]);let wakes=0,sends=0;
 const services={state:f.state,snapshot:f.snapshot,latest:<T>(k:string)=>records.get(k) as T|undefined,record:(k:string,v:Record<string,unknown>)=>records.set(k,structuredClone(v)),wake:()=>{wakes++;},send:async()=>{sends++;return write;}};
 await communicateHybrid(services);await communicateHybrid(services);
 assert.equal(sends,1);assert.equal(wakes,0);assert.equal((records.get('state') as HybridState).intents?.length??0,0);
 assert.equal((records.get('state') as HybridState).directive!.agreements.length,0);
});

test('communication runs after tactical admission closes without advancing tactical sequence or blocking readiness',async()=>{
 const f=fixture(),store=new AiStore(':memory:');let posts=0,tactics=0;
 const {createBackground,...base}=hybridMode;
 const mode:BotMode={...base,prepare:()=>({context:{prompt:''} as never,run:async()=>{tactics++;return {tokens:0,reply:{tool:'finish',arguments:{},summary:'done'}};}})};
 const gateway:GameGateway={snapshot:async()=>structuredClone(f.snapshot),request:async()=>{posts++;return {accepted:true,status:'sent'};}};
 const runner=new ControllerSeatRunner(f.state,store,gateway,{step:async()=>assert.fail('No model')},1,{},()=>mode);
 try{
  await runner.poll(1000,true,false,{oneRoundPerTick:true});const sequence=f.state.sequence;assert.equal(tactics,1);
  store.saveEvents(f.state,[{kind:'mode-hybrid-state',details:f.saved}]);
  await runner.pollBackground();
  assert.equal(posts,1);assert.equal(f.state.sequence,sequence);assert.equal(tactics,1);assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),true);
  const receipt=store.latest<CommunicationWrite>(f.state.roomId,0,'mode-hybrid-communication-write');assert.equal(receipt?.status,'accepted');
 }finally{store.close();}
});

test('an unknown communication result leaves tactical readiness independent',async()=>{
 const f=fixture(),store=new AiStore(':memory:');let posts=0;
 const {createBackground,...base}=hybridMode;
 const mode:BotMode={...base,prepare:()=>({context:{prompt:''} as never,run:async()=>({tokens:0,reply:{tool:'finish',arguments:{},summary:'done'}})})};
 const gateway:GameGateway={snapshot:async()=>structuredClone(f.snapshot),request:async()=>{posts++;throw Error('lost chat response');},reconcileWrites:async()=>[]};
 const runner=new ControllerSeatRunner(f.state,store,gateway,{step:async()=>assert.fail('No model')},1,{},()=>mode);
 try{
  store.saveEvents(f.state,[{kind:'mode-hybrid-state',details:f.saved}]);
  await runner.poll(1000,true,false,{oneRoundPerTick:true});
  assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),true);assert.equal(f.state.error,null);
  await runner.pollBackground();assert.equal(posts,1);assert.equal(f.state.sequence,1);
  assert.equal(runner.readyToAdvance(f.snapshot.observation.view.tick),true);
 }finally{store.close();}
});
