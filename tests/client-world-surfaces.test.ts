
import {PlayerIntel} from '../packages/client/src/PlayerIntel.js';
import type {PlayerIntelStatistics} from '../packages/contracts/src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {message} from '../packages/client/src/PlayerNotifications.js';
import {WorldDepartureInput} from '../packages/client/src/WorldDepartureInput.js';
import {FleetCountdowns} from '../packages/client/src/FleetCountdowns.js';
import type {GameFleet} from '../packages/client/src/game-view.js';

test('canonical notification duration converts legacy hours without rewriting free text',()=>{
  assert.match(message('P0 just launched a sub from A. It is estimated to arrive at B in about 2 hours.'),/12天/);
  assert.match(message('You have been away from the game for 16 hours.'),/96天/);
  assert.equal(message('We agreed on 2 hours.'),'We agreed on 2 hours.');
});
test('departure controls use absolute integer day steps while remaining time stays fractional',()=>{
  const html=renderToStaticMarkup(React.createElement(WorldDepartureInput,{day:3,minimum:3,maximum:145,currentDay:1.25,onChange:()=>{},onValidityChange:()=>{}}));
  assert.match(html,/value="3"/);
  assert.match(html,/step="1"/);
  assert.match(html,/第3天/);
  assert.match(html,/1.75天/);
  assert.doesNotMatch(html,/1\/600天/);
  assert.doesNotMatch(html,/小时|分钟/);
});
test('fleet departure and arrival preserve fractional rule seconds and unknown arrival',()=>{
  const fleet={id:'F1',state:'waiting',departureMinutes:0.5/60,arrivalMinutes:300/60,canCancelLaunch:true} as GameFleet;
  const html=renderToStaticMarkup(React.createElement(FleetCountdowns,{fleet,tick:0,live:false,onArrival:()=>{},arrivalDisabled:false}));
  assert.match(html,/≈0.000833天/);
  assert.match(html,/0.5天/);
  const unknown=renderToStaticMarkup(React.createElement(FleetCountdowns,{fleet:{...fleet,arrivalMinutes:null},tick:0,live:false,onArrival:()=>{},arrivalDisabled:true}));
  assert.match(unknown,/暂无法确定/);
});

test('public intel uses world-day mine rate and integer theoretical 144-day fleet capacity',()=>{
  const row={player:0,active:true,neptunium:10,npPerDay:144,drillerRate:144,drillers:20,output:150,numOutposts:1,outposts:{mine:1,factory:0,generator:0}} as PlayerIntelStatistics;
  const html=renderToStaticMarkup(React.createElement(PlayerIntel,{rows:[row],player:0,historical:false}));
  assert.match(html,/1kg \/ 天/);
  assert.match(html,/144舰 \/ 144天/);
  assert.match(html,/非连续产出/);
  assert.doesNotMatch(html,/理论日产舰/);
});
