import {commanderModelFactory} from './helpers/model-fixture.js';
import {readPromptSections} from '../packages/contracts/src/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {COMMANDER_VOICES,AI_PERSONALITIES} from '../packages/contracts/src/ai-personalities.js';
import type {CommanderMessage,CommanderProposal} from '../packages/contracts/src/index.js';
import {ROUND_TERMINOLOGY} from '../packages/ai/src/controller/presentation/round-map.js';
import {MANUAL_COMMAND_POLICY} from '../packages/ai/src/controller/execution/manual-coordination.js';
import {CommanderWorker,commanderProposalSummary,parseCommanderResult} from '../packages/ai/src/controller/runtime/commander-worker.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {CommanderMessageBubble} from '../packages/client/src/CommanderChat.js';
import {ChatMapContext} from '../packages/client/src/ChatMessageText.js';

const room='commander-voice-test';
const view=()=>observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,room);
async function drain(worker:CommanderWorker){for(let i=0;worker.busy&&i<500;i++)await new Promise(r=>setTimeout(r,2));assert.equal(worker.busy,false);}
for(const personality of Object.keys(AI_PERSONALITIES) as (keyof typeof AI_PERSONALITIES)[]){
 test(`private commander voice ${personality} is supplied without external deception policy`,async()=>{
  const state=initialState(room,0,{model:'fake',personality}),store=new AiStore(':memory:'),threads=new CommanderStore(),obs=view();
  state.enabled=false;state.status='paused';let calls=0;
  const reply='我不赞成现在全压，矿点不能空着。先稳住，再找机会。';
  const worker=new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store,available:()=>true,onDirectives:()=>{},provider:commanderModelFactory(()=>({step:async input=>{
   calls++;assert.ok(readPromptSections(input.prompt)?.[0]?.text.startsWith(MANUAL_COMMAND_POLICY.split('\n')[0]!));
   assert.equal(input.prompt.split(ROUND_TERMINOLOGY).length-1,1);
   assert.match(input.prompt,/\[据点\]/);
   assert.ok(input.prompt.indexOf(MANUAL_COMMAND_POLICY.split('\n')[0]!)<input.prompt.indexOf('私聊表达风格'));
   assert.ok(input.prompt.includes(COMMANDER_VOICES[personality]));
   assert.ok(!input.prompt.includes(AI_PERSONALITIES[personality].dialoguePrompt));
   for(const rule of ['通常一至两句','未证实的玩家说法用条件语气','不强制情绪词','绝不隐瞒真实意图','没有任何工具执行能力'])assert.ok(input.prompt.includes(rule),rule);
   assert.equal(input.effort,'low');
   return {reply:{tool:'finish',arguments:{memory:{strategy:'北线留守60兵。'}},summary:reply},tokens:3};
  }})),transport:{request:async(path,data)=>{if(path==='/tool/observation')return obs;assert.equal(path,'/tool/commander/worker');return data?threads.worker(room,0,data,0):threads.read(room,0);}}});
  try{
   await threads.send(room,0,{id:'question',text:'全压吧？',references:[]},obs);worker.tick();await drain(worker);
   const thread=threads.read(room,0),answer=thread.messages.at(-1)!;
   assert.equal(calls,1);assert.equal(answer.text,reply);assert.notEqual(answer.proposal!.summary,reply);
   assert.equal(answer.proposal!.text,'北线留守60兵。');assert.equal(answer.proposal!.status,'pending');
   assert.equal(thread.directives.version,0);assert.equal(state.memory.strategy,'');assert.equal(state.enabled,false);assert.equal(state.status,'paused');
  }finally{await worker.close();store.close();}
 });
}
test('proposal summaries preview real additions, replacements, removals and explicit clearing',()=>{
 assert.equal(commanderProposalSummary('守北线',''),'清除现有指挥官指令，之后不再沿用这些要求。');
 assert.match(commanderProposalSummary('守北线','守北线\n南线侦察'),/^增加要求：南线侦察/);
 assert.match(commanderProposalSummary('强攻北线','守住北线'),/^调整为：守住北线（完整变更见下方）/);
 assert.match(commanderProposalSummary('守北线\n强攻南线','守北线'),/^撤下这项要求：强攻南线/);
 assert.equal(commanderProposalSummary('守北线\n南线侦察','南线侦察\n守北线'),'仅整理指示排布，具体内容见完整指示。');
 assert.ok(commanderProposalSummary('', '长'.repeat(6000)).length<150);
 assert.match(commanderProposalSummary('a','b\nc'),/完整变更见下方/);
});
const proposal:CommanderProposal={id:'p',baseVersion:0,text:'守北线。',summary:'先稳住，再找机会。',status:'pending'};
const message:CommanderMessage={id:'a',role:'assistant',text:proposal.summary,references:[],tick:1,sentAt:1,status:'completed',proposal};
const render=(m:CommanderMessage,version=0)=>renderToStaticMarkup(React.createElement(CommanderMessageBubble,{message:m,version,directives:'强攻北线。',confirming:null,confirm:()=>{throw Error('render must not confirm');},resolveReference:()=>({label:'',locatable:false}),locate:()=>{}}));

