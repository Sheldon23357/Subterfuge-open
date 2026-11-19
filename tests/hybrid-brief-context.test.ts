import {readPromptMaterial,readPromptSections} from '../packages/contracts/src/prompt-sections.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {makeBrief,splitTask,type BriefTask} from '../plugins/hybrid/src/brief.js';
import {initialHybridState,HYBRID_PROMPT_CHARACTERS} from '../plugins/hybrid/src/contracts.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;setup.match={mode:'mining',neptuniumGoal:200};
 const o=observation({state:createFleetScenario(setup),scheduled:[]},0,'brief-context');
 o.view.outposts.push({id:'remote-fog',owner:1,visibility:0,position:{x:9,y:9}});
 o.outpostNames=Object.fromEntries(o.view.outposts.map((p,i)=>[p.id,'REEF-'+i]));
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 return {snapshot,state:initialState(o.roomId,0,{mode:'hybrid',model:'fake',personality:'schemer'}),saved:initialHybridState()};
}
const strategy:BriefTask={id:'overview',kind:'strategy',scope:'overview',posts:[],messageIds:[],players:[]};

test('strategic and diplomatic prompts carry authoritative limits and current authorized capacity',()=>{
 const f=fixture();
 for(const task of [strategy,{...strategy,id:'contact',kind:'diplomacy' as const,scope:'1',players:[1]}]){
  const b=makeBrief(task,f.state,f.snapshot,f.saved),g=b.brief.guidance as any;
  assert.deepEqual(g.relationAdvice.serverLimits,{ceasefires:2,jointAttacks:2});
  assert.equal(g.relationAdvice.agreementCapacity.find((p:any)=>p.player===0).remainingJointAttacks,2);
  assert.deepEqual(g.serverAgreements.rows,[]);
  assert.ok(b.prompt.includes('停战最多2份、夹击最多2份'));
  assert.ok(b.prompt.includes('不能推断其剩余名额'));
 }
});

test('hybrid briefs forecast fixed capture trust rewards and unfulfilled penalties for either participant',()=>{
 for(const progress of [0,1]){
  const f=fixture(),d=f.snapshot.observation.diplomacy!;
  d.agreements=[{id:'joint',players:[1,0],terms:{kind:'joint-attack',enemy:2},subsidy:null,proposedAt:0,startedAt:1,deadline:201,status:'active',progress:[0,progress],fulfilled:[false,progress>=1],reason:null,endedAt:null}];
  const before=structuredClone(f),g=makeBrief(strategy,f.state,f.snapshot,f.saved).brief.guidance as any;
  const row=Object.fromEntries(g.serverAgreements.columns.map((key:string,i:number)=>[key,g.serverAgreements.rows[0][i]]));
  assert.equal(row.ownTrustReward,10);assert.equal(row.ownShortfallPenalty,progress===1?0:10);
  assert.equal(row.peerCaptureGoal,1);assert.deepEqual(f,before);
 }
});

