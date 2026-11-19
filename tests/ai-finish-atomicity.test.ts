import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
function fixture(path=':memory:'){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const o=observation({state:createFleetScenario(cfg),scheduled:[]},0,'room');
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2,notebook:[],reminders:[]};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(path);
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No game writes');}};
 const context=()=>({state,snapshot,gateway,id:'transaction',now:o.view.tick*600+o.secondsSinceLastTick,spoken:0});
 return {state,store,snapshot,gateway,context};
}
const storedNote=(id:string,text='Final fact')=>({id,kind:'fact',text,expiresAt:null});
const note=(id:string,text='Final fact')=>({id,kind:'fact' as const,text,expiresWorldDay:null});
function fullFixture(){
 const f=fixture(),now=f.context().now;
 f.snapshot.notebook=Array.from({length:32},(_,i)=>({id:`n${i}`,kind:'note',priority:'medium',text:'Existing body',updatedAt:i,expiresAt:null}));
 f.snapshot.reminders=Array.from({length:16},(_,i)=>({id:`r${i}`,atSeconds:(f.snapshot.observation.view.tick+2)*600,note:'Review'}));
 f.store.saveEvents(f.state,[...f.snapshot.notebook.map(details=>({kind:'notebook-set',details})),...f.snapshot.reminders.map(details=>({kind:'reminder-set',details}))]);
 return {...f,now,future:f.snapshot.observation.view.tick+3};
}
test('same key same accepted local content is idempotent; changed content conflicts without side effects',()=>{
 const f=fixture();try{f.store.save(f.state);const events=[{kind:'notebook-set',details:{...storedNote('one'),updatedAt:0}},{kind:'tool-result',details:{id:'commit',tool:'finish',result:{accepted:true,value:'first'}}}];
 f.store.saveLocalEvents(f.state,'commit',events);const before=f.store.historyPage('room',0).entries[0]!.id;
 f.store.saveLocalEvents(f.state,'commit',events);assert.equal(f.store.historyPage('room',0).entries[0]!.id,before);
 assert.throws(()=>f.store.saveLocalEvents(f.state,'commit',[{kind:'notebook-set',details:{...storedNote('injected'),updatedAt:0}},{kind:'tool-result',details:{id:'commit',tool:'finish',result:{accepted:true,value:'different'}}}]),/LOCAL_ID_CONFLICT/);
 assert.equal(f.store.notebook('room',0,0).length,1);
 }finally{f.store.close();}
});
test('source CAS prevents cross-connection/local changes at commit and rolls back candidate',()=>{
 const f=fixture();try{f.store.save(f.state);const basis=f.store.localWriteBasis('room',0);f.store.save(f.state,'notebook-set',{...storedNote('external'),updatedAt:0});
 assert.throws(()=>f.store.saveLocalEvents(f.state,'commit',[{kind:'notebook-set',details:{...storedNote('candidate'),updatedAt:0}},{kind:'tool-result',details:{id:'commit',tool:'finish',result:{saved:true}}}],basis),/LOCAL_BASIS_CHANGED/);
 assert.deepEqual(f.store.notebook('room',0,0).map(n=>n.id),['external']);assert.equal(f.store.queryResult('room',0,'commit'),undefined);
 }finally{f.store.close();}
});

test('one finish commits strategy, note and reminder together without a preview or review round',async()=>{
 const f=fixture();try{
  let calls=0;
  await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{assert.equal(++calls,1);return {tokens:0,reply:{tool:'finish',summary:'Done',arguments:{memory:{strategy:'守住矿并保留机动兵力'},notebook:{set:[note('one')]},reminders:{set:[{id:'next',atWorldDay:f.snapshot.observation.view.tick+2,note:'重新比较'}]}}}};}}).poll(0,true);
  assert.equal(f.state.status,'waiting');assert.equal(f.store.load('room',0)!.memory.strategy,'守住矿并保留机动兵力');
  assert.deepEqual(f.store.notebook('room',0,f.context().now).map(n=>n.id),['one']);assert.equal(f.store.reminders('room',0).length,1);
  assert.equal(f.store.memoryReviews('room',0).length,0);
 }finally{f.store.close();}
});