test('commander English names link in replies, proposal summaries, changes and full directives',()=>{
 const m={...message,text:'先守 NEMO BAY，留57兵。',proposal:{...proposal,text:'NEMO BAY 留57兵。',summary:'守住 NEMO BAY。'}};
 const html=renderToStaticMarkup(React.createElement(ChatMapContext.Provider,{value:{outposts:[{id:'据点 57',name:'NEMO BAY'}],locate:()=>{}}},React.createElement(CommanderMessageBubble,{message:m,version:0,directives:'保持侦察。',confirming:null,confirm:()=>{},resolveReference:()=>({label:'',locatable:false}),locate:()=>{}})));
 assert.equal((html.match(/>NEMO BAY<\/a>/g)??[]).length,4);
 assert.equal((html.match(/href="#outpost-%E6%8D%AE%E7%82%B9%2057"/g)??[]).length,4);
 assert.ok(html.includes('留57兵'));assert.equal(m.text,'先守 NEMO BAY，留57兵。');
});
test('old duplicate proposal summary renders once, full actual diff stays visible before separate confirmation',()=>{
 const html=render(message);
 assert.equal(html.split(message.text).length-1,1);assert.ok(html.includes('我想这样调整'));
 assert.ok(html.includes('将移除或替换的原指示'));assert.ok(html.includes('强攻北线。'));assert.ok(html.includes('将加入的指示'));assert.ok(html.includes('守北线。'));
 assert.ok(html.includes('<details>'));assert.ok(!html.includes('<details open'));
 assert.ok(html.includes('确认只更新指挥官指令，不代表已出兵或执行'));assert.ok(html.includes('确认并融入指挥官指令'));
});
test('distinct summary and clear proposal remain reviewable; stale/confirmed proposals cannot confirm',()=>{
 const clear=render({...message,proposal:{...proposal,text:'',summary:commanderProposalSummary('强攻北线。','')}});
 assert.ok(clear.includes('清除现有指挥官指令'));assert.ok(clear.includes('强攻北线。'));
 for(const status of ['confirmed','superseded'] as const){const html=render({...message,proposal:{...proposal,status}},1);assert.ok(!html.includes('确认并融入指挥官指令'));assert.ok(html.includes(status==='confirmed'?'已融入指挥官指令':'这份方案已过期'));}
 assert.ok(!render(message,1).includes('确认并融入指挥官指令'));
});
test('reconciliation acknowledgement stays internal and confirmation keeps the only progress message',async()=>{
 const threads=new CommanderStore(),obs=view();await threads.send(room,0,{id:'q',text:'守北线',references:[]},obs);
 await threads.worker(room,0,{op:'reply',messageId:'q',reply:'我倾向先守。',proposal:{baseVersion:0,text:'守北线',summary:'先守北线'}},0);
 const p=threads.read(room,0).messages.at(-1)!.proposal!;await threads.confirm(room,0,{proposalId:p.id,version:0},0);
 const before=threads.read(room,0);
 await threads.worker(room,0,{op:'ack',version:1,reply:'已更新总体战略。具体行动仍需正常决策。'},0);
 assert.deepEqual(threads.read(room,0).messages,before.messages);assert.equal(threads.read(room,0).directives.appliedVersion,1);
 const receipt=threads.read(room,0).messages.at(-1)!;assert.equal(receipt.text,'指挥官指令已保存，AI 将调整原有策略。');assert.equal(receipt.role,'system');assert.ok(render(receipt,1).includes('进展反馈'));assert.ok(!render(receipt,1).includes('naval-commander.png'));
 assert.ok(render({...receipt,role:'assistant'},1).includes(receipt.text));
});

