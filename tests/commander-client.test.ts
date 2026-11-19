import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {CommanderChat,CommanderMessageBubble,CommanderRepliesHeader} from '../packages/client/src/CommanderChat.js';
import {NotebookOverview} from '../packages/client/src/NotebookOverview.js';
import {addCommanderReference,canConfirmCommanderProposal,commanderFriendlyError,commanderReferenceKey,commanderSnapshotIsCurrent,commanderDirectiveChanges,commanderKeyboardViewport,commanderDockAnchor,commanderChronologicalMessages,validateCommanderThread} from '../packages/client/src/commander-chat-model.js';
import type {CommanderMessage,CommanderThread,CommanderProposal} from '../packages/contracts/src/index.js';
const proposal:CommanderProposal={id:'proposal-1',baseVersion:0,text:'北矿保留六十兵。\n暂停北上，保留南线侦察。',summary:'增加北矿留兵要求，将北上扩张改为防守。',status:'pending'};
const message:CommanderMessage={id:'reply-1',role:'assistant',text:'北矿更值得优先防守。建议先保住这里，南线继续侦察。',references:[{kind:'outpost',id:'north',label:'北矿'}],tick:35,sentAt:100,status:'completed',proposal};
const thread=(messages:CommanderMessage[]=[message],version=0,appliedVersion=0):CommanderThread=>({roomId:'room',player:0,messages,directives:{version,text:version?proposal.text:'',appliedVersion}});
const render=(m:CommanderMessage,version=0,locatable=true)=>renderToStaticMarkup(React.createElement(CommanderMessageBubble,{message:m,version,directives:'继续北上。',confirming:null,confirm:()=>{},resolveReference:()=>({label:'北矿',locatable}),locate:()=>{}}));

test('internal reconciliation ACK can clear only its resolved failure notice without another chat reply',()=>{
 const notice:CommanderMessage={id:'notice-reconcile-error-1',role:'assistant',status:'failed',text:'整理失败',references:[],tick:35,sentAt:101};
 const before=thread([message,notice],1,0),after=thread([message],1,1);
 assert.equal(commanderSnapshotIsCurrent(before,after),true);
 assert.equal(commanderSnapshotIsCurrent(before,thread([message],1,0)),false);
 assert.equal(commanderSnapshotIsCurrent(before,thread([],1,1)),false);
 assert.equal(commanderSnapshotIsCurrent(thread([message,{...notice,id:'unrelated-error'}],1,0),after),false);
 assert.equal(commanderSnapshotIsCurrent(thread([message,{...notice,id:'notice-reconcile-error-2'}],1,0),after),false);
});

