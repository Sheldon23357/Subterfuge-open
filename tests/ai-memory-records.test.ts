
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AiStore,initialState,executeTool,type AiSnapshot,type NotebookEntry,type MemoryRecord} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {notebookContext} from '../packages/ai/src/controller/storage/memory-records.js';
import {normalizeStructuredArguments} from '../packages/ai/src/controller/contracts/structured-arguments.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3,roster:[0,1,2].map(p=>({gamePlayer:p,chatPlayer:p})),task:{category:'military',scope:'local',weight:'medium',reasons:[],entities:['front'],deferred:[]}};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No real game writes');}};
 const context={snapshot,state,gateway,id:'test',spoken:0,now:60000,readNotebookQuery:(q:any)=>store.queryNotebook('room',0,60000,q),hasMemoryEvidence:(r:string)=>store.hasMemoryEvidence('room',0,r)};
 return {snapshot,state,store,gateway,context};
}
function plan(id:string,overrides:Partial<MemoryRecord>={}):NotebookEntry{return {id,kind:'plan',text:'完整计划事实与条件。'.repeat(80),updatedAt:60000,expiresAt:null,record:{type:'plan',status:'active',summary:`${id}当前目标和转向条件`,players:[2],entities:['remote'],links:[],evidence:['chat:evidence'],reviewAt:90000,...overrides}};}

test('local context preserves global constraints, unknown prose, relevant chains and alternative indexes',()=>{
 const f=fixture();try{
 const binding={...plan('third-party',{type:'agreement'}),kind:'agreement' as const,text:'即使与别人交战也不得进入front；否则违约'};
 f.snapshot.notebook=[binding,{id:'old',kind:'plan',text:'未整理的重要计划',updatedAt:0,expiresAt:null},plan('front-plan',{entities:['front'],links:['support']}),plan('support',{links:['reserve']}),plan('reserve'),plan('alternative')];
 const result=notebookContext(f.snapshot);
 assert.deepEqual(result.notebook.map(n=>n.id),['third-party','old','front-plan','support','reserve']);
 assert.ok(JSON.stringify(result).includes('alternative当前目标和转向条件'));
 assert.ok(!JSON.stringify(result).includes('detailOmitted":false'));
 }finally{f.store.close();}
});
test('global, explicit expansion and maintenance include every active body',()=>{
 const f=fixture();try{f.snapshot.notebook=[plan('a'),plan('b')];
 for(const task of [{category:'strategy',weight:'heavy'},{category:'military',scope:'local',fullContext:true,weight:'heavy'},{category:'diplomacy',notebookReview:true,weight:'low'}]){
 f.snapshot.task={reasons:[],entities:[],deferred:[],...task} as any;
 assert.deepEqual(notebookContext(f.snapshot).notebook,f.snapshot.notebook);
 }}finally{f.store.close();}
});
test('stale and due bodies stay exact while unresolved dependencies retain targeted expansion',()=>{
 const f=fixture();try{
 f.snapshot.notebook=[{...plan('stale'),updatedAt:0},plan('due',{reviewAt:60000}),plan('independent')];
 assert.deepEqual(notebookContext(f.snapshot).notebook.map(n=>n.id),['stale','due']);
 f.snapshot.notebook.push(plan('broken',{links:['archived-precondition']}));
 const unrelated=notebookContext(f.snapshot);
 assert.deepEqual(unrelated.notebook.map(n=>n.id),['stale','due']);
 assert.deepEqual(unrelated.notebookIndex!.find(n=>n.id==='broken')!.links,['archived-precondition']);
 assert.match(unrelated.notebookSelection!.read,/notebook.*ids|observe.*full/);
 f.snapshot.task!.entities.push('broken');
 const selected=notebookContext(f.snapshot);
 assert.deepEqual(selected.notebook,f.snapshot.notebook.filter(n=>['stale','due','broken'].includes(n.id)));
 assert.deepEqual(selected.unresolvedRecordDependencies!.map(g=>({record:g.record,id:g.id,status:g.status})),[{record:'broken',id:'archived-precondition',status:'unknown'}]);
 assert.match(selected.unresolvedRecordDependencies![0]!.read,/notebook.*archive:true/);
 assert.match(selected.unresolvedRecordDependencies![0]!.instruction,/do not assume completed or absent/);
 assert.ok(selected.notebookIndex!.some(n=>n.id==='independent'));
 }finally{f.store.close();}
});
test('diplomacy includes every binding agreement and related player records',()=>{
 const f=fixture();try{
 f.snapshot.task={category:'diplomacy',weight:'light',reasons:[],entities:[],deferred:[]};
 f.snapshot.chat=[{id:'message',from:1,to:0,text:'共同进攻',tick:100,sentAt:0}];
 f.snapshot.notebook=[plan('partner',{players:[1]}),plan('alternative'),{...plan('third-party',{type:'agreement'}),kind:'agreement'}];
 assert.deepEqual(notebookContext(f.snapshot).notebook.map(n=>n.id),['partner','third-party']);
 }finally{f.store.close();}
});
test('closed and expired records leave active context but all versions and removal events remain queryable and private',()=>{
 const f=fixture();try{
 const n=plan('campaign');f.store.save(f.state,'notebook-set',n);
 f.store.save(f.state,'notebook-set',{...n,record:{...n.record,status:'completed'}});
 f.store.save(f.state,'notebook-removed',{id:n.id});
 f.store.save({...f.state,lobbySeat:1},'notebook-set',plan('secret'));
 assert.equal(f.store.notebook('room',0,60000).length,0);
 const first=f.store.queryNotebook('room',0,60000,{archive:true,ids:['campaign'],limit:1});
 assert.equal(first.entries.length,1);assert.ok(first.nextCursor);
 const second=f.store.queryNotebook('room',0,60000,{archive:true,ids:['campaign'],before:first.nextCursor!,limit:1});
 assert.equal((second.entries[0] as any).entry.record.status,'completed');
 const third=f.store.queryNotebook('room',0,60000,{archive:true,ids:['campaign'],before:second.nextCursor!,limit:1});
 assert.equal((third.entries[0] as any).entry.record.status,'active');assert.equal(third.nextCursor,null);
 assert.equal(f.store.queryNotebook('room',0,60000,{archive:true,text:'secret'}).entries.length,0);
 }finally{f.store.close();}
});
test('relation judgments are prose and retired scores or evidence structures cannot become executable authority',async()=>{
 const f=fixture();try{
  const input={id:'relation:1',kind:'note',text:'对方自称愿意合作，可信度未知；未承诺出兵。',priority:'high',expiresWorldDay:null};
  const result=await executeTool('notebook',{set:[input]},f.context) as any;
  assert.equal(result.set[0].text,input.text);assert.equal(result.set[0].record,undefined);
  for(const extra of [{record:{scores:{trust:null}}},{basis:'reported'},{basisTick:100}])await assert.rejects(executeTool('notebook',{set:[{...input,...extra}]},f.context),/INVALID_TOOL_FIELDS/);
  assert.equal(f.store.notebook('room',0,60000).length,0,'validation is not a commit');
 }finally{f.store.close();}
});

