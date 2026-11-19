
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PlayerControlStatus} from '../packages/client/src/PlayerControlStatus.js';
import {ManualCommandProtectionNote} from '../packages/client/src/ManualCommandProtectionNote.js';
import {playerControlPresentation,validatePlayerControl,type PlayerControlView} from '../packages/client/src/player-control-view.js';
import {manualActionSummary,manualCancellationQuestion,manualCommandNotice,manualRequestIdentity,collateralScheduleIds,collateralSchedules,cancellationToken} from '../packages/client/src/manual-command-feedback.js';
import {PlayerConnection,PlayerRequestError} from '../packages/client/src/player-connection.js';
import type {ManualCommandView,QueuedOrderView} from '../packages/contracts/src/index.js';
const control:PlayerControlView={protocol:'player-control/2',roomId:'test-room',player:0,mode:'agent',controller:'external',expiresAt:123};
const view:ManualCommandView={version:2,receiptsFromVersion:1,hasEarlierReceipts:false,receipts:[{id:'manual:0:1',version:1,player:0,tick:5,seconds:0,kind:'order',orderId:'order-1',action:{kind:'launch',source:'source-id',destination:'target-id'},outcome:'applied',affectedFleetIds:['fleet-1'],cancelledScheduleIds:[]},{id:'manual:0:2',version:2,player:0,tick:5,seconds:0,kind:'schedule',orderId:'order-2',scheduleId:'order-2',action:{kind:'set-shields',outpostId:'source-id',enabled:false},outcome:'scheduled',affectedFleetIds:[],cancelledScheduleIds:[]}],protections:[{receiptId:'manual:0:1',kind:'fleet',scope:['fleet:fleet-1']},{receiptId:'manual:0:2',kind:'schedule',scope:['schedule:order-2']}]};
const names={'source-id':'Avalon','target-id':'Borealis'};
test('manual cooperation requires explicit authenticated server support and does not relax chat/check-in',()=>{
  assert.equal(playerControlPresentation(null).blocked,true);
  for(const flag of [undefined,false])assert.equal(playerControlPresentation({...control,...(flag===undefined?{}:{manualCommandsAllowed:flag})}).blocked,true);
  const enabled={...control,manualCommandsAllowed:true};validatePlayerControl(enabled,'test-room',0);
  assert.deepEqual(playerControlPresentation(enabled),{blocked:false,exclusiveBlocked:true,collaborative:true,label:'手动优先 · AI 协作'});
  assert.equal(playerControlPresentation({...enabled,mode:'manual',controller:'hosted'}).blocked,false);
  assert.equal(playerControlPresentation({...control,mode:'manual',controller:'manual'}).exclusiveBlocked,false);
  assert.throws(()=>validatePlayerControl(enabled,'other-room',0),/身份不匹配/);
  assert.throws(()=>validatePlayerControl(enabled,'test-room',1),/身份不匹配/);
  assert.throws(()=>validatePlayerControl({...enabled,manualCommandsAllowed:'true' as unknown as boolean},'test-room',0),/身份不匹配/);
});
test('healthy and loading control states render no supplemental strip, replacement label or empty badge',()=>{
 for(const value of [null,{...control,manualCommandsAllowed:true},{...control,mode:'manual' as const,controller:'hosted' as const,manualCommandsAllowed:true},{...control,mode:'manual' as const,controller:'manual' as const}]){
  assert.equal(renderToStaticMarkup(React.createElement(PlayerControlStatus,{value,error:''})),'');
 }
 const lab=readFileSync('packages/client/src/main.tsx','utf8');assert.ok(!lab.includes('controllerStatus'));
 const game=readFileSync('packages/client/src/Game.tsx','utf8');assert.ok(!game.includes('ManualCommandProtectionNote'));assert.ok(!game.includes('手动安排优先'));
});
test('real control errors and unsupported-server warnings remain visible without supplemental status copy',()=>{
 for(const value of [control,{...control,mode:'manual' as const,controller:'hosted' as const}]){
  const html=renderToStaticMarkup(React.createElement(PlayerControlStatus,{value,error:''}));
  assert.ok(html.includes('role="alert"'));assert.ok(html.includes('尚不支持'));assert.ok(!/<button|手动优先|可直接下令|外部 AI 控制|服务器托管/.test(html));
 }
 for(const value of [null,{...control,manualCommandsAllowed:true}]){
  const html=renderToStaticMarkup(React.createElement(PlayerControlStatus,{value,error:'控制权身份不匹配，请重新连接。'}));
  assert.ok(html.includes('role="alert"'));assert.ok(html.includes('控制权身份不匹配，请重新连接。'));assert.ok(!/手动优先|可直接下令|尚不支持/.test(html));
 }
});
test('committed manual receipt feedback uses names, preserves scheduled outcome and cannot invent success',()=>{
 assert.equal(manualCommandNotice(view,'missing','order',names),null);
 assert.equal(manualCommandNotice(view,'order-1','schedule',names),null);
 assert.equal(manualCommandNotice(view,'order-1','order',names),'Avalon → Borealis：已执行。手动安排优先，AI 不会直接覆盖。');
 const scheduled=manualCommandNotice(view,'order-2','schedule',names)!;assert.ok(scheduled.includes('Avalon · 调整护盾：已预约'));assert.ok(!scheduled.includes('已执行'));
 assert.equal(manualActionSummary({kind:'launch',source:'unknown',destination:'unknown-target'},names),'据点 → 据点');
 const collateral={...view,receipts:[{...view.receipts[0]!,cancelledScheduleIds:['old-schedule']}]};assert.ok(manualCommandNotice(collateral,'order-1','order',names)?.includes('同时取消了 1 条关联预约'));
});
test('only matching protected objects are badged, without claiming model acknowledgement',()=>{
 const render=(scope:string)=>renderToStaticMarkup(React.createElement(ManualCommandProtectionNote,{view,scopes:[scope]}));
 assert.ok(render('fleet:fleet-1').includes('不代表 AI 已完成战略复核'));assert.equal(render('fleet:other'),'');assert.ok(render('schedule:order-2').includes('手动安排优先'));
});
test('collateral cancellation review lists affected manual arrangements and binds exact token data',()=>{
 const scheduled=[{id:'other',player:0,status:'pending',action:{kind:'launch',source:'source-id',destination:'target-id'},issueTick:9}] as QueuedOrderView[];
 const question=manualCancellationQuestion(['other','missing'],scheduled,names);assert.ok(question.includes('Avalon → Borealis（第 9 天）'));assert.ok(question.includes('同时取消 2 条'));assert.ok(question.includes('当前未能显示详情'));assert.ok(!question.includes('source-id'));
 assert.deepEqual(collateralSchedules(scheduled,['other']),scheduled);assert.equal(collateralSchedules(scheduled,['missing']),null);assert.equal(collateralSchedules(undefined,['other']),null);assert.equal(collateralSchedules([...scheduled,...scheduled],['other','different']),null);
 assert.deepEqual(collateralScheduleIds(['one','two']),['one','two']);for(const bad of [[],['x','x'],[''],[1],true])assert.equal(collateralScheduleIds(bad),null);
 assert.equal(cancellationToken('a'.repeat(64)),'a'.repeat(64));assert.equal(cancellationToken('true'),null);
 assert.deepEqual(manualRequestIdentity('cancel-schedule',{id:'target',player:0}),{id:'target',player:0,kind:'cancel-schedule'});
});
test('player transport retains structured conflict and only echoes confirmed exact closure token',async t=>{
 const bodies:unknown[]=[];t.mock.method(globalThis,'fetch',async(_input:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({code:'MANUAL_COMMAND_CONFLICT',cancelledScheduleIds:['other'],cancellationToken:'a'.repeat(64),cancelledSchedules:[{id:'other',player:0,status:'pending',issueTick:9,action:{kind:'launch',source:'source-id',destination:'target-id',drillers:40}}]},{status:409});});
 const client=new PlayerConnection('synthetic-only');await assert.rejects(client.cancel('target','revision'),(error:unknown)=>error instanceof PlayerRequestError&&error.code==='MANUAL_COMMAND_CONFLICT'&&error.cancelledScheduleIds?.[0]==='other'&&error.cancellationToken==='a'.repeat(64)&&error.cancelledSchedules?.[0]?.action.drillers===40&&error.message.includes('尚未执行'));
 await assert.rejects(client.cancel('target','revision',['other'],'a'.repeat(64)));
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['target','revision']))),clientCommandId='cancel-'+Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
 assert.deepEqual(bodies,[{kind:'cancel-schedule',clientCommandId,expectedRevision:'revision',payload:{id:'target'}},{kind:'cancel-schedule',clientCommandId,expectedRevision:'revision',payload:{id:'target',confirmCancelledScheduleIds:['other'],confirmCancellationToken:'a'.repeat(64)}}]);
 const player=readFileSync('packages/client/src/player-main.tsx','utf8'),lab=readFileSync('packages/client/src/main.tsx','utf8');
 for(const source of [player,lab]){assert.ok(source.includes('window.confirm(manualCancellationQuestion'));assert.ok(source.includes('error.cancellationToken'));assert.ok(source.includes('error.cancelledSchedules'));assert.ok(!source.includes('manualCancellationQuestion(error.cancelledScheduleIds,view.orders'));assert.ok(!source.includes('manualCancellationQuestion(error.cancelledScheduleIds,current.scheduled'));}
 assert.ok(player.includes('readOnly={control.exclusiveBlocked}'));assert.doesNotMatch(player,/kind:\s*["']check-in["']/);
});