test('a reconciliation failure notice does not append a request to repeat the player question',()=>{
 const html=render({id:'notice-reconcile-error-1',role:'assistant',text:'指令已保存，但执行策略尚未整理完成。',references:[],tick:433,sentAt:0,status:'failed'},1);
 assert.match(html,/执行策略尚未整理完成/);assert.ok(!html.includes('请重新提问'));assert.ok(!html.includes('这次讨论未完成'));
});
test('warm natural language remains data-only; protocol and action claims cannot become tools',()=>{
 const text='拿不准，就先别赌这一下。我们再看看北线。';assert.equal(parseCommanderResult({tool:'finish',arguments:{memory:null},summary:text},'discuss').text,text);
 assert.throws(()=>parseCommanderResult({tool:'deploy',arguments:{},summary:'放心，交给我。'},'discuss'));
 assert.throws(()=>parseCommanderResult({tool:'finish',arguments:{memory:null},summary:'{"tool":"deploy"}'},'discuss'));
});

test('line-layout-only changes disclose their limits and open the full instructions',()=>{
 const html=render({...message,proposal:{...proposal,text:'强攻北线。\n强攻北线。',summary:'仅整理指示排布，具体内容见完整指示。'}});
 assert.ok(html.includes('检测到排列或格式变化'));assert.ok(html.includes('<details open="">'));assert.ok(!html.includes('指挥官指令内容保持不变'));
});

test('reconciliation keeps the same encoding definitions before dynamic directives without repeating them',async()=>{
 const state=initialState(room,0,{model:'fake',personality:'schemer'}),store=new AiStore(':memory:'),threads=new CommanderStore(),obs=view();let calls=0;
 const worker=new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store,available:()=>true,onDirectives:()=>{},provider:commanderModelFactory(()=>({step:async input=>{
  calls++;assert.ok(readPromptSections(input.prompt)?.[0]?.text.startsWith(MANUAL_COMMAND_POLICY.split('\n')[0]!));
  assert.equal(input.prompt.split(ROUND_TERMINOLOGY).length-1,1);
  assert.match(input.prompt,/\[据点\]/);
  assert.ok(input.prompt.indexOf(MANUAL_COMMAND_POLICY.split('\n')[0]!)<input.prompt.indexOf('已确认指挥官指令'));
  assert.ok(input.prompt.includes('不能发送外交或执行游戏动作'));
  return {reply:{tool:'finish',arguments:{memory:{strategy:'守北线'}},summary:'我已经出兵了。'},tokens:0};
 }})),transport:{request:async(path,data)=>{if(path==='/tool/observation')return obs;assert.equal(path,'/tool/commander/worker');return data?threads.worker(room,0,data,0):threads.read(room,0);}}});
 try{
  await threads.send(room,0,{id:'q',text:'守北线',references:[]},obs);await threads.worker(room,0,{op:'reply',messageId:'q',reply:'先守北线。',proposal:{baseVersion:0,text:'守北线',summary:'守北线'}},0);
  const p=threads.read(room,0).messages.at(-1)!.proposal!;await threads.confirm(room,0,{proposalId:p.id,version:0},0);worker.tick();await drain(worker);
  const receipt=threads.read(room,0).messages.at(-1)!;assert.equal(calls,1);assert.equal(receipt.role,'system');assert.doesNotMatch(receipt.text,/已经出兵/);assert.equal(threads.read(room,0).directives.appliedVersion,1);
 }finally{await worker.close();store.close();}
});
