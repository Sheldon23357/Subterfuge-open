import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {diagnosticTimeSummary,RawTimeLegend,toolTimeSummary,commandTimeSummary,JournalToolTimeSummary} from '../packages/client/src/DiagnosticTime.js';
test('notebook rule seconds and basis tick have separate typed projections without mutating raw data',()=>{const p={updatedAt:60000,expiresAt:61200,basisTick:100,record:{reviewAt:61800}};const raw=JSON.stringify(p);assert.deepEqual(diagnosticTimeSummary('notebook',p),['更新 第100天','有效至 第102天','依据 第100天','复核 第103天']);assert.equal(JSON.stringify(p),raw);});
test('reminder and campaign use their actual contracts',()=>{assert.deepEqual(diagnosticTimeSummary('reminders',{atSeconds:61800}),['提醒 第103天']);assert.deepEqual(diagnosticTimeSummary('campaigns',{plans:[{id:'a',createdTick:100,reviewAtTick:104}]}),['a 创建 第100天','a 复查 第104天']);});
test('current tool receipts use world-day fields while contradictory raw anchors remain visible',()=>{
 assert.deepEqual(toolTimeSummary('notebook',{set:[{updatedWorldDay:100,expiresWorldDay:102}]}),['更新 第100天','有效至 第102天']);
 assert.deepEqual(toolTimeSummary('reminders',{set:[{atWorldDay:103}]}),['提醒 第103天']);
 assert.deepEqual(diagnosticTimeSummary('reminders',{atWorldDay:103,atSeconds:61200}),['提醒 第103天','提醒（原始锚点） 第102天','提醒时间依据冲突']);
 assert.deepEqual(diagnosticTimeSummary('notebook',{updatedWorldDay:0,expiresWorldDay:null}),['更新 第0天']);
});
test('event nextReview converts but wall timestamps duration and tokens never convert',()=>{assert.deepEqual(diagnosticTimeSummary('event',{nextReview:63000,durationMs:1250,startedAt:1792470000000,expiresAt:1792470030000,tokens:140}),['下次复核 第105天']);assert.deepEqual(diagnosticTimeSummary('event',{expiresAt:60000}),[]);});
test('unknown invalid and missing values are not inferred',()=>{assert.deepEqual(diagnosticTimeSummary('notebook',{updatedAt:'60000',expiresAt:null,otherTime:61800}),['更新时间未判定']);assert.deepEqual(diagnosticTimeSummary('reminders',{atSeconds:Infinity}),['提醒时间未判定']);assert.deepEqual(diagnosticTimeSummary('notebook',null),[]);});
test('raw legends distinguish wall breakpoint timestamps and internal seconds',()=>{const h=renderToStaticMarkup(React.createElement(RawTimeLegend));assert.match(h,/断点 expiresAt 为毫秒/);assert.match(h,/600规则秒＝1世界日/);assert.match(h,/其他时间字段未判定/);assert.match(h,/历史正文不改写/);});

test('known tool wrappers are projected; arbitrary nested values remain untouched',()=>{assert.deepEqual(toolTimeSummary('notebook',{set:[{updatedAt:60000}]}),['更新 第100天']);assert.deepEqual(toolTimeSummary('reminders',{active:[{atSeconds:61800}]}),['提醒 第103天']);assert.deepEqual(toolTimeSummary('unknown',{set:[{updatedAt:60000}]}),[]);assert.deepEqual(toolTimeSummary('notebook',{nested:{updatedAt:60000}}),[]);assert.deepEqual(toolTimeSummary('notebook',{set:[],active:[{updatedAt:60000}]}),['更新 第100天']);});
test('pending v2 command uses exact schedule basis; direct order never invents absolute day',()=>{assert.deepEqual(commandTimeSummary('/player/v2/owner/commands',{kind:'schedule',issueTick:100,order:{action:{kind:'launch',delaySeconds:600}}}),['执行 第100天','准备时长 1天','出发 第101天']);assert.deepEqual(commandTimeSummary('/player/v2/owner/commands',{kind:'order',expiresAt:60000,order:{action:{kind:'launch',delaySeconds:600}}}),['准备时长 1天','缺少原观察完整时刻，未推算绝对出发日']);assert.deepEqual(commandTimeSummary('/player/v2/owner/commands',{kind:'chat-send',issueTick:100}),[]);});

test('console journal applies known tool result schema only, not model intentions',()=>{const value={tool:'notebook',result:{set:[{updatedAt:60000}]}};assert.match(renderToStaticMarkup(React.createElement(JournalToolTimeSummary,{kind:'tool-result',value})),/第100天/);assert.equal(renderToStaticMarkup(React.createElement(JournalToolTimeSummary,{kind:'tool-intent',value})), '');});
