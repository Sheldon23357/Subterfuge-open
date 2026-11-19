import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {AiStore,initialState,GameRequestError,GameTransportError,type AiSnapshot,type AgentRequest} from '../packages/ai/src/index.js';
import {createFleetScenario,submitFleetOrder,type FleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {cancelSchedule,type LabRoom} from '../packages/server/src/planning.js';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const reply=(tool:string,args:unknown={})=>({tokens:1,reply:{tool,arguments:JSON.stringify(args),summary:'freshness regression'}});
function fixture(kind:'order'|'batch'='order',options:{holdReceipt?:boolean;unknown?:boolean;notice?:boolean;local?:boolean}={}){
 let room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[]};
 const initial=observation(room,0,'freshness'),source=initial.view.outposts.find(p=>p.owner===0)!,target=initial.view.outposts.find(p=>p.owner!==0)!;
 const launch={kind:'launch',source:source.id,destination:target.id,drillers:1} as const;
 const modelLaunch={...launch,source:initial.outpostNames![source.id]!,destination:initial.outpostNames![target.id]!};
 const store=new AiStore(':memory:'),state=initialState('freshness',0,{model:'',personality:'sentinel'});
 if(options.local){state.lastThought=60000;store.save(state,'wake-state',{signals:[{key:'local-review',category:'military',reason:'local review',entities:[target.id],urgent:true}],deferred:[],observed:observation(room,0,'freshness'),inFlight:null});}
 const entered1=gate(),entered2=gate(),release1=gate(),release2=gate(),captured=gate(),releasePoll=gate(),written=gate(),releaseReceipt=gate();
 let reads=0,calls=0,writes=0,staleRoutes=0,notify=false;
 const requests:AgentRequest[]=[],readCursors:{chat:number;notice:number}[]=[];
 const current=()=>observation(room,0,'freshness');
 const snapshot=():AiSnapshot=>({observation:current(),chat:notify?[{id:'late-chat',from:1,to:0,text:'fresh message retained',tick:100,sentAt:0}]:[],notifications:notify?[{id:0,kind:'battle',text:'fresh battle retained',tick:100,seconds:0,details:'new battle',urgent:true,sendNotification:true,location:{kind:'outpost',id:source.id,position:source.position}}]:[],chatCursor:notify?1:0,notificationCursor:notify?1:0,chatPlayer:0,chatCount:2});
 const gateway={
  attackRoutes:async(o:AiSnapshot['observation'])=>{if(o.revision!==current().revision){staleRoutes++;throw new GameRequestError(409,current());}return attackRoutes(o);},
  snapshot:async(chat:number,notice:number)=>{readCursors.push({chat,notice});const s=structuredClone(snapshot());if(++reads===2){captured.release();await releasePoll.promise;}return s;},
  request:async(path:string,data:unknown)=>{const d=data as {revision:string;order:FleetOrder;issueTick:number;id:string};if(d.revision!==current().revision)throw new GameRequestError(409,current());
   try{
    if(path==='/tool/order')room={...room,state:submitFleetOrder(room.state,{...d.order,player:0}).state};
    else throw Error('Unexpected write path');
   }catch(e){throw new GameRequestError(400,undefined,undefined,String(e));}
   writes++;written.release();if(options.holdReceipt)await releaseReceipt.promise;if(options.unknown)throw new GameTransportError();return current();},
 };
 const action=kind==='order'?{action:modelLaunch}:{actions:[{tool:'order',arguments:{action:modelLaunch}},{tool:'order',arguments:{action:{...modelLaunch,drillers:1000000}}}]};
 const runner=new SeatRunner(state,store,gateway,{step:async r=>{requests.push(r);calls++;if(calls===1){entered1.release();await release1.promise;return reply(kind,action);}if(calls===2){entered2.release();await release2.promise;}return reply('finish');}});
 return {store,state,runner,gateway,current,requests,readCursors,entered1,entered2,release1,release2,captured,releasePoll,written,releaseReceipt,notify:()=>{notify=!!options.notice;},counts:()=>({reads,calls,writes,staleRoutes}),close:()=>{release1.release();release2.release();releasePoll.release();releaseReceipt.release();runner.pause();store.close();}};
}
for(const kind of ['order','batch'] as const){
 test(`a delayed pre-${kind} poll cannot regress the accepted observation or create another model call`,async()=>{
  const f=fixture(kind);try{
   const main=f.runner.poll(0,true);await f.entered1.promise;const poll=f.runner.poll(6000);await f.captured.promise;
   f.release1.release();await f.entered2.promise;const accepted=f.current();f.releasePoll.release();await poll;
   f.release2.release();await main;
   assert.equal(f.counts().calls,2);assert.equal(f.counts().writes,1);assert.equal(f.counts().staleRoutes,0);assert.equal(f.counts().reads,3);
   assert.equal(f.state.lastRevision,accepted.revision);assert.equal(f.store.baseline('freshness',0)?.revision,accepted.revision);
   assert.equal(f.store.latest('freshness',0,'reply-superseded'),null);
   const wake=f.store.latest<{signals:{key:string}[];observed?:AiSnapshot['observation']}>('freshness',0,'wake-state')!;
   assert.equal(f.store.latest<AiSnapshot['observation']>('freshness',0,'wake-observation')!.revision,accepted.revision);
   assert.equal(wake.observed,undefined);assert.ok(!wake.signals.some(s=>s.key.startsWith('arrival:')));
  }finally{f.close();}
 });
}
test('a poll crossing an in-flight write waits for its receipt, then refreshes without deadlock',async()=>{
 const f=fixture('order',{holdReceipt:true});try{
  const main=f.runner.poll(0,true);await f.entered1.promise;let pollDone=false;const poll=f.runner.poll(6000).then(()=>{pollDone=true;});await f.captured.promise;
  f.release1.release();await f.written.promise;f.releasePoll.release();await new Promise(r=>setImmediate(r));
  assert.equal(pollDone,false);assert.equal(f.counts().reads,2);
  f.releaseReceipt.release();await f.entered2.promise;await poll;f.release2.release();await main;
  assert.equal(f.counts().calls,2);assert.equal(f.counts().staleRoutes,0);assert.equal(f.state.lastRevision,f.current().revision);
 }finally{f.close();}
});
test('refreshing an invalidated poll retains new chat and a genuine important notification',async()=>{
 const f=fixture('order',{notice:true});try{
  const main=f.runner.poll(0,true);await f.entered1.promise;const poll=f.runner.poll(6000);await f.captured.promise;
  f.release1.release();await f.entered2.promise;f.notify();f.releasePoll.release();await poll;f.release2.release();await main;
  assert.equal(f.counts().calls,3);assert.equal(f.counts().staleRoutes,0);
  const final=f.requests[2]!.prompt;assert.match(final,/fresh message retained/);assert.match(final,/fresh battle retained/);
  assert.doesNotMatch(final,/本人舰队已抵达或消失/);assert.equal(f.state.notificationCursor,1);assert.equal(f.state.chatCursor,1);
 }finally{f.close();}
});
test('a previously started observer cannot resume the runner after an unknown write outcome',async()=>{
 const f=fixture('order',{holdReceipt:true,unknown:true});try{
  const main=f.runner.poll(0,true);await f.entered1.promise;const poll=f.runner.poll(6000);await f.captured.promise;
  f.release1.release();await f.written.promise;f.releasePoll.release();await new Promise(r=>setImmediate(r));f.releaseReceipt.release();await main;await poll;
  assert.equal(f.state.status,'error');assert.equal(f.counts().calls,1);assert.equal(f.counts().writes,1);assert.equal(f.runner.running,false);
 }finally{f.close();}
});
test('local tactical rounds retain accepted writes without depending on a global route refresh',async()=>{
 const f=fixture('order',{local:true});try{
  const main=f.runner.poll(0,true);await f.entered1.promise;const poll=f.runner.poll(6000);await f.captured.promise;
  f.release1.release();await f.entered2.promise;f.releasePoll.release();await poll;f.release2.release();await main;
  assert.equal(f.counts().calls,2);assert.equal(f.counts().staleRoutes,0);assert.equal(f.state.lastRevision,f.current().revision);
  assert.equal(f.store.latest('freshness',0,'reply-superseded'),null);
 }finally{f.close();}
});
test('a failed invalidated-poll refresh propagates once instead of waiting or retrying indefinitely',async()=>{
 const f=fixture();try{
  const original=f.gateway.snapshot;f.gateway.snapshot=async(chat,notice)=>{if(f.counts().reads>=2)throw new GameTransportError();return original(chat,notice);};
  const main=f.runner.poll(0,true);await f.entered1.promise;const poll=f.runner.poll(6000);await f.captured.promise;
  f.release1.release();await f.entered2.promise;f.releasePoll.release();await poll;
  assert.ok(f.store.latest('freshness',0,'observation-error'));f.release2.release();await main;
  assert.equal(f.counts().calls,2);assert.equal(f.state.status,'waiting');assert.equal(f.state.lastRevision,f.current().revision);
 }finally{f.close();}
});
test('a fresh route-conflict observation invalidates an already captured older background poll',async()=>{
 let room:LabRoom={state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[]};
 const store=new AiStore(':memory:'),state=initialState('route-freshness',0,{model:'',personality:'sentinel'});
 const routeEntered=gate(),releaseRoute=gate(),pollCaptured=gate(),releasePoll=gate(),modelEntered=gate(),releaseModel=gate();
 let reads=0,routes=0,calls=0;const current=()=>observation(room,0,'route-freshness');
 const gateway={snapshot:async()=>{const snapshot:AiSnapshot={observation:current(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};if(++reads===2){pollCaptured.release();await releasePoll.promise;}return snapshot;},
  attackRoutes:async(o:AiSnapshot['observation'])=>{if(++routes===1){routeEntered.release();await releaseRoute.promise;throw new GameRequestError(409,current());}assert.equal(o.revision,current().revision);return attackRoutes(o);},
  request:async()=>{throw Error('No tool writes in route regression');}};
 const runner=new SeatRunner(state,store,gateway,{step:async()=>{calls++;modelEntered.release();await releaseModel.promise;return reply('finish');}});
 try{
  const main=runner.poll(0,true);await routeEntered.promise;const poll=runner.poll(6000);await pollCaptured.promise;
  const o=current(),source=o.view.outposts.find(p=>p.owner===0)!,target=o.view.outposts.find(p=>p.owner!==0)!;
  room={...room,state:submitFleetOrder(room.state,{id:'external-launch',player:0,action:{kind:'launch',source:source.id,destination:target.id,drillers:1}}).state};
  releaseRoute.release();await modelEntered.promise;releasePoll.release();await poll;releaseModel.release();await main;
  assert.equal(calls,1);assert.equal(reads,4);assert.equal(state.lastRevision,current().revision);assert.equal(store.latest('route-freshness',0,'reply-superseded'),null);
 }finally{releaseRoute.release();releasePoll.release();releaseModel.release();runner.pause();store.close();}
});