test('an invalid last domain prevents every runner domain write, including proposed removals',async()=>{
 const f=fullFixture();try{
  let calls=0;
  await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{
   if(++calls>1)throw Error('Synthetic fixture stops after rejection');
   return {tokens:0,reply:{tool:'finish',summary:'Invalid complete transaction',arguments:{memory:{strategy:'must-not-save'},notebook:{remove:['n0'],set:[note('new')]},reminders:{cancel:['r0'],set:[{id:'bad',atWorldDay:f.future+0.5,note:'Invalid fractional day'}]}}}};
  }}).poll(0,true);
  assert.equal(f.store.load('room',0)!.memory.strategy,'');
  assert.equal(f.store.notebook('room',0,f.now).length,32);assert.ok(f.store.notebook('room',0,f.now).some(n=>n.id==='n0'));assert.ok(!f.store.notebook('room',0,f.now).some(n=>n.id==='new'));
  assert.equal(f.store.reminders('room',0).length,16);assert.ok(f.store.reminders('room',0).some(r=>r.id==='r0'));
  assert.match(JSON.stringify(f.store.latest('room',0,'tool-rejected')),/FINISH_PREFLIGHT_INVALID/);
 }finally{f.store.close();}
});

test('full transactions validate multiple removals, additions and same-identity replacements together',async()=>{
 const f=fullFixture();try{
  const before=JSON.stringify({state:f.state,snapshot:f.snapshot});
  const result=await executeTool('finish',{notebook:{remove:['n0','n1'],set:[note('a'),note('b'),note('n2','Updated body')]},reminders:{cancel:['r0','r1'],set:[{id:'a',atWorldDay:f.future,note:'a'},{id:'b',atWorldDay:f.future,note:'b'},{id:'r2',atWorldDay:f.future,note:'Updated review'}]}},f.context()) as any;
  assert.equal(result.notebook.set.length,3);assert.equal(result.reminders.set.length,3);
  assert.equal(JSON.stringify({state:f.state,snapshot:f.snapshot}),before,'preflight is read-only');
  assert.equal(f.store.notebook('room',0,f.now).length,32);assert.equal(f.store.reminders('room',0).length,16);
 }finally{f.store.close();}
});

test('duplicate identities and malformed removals cannot create fictitious transaction capacity',async()=>{
 for(const args of [
  {notebook:{set:[note('same'),note('same')]}},
  {notebook:{remove:['']}},
  {reminders:{set:[{id:'same',atWorldDay:103,note:'one'},{id:'same',atWorldDay:103,note:'two'}]}},
  {reminders:{cancel:['r0','r0']}},
 ]){
  const f=fullFixture();try{await assert.rejects(executeTool('finish',args,f.context()),/FINISH_PREFLIGHT_INVALID/);assert.equal(f.store.notebook('room',0,f.now).length,32);assert.equal(f.store.reminders('room',0).length,16);}finally{f.store.close();}
 }
});

for(const mode of ['complete-and-add','cancel-and-add','reschedule','future-complete','unknown-complete','duplicate-complete'] as const)test(`reminder capacity transaction: ${mode}`,async()=>{
 const f=fullFixture();try{
  if(mode!=='future-complete')f.snapshot.reminders![0]!.atSeconds=f.now;
  const next={id:'new',atWorldDay:f.future,note:'Review'},reminders=mode==='complete-and-add'?{complete:['r0'],set:[next]}:mode==='cancel-and-add'?{cancel:['r0'],set:[next]}:mode==='reschedule'?{set:[{...next,id:'r0'}]}:mode==='unknown-complete'?{complete:['missing'],set:[next]}:mode==='duplicate-complete'?{complete:['r0','r0'],set:[next]}:{complete:['r0'],set:[next]};
  if(['future-complete','unknown-complete','duplicate-complete'].includes(mode))await assert.rejects(executeTool('finish',{reminders},f.context()),/FINISH_PREFLIGHT_INVALID/);
  else {const result=await executeTool('finish',{reminders},f.context()) as any;assert.equal(result.reminders.set.length,1);assert.deepEqual(result.reminders.complete,mode==='complete-and-add'?['r0']:[]);assert.deepEqual(result.reminders.cancel,mode==='cancel-and-add'?['r0']:[]);}
  assert.equal(f.store.reminders('room',0).length,16);
 }finally{f.store.close();}
});