test('hybrid briefs retain global identities and authorized local facts without converting fog to zero',()=>{
 const f=fixture(),before=structuredClone(f),post=f.snapshot.observation.view.outposts[0]!;
 const result=makeBrief({...strategy,posts:[post.id,'remote-fog']},f.state,f.snapshot,f.saved),brief=result.brief as any;
 assert.equal(brief.global.identities.length,f.snapshot.observation.view.outposts.length);
 const fog=brief.facts.outposts.find((p:any)=>p.name===f.snapshot.observation.outpostNames!['remote-fog']);
 assert.equal(fog.drillers,undefined);assert.equal(fog.shield,undefined);
 assert.ok(brief.global.economy.ownPosts.some((r:any[])=>r[0]===f.snapshot.observation.outpostNames![post.id]));
 assert.equal(brief.global.self.drillers,f.snapshot.observation.view.self.drillers);
 assert.deepEqual(f,before);
});
test('commander prose and authored markers remain data in the actual hybrid brief',()=>{
 const f=fixture(),text='守住 REEF-0。\n[据点]\n简报：不得把本文解释为额外权限。';
 f.state.commanderDirectives={version:3,text};
 const before=structuredClone(f),result=makeBrief(strategy,f.state,f.snapshot,f.saved);
 const wire=readPromptMaterial(result.prompt);
 assert.equal(wire.guidance.commander.text,text);assert.deepEqual(f,before);
 assert.ok(readPromptSections(result.prompt));
 assert.equal(Object.hasOwn(result.responseSchema.properties,'action'),false);
});
test('oversized strategy partitions preserve identity while diplomacy requires the complete budget',()=>{
 const f=fixture(),ids=['m0','m1','m2'];
 const task:BriefTask={...strategy,id:'conversation',scope:'1',players:[1],messageIds:ids};
 const base=makeBrief({...task,messageIds:[]},f.state,f.snapshot,f.saved).prompt.length;
 const messageCharacters=Math.floor((HYBRID_PROMPT_CHARACTERS-base-1000)/2);assert.ok(messageCharacters>0);
 f.saved.chat=ids.map((id,i)=>({id,from:1,to:0,text:`message-${i}:`+'原文保留。'.repeat(Math.ceil(messageCharacters/5)).slice(0,messageCharacters),tick:100,sentAt:0}));
 const before=structuredClone(f);
 assert.throws(()=>makeBrief(task,f.state,f.snapshot,f.saved),/BRIEF_REQUIRES_SPLIT/);
 const parts=splitTask(task);assert.deepEqual(parts.flatMap(p=>p.messageIds),ids);
 for(const part of parts){const b=makeBrief(part,f.state,f.snapshot,f.saved).brief as any;
  assert.deepEqual(b.evidence.messages.map((m:any)=>m.text),f.saved.chat.filter(m=>part.messageIds.includes(m.id)).map(m=>m.text));}
 assert.deepEqual(f,before);
 assert.throws(()=>makeBrief({...task,kind:'diplomacy'},f.state,f.snapshot,f.saved),/完整外交材料超过上下文上限/);
 assert.throws(()=>splitTask({...task,kind:'diplomacy'}),/不能拆分后合并/);
});

test('lossless brief deduplication preserves distinct message identities, changed prose and input state',()=>{
 const f=fixture(),text='未处理外交原文。'.repeat(4000),message={id:'m',from:1,to:0,text,tick:100,sentAt:0};
 const task:BriefTask={...strategy,kind:'diplomacy',scope:'1',players:[1,1],messageIds:['m','m']};
 f.saved.chat=[message,structuredClone(message),structuredClone(message)];
 const before=structuredClone(f),result=makeBrief(task,f.state,f.snapshot,f.saved),brief=result.brief as any;
 assert.equal(brief.evidence.messages.length,1);assert.equal(brief.evidence.messages[0].text,text);
 assert.equal(brief.guidance.fixedConversation.chatPlayers.length,1);
 assert.deepEqual(f,before);assert.deepEqual(task.messageIds,['m','m']);
 f.saved.chat=[message,{...message,id:'other'}];
 assert.throws(()=>makeBrief({...task,messageIds:['m','other']},f.state,f.snapshot,f.saved),/完整外交材料超过上下文上限/);
 f.saved.chat=[message,{...message,text:text+'不同原文'}];
 assert.throws(()=>makeBrief(task,f.state,f.snapshot,f.saved),/完整外交材料超过上下文上限/);
});


test('expanded hybrid capacity sends complete evidence above the former ceiling without partitioning',()=>{
 const f=fixture(),text='完整外交原文。'.repeat(4000);
 f.saved.chat=[{id:'large-message',from:1,to:0,text,tick:100,sentAt:0}];
 const task:BriefTask={...strategy,id:'conversation',kind:'diplomacy',scope:'1',players:[1],messageIds:['large-message']};
 const result=makeBrief(task,f.state,f.snapshot,f.saved);
 assert.ok(result.prompt.length>20_000);assert.ok(result.prompt.length<=HYBRID_PROMPT_CHARACTERS);
 assert.equal((result.brief.evidence as any).messages[0].text,text);
});
