import {DispatchSourceLocked} from '../packages/server/src/dispatch-guard.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup,type FleetAction} from '../packages/engine/src/index.js';
import {advanceRoom,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {applyCoordinatedOrder,applyCoordinatedCancellation} from '../packages/server/src/player-commands.js';
import {reconcileManualProtections,manualCommandView,manualCommandVersion,manualReceiptPage,ManualCommandConflict} from '../packages/server/src/manual-commands.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {PlayerControl} from '../packages/server/src/player-control.js';
function room():LabRoom{const setup=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;setup.economy.players[0]!.neptunium=200;return {state:createFleetScenario(setup),scheduled:[]};}
const launch=(drillers=20):FleetAction=>({kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers});
const order=(r:LabRoom,id:string,action:FleetAction,source:'manual'|'agent'='manual',tick?:number)=>applyCoordinatedOrder(r,{id,player:0,action},source,0,tick);

test('starting another mine cannot implicitly commit a protected human mine',()=>{
 const cfg=structuredClone(room().state.initial);cfg.economy.outposts.find(p=>p.id==='红方后方')!.owner=0;
 cfg.economy.outposts.find(p=>p.id==='红方后方')!.drillers=300;
 const initial:LabRoom={state:createFleetScenario(cfg),scheduled:[]};
 const r=order(initial,'human-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'}),before=saveRoom(r);
 assert.throws(()=>order(r,'other-mine',{kind:'toggle-mine',outpostId:'红方后方'},'agent'),ManualCommandConflict);
 assert.equal(saveRoom(r),before);assert.equal(r.state.economy.outposts.find(p=>p.id==='蓝方工厂')!.minePending,true);
 assert.deepEqual(restoreRoom(before),r);
});

