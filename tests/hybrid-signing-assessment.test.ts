import test from 'node:test';
import assert from 'node:assert/strict';
import {modelWireInstructionsFor,hybridBriefPrompt} from '../plugins/hybrid/src/prompts.js';
import {ceasefireMaterial} from '../plugins/hybrid/src/ceasefire.js';
import {initialHybridState} from '../plugins/hybrid/src/contracts.js';
import {makeBrief} from '../plugins/hybrid/src/brief.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-observation.js';
import {DIPLOMACY_RULES} from '../packages/rules/src/index.js';

test('signing instructions compare marginal own benefits with independent retreat and preserve asymmetric bargaining',()=>{
 const instructions=modelWireInstructionsFor('diplomacy');
 for(const rule of ['直接保护的是对方资产','不约束清单外的反击','最佳可行的不签方案','独立撤军止损','沉没成本','保护竞争对手收入','净收益分数','不要求收益对等','信任奖励','本方新增利益及依据—主要代价—为何优于不签—重新评估条件','同一保护范围已有生效停战','已有本方待签版本','不新增响应字段'])
  assert.ok(instructions.includes(rule),`missing signing policy: ${rule}`);
 for(const kind of ['strategy','commander'] as const)assert.ok(!modelWireInstructionsFor(kind).includes('最佳可行的不签方案'),'signing policy stays in its responsible role');
});

test('one-sided mine truce supplies enemy ownership and the full 34-troop withdrawal cost alongside the signing policy',()=>{
 const setup:FleetSetup={size:{width:40,height:40},positions:{a:{x:0,y:0},b:{x:0,y:.1},c:{x:0,y:-.1},mine:{x:1,y:0},remote:{x:15,y:15}},
  economy:{initialTick:0,teamSize:0,players:Array.from({length:3},()=>({active:true,neptunium:50,minesCreated:0})),
   outposts:['a','b','c','mine','remote'].map((id,i)=>({id,owner:i<3?0:i===3?1:2,type:id==='mine'?'mine':'generator',drillers:i<3?100:10,shield:0,shieldMax:0,shieldsEnabled:true,productionProgress:0,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false}))}};
 let state=createFleetScenario(setup);
 for(const [i,drillers] of [5,27,34].entries())state=submitFleetOrder(state,{id:'attack-'+i,player:0,action:{kind:'launch',source:['a','b','c'][i]!,destination:'mine',drillers}}).state;
 state=submitFleetOrder(state,{id:'one-sided',player:1,action:{kind:'propose-agreement',peer:0,terms:{kind:'ceasefire',outposts:['mine']},subsidy:null,counterTo:null}}).state;
 const o=observation({state,scheduled:[]},0,'signing-test'),saved=initialHybridState();
 o.outpostNames={a:'ALPHA',b:'BETA',c:'GAMMA',mine:'WATSON',remote:'REMOTE'};
 const assessment=ceasefireMaterial(o,[1],saved,[])!.proposals[0]!;
 assert.deepEqual(assessment.outposts,['mine']);
 assert.equal(o.view.outposts.find(p=>p.id==='mine')!.owner,1);
 assert.equal(assessment.totalOwnLostDrillers,34);
 assert.deepEqual(assessment.withdrawals.map(f=>f.survivingDrillers).sort((a,b)=>a!-b!),[2,13,17]);
 assert.equal(assessment.peerApproaches.length,0);
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};
 const material=makeBrief({id:'diplomacy-1',kind:'diplomacy',scope:'1',players:[1],posts:['mine'],messageIds:[]},initialState(o.roomId,0,{mode:'hybrid',model:'mock',personality:'schemer'}),snapshot,saved);
 assert.ok(material.prompt.includes('WATSON'));
 assert.ok(material.prompt.includes('totalOwnLostDrillers'));
 assert.ok(material.prompt.includes('直接保护的是对方资产'));
 assert.ok(material.prompt.includes('独立撤军止损'));
});

test('the shared diplomacy rule prompt takes the proposal lifetime from authoritative constants',()=>{
 const prompt=hybridBriefPrompt('diplomacy',true,false,false,{});
 assert.ok(prompt.includes(`待签提案${DIPLOMACY_RULES.proposalTicks}tick`));
 assert.ok(!prompt.includes('待签提案24tick'));
});
