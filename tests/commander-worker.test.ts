import {commanderModelFactory} from './helpers/model-fixture.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CommanderWorker,parseCommanderResult} from '../packages/ai/src/controller/runtime/commander-worker.js';
import {initialState,type AgentProvider} from '../packages/ai/src/controller/contracts/types.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {observation} from '../packages/server/src/player-api.js';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {ProviderError} from '../packages/ai/src/controller/contracts/provider-error.js';
const roster=[{chatPlayer:5,gamePlayer:0,displayName:'幽影'},{chatPlayer:3,gamePlayer:1,displayName:'冰洋'}];
const view=()=>observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'commander-test');
async function drain(worker:CommanderWorker){for(let i=0;worker.busy&&i<500;i++)await new Promise(r=>setTimeout(r,2));assert.equal(worker.busy,false);}
function fixture(provider:AgentProvider,hooks:{buildPrompt?:(input:import('../packages/ai/src/controller/contracts/bot-mode.js').CommanderPromptInput)=>string;observation?:()=>ReturnType<typeof view>;onDirectives?:(count:number)=>void;failAck?:()=>boolean;failErrorReply?:()=>boolean}={}){
 const state=initialState('commander-test',0,{model:'fake',personality:'schemer'});state.enabled=false;state.status='paused';
 const store=new AiStore(':memory:'),threads=new CommanderStore(),obs=view();let reviews=0;const paths:string[]=[];
 const worker=new CommanderWorker({...(hooks.buildPrompt?{buildPrompt:hooks.buildPrompt}:{}),state,expectedPlayer:0,roster:()=>roster,store,provider:commanderModelFactory(()=>provider),available:()=>true,onDirectives:()=>{reviews++;hooks.onDirectives?.(reviews);},transport:{request:async(path,data)=>{paths.push(path);if(path==='/tool/observation')return hooks.observation?.()??obs;if(path!=='/tool/commander/worker')throw Error('Unexpected side effect');if(data){if((data as {op?:string}).op==='ack'&&hooks.failAck?.())throw Error('Ack connection interrupted');if((data as {op?:string;error?:boolean}).op==='reply'&&(data as {error?:boolean}).error&&hooks.failErrorReply?.())throw Error('Error notification interrupted');return threads.worker(state.roomId,0,data,obs.view.tick);}return threads.read(state.roomId,0);}}});
 return {state,store,threads,worker,obs,paths,reviews:()=>reviews,close:async()=>{await worker.close();store.close();}};
}
test('commander output is data-only and rejects tool execution or protocol dumps',()=>{
 assert.throws(()=>parseCommanderResult({tool:'order',arguments:{},summary:'出兵'},'discuss'));
 assert.throws(()=>parseCommanderResult({tool:'finish',arguments:{notebook:{set:[]}},summary:'好'},'discuss'));
 assert.throws(()=>parseCommanderResult({tool:'finish',arguments:{memory:{relations:'攻击'}},summary:'好'},'discuss'));
 assert.throws(()=>parseCommanderResult({tool:'finish',arguments:{},summary:'{"tool":"order"}'},'discuss'));
 assert.deepEqual(parseCommanderResult({tool:'finish',arguments:{memory:null},summary:'建议先稳住北线。'},'discuss'),{text:'建议先稳住北线。',memory:{}});
});

test('queue admission refreshes the discussion to the latest observation in realtime and turn-based games',async()=>{
 for(const realtime of [true,false]){
  let reads=0,sends=0;const base=view();
  const f=fixture({step:async input=>{await input.beforeSend?.();assert.match(input.prompt,new RegExp('latest-observation:'+reads+'\\b'));sends++;return {reply:{tool:'finish',arguments:{memory:null},summary:'维持当前战略。'},tokens:0};}},{buildPrompt:input=>'latest-observation:'+input.observation.revision,observation:()=>({...base,realtime,revision:String(++reads),view:{...base.view,tick:base.view.tick+reads}})});
  try{
   await f.threads.send('commander-test',0,{id:'clock-discussion',text:'说明战略，不修改指令。',references:[]},f.obs);
   f.worker.tick();await drain(f.worker);
   assert.equal(sends,1);
   assert.equal(f.threads.read('commander-test',0).messages[0]!.status,'completed');
   assert.equal(f.threads.read('commander-test',0).directives.version,0);
  }finally{await f.close();}
 }
});

