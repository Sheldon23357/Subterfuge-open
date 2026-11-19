import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,type FleetSetup,prepareForecastKnowledge,buildForecastWorld} from '../packages/engine/src/index.js';
import {observedRuleNotificationEntries} from '../packages/server/src/notification-confirmation.js';
import {simulatePlayerFuture} from '../packages/server/src/player-forecast.js';
import {NotificationScheduleStore} from '../packages/server/src/notification-schedule-store.js';
test('only matching real recipient events confirm predicted combat after clock catch-up',()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const live=submitFleetOrder(createFleetScenario(cfg),{id:'attack',player:0,action:{kind:'launch',source:cfg.economy.outposts[0]!.id,destination:cfg.economy.outposts[1]!.id,drillers:27}}).state;
 const forecast=simulatePlayerFuture({state:live,scheduled:[]},0,110);assert.equal(forecast.status,'conditional');if(forecast.status!=='conditional')return;
 const store=new NotificationScheduleStore(':memory:');
 try{
  store.replace('r',0,0,'before',0,forecast.notificationTimeline);
  const actual=advanceFleetScenario(live,110);
  store.replace('r',0,1,'after',6000000,[],observedRuleNotificationEntries(actual,0));
  const due=store.deliverDue('r',0,'after',6000000);
  assert.ok(due.some(n=>n.entry.notification.kind==='battle'));
  assert.deepEqual(store.inbox('r',1),[]);
  const built=buildForecastWorld(prepareForecastKnowledge(live,0));assert.equal(built.status,'conditional');
  if(built.status==='conditional')assert.throws(()=>observedRuleNotificationEntries(built.state,0),/authoritative/);
 }finally{store.close();}
});
