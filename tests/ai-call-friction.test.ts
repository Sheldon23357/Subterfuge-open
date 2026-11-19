import {SeatRunner} from './helpers/scripted-controller.js';
import {roundMapBlocks} from '../packages/ai/src/controller/presentation/round-map.js';
import {fleetReferenceRenderer} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {createHash} from 'node:crypto';import {AiStore,initialState,executeTool,PlayerGateway,GameRequestError,GameTransportError,type AiSnapshot} from '../packages/ai/src/index.js';
import {type ToolContext} from '../packages/ai/src/controller/execution/tools.js';
import {scheduleLabel,fleetLabel} from '../packages/ai/src/controller/presentation/fleet-labels.js';
import {STRUCTURED_ARGUMENT_DEFINITIONS} from '../packages/ai/src/controller/contracts/structured-arguments.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation,createPlayerApi} from '../packages/server/src/player-api.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {scheduledCommitments} from '../packages/ai/src/controller/analysis/scheduled-commitments.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {cancelSchedule} from '../packages/server/src/planning.js';
import {commandSource} from '../packages/server/src/manual-commands.js';

const source='蓝方工厂',hub='红方后方',target='红方矿场';
const launch=(drillers:number,destination=hub)=>({kind:'launch',delayWorldDays:1,source,destination,drillers});
async function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 cfg.economy.outposts[2].owner=0;

 const accessData=PlayerAccess.generate(2),access=new PlayerAccess(accessData),serial=new SerialExecutor(),roomStore=new RoomStore(':memory:');
 roomStore.commit({state:createFleetScenario(cfg),scheduled:[],playerRoomId:access.roomId},0);roomStore.protocol!.startAuthority(access.roomId,cfg.economy.players.length);
 const server=createPlayerApi({protocol:{repository:roomStore.protocol!,roomId:access.roomId,serial,load:()=>roomStore.load()!,commit:(next,revision)=>roomStore.commit(next,revision),ownerIdentity:authorization=>{const player=access.identity(authorization);return player===null?null:{roomId:access.roomId,player};}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address==='object');
 const gateway=new PlayerGateway(`http://127.0.0.1:${address.port}`,accessData.credentials[0]!.token,access.roomId,0,2);
 const state=initialState(access.roomId,0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const snapshot:AiSnapshot={observation:observation(roomStore.load()!.room,0,access.roomId),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const c:ToolContext={state,snapshot,gateway,id:'initial',spoken:0,now:60000,
  audit:(kind,p)=>store.save(state,kind,p),readToolResult:(id,detail)=>store.queryResult(state.roomId,0,id,detail),
  hasMemoryEvidence:ref=>store.hasMemoryEvidence(state.roomId,0,ref)};
 const send=async(tool:string,args:unknown,id:string)=>{c.id=id;const o=await executeTool(tool,args,c) as AiSnapshot['observation'];snapshot.observation=o;const room=roomStore.load()!.room;assert.equal(o.manualCommands?.receipts.length??0,0,'real agent-controlled writes are not human command evidence');assert.ok(Object.values(room.manualCoordination?.provenance??{}).every(source=>source==='agent'));return o;};
 const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));roomStore.close();store.close();};
 const manualSchedule=(id:string,action:any,issueTick:number)=>{const saved=roomStore.load()!;roomStore.commit(scheduleOrder(saved.room,{order:{id,player:0,action:(()=>{const {delayWorldDays,...rest}=action;return {...rest,...delayWorldDays===undefined?{}:{delaySeconds:delayWorldDays*600}};})()},issueTick}),saved.revision);snapshot.observation=observation(roomStore.load()!.room,0,access.roomId);};
 const manualCancel=(id:string)=>{const saved=roomStore.load()!;roomStore.commit(cancelSchedule(saved.room,id,0),saved.revision);snapshot.observation=observation(roomStore.load()!.room,0,access.roomId);};
 return {snapshot,state,store,gateway,c,send,close,manualSchedule,manualCancel,room:()=>roomStore.load()!.room};
}


test('archived reads and writes cannot reopen a retired model recall capability',async()=>{
 const f=await fixture();let archiveReads=0;try{
  const context={...f.c,readToolResult:()=>{archiveReads++;return {body:'must not enter the model'};}};
  for(const tool of ['rules','chatHistory','forecast','queries','notebook','order','batch']){
   f.store.save(f.state,'tool-result',{id:'saved-'+tool,tool,result:{body:'archived '+tool}});
   await assert.rejects(executeTool('recall',{id:'saved-'+tool,detail:true},context),/not available/);
  }
  await assert.rejects(executeTool('notebook',{id:'saved-notebook'},context));
  assert.equal(archiveReads,0,'model requests cannot invoke the internal archive reader');
  assert.equal(f.room().state.commands.length,0);
 }finally{await f.close();}
});

test('player schedule labels never rename a fleet sharing the same underlying id',async()=>{
 const f=await fixture();try{
  f.manualSchedule('one',launch(14),101);
  const s=f.snapshot.observation.scheduled[0]!;
  f.snapshot.observation.view.fleets.push({id:s.id,owner:0,state:'moving',gift:false,position:{x:0,y:0},drillers:14,destination:{kind:'outpost',id:hub}});
  const before=structuredClone(f.snapshot),prompt=roundMapBlocks(f.snapshot,fleetReferenceRenderer(f.snapshot.observation)).map(b=>b.text).join('\n');
  assert.ok(prompt.includes(scheduleLabel(s.id)));assert.ok(prompt.includes(fleetLabel(s.id)));
  assert.deepEqual(f.snapshot,before);

 }finally{await f.close();}
});