test('one finish saves full prose atomically and an invalid reminder cannot partially save strategy',async()=>{
 const f=fixture();let phase=0;try{
  const input={id:'new',kind:'plan',priority:'high',text:'先保持现有防线，尚未下令救援。',expiresWorldDay:null};
  const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async()=>({tokens:1,reply:{tool:'finish',summary:'test',arguments:{notebook:{set:[input]},...(phase++===0?{memory:{strategy:'must not save'},reminders:{set:[{id:'bad',atWorldDay:101,note:'bad',entities:['hidden-entity']}]}}:{})}}})});
  await runner.poll(0,true);assert.equal(phase,2);assert.equal(f.state.memory.strategy,'');
  assert.equal(f.store.notebook('room',0,60000)[0]!.text,input.text);assert.equal(f.store.notebook('room',0,60000)[0]!.record,undefined);
  assert.ok(f.store.latest<any>('room',0,'bot-compute-started').memoryContext);
 }finally{f.store.close();}
});

test('notebook reads only current active bodies and rejects the retired historical query interface',async()=>{
 const f=fixture();try{
  f.store.save(f.state,'notebook-set',{id:'detail',kind:'plan',priority:'medium',text:'完整的当前计划正文',updatedAt:60000,expiresAt:null});
  f.snapshot.notebook=f.store.notebook('room',0,60000);
  const result=await executeTool('notebook',{},f.context) as any;
  assert.equal(result.active[0].text,'完整的当前计划正文');
  await assert.rejects(executeTool('notebook',{query:{ids:['detail']}},f.context),/INVALID_TOOL_FIELDS/);
  await assert.rejects(executeTool('notebook',{query:{},remove:['detail']},f.context),/INVALID_TOOL_FIELDS/);
 }finally{f.store.close();}
});

test('evidence lookup cannot borrow another player private history',()=>{
 const f=fixture();try{
 f.store.save({...f.state,lobbySeat:1},'messages-read',{messages:[{id:'secret'}]});
 f.store.save(f.state,'messages-read',{messages:[{id:'own'}]});
 assert.equal(f.store.hasMemoryEvidence('room',0,'chat:secret'),false);
 assert.equal(f.store.hasMemoryEvidence('room',0,'chat:own'),true);
 }finally{f.store.close();}
});

