import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {notebookDisplayText,notebookReadableText} from '../packages/client/src/notebook-display.js';
import {noteEntryTitle,NoteCard} from '../packages/client/src/NoteReadable.js';
import {NoteReadable} from '../packages/client/src/AgentDiagnostics.js';

test('notebook location names use the authenticated map without changing quantities or opaque IDs',()=>{
 const names={'据点27':'HAVEN','据点32':'COVE','据点39':'REEF'};
 assert.equal(notebookDisplayText('第27天，27已实际占领，32方向；39集结。驻27兵；expand-27；据点39 → 32',names),'第27天，HAVEN已实际占领，COVE方向；REEF集结。驻27兵；expand-27；REEF → COVE');
 assert.equal(notebookDisplayText('据点99、99方向',names),'据点99、99方向');
 const payload={target:'据点27',allocations:[{source:'据点32',drillers:27}],record:{entities:['据点39']}};
 const html=renderToStaticMarkup(React.createElement(NoteReadable,{entry:{id:1,kind:'campaign-state',payload},source:'campaigns',names}));
 const display=html.split('<details class="note-raw">')[0]!;
 assert.match(display,/HAVEN/);assert.match(display,/COVE/);assert.match(html,/REEF/);assert.match(display,/>27</);
 assert.equal(payload.target,'据点27');assert.match(html,/据点27/,'raw data remains verbatim');
});


test('campaign display puts intent and remaining allocation ahead of bookkeeping while preserving raw identities',()=>{
 const id='p0-'+ 'a'.repeat(64),payload={id:'internal-campaign-key',target:'据点27',objective:'拿下发电站',holdPlan:'占领后留12兵',cancelWhen:'来源遭攻击',stage:'underway',allocations:[{source:'据点32',drillers:0}],accountedFleets:[id,id+'other'],committedOrders:[id],movement:{waiting:0,moving:1},issues:[],comparisonInvalidated:false};
 const saved=JSON.stringify(payload),html=renderToStaticMarkup(React.createElement(NoteReadable,{entry:{id:1,kind:'campaign-state',payload},source:'campaigns',names:{'据点27':'HAVEN','据点32':'COVE'}}));
 const player=html.split('<details class="note-raw">')[0]!;
 assert.match(player,/拿下发电站/);assert.match(player,/占领后留12兵/);assert.match(player,/来源遭攻击/);assert.match(player,/剩余兵力预留/);assert.match(player,/>0<\/td>/);assert.match(player,/行进中 1 支/);
 assert.ok(!player.includes(id));assert.ok(!player.includes('accountedFleets'));assert.ok(!player.includes('committedOrders'));assert.match(player,/已记账身份 2 项/);assert.match(player,/执行关联 1 项/);
 assert.ok(html.includes(id));assert.equal(JSON.stringify(payload),saved);assert.equal((html.match(/class="note-raw"/g)||[]).length,1);
});

test('typed notes keep summary, full terms, translated status and unknown versus zero scores',()=>{
 const payload={kind:'agreement',text:'双方停火至第50天；兵力运输不提供救援；等待对方确认。',record:{type:'agreement',status:'proposed',summary:'候选停火，尚未接受',players:[1],entities:[],links:['note:proposal-1'],evidence:['chat:offer-1'],scores:{trust:0,hostility:null}}};
 const html=renderToStaticMarkup(React.createElement(NoteReadable,{entry:{id:2,kind:'notebook-set',payload},source:'notebook'}));
 const player=html.split('<details class="note-raw">')[0]!;
 assert.match(player,/已提议/);assert.match(player,/候选停火，尚未接受/);assert.match(player,/兵力运输不提供救援/);assert.match(player,/席位 2/);assert.match(player,/信任<\/dt><dd>0/);assert.match(player,/敌意<\/dt><dd>未知/);assert.match(player,/关联与依据/);
 assert.ok(!player.includes('结构化记录'));assert.ok(!player.includes('proposed'));
});

test('reminder display retains event state and substantive text while future diagnostic fields remain available in raw data',()=>{
 const payload={id:'opaque-reminder-id',note:'复查据点27守备，确认援军是否抵达',category:'military',atSeconds:12000,internalFutureField:'opaque-debug-value'};
 const html=renderToStaticMarkup(React.createElement(NoteReadable,{entry:{id:3,kind:'reminder-fired',payload},source:'reminders',names:{'据点27':'HAVEN'}}));
 const player=html.split('<details class="note-raw">')[0]!;
 assert.match(player,/已触发/);assert.match(player,/复查HAVEN守备/);assert.ok(!player.includes('opaque-reminder-id'));assert.ok(!player.includes('internalFutureField'));assert.ok(html.includes('opaque-debug-value'));
});


test('overview text and list titles abbreviate opaque references without assigning fleet or schedule identity',()=>{
 const id='p0-'+ 'a'.repeat(64),text='复查 '+id;
 assert.equal(notebookReadableText(text,{}),'复查 p0-AAAAAAAA…');
 assert.equal(noteEntryTitle({id:1,kind:'notebook-set',payload:{id:'internal-note-key',record:{summary:text}}},'notebook',{}),'复查 p0-AAAAAAAA…');
 assert.equal(notebookDisplayText(text,{}),text);
});


test('expanded cards do not repeat their summary as a second body heading and retain the complete body',()=>{
 const summary='保留矿场守备，下一轮复查',text='当前已核实守备31兵；保留后续补兵选项。';
 const html=renderToStaticMarkup(React.createElement(NoteCard,{entry:{id:1,kind:'notebook-set',payload:{kind:'plan',text,record:{type:'plan',status:'active',summary}}},source:'notebook'}));
 assert.equal(html.split('class="note-readable"')[1]!.split('class="note-raw"')[0]!.includes(summary),false);
 assert.ok(html.includes('<p class="note-body">'+text));
 assert.equal(noteEntryTitle({id:2,kind:'notebook-set',payload:{kind:'fact',text:'很长的事实正文'}},'notebook'),'事实记录');
 const reminder=renderToStaticMarkup(React.createElement(NoteCard,{entry:{id:3,kind:'reminder-set',payload:{note:'核对舰队抵达',category:'military',atSeconds:600}},source:'reminders'}));
 assert.match(reminder,/军事提醒/);assert.match(reminder,/<p class="note-body">核对舰队抵达/);
});


test('numeric garrison limits with whitespace keep their units instead of becoming outpost aliases',()=>{
 const names={'据点10':'SMITHRAND','据点1':'ADRIA'};
 assert.equal(notebookDisplayText('执行最低留守 10 兵力（含预约）',names),'执行最低留守 10 兵力（含预约）');
 assert.equal(notebookDisplayText('留守 1 兵；防守 10 天后复查',names),'留守 1 兵；防守 10 天后复查');
 assert.equal(notebookDisplayText('增援 10，守 1',names),'增援 SMITHRAND，守 ADRIA');
});