test('initial incoming messages become persistent evidence and existing started records are accepted privately',async()=>{
 const f=await fixture();try{
  const msg={id:'received',from:1,to:0,text:'已撤单，稍后核验',tick:100,sentAt:0};f.snapshot.chat=[msg];
  const g={snapshot:async()=>structuredClone(f.snapshot),request:f.gateway.request.bind(f.gateway),attackRoutes:f.gateway.attackRoutes.bind(f.gateway)};
  await new SeatRunner(f.state,f.store,g,{step:async()=>({tokens:1,reply:{tool:'finish',summary:'已读',arguments:{}}})}).poll(0,true);
  assert.equal(f.store.latest<any>(f.state.roomId,0,'messages-read').messages[0].id,'received');
  assert.equal(f.store.hasMemoryEvidence(f.state.roomId,0,'chat:received'),true);
  f.store.save(f.state,'started',{sequence:9,incomingMessages:[{...msg,id:'old-initial'}]});
  assert.equal(f.store.hasMemoryEvidence(f.state.roomId,0,'chat:old-initial'),true);
  assert.equal(f.store.hasMemoryEvidence(f.state.roomId,1,'chat:old-initial'),false);
  assert.equal(f.store.hasMemoryEvidence('other',0,'chat:old-initial'),false);
  assert.equal(f.store.hasMemoryEvidence(f.state.roomId,0,'chat:invented'),false);
 }finally{await f.close();}
});

test('pause after a confirmed write persists its receipt before another decision and recovery never replays it',async()=>{
 const f=await fixture();try{
  let runner:SeatRunner,calls=0;
  const gateway={snapshot:async()=>({...f.snapshot,observation:observation(f.room(),0,f.state.roomId)}),
   attackRoutes:f.gateway.attackRoutes.bind(f.gateway),request:async(path:string,args:unknown)=>{
    const result=await f.gateway.request(path,args);if(path==='/tool/order')runner.pause();return result;
   }};
  runner=new SeatRunner(f.state,f.store,gateway,{step:async()=>{calls++;return {tokens:1,reply:{tool:'order',arguments:{action:{...launch(14),source:f.snapshot.observation.outpostNames![source]!,destination:f.snapshot.observation.outpostNames![hub]!}},summary:'中转'}};}});
  await runner.poll(0,true);
  assert.equal(calls,1);assert.equal(f.room().state.commands.filter(c=>c.action.kind==='launch').length,1);
  assert.ok(f.store.history(f.state.roomId,0,100).some(row=>row.kind==='tool-result'&&(row.payload as {tool?:string}).tool==='order'));
  assert.equal(f.store.latest(f.state.roomId,0,'campaign-state'),null);
  const restored=f.store.load(f.state.roomId,0)!;restored.enabled=true;
  const freshGateway={snapshot:gateway.snapshot,request:f.gateway.request.bind(f.gateway),attackRoutes:gateway.attackRoutes};
  await new SeatRunner(restored,f.store,freshGateway,{step:async()=>({tokens:1,reply:{tool:'finish',arguments:{},summary:'保留已接受的运输'}})}).poll(10000,true);
  assert.equal(f.room().state.commands.filter(c=>c.action.kind==='launch').length,1);
 }finally{await f.close();}
});

test('internal evidence metadata is absent from generation schema and legacy invalid metadata still rejects atomically',async()=>{
 const f=await fixture();try{
  assert.equal('memoryRecord'in STRUCTURED_ARGUMENT_DEFINITIONS,false);
  const record={type:'plan',status:'active',summary:'明确计划',players:[0],entities:[],links:[],evidence:Array.from({length:9},(_,i)=>'tool:'+i),reviewAt:null};
  await assert.rejects(executeTool('finish',{memory:{strategy:'must not save'},notebook:{set:[{id:'nine-evidence',kind:'plan',text:'保留所有依据',record}]}},f.c),/FINISH_PREFLIGHT_INVALID/);
  assert.equal(f.state.memory.strategy,'');assert.equal(f.store.notebook(f.state.roomId,0,60000).length,0);
 }finally{await f.close();}
});







test('zero-troop transport is rejected atomically and ordinary troops use the normal command path',async()=>{
 const f=await fixture();try{
  for(const drillers of [0,-1])await assert.rejects(f.send('order',{action:launch(drillers)},'invalid-'+drillers));
  assert.equal(f.room().state.commands.length,0);
  await f.send('order',{action:launch(1)},'positive');assert.equal(f.snapshot.observation.view.fleets[0]!.drillers,1);
  assert.equal(f.room().state.commands.filter(c=>c.action.kind==='launch').length,1);
 }finally{await f.close();}
});
test('a scheduled transport reserves its troops and cancellation releases the actual commitment',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.manualSchedule('empty-future',launch(0),101));
  f.manualSchedule('future-troops',launch(35),101);
  const pending=f.snapshot.observation.scheduled.find(p=>p.status==='pending')!;assert.ok(pending);
  assert.equal(f.snapshot.observation.view.fleets.length,0);
  assert.equal(scheduledCommitments(f.snapshot.observation).find(p=>p.source===source)!.drillers,35);
  f.manualCancel(pending.id);assert.deepEqual(scheduledCommitments(f.snapshot.observation),[]);
  assert.equal(f.room().state.commands.filter(c=>c.action.kind==='launch').length,0);
 }finally{await f.close();}
});
