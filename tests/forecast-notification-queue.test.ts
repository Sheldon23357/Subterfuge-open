import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createForecastNotificationQueue} from '../packages/engine/src/forecast-notification-queue.js';
import type {ForecastRuleNotice} from '../packages/engine/src/forecast-notification-queue.js';
import type {ForecastSonarNotice} from '../packages/engine/src/forecast-notifications.js';
const rule:ForecastRuleNotice={kind:'battle',tick:101,seconds:0,text:'battle',details:null,urgent:true,sendNotification:false,location:null,minutesBeforeSending:11,generateAlert:true};
const sonar:ForecastSonarNotice={kind:'sonar-contact',tick:101,minutesBeforeSending:11,fleetId:'known',position:{x:1,y:2},multiple:false,sendNotification:true,generateAlert:false};
test('notification queue preserves rule-before-sonar insertion order and copy isolation',()=>{
 const queue=createForecastNotificationQueue();queue.rule(rule);queue.sonar(sonar);queue.rule({...rule,tick:102});
 const result=queue.result();assert.deepEqual(result.map(e=>[e.sequence,e.source]),[[0,'rule'],[1,'sonar'],[2,'rule']]);
 result[0]!.notification.tick=999;assert.equal(queue.result()[0]!.notification.tick,101);
 const input=structuredClone(sonar);queue.sonar(input);input.position.x=999;
 const last=queue.result()[3]!;assert.equal(last.source,'sonar');if(last.source==='sonar')assert.equal(last.notification.position.x,1);
});
test('all event flags consume the shared 1024 capacity and overflow cannot replace earlier events',()=>{
 const queue=createForecastNotificationQueue();
 for(let i=0;i<1023;i++)queue.rule({...rule,text:String(i)});
 assert.equal(queue.full(),false);queue.sonar(sonar);assert.equal(queue.full(),true);
 const before=queue.result();queue.rule(rule);queue.sonar(sonar);
 assert.deepEqual(queue.result(),before);assert.equal(before.length,1024);
 assert.equal(before[1023]!.source,'sonar');assert.ok(before.slice(0,1023).every(e=>!e.notification.sendNotification));
});