test('new proposals reject confirmation workflow while retaining operational conditions',()=>{
 const reply=(strategy:string)=>({tool:'finish',arguments:{memory:{strategy}},summary:'集中兵力进攻天火。'});
 assert.throws(()=>parseCommanderResult(reply('准备合并后的完整指挥官指令：玩家确认后进攻。'),'discuss'),/actionable/);
 assert.throws(()=>parseCommanderResult(reply('玩家确认后，集中兵力进攻。'),'discuss'),/confirmation/);
 assert.equal(parseCommanderResult(reply('敌军进入航程后，集中兵力进攻；保留核心据点守备。'),'discuss').memory.strategy,'敌军进入航程后，集中兵力进攻；保留核心据点守备。');
});

test('malformed discussion memory is discarded without a corrective model call',async t=>{
 let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
 const f=fixture({step:async request=>{calls++;if(calls===1)return {tokens:0,reply:{tool:'finish',arguments:{memory:'错误字符串'},summary:'建议进攻。'}};assert.doesNotMatch(request.prompt,/上一份回复已完整返回/);return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'集中兵力进攻天火。'}},summary:'集中兵力进攻天火。'}};}});
 try{
  await f.threads.send('commander-test',0,{id:'format-repair',text:'改为集中进攻天火',references:[]},f.obs);
  f.worker.tick();await drain(f.worker);assert.equal(calls,1);assert.equal(f.threads.read('commander-test',0).messages[0]!.status,'failed');
  assert.equal(f.store.latest<{status:string}>(f.state.roomId,0,'provider-dispatch-commander')!.status,'settled');
  now+=6000;f.worker.tick();await drain(f.worker);
  assert.equal(calls,1);assert.equal(f.threads.read('commander-test',0).messages.at(-1)!.proposal,undefined);
  await f.threads.send('commander-test',0,{id:'new-discussion',text:'请重新分析进攻天火',references:[]},f.obs);
  now+=6000;f.worker.tick();await drain(f.worker);assert.equal(calls,2);assert.equal(f.threads.read('commander-test',0).messages.at(-1)!.proposal!.text,'集中兵力进攻天火。');
  assert.equal(f.threads.read('commander-test',0).directives.version,0);
 }finally{await f.close();}
});

test('an undelivered error notification cannot resubmit a discarded discussion reply',async t=>{
 let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
 const f=fixture({step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{memory:'invalid'},summary:'不能发布的正文'}};}},{failErrorReply:()=>true});
 try{
  await f.threads.send('commander-test',0,{id:'undelivered-error',text:'讨论下一步',references:[]},f.obs);
  for(let i=0;i<4;i++){f.worker.tick();await drain(f.worker);now+=20000;}
  assert.equal(calls,1);
  assert.equal(f.threads.read('commander-test',0).directives.version,0);
  assert.equal(f.threads.read('commander-test',0).messages.length,1);
  assert.ok(f.store.latest<{messages:string[]}>(f.state.roomId,0,'commander-model-hold')!.messages.includes('undelivered-error'));
 }finally{await f.close();}
});

test('completed provider envelope errors are discarded and preserve unapplied commander authority',async t=>{
 let now=Date.now(),calls=0;t.mock.method(Date,'now',()=>now);
 const f=fixture({step:async()=>{calls++;throw new ProviderError('invalid-response',undefined,{stage:'parse-response',outcome:'completed'});}});
 try{
  await f.threads.send('commander-test',0,{id:'confirmed',text:'进攻天火',references:[]},f.obs);
  await f.threads.worker('commander-test',0,{op:'reply',messageId:'confirmed',reply:'请确认',proposal:{baseVersion:0,text:'集中进攻天火',summary:'集中进攻'}},100);
  const p=f.threads.read('commander-test',0).messages.at(-1)!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},100);
  for(let i=0;i<5;i++){f.worker.tick();await drain(f.worker);now+=20000;}
  assert.equal(calls,1);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);
  assert.equal(f.store.latest(f.state.roomId,0,'commander-format-retry'),null);
  const notice=f.threads.read('commander-test',0).messages.at(-1)!.text;assert.match(notice,/尚未整理完成/);assert.doesNotMatch(notice,/再发一条消息|已.{0,3}出兵/);
 }finally{await f.close();}
});