test('manual commands protect implicit same-route edits and cancellation without blocking unrelated AI work',()=>{
 let r=order(room(),'human',launch(20));
 assert.equal(manualCommandVersion(r,0),1);assert.equal(manualCommandView(r,1).receipts.length,0);
 for(const a of [launch(1),launch(30),{kind:'cancel-launch',fleetId:'human'},{kind:'return-fleet',fleetId:'human'}] as FleetAction[])assert.throws(()=>order(r,'ai-'+JSON.stringify(a),a,'agent'),ManualCommandConflict);
 r=order(r,'unrelated',{kind:'toggle-funding',recipient:1},'agent');assert.equal(r.state.commands.at(-1)!.id,'unrelated');
 assert.equal(r.state.fleets.find(f=>f.id==='human')!.drillers,20);assert.equal(manualCommandVersion(r,0),1);
});
test('latest human edit of an AI fleet protects the resolved original identity and retry does not re-protect or increment',()=>{
 let r=order(room(),'ai-first',{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:10,delaySeconds:1200},'agent');r=order(r,'human-edit',launch(30));
 assert.deepEqual(manualCommandView(r,0).receipts[0]!.affectedFleetIds,['ai-first']);
 assert.throws(()=>order(r,'ai-revert',launch(10),'agent'),DispatchSourceLocked);
 assert.throws(()=>order(r,'same-day-human-edit',launch(40)),DispatchSourceLocked);
 const replay=saveRoom(r);r=order(r,'human-edit',launch(30));assert.equal(saveRoom(r),replay);
 r=advanceRoom(r,r.state.economy.tick+1);
 r=order(r,'human-edit-again',launch(40));const before=saveRoom(r);r=order(r,'human-edit',launch(30));assert.equal(saveRoom(r),before);assert.equal(manualCommandVersion(r,0),2);
});
test('cancelled launch route suppresses new IDs and quantities after fleet disappearance and time advance, but not other routes',()=>{
 let r=order(room(),'ai-fleet',launch(),'agent');r=order(r,'human-cancel',{kind:'cancel-launch',fleetId:'ai-fleet'});
 assert.equal(r.state.fleets.find(f=>f.id==='ai-fleet')?.used,false);
 for(const count of [1,20,30])assert.throws(()=>order(r,'new-'+count,launch(count),'agent'),DispatchSourceLocked);
 r=advanceRoom(r,r.state.economy.tick+2);assert.throws(()=>order(r,'new-after-time',launch(1),'agent'),ManualCommandConflict);
 assert.doesNotThrow(()=>order(r,'other-route',{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:1},'agent'));
 r=order(r,'human-authorizes-new',launch(10));assert.equal(manualCommandView(r,0).protections.some(p=>p.kind==='route'),false);
});
test('route suppression expires on material target ownership change, not production/time changes',()=>{
 let r=order(room(),'old',launch(),'agent');r=order(r,'cancel',{kind:'cancel-launch',fleetId:'old'});
 const changed=structuredClone(r);changed.state.economy.outposts.find(o=>o.id==='红方矿场')!.owner=0;
 assert.equal(manualCommandView(changed,0).protections.some(p=>p.kind==='route'),false);
 assert.throws(()=>order(changed,'same-day-new-circumstances',launch(1),'agent'),DispatchSourceLocked);
 assert.doesNotThrow(()=>order(advanceRoom(changed,changed.state.economy.tick+1),'new-circumstances',launch(1),'agent'));
});
test('pending manual schedules reserve explicit drillers while spare resources remain usable',()=>{
 let r=order(room(),'manual-plan',launch(70),'manual',102);
 assert.throws(()=>order(r,'consume',{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:50},'agent'),ManualCommandConflict);
 assert.doesNotThrow(()=>order(r,'spare',{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:10},'agent'));
 assert.throws(()=>order(r,'same-route-future',launch(1),'agent',103),ManualCommandConflict);
});
test('previously queued AI effects are rechecked at execution and cannot reverse a later human choice or steal scheduled resources',()=>{
 let r=order(room(),'old-shield',{kind:'set-shields',outpostId:'蓝方工厂',enabled:true},'agent',101);
 r=order(r,'old-launch',{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:80},'agent',101);
 r=order(r,'unrelated',{kind:'toggle-funding',recipient:1},'agent',101);
 r=order(r,'human-shield',{kind:'set-shields',outpostId:'蓝方工厂',enabled:false});r=order(r,'human-plan',launch(70),'manual',102);
 const next=advanceRoom(restoreRoom(saveRoom(r)),101);
 assert.equal(next.scheduledOrders!.find(p=>p.id==='old-shield')!.status,'failed');assert.match(next.scheduledOrders!.find(p=>p.id==='old-shield')!.reason!,/manual/);
 assert.equal(next.scheduledOrders!.find(p=>p.id==='old-launch')!.status,'failed');assert.equal(next.scheduledOrders!.find(p=>p.id==='unrelated')!.status,'executed');assert.equal(next.scheduledOrders!.find(p=>p.id==='human-plan')!.status,'pending');
 assert.equal(next.state.commands.some(c=>c.id==='old-launch'),false);
});
test('AI cancellation checks original collateral closure; human confirmation binds exact closure contents',()=>{
 let r=order(room(),'ai-base',launch(10),'agent',101);r=order(r,'human-edit',{...launch(20),fleetId:'ai-base'} as FleetAction,'manual',102);
 assert.throws(()=>applyCoordinatedCancellation(r,'ai-base',0,'agent'),ManualCommandConflict);
 let conflict:ManualCommandConflict|undefined;try{applyCoordinatedCancellation(r,'ai-base',0,'manual');}catch(error){assert.ok(error instanceof ManualCommandConflict);conflict=error;}
 assert.deepEqual(conflict!.cancelledScheduleIds,['human-edit']);assert.ok(conflict!.cancellationToken);
 assert.throws(()=>applyCoordinatedCancellation(r,'ai-base',0,'manual',0,['human-edit'],'wrong'),ManualCommandConflict);
 const next=applyCoordinatedCancellation(r,'ai-base',0,'manual',0,['human-edit'],conflict!.cancellationToken);
 assert.equal(next.scheduledOrders!.every(p=>p.status==='cancelled'),true);assert.deepEqual(manualCommandView(next,0).receipts.at(-1)!.cancelledScheduleIds,['ai-base','human-edit']);
});
test('invalid manual command leaves provenance, queue, facts and guards unchanged',()=>{
 const r=order(room(),'ai-plan',launch(10),'agent',101),before=saveRoom(r);
 assert.throws(()=>order(r,'invalid',launch(100000)));assert.equal(saveRoom(r),before);assert.equal(manualCommandVersion(r,0),0);
});
test('legacy unknown schedules remain unknown rather than guessed AI, and valid engine behavior is retained',()=>{
 let r=scheduleOrder(room(),{order:{id:'unknown',player:0,action:{kind:'toggle-funding',recipient:1}},issueTick:101});r=order(r,'manual',launch(10));
 assert.equal(r.manualCoordination!.provenance.unknown,undefined);assert.equal(advanceRoom(r,101).scheduledOrders![0]!.status,'executed');
});
test('durable facts have bounded projection and complete own-seat lookup/replay without synthetic success',()=>{
 let r=room();for(let i=0;i<120;i++)r=order(r,`manual-check-${i}`,{kind:'toggle-funding',recipient:1});
 r=restoreRoom(saveRoom(r));const view=manualCommandView(r,0);assert.equal(view.version,120);assert.equal(view.receipts.length,100);assert.equal(view.hasEarlierReceipts,true);
 assert.equal(manualReceiptPage(r,0,new URLSearchParams({id:'manual:0:1'})).receipts[0]!.version,1);
 assert.equal(manualReceiptPage(r,1,new URLSearchParams({id:'manual:0:1'})).receipts.length,0);
 assert.equal(manualReceiptPage(r,0,new URLSearchParams({after:'0',limit:'100'})).hasMore,true);
 assert.deepEqual(manualReceiptPage(r,0,new URLSearchParams({after:'100',limit:'100'})).receipts.map(x=>x.version),Array.from({length:20},(_,i)=>101+i));
});
test('v2 human command preserves the AI lease while stale and protected model writes are rejected',async t=>{
 const h=protocolHarness(t,{room:room()}),data=h.ownerCredentials,session='manual-priority-test-session',server=await createOwnerPlayerApi(h);h.repository.ownerControl(h.roomId,0,{action:'acquire',sessionId:session});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const request=async(path:string,body?:unknown,headers:Record<string,string>={})=>{const response=await fetch(`http://127.0.0.1:${address.port}`+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${data.credentials[0]!.token}`,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
 const command=(id:string,action:FleetAction,revision:string)=>({kind:'order',clientCommandId:id,expectedRevision:revision,payload:{action}}),path='/player/v2/owner/commands';
 try{
  const before=await request('/player/v2/owner/observation'),manual=await request(path,command('human-launch',launch(),before.body.revision));assert.equal(manual.status,200);assert.equal(manual.body.manualCommands.version,1);assert.equal(h.repository.ownerStatus(h.roomId,0,{'x-subterfuge-control-session':session}).sessionId,session);
  const headers={'x-subterfuge-controller':'agent','x-subterfuge-control-session':session};
  const stale=await request(path,command('ai-unrelated',{kind:'toggle-funding',recipient:1},before.body.revision),headers);assert.equal(stale.status,409);assert.equal(stale.body.code,'REVISION_CONFLICT');
  const conflict=await request(path,command('ai-revert',launch(1),manual.body.revision),headers);assert.equal(conflict.status,409);assert.equal(conflict.body.code,'MANUAL_COMMAND_CONFLICT');
  const allowed=await request(path,command('ai-unrelated-new',{kind:'toggle-funding',recipient:1},manual.body.revision),headers);assert.equal(allowed.status,200);
  assert.equal((await request('/player/v2/owner/control')).body.mode,'agent');
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('expired route and fleet authority cannot resurrect after lifecycle transitions',()=>{
 let r=order(room(),'launch',launch());r=order(r,'cancel',{kind:'cancel-launch',fleetId:'launch'});
 r.state.events.push({sequence:r.state.events.length,tick:r.state.economy.tick+1,fraction:0,kind:'outpost-captured',subject:'红方矿场',details:{before:1,owner:0}});
 // Current ownership is back to the original value; historical transition still terminates this guard.
 assert.equal(manualCommandView(r,0).protections.some(p=>p.kind==='route'),false);
 r=reconcileManualProtections(r);assert.equal(r.manualCoordination!.protections.some(p=>p.kind==='route'),false);
 let moved=order(room(),'human-moving',launch());moved.state.events.push({sequence:moved.state.events.length,tick:moved.state.economy.tick+1,fraction:0,kind:'unloaded',subject:'human-moving',details:{outpost:'红方矿场',drillers:20}});
 assert.equal(manualCommandView(moved,0).protections.some(p=>p.kind==='fleet'),false);moved=reconcileManualProtections(moved);assert.equal(moved.manualCoordination!.protections.some(p=>p.kind==='fleet'),false);
});
test('restoring malformed coordination fails closed for canonical receipts, provenance and kind-specific guards',()=>{
 const r=order(order(room(),'fleet',launch()),'plan',{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方后方',drillers:30},'manual',102),text=saveRoom(r);
 for(const mutate of [(v:any)=>{v.manualCoordination.receipts[0].id='forged';},(v:any)=>{delete v.manualCoordination.protections.find((p:any)=>p.kind==='fleet').fleetId;},(v:any)=>{v.manualCoordination.protections.find((p:any)=>p.kind==='resources').drillers=-1;},(v:any)=>{v.manualCoordination.provenance.fleet='forged';},(v:any)=>{v.manualCoordination.protections[0].eventCursor=-1;},(v:any)=>{const p=v.manualCoordination.protections.find((p:any)=>p.kind==='fleet');p.fleetId='nonexistent';p.scope=['fleet:nonexistent'];},(v:any)=>{v.manualCoordination.protections.find((p:any)=>p.kind==='resources').drillers=0;}]){const raw=JSON.parse(text);mutate(raw);assert.throws(()=>restoreRoom(JSON.stringify(raw)),/manual|provenance/);}
 assert.deepEqual(restoreRoom(text),r);
});
test('manual scheduled setting acquires effect protection at execution without inventing another manual receipt',()=>{
 let r=order(room(),'manual-shield',{kind:'set-shields',outpostId:'蓝方工厂',enabled:false},'manual',101);r=advanceRoom(r,101);
 assert.equal(manualCommandVersion(r,0),1);assert.equal(manualCommandView(r,0).receipts[0]!.outcome,'scheduled');
 assert.equal(r.scheduledOrders![0]!.status,'executed');assert.throws(()=>order(r,'ai-reverse',{kind:'set-shields',outpostId:'蓝方工厂',enabled:true},'agent'),ManualCommandConflict);assert.deepEqual(restoreRoom(saveRoom(r)),r);
});

test('unknown-origin queued reversal is blocked without inventing AI provenance or cancelling unrelated unknown work',()=>{
 let r=scheduleOrder(room(),{order:{id:'unknown-shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true}},issueTick:101});
 r=scheduleOrder(r,{order:{id:'unknown-unrelated',player:0,action:{kind:'toggle-funding',recipient:1}},issueTick:101});r=order(r,'human-shield',{kind:'set-shields',outpostId:'蓝方工厂',enabled:false});
 r=advanceRoom(r,101);assert.equal(r.scheduledOrders!.find(p=>p.id==='unknown-shield')!.status,'failed');assert.equal(r.scheduledOrders!.find(p=>p.id==='unknown-unrelated')!.status,'executed');assert.equal(r.manualCoordination!.provenance['unknown-shield'],undefined);
});

test('manual cancelled mine cannot be immediately recreated under fresh AI command IDs',()=>{
 let r=order(room(),'mine',{kind:'toggle-mine',outpostId:'蓝方工厂'},'agent');r=order(r,'cancel-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'});
 assert.throws(()=>order(r,'recreate-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'},'agent'),ManualCommandConflict);assert.doesNotThrow(()=>order(r,'human-new-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'}));assert.deepEqual(restoreRoom(saveRoom(r)),r);
});
test('cancelling a non-launch scheduled setting protects its exact field against recreation',()=>{
 let r=order(room(),'ai-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'},'agent',101);r=applyCoordinatedCancellation(r,'ai-mine',0,'manual');
 assert.throws(()=>order(r,'new-mine',{kind:'toggle-mine',outpostId:'蓝方工厂'},'agent',102),ManualCommandConflict);assert.deepEqual(restoreRoom(saveRoom(r)),r);
});


test('ordinary valid-match owner check-in is recorded by the game but is not new tactical manual intent',()=>{
 let r=room();r.state.initial.match={mode:'mining',neptuniumGoal:1000};r.state=createFleetScenario(r.state.initial);
 r=order(r,'owner-check-in',{kind:'check-in'});assert.equal(r.state.commands.at(-1)!.id,'owner-check-in');assert.equal(manualCommandVersion(r,0),0);assert.equal(manualCommandView(r,0).receipts.length,0);assert.deepEqual(restoreRoom(saveRoom(r)),r);
});

test('backend funding preference cannot be implicitly reversed',()=>{
 let r=order(room(),'human-fund',{kind:'toggle-funding',recipient:1});assert.throws(()=>order(r,'ai-unfund',{kind:'toggle-funding',recipient:1},'agent'),ManualCommandConflict);assert.deepEqual(restoreRoom(saveRoom(r)),r);
});









test('cancelled routes reopen after actual source or destination battles without requiring owner management',()=>{
 for(const target of ['蓝方工厂','红方矿场']){
  const setup=structuredClone(room().state.initial),support='battle-support',targetOutpost=setup.economy.outposts.find(o=>o.id===target)!,opponent=targetOutpost.owner===0?1:0;
  setup.economy.outposts.push({...structuredClone(setup.economy.outposts[0]!),id:support,owner:opponent,drillers:1,productionProgress:0});setup.positions[support]={x:setup.positions[target]!.x+0.001,y:setup.positions[target]!.y};
  let r=order({state:createFleetScenario(setup),scheduled:[]},'cancelled-mission',launch(20),'agent');r=order(r,'cancel-before-battle',{kind:'cancel-launch',fleetId:'cancelled-mission'});
  assert.equal(r.state.fleets.find(f=>f.id==='cancelled-mission')?.used,false);assert.throws(()=>order(r,'immediate-recreation',launch(1),'agent'),DispatchSourceLocked);
  r=advanceRoom(r,r.state.economy.tick+2);assert.throws(()=>order(r,'production-recreation',launch(30),'agent'),ManualCommandConflict);
  const facts=structuredClone(r.manualCoordination!.receipts),owner=r.state.economy.outposts.find(o=>o.id===target)!.owner;
  r=applyCoordinatedOrder(r,{id:'material-battle',player:opponent,action:{kind:'launch',delaySeconds:600,source:support,destination:target,drillers:1}},'agent');
  for(let i=0;i<5&&!r.state.events.some(e=>e.kind==='battle'&&e.details.target===target);i++)r=advanceRoom(r,r.state.economy.tick+1);
  assert.ok(r.state.events.some(e=>e.kind==='battle'&&e.details.target===target));assert.equal(r.state.economy.outposts.find(o=>o.id===target)!.owner,owner,'battle, not ownership change, ends the old tactical context');
  assert.ok(!manualCommandView(r,0).protections.some(p=>p.kind==='route'));assert.deepEqual(r.manualCoordination!.receipts,facts);
  assert.doesNotThrow(()=>order(restoreRoom(saveRoom(r)),'new-tactical-plan',launch(1),'agent'));
 }
});
