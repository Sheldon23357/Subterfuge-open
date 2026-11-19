import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {appendActivity,readGlobalBattleLosses,type ActivityEvent} from '../packages/engine/src/notification-journal.js';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectGlobalBattleLosses,projectPlayerActivity,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {playerGameView} from '../packages/client/src/game-view.js';
import {BattleLossMatrix} from '../packages/client/src/BattleLossMatrix.js';

function event(id:number,battle?:ActivityEvent['battle']):ActivityEvent {
  return {id,kind:battle?'battle':'departed',tick:id,seconds:0,actor:0,subject:'fleet',source:null,destination:null,drillers:0,enabled:null,...(battle?{battle}:{})};
}
test('global totals preserve directions, accumulate beyond the live feed, and return detached snapshots',()=>{
  const state={};
  appendActivity(state,-1,event(0,{attacker:{player:0,loss:7},defender:{player:1,loss:11}}));
  assert.deepEqual(readGlobalBattleLosses(state,3),[[0,7,0],[11,0,0],[0,0,0]]);
  for(let i=1;i<20;i++)appendActivity(state,-1,event(i));
  appendActivity(state,-1,event(20,{attacker:{player:1,loss:5},defender:{player:0,loss:2}}));
  appendActivity(state,-1,event(21,{attacker:{player:0,loss:99},defender:{player:null,loss:88}}));
  const result=readGlobalBattleLosses(state,3);
  assert.deepEqual(result,[[0,9,0],[16,0,0],[0,0,0]]);
  result[0]![1]=999;
  assert.equal(readGlobalBattleLosses(state,3)[0]![1],9,'caller cannot corrupt cached totals');
});

test('all seats receive identical settled global losses, including battles outside sonar, after restore',()=>{
  const setup:FleetSetup={size:{width:80,height:80},positions:{a:{x:0,y:0},b:{x:2,y:0},c:{x:35,y:35}},
    economy:{initialTick:0,teamSize:0,players:Array.from({length:3},()=>({active:true,neptunium:0,minesCreated:0})),
      outposts:['a','b','c'].map((id,owner)=>({id,owner,type:'generator',drillers:200,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))},};
  const initial=createFleetScenario(setup);
  assert.deepEqual(projectGlobalBattleLosses(initial),[[0,0,0],[0,0,0],[0,0,0]]);
  const launched=submitFleetOrder(initial,{id:'attack',player:0,action:{kind:'launch',source:'a',destination:'b',drillers:20}}).state;
  const settled=advanceFleetScenario(launched,35);
  const matrix=projectGlobalBattleLosses(settled);
  assert.equal(matrix[0]![1],20);
  assert.equal(matrix[1]![0],20);
  assert.equal(projectPlayerActivity(settled,2).some(e=>e.battle),false,'remote seat has no private battle detail');
  for(const state of [settled,restoreFleetSnapshot(saveFleetSnapshot(settled))]){
    for(let seat=0;seat<3;seat++){
      const observed=observation({state,scheduled:[]},seat,'battle-room');
      assert.deepEqual(observed.battleLosses,matrix);
      assert.deepEqual(playerGameView(observed).battleLosses,matrix);
    }
  }
});

test('matrix renders N squared cells, distinct directions and unavailable data without invented zeroes',()=>{
  const html=renderToStaticMarkup(React.createElement(BattleLossMatrix,{matrix:[[0,7],[11,0]],count:2,tick:35}));
  assert.equal((html.match(/<td /g)??[]).length,4);
  assert.ok(html.includes('造成 7 兵损失'));
  assert.ok(html.includes('造成 11 兵损失'));
  assert.ok(!html.includes('造成损失方 →'));
  assert.ok(html.includes('损失方 ↓'));
  assert.equal((html.match(/is-diagonal/g)??[]).length,2);
  const unavailable=renderToStaticMarkup(React.createElement(BattleLossMatrix,{matrix:undefined,count:2,tick:0}));
  assert.ok(unavailable.includes('暂不可用'));
  assert.ok(!unavailable.includes('<td'));
});