test('own successful say receipts are evidence, while intents, failures, other rooms, seats and nested IDs are not',()=>{
 const f=fixture();try{
  const receipt=(id:string)=>({id,tool:'say',result:{roomId:'room',message:{id,from:7,to:1,text:'本人提议',tick:100,sentAt:0}}});
  f.store.save(f.state,'tool-result',receipt('sent'));
  assert.equal(f.store.hasMemoryEvidence('room',0,'chat:sent'),true);
  f.store.save(f.state,'tool-intent',receipt('pending'));
  f.store.save(f.state,'tool-rejected',receipt('rejected'));
  f.store.save(f.state,'tool-result',{...receipt('failed'),result:{...receipt('failed').result,error:'not sent'}});
  f.store.save({...f.state,lobbySeat:1},'tool-result',receipt('foreign-seat'));
  f.store.save({...f.state,roomId:'other'},'tool-result',{...receipt('foreign-room'),result:{...receipt('foreign-room').result,roomId:'other'}});
  f.store.save(f.state,'tool-result',{...receipt('wrong-room'),result:{...receipt('wrong-room').result,roomId:'other'}});
  f.store.save(f.state,'tool-result',{id:'nested',tool:'say',result:{roomId:'room',message:{id:'real',from:7,to:1,text:'id:nested'},extra:{id:'nested'}}});
  f.store.save(f.state,'tool-result',{...receipt('wrong-tool'),tool:'order'});
  for(const id of ['pending','rejected','failed','foreign-seat','foreign-room','wrong-room','nested','wrong-tool','invented'])
   assert.equal(f.store.hasMemoryEvidence('room',0,'chat:'+id),false,id);
 }finally{f.store.close();}
});

test('runner can save an own sent-message reference in the next finish without rereading chat',async()=>{
 const f=fixture();let sentId='',calls=0;try{
  f.snapshot.chatPlayer=7;f.snapshot.chatCount=9;f.state.enabled=true;
  const gateway={...f.gateway,request:async(path:string,data:any)=>{
   assert.equal(path,'/tool/chat');sentId=data.id;
   return {roomId:'room',message:{id:sentId,from:7,to:data.to,text:data.text,tick:100,sentAt:0}};
  }};
  const runner=new SeatRunner(f.state,f.store,gateway,{step:async()=>{
   calls++;
   assert.ok(calls<=2,'no rejection, chatHistory or finish retry expected');
   const note={id:'sent-offer',kind:'agreement',priority:'high',text:'本人已发送停战提议，尚未接受。消息 chat:'+sentId,expiresWorldDay:null};
   return {tokens:1,reply:calls===1?{tool:'say',summary:'提出停战',arguments:JSON.stringify({to:1,text:'提议停战，等待你确认。'})}
    :{tool:'finish',summary:'保存尚未接受的提议',arguments:{notebook:{set:[{...note,kind:'agreement'}]}}}};
  }});
  await runner.poll(0,true);
  assert.equal(calls,2);assert.equal(f.state.status,'waiting');
  assert.ok(f.store.notebook('room',0,60000)[0]!.text.includes('尚未接受'));assert.ok(f.store.notebook('room',0,60000)[0]!.text.includes('chat:'+sentId));
  assert.equal(f.store.notebook('room',0,60000)[0]?.record,undefined);
  assert.equal(f.store.latest('room',0,'tool-rejected'),null);
 }finally{f.store.close();}
});
test('structured schema normalization preserves nullable scores and review times',()=>{
 const raw={notebook:{set:[{record:{reviewAt:null,scores:{trust:null,hostility:null,threat:null,cooperation:null,confidence:0}},expiresAt:null}]},memory:null};
 const result=normalizeStructuredArguments(raw) as any;
 assert.equal(result.memory,undefined);assert.equal(result.notebook.set[0].record.reviewAt,null);assert.equal(result.notebook.set[0].record.scores.trust,null);
});

test('relation prose shares the global note cap and unchanged updates do not refresh body age',async()=>{
 const f=fixture();try{
  f.snapshot.notebook=Array.from({length:32},(_,i)=>({id:'old-'+i,kind:'plan',priority:'medium',text:'existing plan',updatedAt:59000,expiresAt:null}));
  const input={id:'relation:1',kind:'note',priority:'high',text:'合作意愿未知，尚无承诺。',expiresWorldDay:null};
  const first=await executeTool('notebook',{set:[input]},f.context) as any;
  assert.equal(first.active.length,32);assert.ok(first.active.some((n:any)=>n.id==='relation:1'));assert.equal(first.remove.length,1);
  f.snapshot.notebook=first.active;
  const repeated=await executeTool('notebook',{set:[input]},{...f.context,now:60600}) as any;
  assert.equal(repeated.set.length,0);assert.equal(repeated.active.find((n:any)=>n.id==='relation:1').updatedAt,60000);
 }finally{f.store.close();}
});

test('active query paging is complete without leaking closed versions',()=>{
 const f=fixture();try{
 for(let i=0;i<4;i++)f.store.save(f.state,'notebook-set',plan('page-'+i));
 f.store.save(f.state,'notebook-set',plan('page-3',{status:'completed'}));
 const first=f.store.queryNotebook('room',0,60000,{limit:2});assert.equal(first.entries.length,2);assert.ok(first.nextCursor);
 const next=f.store.queryNotebook('room',0,60000,{before:first.nextCursor!,limit:2});assert.equal(next.entries.length,1);assert.equal(next.nextCursor,null);
 assert.deepEqual([...first.entries,...next.entries].map((n:any)=>n.id),['page-2','page-1','page-0']);
 }finally{f.store.close();}
});