test('unsent commander request rebuilds after an external strategy commit without posting a failure',async()=>{
 let attempts=0,sends=0;
 const f=fixture({step:async input=>{
  attempts++;
  if(attempts===1)f.store.save({...f.state,memory:{...f.state.memory,strategy:'排队期间更新的战略'}});
  await input.beforeSend?.();
  sends++;assert.match(input.prompt,/排队期间更新的战略/);
  return {reply:{tool:'finish',arguments:{memory:null},summary:'按最新战略讨论。'},tokens:0};
 }});
 try{
  await f.threads.send('commander-test',0,{id:'queued-strategy',text:'继续讨论',references:[]},f.obs);
  f.worker.tick();await drain(f.worker);
  assert.equal(sends,0);assert.equal(f.threads.read('commander-test',0).messages.length,1);
  assert.equal(f.store.latest('commander-test',0,'commander-call-failed'),null);
  f.worker.tick(Date.now()+2000);await drain(f.worker);
  assert.equal(attempts,2);assert.equal(sends,1);
  assert.equal(f.threads.read('commander-test',0).messages.at(-1)!.text,'按最新战略讨论。');
 }finally{await f.close();}
});

test('commander discussion and reconciliation share current map effects and full active note bodies',async()=>{
 let calls=0;
 const body='保留多来源联合进攻方案；下一步先比较守矿与增援。';
 const f=fixture({step:async input=>{
  calls++;
  if(input.commanderMode==='reconcile'){assert.match(input.prompt,/顶层仍必须完整输出request、summary、nextContext/);assert.doesNotMatch(input.prompt,/只输出memory，不输出其他字段/);}
  assert.ok(input.prompt.includes(body));
  assert.ok(!input.prompt.includes('已过期正文'));
  assert.ok(!input.prompt.includes('旧关系记忆'));
  assert.match(input.prompt,/\[据点\]\n名称\t归属/);
  assert.doesNotMatch(input.prompt,/garrison\/1|id是真实据点ID/);
  return {reply:{tool:'finish',arguments:{memory:{strategy:'优先守矿'}},summary:'先守矿，再比较增援。'},tokens:0};
 }});
 f.obs.view.tick=2;
 const post=f.obs.view.outposts[0]!;


 f.state.memory.relations='旧关系记忆';
 f.store.save(f.state,'notebook-set',{id:'active',kind:'plan',text:body,updatedAt:0,expiresAt:null});
 f.store.save(f.state,'notebook-set',{id:'expired',kind:'note',text:'已过期正文',updatedAt:0,expiresAt:600});
 try{
  await f.threads.send('commander-test',0,{id:'map-effects',text:'怎么安排？',references:[]},f.obs);
  f.worker.tick();await drain(f.worker);
  const answer=f.threads.read('commander-test',0).messages.at(-1)!;
  assert.ok(answer.proposal);
  await f.threads.confirm('commander-test',0,{proposalId:answer.proposal.id,version:0},2);
  f.worker.tick(Date.now()+2000);await drain(f.worker);
  assert.equal(calls,2);
 }finally{await f.close();}
});