test('commander references preserve order, distinguish types and deduplicate stable identities',()=>{
 const first=addCommanderReference([],{kind:'outpost',id:'a',label:'北矿'});
 assert.equal(addCommanderReference(first,{kind:'outpost',id:'a',label:'改名'}),first);
 const both=addCommanderReference(first,{kind:'fleet',id:'a',label:'舰队'});
 assert.equal(both.length,2);assert.deepEqual(both.map(commanderReferenceKey),['outpost:a','fleet:a']);
 let refs=both;for(let i=0;i<20;i++)refs=addCommanderReference(refs,{kind:'outpost',id:'o'+i});assert.equal(refs.length,12);
});
test('proposal confirmation requires pending state and exact current instruction version',()=>{
 assert.equal(canConfirmCommanderProposal(proposal,0),true);
 assert.equal(canConfirmCommanderProposal(proposal,1),false);
 assert.equal(canConfirmCommanderProposal({...proposal,status:'confirmed'},0),false);
 assert.equal(canConfirmCommanderProposal({...proposal,status:'superseded'},0),false);
});
test('late polling snapshots cannot roll back messages, confirmed instructions, or applied receipts',()=>{
 const confirmed={...message,proposal:{...proposal,status:'confirmed' as const}};
 const newest=thread([confirmed],1,1);
 assert.equal(commanderSnapshotIsCurrent(newest,thread()),false);
 assert.equal(commanderSnapshotIsCurrent(newest,thread([confirmed],1,0)),false);
 assert.equal(commanderSnapshotIsCurrent(newest,thread([message],1,1)),false);
 assert.equal(commanderSnapshotIsCurrent(newest,thread([],1,1)),false);
 assert.equal(commanderSnapshotIsCurrent(newest,thread([confirmed,{...message,id:'receipt'}],1,1)),true);
 const completed=thread([{...message,status:'completed'}]);
 assert.equal(commanderSnapshotIsCurrent(completed,thread([{...message,status:'queued'}])),false);
 assert.equal(commanderSnapshotIsCurrent(newest,{...newest,roomId:'other'}),false);
});
test('thread identity rejects different room and seat',()=>{
 assert.equal(validateCommanderThread(thread(),'room',0).roomId,'room');
 assert.throws(()=>validateCommanderThread(thread(),'other',0));assert.throws(()=>validateCommanderThread(thread(),'room',1));
});
test('AI bubbles show natural-language text, avatar, references and visible merged directive preview',()=>{
 const html=render(message);
 assert.ok(html.includes('指挥官'));assert.ok(html.includes(message.text));assert.ok(html.includes('commander-avatar'));
 assert.ok(html.includes('确认并融入指挥官指令'));assert.ok(html.includes('北矿保留六十兵。'));assert.ok(html.includes('将移除或替换的原指示'));assert.ok(html.includes('继续北上。'));assert.ok(html.includes('<details>'));assert.ok(!html.includes('<details open='));
 assert.ok(!html.includes('baseVersion'));assert.ok(!html.includes('proposal-1'));
});
test('confirmed and superseded proposals cannot render an actionable confirm button',()=>{
 assert.ok(!render(message,1).includes('确认并融入指挥官指令'));
 const confirmed=render({...message,proposal:{...proposal,status:'confirmed'}},1);
 assert.ok(confirmed.includes('已融入指挥官指令'));assert.ok(!confirmed.includes('确认并融入指挥官指令'));
 assert.ok(confirmed.includes('已确认。'));assert.ok(!confirmed.includes('以回复为准'));
});
test('invisible historical fleet references never offer a location action',()=>{
 const html=render({...message,references:[{kind:'fleet',id:'old-fleet',label:'先遣舰队'}]},0,false);
 assert.ok(html.includes('暂不可见'));assert.ok(html.includes('disabled=""'));assert.ok(!html.includes('old-fleet'));
});
test('reply expansion is opt-in and React escapes model HTML',()=>{
 const html=render({...message,text:'<script>alert(1)</script>'+ '自然语言'.repeat(100),proposal:undefined} as unknown as CommanderMessage);
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('展开回复'));assert.ok(html.length<3000);
});
test('compact glass composer uses portrait history access without persistent labels or placeholder',()=>{
 const html=renderToStaticMarkup(React.createElement(CommanderChat,{roomId:'room',player:0,request:async()=>thread(),resolveReference:()=>({label:'北矿',locatable:true}),locate:()=>{}}));
 assert.ok(!html.includes('己方参谋 · 私密'));assert.ok(!html.includes('placeholder='));assert.ok(html.includes('打开本局讨论历史'));assert.ok(html.includes('/assets/commander/naval-commander.png'));assert.ok(html.includes('commander-sr-status'));assert.ok(html.includes('与己方 AI 讨论局势'));assert.ok(html.includes('textarea'));assert.ok(!html.includes('JSON'));
 const css=readFileSync('packages/client/src/commander-chat.css','utf8');assert.ok(css.includes('bottom:var(--commander-bottom,8px)'));assert.ok(css.includes('backdrop-filter:blur(22px)'));assert.ok(css.includes('width:30vw'));assert.ok(css.includes('height:58px'));assert.ok(css.includes('--commander-entry-width:calc(40vw - 60px)'));assert.ok(css.includes('background:#142733b3'));assert.ok(!css.includes('.commander-toolbar'));
 assert.ok(commanderFriendlyError('messages').includes('内容已保留'));assert.ok(commanderFriendlyError('confirm').includes('核对指示'));
});
test('notebook presents commander instructions independently of AI strategy',()=>{
 const html=renderToStaticMarkup(React.createElement(NotebookOverview,{value:{commanderDirectives:{version:2,text:'守住北矿'},memory:{strategy:'向南侦察',relations:'',agreements:'',deceptions:''},relations:[]}}));
 assert.ok(html.indexOf('指挥官指令')<html.indexOf('总体战略'));assert.ok(html.includes('守住北矿'));assert.ok(html.includes('向南侦察'));assert.ok(!html.includes('玩家确认后生效'),'already confirmed directives must not appear pending confirmation');
});

