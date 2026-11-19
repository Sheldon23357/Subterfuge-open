import test from 'node:test';
import assert from 'node:assert/strict';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {initialHybridState,type HybridState,type StrategicAssessment} from '../plugins/hybrid/src/contracts.js';
import {publishContractIntent,contractCommandStep,settleHybridContractReceipts} from '../plugins/hybrid/src/server-contracts.js';
import type {BotModeServices} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {initialState,type AiSnapshot,type GameGateway} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {ControllerSeatRunner} from '../packages/ai/src/controller/runtime/runner.js';
import {hybridMode} from '../plugins/hybrid/src/index.js';
import {GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';
import type {DiplomacyAction} from '../packages/rules/src/index.js';

function fixture(){
 const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:15,y:0}},economy:{initialTick:0,teamSize:0,
  players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 const room={state:createFleetScenario(setup),scheduled:[]},saved=initialHybridState(),receipts=new Map<string,unknown>(),attempts=new Map<string,string>();let serial=0,wakes=0;
 const observe=()=>observation(room,0,'queue-test');
 const snapshot=():AiSnapshot=>({observation:observe(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3});
 const action=(peer:number):DiplomacyAction=>({kind:'propose-agreement',peer,terms:{kind:'ceasefire',outposts:['a',peer===1?'b':'c']},subsidy:null,counterTo:null});
 const assessment=(action:DiplomacyAction|null):StrategicAssessment=>({summary:'边界安排',objectives:[],forbiddenPlayers:[],protectedSources:[],reserves:[],reviewOn:[],message:null,agreement:{status:'none',fulfillment:'none',summary:'边界合作',internalIntent:'稳定边界',forbidAttack:false,forbiddenTargets:[],jointAttack:null,expiresWorldDay:null},diplomacyAction:action,intentEdits:{upsert:[],cancel:[]}});
 const publish=(peer:number,a=action(peer))=>publishContractIntent(saved,observe(),assessment(a),String(peer),[peer],0);
 const lookup:NonNullable<BotModeServices['attemptReceipt']>=(kind,id)=>{const requestId=attempts.get(kind+':'+id);return requestId?{requestId,receipt:receipts.get(requestId)}:undefined;};
 const services={latest:()=>undefined,attemptReceipt:lookup,record:(kind:string,details:Record<string,unknown>)=>{if(kind==='contract-attempt')attempts.set(kind+':'+details.id,'request-'+(++serial));}} as unknown as BotModeServices;
 const project=(requestId:string)=>settleHybridContractReceipts({requestIds:[requestId],latest:<T>()=>saved as T,attemptReceipt:lookup,record:(_kind,value)=>Object.assign(saved,value),wake:()=>{wakes++;}});
 return {room,saved,observe,snapshot,action,assessment,publish,receipts,attempts,services,project,wakes:()=>wakes};
}

test('new conversations queue behind an unknown effect and duplicate intentions reuse the original entry',()=>{
 const f=fixture();f.publish(1);
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'order');
 const first=f.saved.contractCommands![0]!,id=f.attempts.get('contract-attempt:'+first.id)!;
 f.publish(2);f.publish(2);
 assert.deepEqual(f.saved.contractCommands!.map(c=>c.status),['unknown','pending']);
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'finish');
 assert.equal(f.attempts.size,1,'no second remote attempt while the first result is unknown');
 f.receipts.set(id,{result:{commandReceipt:{status:'accepted'}}});f.project(id);
 assert.deepEqual(f.saved.contractCommands!.map(c=>c.status),['accepted','pending']);assert.equal(f.wakes(),1);
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'order');
 assert.equal(f.attempts.size,2);assert.deepEqual(f.saved.contractCommands!.map(c=>c.status),['accepted','unknown']);
});

test('unrelated receipts cannot turn an about-to-send attempt into a retry',()=>{
 const f=fixture();f.publish(1);contractCommandStep(f.saved,f.observe(),f.services,0);
 const first=f.saved.contractCommands![0]!,id=f.attempts.get('contract-attempt:'+first.id)!;
 f.receipts.set(id,{result:{status:'not-executed'}});
 f.project('unrelated-request');assert.equal(first.status,'unknown');assert.equal(f.wakes(),0);
 f.project(id);assert.equal(f.saved.contractCommands![0]!.status,'pending');assert.equal(f.wakes(),1);
});

