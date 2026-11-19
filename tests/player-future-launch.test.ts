import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {restoreRoom,saveRoom,type LabRoom} from '../packages/server/src/planning.js';

test('authenticated players can edit and cascade-cancel their own future fleet without extra slots or cross-seat access',async t=>{
  let room:LabRoom={state:createFleetScenario(JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup),scheduled:[]};
  const h=protocolHarness(t,{room}),data=h.ownerCredentials,server=await createOwnerPlayerApi(h);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const request=(path:string,player:number,input?:unknown)=>fetch(base+path,{method:input?'POST':'GET',headers:{Authorization:`Bearer ${data.credentials[player]!.token}`},...(input?{body:JSON.stringify(input)}:{})});
  try{
    const action={kind:'launch',source:'蓝方工厂',destination:'红方后方',drillers:20,delaySeconds:1800};
    let own=await (await request('/player/v2/owner/observation',0)).json();
    const created=await request('/player/v2/owner/commands',0,{kind:'schedule',clientCommandId:'root',expectedRevision:own.revision,issueTick:102,payload:{action}});assert.equal(created.status,200);own=await created.json();
    const identity=own.scheduled[0].id;
    const other=await (await request('/player/v2/owner/observation',1)).json();
    assert.equal(other.scheduled.length,0);
    assert.equal((await request('/player/v2/owner/commands',1,{kind:'schedule',clientCommandId:'steal',expectedRevision:other.revision,issueTick:103,payload:{action:{...action,fleetId:identity}}})).status,400);
    const edited=await request('/player/v2/owner/commands',0,{kind:'schedule',clientCommandId:'edit',expectedRevision:own.revision,issueTick:103,payload:{action:{...action,drillers:40,fleetId:identity}}});assert.equal(edited.status,200);own=await edited.json();
    assert.equal(h.store.load()!.room.state.fleetReservations.length,1);assert.equal(own.scheduled.length,2);
    const beforeCancellation=saveRoom(h.store.load()!.room),cancel={kind:'cancel-schedule',clientCommandId:'cancel-edit',expectedRevision:own.revision,payload:{id:own.scheduled[1].id}};
    const needsConfirmation=await request('/player/v2/owner/commands',0,cancel);
    assert.equal(needsConfirmation.status,409);
    const conflict=await needsConfirmation.json();
    assert.equal(conflict.code,'MANUAL_COMMAND_CONFLICT');
    assert.equal(saveRoom(h.store.load()!.room),beforeCancellation,'unconfirmed collateral cancellation leaves state, reservations and manual authority unchanged');
    assert.deepEqual(conflict.cancelledScheduleIds,[own.scheduled[0].id]);
    assert.match(conflict.cancellationToken,/^[a-f0-9]{64}$/);
    assert.deepEqual(conflict.cancelledSchedules.map((p:{id:string})=>p.id),conflict.cancelledScheduleIds);
    assert.deepEqual(conflict.cancelledSchedules[0].action,h.store.load()!.room.scheduledOrders![0]!.action,'the review describes the actual collateral arrangement');
    assert.equal((await request('/player/v2/owner/commands',0,{...cancel,payload:{...cancel.payload,confirmCancelledScheduleIds:conflict.cancelledScheduleIds,confirmCancellationToken:conflict.cancellationToken}})).status,200);
    assert.equal(h.store.load()!.room.state.fleetReservations.length,0);
    assert.deepEqual(h.store.load()!.room.scheduledOrders!.map(p=>p.status),['cancelled','cancelled']);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