test('notebook overview shows exact capacity and omits retired memory categories',()=>{
 const html=renderToStaticMarkup(React.createElement(NotebookOverview,{value:{memory:{strategy:'当前战略',relations:'旧关系内容',agreements:'旧协议内容',deceptions:'旧意图内容'},capacity:{characters:12000,characterLimit:12000,entries:32,entryLimit:32,strategyCharacters:4,strategyLimit:1000}}}));
 for(const text of ['12000 / 12000','32 / 32','4 / 1000','最低等级','仅改等级不刷新正文时间'])assert.ok(html.includes(text));
 for(const text of ['旧关系内容','旧协议内容','旧意图内容','关系表'])assert.ok(!html.includes(text));
});
test('game integration separates live references and discussion from previews and world readiness',()=>{
 const game=readFileSync('packages/client/src/Game.tsx','utf8'),player=readFileSync('packages/client/src/player-main.tsx','utf8'),chat=readFileSync('packages/client/src/CommanderChat.tsx','utf8');
 assert.ok(game.includes('disabled={offset!==0}'));assert.ok(game.includes("const post=view?.outposts.find"));assert.ok(game.includes('locate={reference=>{setOffset(0)'));
 assert.ok(game.includes('commanderReference?.scope===`${commanderRoom}:${seat}`'));
 const adapter=player.slice(player.indexOf('commander:async'),player.indexOf('          unread,',player.indexOf('commander:async')));
 assert.ok(adapter.includes("latest.current?.roomId!==now.roomId"));assert.ok(!adapter.includes('latest.current?.revision'));assert.ok(!adapter.includes('now.revision'));assert.ok(!adapter.includes('control.blocked'));
 assert.ok(chat.includes('if(draftRef.current===draft)setDraft'));assert.ok(chat.includes('!event.nativeEvent.isComposing'));assert.ok(!chat.includes('auto-advance'));assert.ok(!chat.includes('readiness'));
});

test('instruction diffs independently reveal removed requirements rather than trusting model summary',()=>{
 assert.deepEqual(commanderDirectiveChanges('保留六十兵\n继续北上','保留六十兵\n暂停北上'),{removed:['继续北上'],added:['暂停北上']});
 assert.deepEqual(commanderDirectiveChanges('不可攻击红方',''),{removed:['不可攻击红方'],added:[]});
});
test('mobile keyboard viewport uses actual visible height and top only while composing',()=>{
 assert.deepEqual(commanderKeyboardViewport(844,400,50,true),{height:400,top:50});
 assert.equal(commanderKeyboardViewport(844,844,0,true),null);assert.equal(commanderKeyboardViewport(844,400,50,false),null);
 assert.equal(commanderKeyboardViewport(844,NaN,0,true),null);
});

