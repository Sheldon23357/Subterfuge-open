import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {EndedHallRooms,splitHallRooms,HallRoomList} from '../packages/client/src/HallRoomList.js';
import type {HubRoomSummary} from '../packages/contracts/src/index.js';
const room=(code:string,status:HubRoomSummary['status'],endedAt=0):HubRoomSummary=>({code,name:code,status,endedAt,createdAt:1,players:2,capacity:2});
test('ended matches are newest-first, limited to five, and rendered in a closed disclosure',()=>{
 const input=[room('LIVE01','in-progress'),room('WAIT01','waiting'),room('BAD001','unavailable'),...Array.from({length:7},(_,i)=>room('END00'+i,'ended',i+1))];
 const groups=splitHallRooms(input);assert.equal(groups.active.length,3);assert.deepEqual(groups.ended.map(r=>r.endedAt),[7,6,5,4,3]);
 const html=renderToStaticMarkup(React.createElement(EndedHallRooms,{rooms:groups.ended,busy:false,joining:null,returning:()=>true,enter:()=>{}}));
 assert.match(html,/<details class="hall-ended">/);assert.doesNotMatch(html,/<details[^>]* open/);assert.match(html,/已结束对局/);assert.doesNotMatch(html,/对局进行中/);
 const failed=renderToStaticMarkup(React.createElement(HallRoomList,{rooms:[room('FAIL01','unavailable')],busy:false,joining:null,returning:()=>true,enter:()=>{}}));assert.match(failed,/disabled=""/);assert.match(failed,/恢复失败/);
});
