import test from 'node:test';
import assert from 'node:assert/strict';
import {worldTimeContext} from '../packages/ai/src/controller/presentation/world-time-context.js';
import {STRUCTURED_ARGUMENT_DEFINITIONS as schemas} from '../packages/ai/src/controller/contracts/structured-arguments.js';

test('model projection adds world units without mutating rule data or historical prose',()=>{
 const original={tick:12,secondsSinceLastTick:599,production:{cycleMinutes:480,nextMinutes:null},fleet:{launchRemainingSeconds:300,},self:{npPerDay:144,drillerRate:1},atSeconds:600,expiresAt:null,sentAt:1234,minutesBeforeSending:60,seconds:12,secondsRemaining:30,text:'12小时停战',timing:{observedSeconds:600,waitingDepartures:[{id:'f',secondsRemaining:300}]}};
 const before=structuredClone(original),p=worldTimeContext(original) as any;
 assert.deepEqual(original,before);assert.equal(p.production.cycleWorldDays,48);assert.equal(p.production.nextMinutes,null);assert.ok(!('nextWorldDays'in p.production));
 assert.equal(p.fleet.launchRemainingSeconds,300);assert.equal(p.fleet.launchRemainingSecondsWorldDays,.5);
 assert.equal(p.self.npPerDayPerWorldDay,1);assert.equal(p.self.drillerRatePerWorldDay,1/144);assert.equal(p.atSecondsWorldDays,1);
 assert.equal(p.sentAt,1234);assert.equal(p.minutesBeforeSending,60);assert.equal(p.seconds,12);assert.equal(p.secondsRemaining,30);assert.equal(p.text,'12小时停战');
 assert.ok(!('secondsWorldDays'in p));assert.ok(!('sentAtWorldDays'in p));assert.equal(p.timing.waitingDepartures[0].remainingWorldDays,.5);
});



test('only known system notification templates are converted, including forecast evidence',()=>{
 const notice={kind:'departed',tick:1,seconds:0,text:'Someone just launched a sub from Home. It is estimated to arrive at Harbor in about 2 hours.'};
 const original={notifications:[notice,{text:'Unknown template: 2 hours'}],chat:[notice],notificationTimeline:[{source:'rule',notification:notice}],lossReports:{eventSource:'rule-notification',events:[notice]}};
 const p=worldTimeContext(original) as any;
 assert.match(p.notifications[0].text,/12世界天/);assert.match(p.notificationTimeline[0].notification.text,/12世界天/);assert.match(p.lossReports.events[0].text,/12世界天/);
 assert.equal(p.chat[0].text,notice.text);assert.equal(p.notifications[1].text,'Unknown template: 2 hours');assert.match(original.notifications[0]!.text,/2 hours/);
});