test('unknown evidence remains unknown; a definitive rejection releases the next queued intention',()=>{
 const f=fixture();f.publish(1);contractCommandStep(f.saved,f.observe(),f.services,0);f.publish(2);
 const id=f.attempts.get('contract-attempt:'+f.saved.contractCommands![0]!.id)!;
 f.receipts.set(id,{result:{status:'unknown'}});f.project(id);
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'finish');assert.equal(f.wakes(),0);
 f.receipts.set(id,{result:{status:'rejected',reason:'Actual current-state rejection'}});f.project(id);
 assert.equal(f.saved.contractCommands![0]!.status,'failed');assert.equal(f.wakes(),1);
 assert.equal(contractCommandStep(f.saved,f.observe(),f.services,0)!.reply.tool,'order');
});

test('an expired queue head is discarded before dispatching the next valid intention',()=>{
 const f=fixture();f.room.state=submitFleetOrder(f.room.state,{id:'old-offer',player:1,action:{kind:'propose-agreement',peer:0,terms:{kind:'joint-attack',enemy:2},subsidy:null,counterTo:null}}).state;
 f.publish(1,{kind:'respond-agreement',agreementId:'old-offer',response:'reject'});
 f.publish(2,{kind:'propose-agreement',peer:2,terms:{kind:'joint-attack',enemy:1},subsidy:null,counterTo:null});
 f.room.state=advanceFleetScenario(f.room.state,Math.ceil(f.room.state.diplomacy.agreements[0]!.deadline));
 const result=contractCommandStep(f.saved,f.observe(),f.services,0)!;
 assert.equal(result.reply.tool,'order');assert.equal(((result.reply.arguments as Record<string,unknown>).action as {peer:number}).peer,2);
 assert.deepEqual(f.saved.contractCommands!.map(c=>c.status),['failed','unknown']);assert.equal(f.attempts.size,1);
});

for(const outcome of ['accepted','rejected'] as const)test(`controller projects a ${outcome} receipt during the same poll, before another tactical round`,async()=>{
 const f=fixture(),store=new AiStore(':memory:'),state=initialState('queue-test',0,{mode:'hybrid',model:'',personality:'schemer'});state.enabled=true;
 f.publish(1);let writes=0;
 const gateway:GameGateway={snapshot:async()=>f.snapshot(),request:async(path,data)=>{
  assert.equal(path,'/tool/order');writes++;
  if(outcome==='rejected')throw new GameRequestError(400,f.observe(),'INVALID_REQUEST');
  const order=(data as {order:{id:string;action:DiplomacyAction}}).order;
  f.room.state=submitFleetOrder(f.room.state,{...order,player:0}).state;return f.observe();
 }};
 const {createBackground,...mode}=hybridMode;
 try{
  store.saveEvents(state,[{kind:'mode-hybrid-state',details:f.saved}]);
  const runner=new ControllerSeatRunner(state,store,gateway,{step:async()=>assert.fail('Receipt projection never calls a model')},1,{},()=>mode);
  await runner.poll(1000,true,false,{oneRoundPerTick:true});
  assert.equal(writes,1);assert.equal(store.latest<HybridState>(state.roomId,0,'mode-hybrid-state')!.contractCommands![0]!.status,outcome==='accepted'?'accepted':'failed');
  assert.equal(f.observe().view.tick,0,'no next tick was needed to update the projection');
 }finally{store.close();}
});

test('a confirmed recovery receipt updates state once and preserves concurrently queued commands',()=>{
 const f=fixture();f.publish(1);contractCommandStep(f.saved,f.observe(),f.services,0);f.publish(2);
 const id=f.attempts.get('contract-attempt:'+f.saved.contractCommands![0]!.id)!;f.receipts.set(id,{result:{status:'accepted',protocolReceipt:{effectCommitted:true}}});
 f.project(id);f.project(id);
 assert.deepEqual(f.saved.contractCommands!.map(c=>c.status),['accepted','pending']);assert.equal(f.wakes(),1);
});
