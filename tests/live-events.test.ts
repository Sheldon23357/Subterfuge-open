import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityText} from '../packages/client/src/live-event-text.js';
import type {PlayerActivityEvent} from '../packages/contracts/src/index.js';

const event:PlayerActivityEvent={id:1,kind:'battle',tick:1,seconds:0,actor:0,subject:'fleet-1',source:'home',destination:{kind:'outpost',id:'target'},drillers:20,enabled:null,
  battle:{attacker:{player:0,loss:0},defender:{player:null,loss:7}}};

test('conflict broadcast shows both sides including zero losses and neutral defenders',()=>{
  const text=activityText(event,id=>id==='target'?'目标据点':id);
  assert.match(text,/目标据点/);
  assert.match(text,/.+损失 0 兵力/);
  assert.match(text,/中立损失 7 兵力/);
  assert.doesNotMatch(text,/进攻方|防守方/);
});

test('fleet conflicts show both losses without treating fleet IDs as outposts',()=>{
  const text=activityText({...event,destination:{kind:'fleet',id:'fleet-2'}},()=>{throw Error('Unexpected outpost lookup');});
  assert.match(text,/舰队交战/);
  assert.match(text,/损失 7 兵力/);
});

test('unknown conflict losses are never displayed as zero',()=>{
  const {battle,...unknown}=event;
  assert.match(activityText(unknown,id=>id),/双方战损未知/);
});

test('actual recovery displays the settled outpost and amount instead of the abandoned route',()=>{
 const {battle,...plain}=event;
 const text=activityText({...plain,kind:'fleet-recovered',termination:{outcome:'recovered',outpost:'home',drillers:20}},id=>{assert.equal(id,'home');return '本人据点';});
 assert.match(text,/舰队已回收.*本人据点.*回收 20 兵力/);assert.ok(!text.includes('已抵达'));
});

test('an empty removal does not display its planned destination as a settlement',()=>{
 const {battle,...plain}=event;
 const text=activityText({...plain,kind:'fleet-removed',drillers:0,termination:{outcome:'removed',outpost:null,drillers:0}},()=>{throw Error('No actual outpost settlement');});
 assert.equal(text,'舰队已移除 · 移除时 0 兵力');
});

for(const reason of ['gift','capture'] as const)test(`actual ${reason} displays both owners without claiming arrival`,()=>{
 const {battle,...plain}=event;
 const text=activityText({...plain,kind:'fleet-transferred',transfer:{from:0,to:1,reason}},()=>{throw Error('Ownership is not arrival');});
 assert.match(text,reason==='gift'?/实际赠送/:/已被俘获/);assert.match(text,/→/);assert.match(text,/20 兵力/);assert.ok(!text.includes('已抵达'));
});