test('discussion and reconciliation generate names from the authorized observation without rewriting output',async()=>{
 let calls=0;
 const reply='先守住 NEMO BAY，防备冰洋，留守57兵。',strategy='NEMO BAY 留守57兵，防备冰洋。';
 const f=fixture({step:async input=>{
  calls++;
  assert.match(input.prompt,/必须使用下方名单中的完整名称，保留授权原文/);
  assert.match(input.prompt,/不使用内部ID、简称或自行翻译/);
  assert.match(input.prompt,/不要编造URL或Markdown链接/);
  assert.match(input.prompt,/地图所有者的编号对应 gamePlayer/);
  const players=JSON.parse(input.prompt.split('本席授权玩家名单：')[1]!.split('\n')[0]!);
  assert.deepEqual(players,roster);
  assert.match(input.prompt,/回复、提案和完整指挥官指令/);
  const names=JSON.parse(input.prompt.split('本席授权据点名称：')[1]!.split('\n')[0]!);
  assert.deepEqual(names,Object.values(f.obs.outpostNames!));
  assert.match(input.prompt,/\[据点\]/);
  assert.match(input.prompt,/\[有效笔记\]/);
  assert.doesNotMatch(input.prompt,/garrison\/1|四项战略记忆/);
  return {reply:{tool:'finish',arguments:{memory:{strategy}},summary:reply},tokens:3};
 }});
 const id=f.obs.view.outposts[0]!.id;
 f.obs.outpostNames={...f.obs.outpostNames,[id]:'NEMO BAY'};
 try{
  await f.threads.send('commander-test',0,{id:'names',text:`守${id}，留57兵`,references:[]},f.obs);
  f.worker.tick();await drain(f.worker);
  const answer=f.threads.read('commander-test',0).messages.at(-1)!;
  assert.equal(answer.text,reply);assert.equal(answer.proposal!.text,strategy);
  await f.threads.confirm('commander-test',0,{proposalId:answer.proposal!.id,version:0},0);
  f.worker.tick(Date.now()+2000);await drain(f.worker);
  assert.equal(calls,2);assert.equal(f.state.memory.strategy,strategy);
 }finally{await f.close();}
});
test('paused independent discussion proposes without mutation, explicit confirmation reconciles memory',async()=>{
 let calls=0;const f=fixture({step:async()=>({reply:{tool:'finish',arguments:{memory:{strategy:++calls===1?'北矿留守60兵':'先稳住北矿，增援优先北线。'}},summary:calls===1?'建议北矿留守60兵，确认后再调整。':'已经出兵并占领北矿。'},tokens:3})});
 try{await f.threads.send('commander-test',0,{id:'hello',text:'北矿留守60兵，怎么样？',references:[]},f.obs);f.worker.tick();await drain(f.worker);
 assert.equal(calls,1);assert.equal(f.state.memory.strategy,'');assert.equal(f.state.enabled,false);assert.equal(f.state.calls,0);assert.equal(f.reviews(),0);
 let t=f.threads.read('commander-test',0);const p=t.messages.find(m=>m.proposal)!.proposal!;assert.equal(t.directives.version,0);
 await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},0);f.worker.tick(Date.now()+2000);await drain(f.worker);
 t=f.threads.read('commander-test',0);assert.equal(t.directives.appliedVersion,1);assert.equal(t.messages.filter(m=>m.role==='system').length,1);assert.equal(t.messages.at(-1)!.text,'指挥官指令已保存，AI 将调整原有策略。');assert.doesNotMatch(t.messages.at(-1)!.text,/已.{0,4}出兵|占领北矿/);assert.equal(f.state.commanderDirectives?.text,'北矿留守60兵');assert.match(f.state.memory.strategy,/北矿/);assert.equal(f.state.status,'paused');assert.equal(f.state.enabled,false);assert.ok(f.paths.every(p=>p==='/tool/commander/worker'||p==='/tool/observation'));
 }finally{await f.close();}
});
test('discussion model is nonblocking and a new instruction invalidates its old proposal',async()=>{
 let release!:(v:any)=>void;const f=fixture({step:()=>new Promise(r=>{release=r;})});
 try{await f.threads.send('commander-test',0,{id:'a',text:'讨论',references:[]},f.obs);f.worker.tick();await new Promise(r=>setTimeout(r,5));assert.equal(f.worker.busy,true);assert.equal(f.state.status,'paused');
 await f.threads.worker('commander-test',0,{op:'reply',messageId:'a',reply:'新提案',proposal:{baseVersion:0,text:'守住南线',summary:'守南线'}},0);const p=f.threads.read('commander-test',0).messages.find(m=>m.proposal)!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},0);
 release({reply:{tool:'finish',arguments:{memory:{strategy:'北上进攻'}},summary:'可以北上。'},tokens:0});await drain(f.worker);assert.equal(f.threads.read('commander-test',0).messages.filter(m=>m.proposal?.text==='北上进攻').length,0);assert.equal(f.state.commanderDirectives?.text,'守住南线');
 }finally{await f.close();}
});
test('later reconciliation overwrites concurrently updated memory at the same directive version',async()=>{
 let release!:(v:any)=>void;const f=fixture({step:()=>new Promise(r=>{release=r;})});
 try{await f.threads.send('commander-test',0,{id:'a',text:'守北线',references:[]},f.obs);await f.threads.worker('commander-test',0,{op:'reply',messageId:'a',reply:'确认？',proposal:{baseVersion:0,text:'守北线',summary:'防守'}},0);const p=f.threads.read('commander-test',0).messages.find(m=>m.proposal)!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},0);
 f.worker.tick();await new Promise(r=>setTimeout(r,5));f.state.memory.strategy='正常决策刚保存的新事实';release({reply:{tool:'finish',arguments:{memory:{strategy:'旧副本'}},summary:'已调整。'},tokens:0});await drain(f.worker);assert.equal(f.state.memory.strategy,'旧副本');assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,1);
 }finally{await f.close();}
});