test('lab commander transport reuses only a seat capability and never retries a mutation automatically',async()=>{
 const {createLabCommanderTransport}=await import('../packages/client/src/commander-transport.js');
 const original=globalThis.fetch,calls:{path:string;options:RequestInit|undefined}[]=[];
 let rejectMutation=false;
 globalThis.fetch=async(input,options)=>{
  const path=String(input);calls.push({path,options});
  if(path==='/api/chat/session')return new Response(JSON.stringify({token:'seat-capability'}),{status:200});
  if(rejectMutation&&path.endsWith('/messages'))return new Response('{}',{status:403});
  return new Response(JSON.stringify(thread()),{status:200});
 };
 try{
  const request=createLabCommanderTransport(2);await request('list');await request('messages',{id:'message',text:'守北矿',references:[]});
  assert.equal(calls.filter(c=>c.path==='/api/chat/session').length,1);
  assert.equal(JSON.parse(String(calls[0]?.options?.body)).seat,2);
  assert.equal((calls[1]?.options?.headers as Record<string,string>)['X-Lab-Seat-Token'],'seat-capability');
  assert.ok(calls.every(c=>!c.path.includes('4400')));
  rejectMutation=true;await assert.rejects(request('messages',{id:'retry',text:'守北矿',references:[]}));
  assert.equal(calls.filter(c=>c.path.endsWith('/messages')).length,2);
  await request('list');assert.equal(calls.filter(c=>c.path==='/api/chat/session').length,2);
 }finally{globalThis.fetch=original;}
});

test('commander dock aligns beside the compact timeline and stacks only on narrow screens',()=>{
 const room={left:0,bottom:900},bar={left:20,right:670,top:834,bottom:892};
 assert.deepEqual(commanderDockAnchor(room,bar,true),{left:680,bottom:8});
 // Each side is exactly 30% of the viewport; the remaining input stays truly centered.
 for(const width of [1280,1440,1920,2560]){
  const entryWidth=width*.4-60,entryLeft=width*.3+30;
  const ruler={left:20,right:20+width*.3,top:834,bottom:892};
  const anchor=commanderDockAnchor(room,ruler,true);
  assert.ok(Math.abs(anchor.left+entryWidth/2-width/2)<1e-9);
  assert.equal(ruler.right-ruler.left,width*.3);
  assert.ok(Math.abs(width-20-width*.3-(anchor.left+entryWidth)-10)<1e-9);
 }
 assert.deepEqual(commanderDockAnchor(room,bar,false),{left:20,bottom:76});
 const keyboardRoom={left:0,bottom:450},keyboardBar={left:10,right:380,top:330,bottom:388};
 assert.deepEqual(commanderDockAnchor(keyboardRoom,keyboardBar,false),{left:10,bottom:130});
 const source=readFileSync('packages/client/src/CommanderChat.tsx','utf8');
 assert.ok(source.indexOf('className="commander-context"')<source.indexOf('className="commander-composer"'));
 const timebar=readFileSync('packages/client/src/Timebar.tsx','utf8');
 for(const label of ['aria-label="历史"','aria-label="返回当前时间"','type="range"','onPointerDown'])assert.ok(timebar.includes(label));
});


test('reply header exposes an explicit history expand control and a return-to-latest control',()=>{
 for(const history of [false,true]){
  const html=renderToStaticMarkup(React.createElement(CommanderRepliesHeader,{history,toggleHistory:()=>{},close:()=>{}}));
  assert.ok(html.includes(history?'收起历史，回到最新回复':'展开双方历史对话'));
  assert.ok(html.includes(`aria-expanded="${history}"`));assert.ok(html.includes('收起所有回复'));
 }
 const css=readFileSync('packages/client/src/commander-chat.css','utf8');
 assert.match(css,/\.commander-replies \{[^}]*left:0; right:0; width:auto;/);
 assert.ok(!/\.commander-replies \{[^}]*width:min/.test(css));
});
test('expanded discussion preserves both participants and receipts in old-to-new order',()=>{
 const late={...message,id:'late',sentAt:300},player={...message,id:'player',role:'player' as const,sentAt:100,proposal:undefined},receipt={...message,id:'receipt',role:'system' as const,sentAt:300};
 const messages=[late,player,receipt] as CommanderMessage[],before=JSON.stringify(messages);
 const ordered=commanderChronologicalMessages(messages);
 assert.deepEqual(ordered.map(item=>item.id),['player','late','receipt']);assert.equal(JSON.stringify(messages),before);
 assert.equal(ordered[1]?.proposal,proposal);assert.equal(ordered[2]?.role,'system');
 assert.deepEqual(commanderChronologicalMessages([]),[]);
});