for(const domain of ['due-reminder','same-id-note','commander'] as const)test(`another SQLite connection changes ${domain} while finish is in flight`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'finish-atomic-cas-')),path=join(dir,'local.sqlite'),f=fixture(path);let other:AiStore|undefined;
 try{
  f.store.saveEvents(f.state,[{kind:'notebook-set',details:{id:'original',kind:'note',text:'Original',updatedAt:0,expiresAt:null}}]);other=new AiStore(path);let calls=0;
  await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{
   assert.equal(++calls,1,'stale reply must not trigger an unrequested model replay');
   const current=other!.load('room',0)!;
   if(domain==='due-reminder')other!.save(current,'reminder-set',{id:'new-due',atSeconds:f.context().now,note:'Unseen due work'});
   if(domain==='same-id-note')other!.save(current,'notebook-set',{id:'original',kind:'note',text:'External same-ID update',updatedAt:f.context().now,expiresAt:null});
   if(domain==='commander'){current.commanderDirectives={version:1,text:'External confirmed directive'};other!.save(current,'state');}
   return {tokens:0,reply:{tool:'finish',arguments:{notebook:{set:[note('candidate')]}},summary:'Reply based on the prior local snapshot'}};
  }}).poll(0,true);
  assert.equal(f.store.latest('room',0,'completed'),null);assert.ok(!f.store.notebook('room',0,f.context().now).some(n=>n.id==='candidate'));
  assert.equal(f.state.status,'waiting');assert.equal(f.state.error,null);assert.equal(f.state.enabled,true);assert.equal(calls,1);assert.equal(f.store.latest('room',0,'bot-compute-failed'),null);assert.equal(f.store.latest<{reason:string}>('room',0,'decision-superseded')!.reason,'local-basis-changed');
  if(domain==='due-reminder')assert.ok(f.store.reminders('room',0).some(r=>r.id==='new-due'));
  if(domain==='same-id-note')assert.equal(f.store.notebook('room',0,f.context().now)[0]!.text,'External same-ID update');
  if(domain==='commander')assert.equal(f.store.load('room',0)!.commanderDirectives?.version,1);
 }finally{other?.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const phase of ['compute','commit'] as const)test(`superseded ${phase} waits for the next tick and resumes with current authority`,async t=>{
 const f=fixture();try{
  let calls=0,raced=false;
  const change=()=>{if(raced)return;raced=true;const current=f.store.load('room',0)!;current.memory.strategy='New authority';current.commanderDirectives={version:1,text:'Defend'};f.store.save(current,'state');};
  const save=f.store.saveLocalEvents.bind(f.store);
  t.mock.method(f.store,'saveLocalEvents',(...args:Parameters<AiStore['saveLocalEvents']>)=>{if(phase==='commit')change();return save(...args);});
  const runner=new SeatRunner(f.state,f.store,f.gateway,{step:async request=>{
   calls++;
   if(calls===1){if(phase==='compute')change();return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'Obsolete'}},summary:'Old basis'}};}
   assert.equal(calls,2);assert.ok(request.prompt.includes('New authority'));assert.equal(f.state.commanderDirectives?.text,'Defend');
   return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'Updated plan'}},summary:'Fresh basis'}};
  }});
  const tick=f.snapshot.observation.view.tick;
  await runner.poll(0,false,true,{oneRoundPerTick:true,eventCoalesceMs:1});
  assert.equal(f.state.status,'waiting');assert.equal(f.state.error,null);assert.equal(calls,1);
  assert.equal(f.store.load('room',0)!.memory.strategy,'New authority');
  assert.ok(runner.readyToAdvance(tick),'an obsolete round must not block the turn clock');
  await runner.poll(1000,false,true,{oneRoundPerTick:true,eventCoalesceMs:1});assert.equal(calls,1,'no same-tick replay');assert.ok(runner.readyToAdvance(tick));
  f.snapshot.observation.view.tick++;f.snapshot.observation.revision='next-tick';
  await runner.poll(2000,false,true,{oneRoundPerTick:true,eventCoalesceMs:1});
  assert.equal(calls,2);assert.equal(f.state.status,'waiting',JSON.stringify(f.store.latest('room',0,'error')));assert.equal(f.state.error,null);
  assert.equal(f.store.load('room',0)!.memory.strategy,'Updated plan');assert.equal(f.state.commanderDirectives?.version,1);
 }finally{f.store.close();}
});

test('finish commits privately without calling remote authority or observation hooks',async()=>{
 const f=fixture();try{
  const forbidden=async()=>{assert.fail('Finish must not read remote authority');};let calls=0;
  await new SeatRunner(f.state,f.store,{...f.gateway,authorityCheck:forbidden,commanderCheck:forbidden,manualCheck:forbidden},{step:async()=>{calls++;return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:'Private plan'},notebook:{set:[note('private')]}},summary:'Finish'}};}}).poll(0,true);
  assert.equal(calls,1);assert.equal(f.state.status,'waiting');assert.equal(f.state.error,null);assert.equal(f.store.load('room',0)!.memory.strategy,'Private plan');assert.equal(f.store.notebook('room',0,f.context().now)[0]!.id,'private');assert.ok(f.store.latest('room',0,'completed'));
 }finally{f.store.close();}
});