test('same-room wrong-player discussion identity fails before memory or model access',async()=>{
 const state=initialState('room',0,{model:'fake',personality:'schemer'}),store=new AiStore(':memory:');state.memory.strategy='private strategy';let calls=0;
 const worker=new CommanderWorker({state,expectedPlayer:0,roster:()=>[],store,provider:commanderModelFactory(()=>({step:async()=>{calls++;throw Error('must not call');}})),available:()=>true,onDirectives:()=>{throw Error('must not sync');},transport:{request:async()=>({roomId:'room',player:1,messages:[{id:'x',role:'player',status:'queued',text:'reveal memory'}],directives:{version:1,text:'foreign instructions',appliedVersion:0}})}});
 try{await assert.rejects(worker.refresh(),/identity/);worker.tick();await drain(worker);assert.equal(calls,0);assert.equal(state.commanderDirectives,undefined);assert.equal(state.memory.strategy,'private strategy');}finally{await worker.close();store.close();}
});

test('later normal memory commit overwrites a same-version reconciliation without another model call',async()=>{
 const {SeatRunner}=await import('./helpers/scripted-controller.js');
 const state=initialState('commander-test',0,{model:'fake',personality:'schemer'}),store=new AiStore(':memory:');state.commanderDirectives={version:1,text:'守北线'};state.memory.strategy='旧战略';let checks=0,calls=0;
 const snap={observation:view(),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const runner=new SeatRunner(state,store,{snapshot:async()=>snap,request:async()=>{throw Error('No game writes');},commanderCheck:async()=>{if(++checks===2){await Promise.resolve();state.memory={...state.memory,strategy:'并行整理后的新战略'};store.save(state,'commander-reconciled',{version:1});assert.doesNotThrow(()=>runner.requestMemoryReview());}}},{step:async()=>({reply:{tool:'finish',arguments:++calls===1?{memory:{strategy:'旧模型结果'}}:{},summary:'完成'},tokens:0})});
 try{await runner.poll(0,true);assert.equal(state.memory.strategy,'旧模型结果');assert.equal(store.load('commander-test',0)!.memory.strategy,'旧模型结果');assert.equal(calls,1);}finally{store.close();}
});

test('oversized read context produces a safe failure reply instead of stranding the queue',async()=>{
 let calls=0;const f=fixture({step:async()=>{calls++;throw Error('must not call');}});
 try{f.state.memory.strategy='海'.repeat(245000);await f.threads.send('commander-test',0,{id:'large',text:'现在怎么样？',references:[]},f.obs);f.worker.tick();await drain(f.worker);const t=f.threads.read('commander-test',0);assert.equal(calls,0);assert.equal(t.messages[0]!.status,'failed');assert.match(t.messages[1]!.text,/没有改变指挥官指令/);assert.equal(t.directives.version,0);}finally{await f.close();}
});

async function confirmDirective(f:ReturnType<typeof fixture>){
 await f.threads.send('commander-test',0,{id:'confirmed',text:'守北线',references:[]},f.obs);
 await f.threads.worker('commander-test',0,{op:'reply',messageId:'confirmed',reply:'请确认',proposal:{baseVersion:0,text:'守北线',summary:'守北线'}},0);
 const proposal=f.threads.read('commander-test',0).messages.find(m=>m.proposal)!.proposal!;
 await f.threads.confirm('commander-test',0,{proposalId:proposal.id,version:0},0);
}

test('post-commit review notification failure retries the receipt without repeating the model or reporting failed reconciliation',async()=>{
 let calls=0;const f=fixture({step:async()=>{calls++;return{reply:{tool:'finish',arguments:{memory:{strategy:'新战略已保存'}},summary:'已整理'},tokens:1};}},
  {onDirectives:count=>{if(count===2)throw Error('LOCAL_BASIS_CHANGED: concurrent decision');}});
 try{
  await confirmDirective(f);f.worker.tick();await drain(f.worker);
  assert.equal(f.store.load('commander-test',0)!.memory.strategy,'新战略已保存');
  assert.equal(f.store.latest('commander-test',0,'commander-call-failed'),null);
  assert.ok(f.store.latest('commander-test',0,'commander-ack-pending'));
  assert.equal(f.threads.read('commander-test',0).messages.some(m=>m.id==='notice-reconcile-error-1'),false);
  f.worker.tick(Date.now()+6000);await drain(f.worker);
  assert.equal(calls,1);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,1);
 }finally{await f.close();}
});

