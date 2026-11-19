import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ChatStore} from '../packages/server/src/chat.js';
import {observerChatPage} from '../packages/server/src/observer-chat.js';
import {ObserverChatMessages} from '../packages/client/src/ObserverChat.js';

test('OB reads public, private and group messages without claiming a seat or changing read marks',async()=>{
 const chat=new ChatStore();await chat.load();
 await chat.sendFromSeat(0,{id:'public',to:null,text:'公开消息'},4,1);
 await chat.sendFromSeat(1,{id:'private',to:2,text:'私聊消息'},4,2);
 await chat.sendFromSeat(2,{id:'group',to:[0,1],text:'群聊消息'},4,3);
 const before=chat.conversationsForSeat(0);
 const page=observerChatPage(chat,'room',new URLSearchParams());
 assert.equal(page.roomId,'room');assert.deepEqual(page.messages.map(m=>m.id),['public','private','group']);
 assert.deepEqual(chat.conversationsForSeat(0),before,'OB reading does not mark player conversations read');
 assert.deepEqual(chat.listForSeat(3).map(m=>m.id),['public'],'ordinary player retains private visibility');
 assert.throws(()=>chat.listForSeat(-1));assert.throws(()=>chat.claim(-1,4));
 page.messages[0]!.text='edited';assert.equal(chat.observerPage().messages[0]!.text,'公开消息');
 const html=renderToStaticMarkup(React.createElement(ObserverChatMessages,{messages:chat.observerPage().messages}));
 for(const text of ['公开频道','私聊消息','群聊消息','北辰','赤潮','天火','第3天'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/<form|<input|<textarea/);
});

test('OB history pages keep an exclusive cursor, cover retained history and allow incremental updates',async()=>{
 const chat=new ChatStore();await chat.load();
 for(let i=0;i<205;i++)await chat.sendFromSeat(i%3,{id:`m${i}`,to:null,text:`消息 ${i}`},3,i);
 const latest=chat.observerPage();assert.deepEqual([latest.fromCursor,latest.toCursor,latest.total],[105,205,205]);
 const previous=chat.observerPage({before:latest.fromCursor});
 const first=chat.observerPage({before:previous.fromCursor});
 assert.deepEqual([...first.messages,...previous.messages,...latest.messages].map(m=>m.id),Array.from({length:205},(_,i)=>`m${i}`));
 await chat.sendFromSeat(1,{id:'new',to:2,text:'新私聊'},3,206);
 const updates=chat.observerPage({after:latest.toCursor});
 assert.deepEqual(updates.messages.map(m=>m.id),['new']);assert.equal(updates.toCursor,206);
 assert.deepEqual(chat.observerPage({after:206}).messages,[]);
 for(const query of ['before=1&after=1','after=-1','after=999','limit=0','limit=201','after=1&after=2','seat=-1','before=1.5','limit=9007199254740992'])assert.throws(()=>observerChatPage(chat,'room',new URLSearchParams(query)),query);
});
