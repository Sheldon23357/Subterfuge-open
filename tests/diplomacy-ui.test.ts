import {labRuleView} from '../packages/server/src/lab-rule-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RelationsTable} from '../packages/client/src/RelationsTable.js';
import {ServerAgreements} from '../packages/client/src/ServerAgreements.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {playerGameView} from '../packages/client/src/game-view.js';

function observed(){
  const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:3,y:0},c:{x:15,y:0}},economy:{initialTick:0,teamSize:0,
    players:Array.from({length:3},()=>({active:true,neptunium:100,minesCreated:0})),
    outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:100,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
  let state=createFleetScenario(setup);
  state=submitFleetOrder(state,{id:'private',player:0,action:{kind:'propose-agreement',peer:1,terms:{kind:'joint-attack',enemy:2},subsidy:{payer:0,amount:10},counterTo:null}}).state;
  state=submitFleetOrder(state,{id:'accept',player:1,action:{kind:'respond-agreement',agreementId:'private',response:'accept'}}).state;
  return {state,scheduled:[]};
}

test('server observation and shared game view preserve only authorized diplomacy facts',()=>{
  const room=observed();
  const own=observation(room,0,'test'),other=observation(room,2,'test');
  assert.equal(own.diplomacy!.agreements.length,1);assert.equal(other.diplomacy!.agreements.length,0);
  assert.equal(other.diplomacy!.receipts.length,0);
  assert.ok(other.diplomacy!.relations.every(r=>r.from===2||r.to===2));
  assert.ok(!('captured' in own.diplomacy!.agreements[0]!));
  assert.ok(!('protectedSince' in own.diplomacy!.agreements[0]!));
  assert.deepEqual(playerGameView(own).diplomacy,own.diplomacy);
});

test('relations render both independent directions and unavailable values without invented zeroes',()=>{
  const o=observation(observed(),0,'test'),d=o.diplomacy!;
  d.relations.find(r=>r.from===0&&r.to===1)!.trust=12.25;
  d.relations.find(r=>r.from===1&&r.to===0)!.trust=-24.5;
  const html=renderToStaticMarkup(React.createElement(RelationsTable,{value:d,player:0}));
  assert.ok(html.includes('我对其信任'));assert.ok(html.includes('其对我信任'));
  assert.ok(html.includes('12.25'));assert.ok(html.includes('-24.5'));
  const missing=renderToStaticMarkup(React.createElement(RelationsTable,{value:undefined,player:0}));
  assert.ok(missing.includes('暂不可用'));assert.ok(!missing.includes('<td'));
});

test('console contract display separates signature, personal fulfilment, deadline and paid subsidy',()=>{
  const value=observation(observed(),0,'test').diplomacy!;
  const html=renderToStaticMarkup(React.createElement(ServerAgreements,{value,names:{}}));
  assert.ok(html.includes('履约中'));assert.ok(html.includes('200'));
  assert.ok(html.includes('0 / 1'));assert.ok(html.includes('任意一个据点'));assert.ok(!html.includes('折算战损'));assert.ok(html.includes('已支付'));
  assert.ok(!html.includes('已履约'));
});

test('OB relations show the global directed matrix without inventing a player perspective',()=>{
 const room=observed(),value=labRuleView(room.state).diplomacy;
 value.relations.find(r=>r.from===1&&r.to===2)!.trust=17.25;
 value.relations.find(r=>r.from===2&&r.to===1)!.trust=-31.5;
 const html=renderToStaticMarkup(React.createElement(RelationsTable,{value,player:null}));
 assert.ok(html.includes('全局信任矩阵'));assert.ok(html.includes('17.25'));assert.ok(html.includes('-31.5'));assert.ok(!html.includes('暂不可用'));assert.ok(!html.includes('我对其信任'));
 assert.equal((html.match(/<td/g)??[]).length,9);
});