test('lost acknowledgement retries idempotently and an existing durable commit repairs the old failure notice without a model call',async()=>{
 let calls=0,fail=true;const f=fixture({step:async()=>{calls++;throw Error('must not regenerate committed strategy');}}, {failAck:()=>{const value=fail;fail=false;return value;}});
 try{
  await confirmDirective(f);
  f.state.memory.strategy='已经整理的战略';f.state.commanderDirectives={version:1,text:'守北线'};
  f.store.save(f.state,'commander-reconciled',{version:1});
  await f.threads.worker('commander-test',0,{op:'notice',id:'reconcile-error-1',reply:'旧的整理失败提示'},0);
  f.worker.tick();await drain(f.worker);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);
  f.worker.tick(Date.now()+6000);await drain(f.worker);
  const thread=f.threads.read('commander-test',0);
  assert.equal(calls,0);assert.equal(thread.directives.appliedVersion,1);
  assert.equal(thread.messages.some(m=>m.id==='notice-reconcile-error-1'),false);
  assert.equal(f.state.memory.strategy,'已经整理的战略');
 }finally{await f.close();}
});

test('explicit empty proposal is not mistaken for absent proposal or applied before confirmation',async()=>{
 const f=fixture({step:async()=>({reply:{tool:'finish',arguments:{memory:{strategy:''}},summary:'可以，确认后清除现有指挥官指令。'},tokens:0})});
 try{await f.threads.send('commander-test',0,{id:'old',text:'守北线',references:[]},f.obs);await f.threads.worker('commander-test',0,{op:'reply',messageId:'old',reply:'请确认',proposal:{baseVersion:0,text:'守北线',summary:'守北线'}},0);const p=f.threads.read('commander-test',0).messages.find(m=>m.proposal)!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},0);await f.threads.worker('commander-test',0,{op:'ack',version:1,reply:'已同步'},0);
 await f.threads.send('commander-test',0,{id:'clear',text:'撤销全部指挥官指令',references:[]},f.obs);f.worker.tick();await drain(f.worker);const t=f.threads.read('commander-test',0);assert.equal(t.directives.text,'守北线');const clear=t.messages.find(m=>m.replyTo==='clear')!.proposal!;assert.equal(clear.text,'');assert.equal(clear.status,'pending');await f.threads.confirm('commander-test',0,{proposalId:clear.id,version:1},0);assert.equal(f.threads.read('commander-test',0).directives.text,'');
 }finally{await f.close();}
});

test('follow-up discussion includes bounded full proposals and historical object references without adopting them',async()=>{
 let prompt='';const f=fixture({step:async request=>{prompt=request.prompt;return{reply:{tool:'finish',arguments:{},summary:'可以把留守改为80，其余保持。'},tokens:0};}});
 try{const target=f.obs.view.outposts[0]!.id;await f.threads.send('commander-test',0,{id:'first',text:'先留60',references:[{kind:'outpost',id:target}]},f.obs);await f.threads.worker('commander-test',0,{op:'reply',messageId:'first',reply:'建议如下。',proposal:{baseVersion:0,text:'北矿留守60兵，南线继续侦察。',summary:'先守北矿'}},0);await f.threads.send('commander-test',0,{id:'second',text:'把刚才60改80，其余不变',references:[]},f.obs);f.worker.tick();await drain(f.worker);assert.ok(prompt.includes('北矿留守60兵，南线继续侦察。'));assert.ok(prompt.includes(f.obs.outpostNames![target]!));assert.match(prompt,/baseVersion/);assert.equal(f.threads.read('commander-test',0).directives.version,0);assert.equal(f.state.memory.strategy,'');}finally{await f.close();}
});

