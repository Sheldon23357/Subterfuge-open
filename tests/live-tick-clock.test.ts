import test from 'node:test';
import assert from 'node:assert/strict';
import type {TickTimeAnchor} from '../packages/contracts/src/index.js';
import {liveTickLabel,lobbyCountdownLabel} from '../packages/client/src/LiveTickClock.js';

const anchor:TickTimeAnchor={id:1,revision:20,fromTick:18,tick:19,wallTimeMs:10000,monotonicMs:1000,sessionId:'s',kind:'advance',source:'automatic'};
test('header tick and elapsed time use the persisted game boundary rather than page load or model round',()=>{
 assert.equal(liveTickLabel(anchor,7500),'Tick 19 · 已过 7.5 秒');
 assert.equal(liveTickLabel({...anchor,wallTimeMs:1000000000000},7500),'Tick 19 · 已过 7.5 秒');
 assert.equal(liveTickLabel(anchor,10000),'Tick 19 · 已过 10.0 秒');
 assert.equal(liveTickLabel({...anchor,id:2,fromTick:19,tick:20,wallTimeMs:20000},1000),'Tick 20 · 已过 1.0 秒');
});
test('missing boundaries, partial starts and reversed wall clocks do not invent elapsed time',()=>{
 assert.equal(liveTickLabel(null,20000),'Tick — · 已过 —');
 assert.equal(liveTickLabel({...anchor,kind:'observed'},20000),'Tick 19 · 已过 —');
 assert.equal(liveTickLabel(anchor,-1),'Tick 19 · 已过 —');
});

test('terminal tick does not accumulate time across waiting, reloads or restarts',()=>{
 assert.equal(liveTickLabel(anchor,17500,true),'Tick 19 · 对局结束');
 assert.equal(liveTickLabel(anchor,17500+86400000,true),'Tick 19 · 对局结束');
 assert.equal(liveTickLabel({...anchor,kind:'observed'},17500,true),'Tick 19 · 对局结束');
 assert.equal(liveTickLabel(anchor,10000,false),'Tick 19 · 已过 10.0 秒');
});

test('lobby countdown uses server seconds and never claims the game started from local time',()=>{
 assert.equal(lobbyCountdownLabel({status:'waiting'}),'等待房主开局');
 assert.equal(lobbyCountdownLabel({status:'starting',secondsRemaining:300}),'开局倒计时 5:00');
 assert.equal(lobbyCountdownLabel({status:'starting',secondsRemaining:61},1500),'开局倒计时 1:00');
 assert.equal(lobbyCountdownLabel({status:'starting',secondsRemaining:1},3000),'等待服务器确认开局');
});
