import {DispatchSourceLocked} from '../packages/server/src/dispatch-guard.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,type FleetAction,type FleetOrder} from '../packages/engine/src/index.js';
import {advanceRoom,scheduleLaunch,previewLaunch,saveRoom,restoreRoom,type LabRoom} from '../packages/server/src/planning.js';
import {applyCoordinatedOrder} from '../packages/server/src/player-commands.js';
import {coordinateHypotheticalManualOrder,manualCommandVersion,commandSource,ManualCommandConflict} from '../packages/server/src/manual-commands.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
import {previewPlayerLaunch} from '../packages/server/src/player-game-preview.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
const action:FleetAction={kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:10};
function room():LabRoom{const setup=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial;setup.economy.players[0].neptunium=200;return{state:createFleetScenario(setup),scheduled:[]};}
function cancelled(){let r=applyCoordinatedOrder(room(),{id:'old',player:0,action},'agent');return applyCoordinatedOrder(r,{id:'cancel',player:0,action:{kind:'cancel-launch',fleetId:'old'}},'manual');}

test('dev owner departure at next tick or later records provenance before same-tick execution and matches readonly preview',()=>{
 const locked=cancelled();assert.throws(()=>scheduleLaunch(locked,{order:{id:'same-day',player:0,action},departureTick:103},0,{source:'manual'}),DispatchSourceLocked);
 const r=advanceRoom(locked,101),before=saveRoom(r);
 for(const departureTick of [102,103]){
  const input:{order:FleetOrder;departureTick:number}={order:{id:'dev-'+departureTick,player:0,action},departureTick};
  const preview=previewLaunch(r,input);assert.ok(preview.arrivalTick!==null);
  const scheduled=scheduleLaunch(r,input,0,{source:'manual'});assert.equal(manualCommandVersion(scheduled,0),2);assert.equal(commandSource(scheduled,input.order.id),'manual');
  const executed=advanceRoom(scheduled,departureTick);assert.equal(executed.scheduled[0]!.status,'executed');assert.deepEqual(restoreRoom(saveRoom(executed)),executed);
  assert.equal(saveRoom(r),before);
 }
});

test('owner drafts remain protected against later known or unknown queued reversal; no factual receipt or persistent actor is created',()=>{
 for(const origin of ['agent','unknown'] as const){
  const old: FleetOrder={id:'old-reversal',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:true}};
  let r=origin==='agent'?applyCoordinatedOrder(room(),old,'agent',0,102):scheduleOrder(room(),{order:old,issueTick:102});
  r=scheduleOrder(r,{order:{id:'unrelated-unknown',player:0,action:{kind:'toggle-funding',recipient:1}},issueTick:102});
  const before=saveRoom(r),draft={id:'owner-hypothesis',player:0,action:{kind:'set-shields' as const,outpostId:'蓝方工厂',enabled:false},issueTick:101};
  const projected=simulatePlayerFuture(r,0,104,[draft],undefined,'manual');assert.equal(projected.status,'conditional');if(projected.status!=='conditional')throw Error('unsupported');
  assert.equal(projected.orders.find(o=>o.id===draft.id)!.status,'executed');assert.equal(projected.orders.find(o=>o.id===old.id)!.status,'failed');assert.equal(projected.orders.find(o=>o.id==='unrelated-unknown')!.status,'executed');
  assert.equal(saveRoom(r),before);assert.equal(manualCommandVersion(r,0),0);assert.equal(commandSource(r,'owner-hypothesis'),undefined);assert.equal(commandSource(r,'unrelated-unknown'),undefined);assert.ok(!JSON.stringify(projected).includes('hypothetical:'));
  const scheduled=scheduleOrder(r,{order:{id:draft.id,player:draft.player,action:draft.action},issueTick:draft.issueTick}),isolated=coordinateHypotheticalManualOrder(r,scheduled,draft,'schedule');assert.equal(manualCommandVersion(isolated,0),0);assert.equal(commandSource(isolated,draft.id),undefined);assert.throws(()=>saveRoom(isolated),/Hypothetical/);
 }
});

test('immediate and future executor drafts cannot override manual scopes and cannot claim owner status via payload',()=>{
 const locked=cancelled();assert.throws(()=>previewPlayerLaunch(locked,0,{id:'same-day-preview',player:0,action}),DispatchSourceLocked);
 const r=advanceRoom(locked,101),before=saveRoom(r);
 for(const issueTick of [101,102]){
  const result=simulatePlayerFuture(r,0,104,[{id:'ai-'+issueTick,player:0,action,issueTick}]);assert.equal(result.status,'conditional');if(result.status!=='conditional')throw Error('unsupported');assert.equal(result.orders[0]!.status,'failed');
  assert.throws(()=>previewPlayerLaunch(r,0,{id:'ai-deployment',player:0,action},issueTick===101?undefined:issueTick,'agent'),ManualCommandConflict);
 }
 assert.equal(saveRoom(r),before);
});