for(const failure of ['invalid-response','unknown'] as const)test(`a question does not retry ${failure} reconciliation; a newly confirmed version starts its own reconciliation`,async()=>{
 const modes:string[]=[];const f=fixture({step:async request=>{modes.push(request.commanderMode!);if(modes.length===1)throw failure==='unknown'?Error('unknown outcome'):new ProviderError('invalid-response',undefined,{stage:'parse-response',outcome:'completed'});return{reply:{tool:'finish',arguments:{memory:request.commanderMode==='discuss'?null:{strategy:'依照新指示守南线'}},summary:'当前局势已核对。'},tokens:0};}});
 try{await f.threads.send('commander-test',0,{id:'first',text:'守北线',references:[]},f.obs);await f.threads.worker('commander-test',0,{op:'reply',messageId:'first',reply:'请确认',proposal:{baseVersion:0,text:'守北线',summary:'防守'}},0);const p=f.threads.read('commander-test',0).messages.find(m=>m.proposal)!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:p.id,version:0},0);
 f.worker.tick();await drain(f.worker);assert.deepEqual(modes,['reconcile']);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);f.worker.tick(Date.now()+10000);await drain(f.worker);assert.equal(modes.length,1);
 await f.threads.send('commander-test',0,{id:'question',text:'近况怎样',references:[]},f.obs);f.worker.tick(Date.now()+20000);await drain(f.worker);
 assert.deepEqual(modes,['reconcile','discuss']);assert.equal(f.threads.read('commander-test',0).messages.find(m=>m.id==='question')!.status,'completed');assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);
 f.worker.tick(Date.now()+30000);await drain(f.worker);assert.equal(modes.length,2);
 await f.threads.send('commander-test',0,{id:'new-directive',text:'改守南线',references:[]},f.obs);await f.threads.worker('commander-test',0,{op:'reply',messageId:'new-directive',reply:'请确认',proposal:{baseVersion:1,text:'守南线',summary:'调整防守'}},0);const next=f.threads.read('commander-test',0).messages.find(m=>m.replyTo==='new-directive')!.proposal!;await f.threads.confirm('commander-test',0,{proposalId:next.id,version:1},0);
 f.worker.tick(Date.now()+40000);await drain(f.worker);assert.deepEqual(modes,['reconcile','discuss','reconcile']);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,2);
 }finally{await f.close();}
});

test('a queued question is answered before an unstarted confirmed-instruction reconciliation',async()=>{
 const modes:string[]=[];const f=fixture({step:async request=>{modes.push(request.commanderMode!);return {reply:{tool:'finish',arguments:{memory:request.commanderMode==='discuss'?null:{strategy:'守北线'}},summary:'已核对当前情况。'},tokens:0};}});
 try{
  await confirmDirective(f);await f.threads.send('commander-test',0,{id:'question-first',text:'近况怎样',references:[]},f.obs);
  f.worker.tick();await drain(f.worker);assert.deepEqual(modes,['discuss']);assert.equal(f.threads.read('commander-test',0).messages.find(m=>m.id==='question-first')!.status,'completed');assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);
  f.worker.tick(Date.now()+10000);await drain(f.worker);assert.deepEqual(modes,['discuss','reconcile']);assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,1);
  const starts=f.store.debugRows('commander-test',0,{kinds:['commander-call-started'],limit:10}).entries.map(r=>r.payload as {mode:string;messageId?:string});assert.equal(starts.find(r=>r.mode==='reconcile')!.messageId,undefined);
 }finally{await f.close();}
});

test('a recovered failed instruction remains held when a new question arrives after restart',async()=>{
 let calls=0;const provider:AgentProvider={step:async request=>{calls++;assert.equal(request.commanderMode,'discuss');return {reply:{tool:'finish',arguments:{memory:null},summary:'当前仍按现有安排防守。'},tokens:0};}};
 const f=fixture(provider);let recovered:CommanderWorker|undefined;
 try{
  await confirmDirective(f);f.store.save(f.state,'commander-model-hold',{messages:[],failedVersion:1,failedAtMessage:'confirmed'});await f.worker.close();
  await f.threads.send('commander-test',0,{id:'after-restart',text:'近况怎样',references:[]},f.obs);
  recovered=new CommanderWorker({state:f.state,expectedPlayer:0,roster:()=>roster,store:f.store,provider:commanderModelFactory(()=>provider),available:()=>true,onDirectives:()=>{},transport:{request:async(path,data)=>{if(path==='/tool/observation')return f.obs;assert.equal(path,'/tool/commander/worker');return data?f.threads.worker(f.state.roomId,0,data,0):f.threads.read(f.state.roomId,0);}}});
  recovered.tick();await drain(recovered);recovered.tick(Date.now()+10000);await drain(recovered);
  assert.equal(calls,1);assert.equal(f.threads.read('commander-test',0).messages.find(m=>m.id==='after-restart')!.status,'completed');assert.equal(f.threads.read('commander-test',0).directives.appliedVersion,0);
 }finally{await recovered?.close();await f.close();}
});
