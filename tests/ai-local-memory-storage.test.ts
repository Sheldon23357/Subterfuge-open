import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
const note=(id:string,text=id)=>({id,kind:'note' as const,text,updatedAt:60000,expiresAt:null});
function fixture(path=':memory:'){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(path);
 state.memory.strategy='old';store.saveEvents(state,[{kind:'notebook-set',details:note('old')},{kind:'reminder-set',details:{id:'old',atSeconds:70000,note:'old'}}]);
 let requests=0;
 return {snapshot,state,store,gateway:{snapshot:async()=>structuredClone(snapshot),request:async()=>{requests++;throw Error('Unexpected real command');}},requests:()=>requests};
}
const reply=(tool:string,args:unknown)=>({tokens:1,reply:{tool,arguments:JSON.stringify(args),summary:'test'}});
for(const tool of ['finish','notebook','reminders'])test(`${tool}: every domain/receipt write failure rolls back and does not expose partial updates`,async()=>{
 const kinds=tool==='reminders'?['reminder-cancelled','reminder-set','tool-result']:tool==='notebook'?['memory-archived','memory-maintained','notebook-removed','notebook-set','tool-result']:['memory-archived','memory-maintained','notebook-removed','notebook-set','reminder-cancelled','reminder-set','tool-result','observation-baseline','wake-state','chat-handled','completed'];
 for(const failKind of kinds){
  const f=fixture();let calls=0,hit=false;
  const original=f.store.saveEvents.bind(f.store);
  f.store.saveEvents=(state,events,localId,expectedBasis)=>{
   if(localId&&!hit){
    const index=events.findIndex(e=>e.kind===failKind);assert.notEqual(index,-1,failKind);
    // A SQLite abort at each statement, including after all domain mutations.
    const db=(f.store as unknown as {db:DatabaseSync}).db;
    db.exec(`CREATE TEMP TRIGGER fail_write BEFORE INSERT ON journal WHEN NEW.kind='${failKind}' BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    try{return original(state,events,localId,expectedBasis);}finally{hit=true;db.exec('DROP TRIGGER fail_write');}
   }
   return original(state,events,localId,expectedBasis);
  };
  const notes={remove:['old'],set:[{id:'old',kind:'note',text:'new'}]},reminders={cancel:['old'],set:[{id:'new',atSeconds:71400,note:'new'}]};
  const args:unknown=tool==='finish'?{memory:{strategy:'new'},notebook:notes,reminders}:tool==='notebook'?{memory:{strategy:'new'},...notes}:reminders;

  try{
   await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>reply(++calls===1?tool:'finish',calls===1?args:{})}).poll(0,true);
   assert.ok(hit,failKind);assert.equal(f.state.memory.strategy,'old',failKind);assert.deepEqual(f.store.notebook('room',0,60000).map(n=>n.id),['old'],failKind);assert.deepEqual(f.store.reminders('room',0).map(r=>r.id),['old'],failKind);assert.equal(f.store.notebook('room',0,60000)[0]!.text,'old');assert.equal(f.requests(),0);assert.equal(calls,2);
   assert.equal(f.store.latest<any>('room',0,'tool-rejected').id,'ai-0-1-0');
  }finally{f.store.close();}
 }
});
test('finish post-commit interruption restores durable state and restart never requests another model or command',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-local-'));const path=join(dir,'test.sqlite');const f=fixture(path);let calls=0;
 const original=f.store.saveLocalEvents.bind(f.store);
 f.store.saveLocalEvents=(...args)=>{original(...args);throw Error('process boundary after COMMIT');};
 try{
  await new SeatRunner(f.state,f.store,f.gateway,{step:async()=>{calls++;return reply('finish',{memory:{strategy:'committed'}});}}).poll(0,true);
  assert.equal(f.state.status,'waiting');assert.equal(f.state.memory.strategy,'committed');assert.equal(calls,1);assert.equal(f.store.latest('room',0,'tool-rejected'),null);f.store.close();
  const store=new AiStore(path);try{
   const restored=store.load('room',0)!;const runner=new SeatRunner(restored,store,f.gateway,{step:async()=>{throw Error('Must not resume finished round');}});
   await runner.poll(1);assert.equal(restored.status,'waiting');assert.equal(store.latest<any>('room',0,'wake-state').inFlight,null);assert.equal(f.requests(),0);
  }finally{store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('local commit IDs are scoped and idempotent; returned projections cannot mutate storage',()=>{
 const f=fixture();try{
 const events=[{kind:'notebook-set',details:note('stable')},{kind:'tool-result',details:{id:'local',tool:'notebook',result:{ok:true}}}];
 f.store.saveLocalEvents(f.state,'local',events);const before=f.store.historyPage('room',0).entries[0]!.id;
 f.store.saveLocalEvents({...f.state,memory:{...f.state.memory,strategy:'duplicate'}},'local',events);
 assert.equal(f.store.historyPage('room',0).entries[0]!.id,before);assert.equal(f.store.load('room',0)!.memory.strategy,'old');
 const other={...f.state,lobbySeat:1};f.store.saveLocalEvents(other,'local',events);assert.equal(f.store.notebook('room',1,60000).length,1);
 f.store.notebook('room',0,60000)[0]!.text='mutated';assert.equal(f.store.latestNotebookEntry('room',0,'old')!.text,'old');
 assert.throws(()=>f.store.saveLocalEvents(f.state,'real',[{kind:'tool-result',details:{id:'real',tool:'order'}}]),/Invalid local/);
 }finally{f.store.close();}
});
test('unrelated writes preserve incremental memory reads while external note appends remain visible',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-incremental-')),path=join(dir,'test.sqlite'),f=fixture(path),other=new AiStore(path);
 try{
  f.store.notebook('room',0,60000);
  const db=(f.store as unknown as {db:DatabaseSync}).db,prepare=db.prepare.bind(db),cursors:unknown[]=[];
  t.mock.method(db,'prepare',(sql:string)=>{
   const statement=prepare(sql);
   if(sql.includes('FROM journal INDEXED BY journal_seat_kind_cursor')){
    const all=statement.all.bind(statement);
    t.mock.method(statement,'all',(...args:Parameters<typeof all>)=>{cursors.push(args[2]);return all(...args);});
   }
   return statement;
  });
  other.recordTiming('room',0,'protocol-request-timing',{durationMs:1});other.flushTimings();
  assert.equal(f.store.notebook('room',0,60000).length,1);
  other.save(f.state,'notebook-set',note('external'));
  assert.equal(f.store.notebook('room',0,60000).length,2);
  assert.ok(cursors.every(cursor=>Number(cursor)>0),'unrelated writes must not replay memory from origin');
 }finally{f.store.close();other.close();rmSync(dir,{recursive:true,force:true});}
});

test('cross-connection rewind invalidates projections even after IDs are reused, including closed latest and cursors',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ai-projection-')),path=join(dir,'test.sqlite'),f=fixture(path),other=new AiStore(path);
 try{
 f.store.saveEvents(f.state,[{kind:'started',details:{tick:100}},{kind:'notebook-set',details:note('kept')},{kind:'memory-reviewed',details:{id:'kept',fingerprint:'a',reason:'check',seconds:60000}}]);
 f.store.saveEvents(f.state,[{kind:'started',details:{tick:101}},{kind:'notebook-removed',details:{id:'kept'}},{kind:'reminder-cancelled',details:{id:'old'}},{kind:'memory-reviewed',details:{id:'kept',fingerprint:'b',reason:'check',seconds:60600}}]);
 assert.equal(other.notebook('room',0,60000).length,1);assert.equal(other.memoryReviews('room',0)[0]!.fingerprint,'b');assert.equal(other.reminders('room',0).length,0);
 f.store.trimHistoryToTick('room',100);
 for(let i=0;i<10;i++)f.store.save(f.state,'notebook-set',note(`new-${i}`));
 assert.equal(other.notebook('room',0,60000).length,12);assert.equal(other.memoryReviews('room',0)[0]!.fingerprint,'a');assert.equal(other.reminders('room',0).length,1);
 assert.equal(other.queryNotebook('room',0,60000,{limit:1}).entries.length,1);assert.ok(other.queryNotebook('room',0,60000,{limit:1}).nextCursor);
 f.store.save(f.state,'notebook-removed',{id:'kept'});assert.equal(other.latestNotebookEntry('room',0,'kept')!.text,'kept');
 }finally{f.store.close();other.close();rmSync(dir,{recursive:true,force:true});}
});
for(const tool of ['notebook','reminders','strategy'])test(`${tool}: a fault after durable commit continues with success feedback`,async()=>{
 const f=fixture();let calls=0,failed=false;const original=f.store.saveLocalEvents.bind(f.store);
 f.store.saveLocalEvents=(...args)=>{const state=original(...args);if(!failed){failed=true;throw Error('after durable commit');}return state;};
 const args=tool==='notebook'?{set:[{id:'new',kind:'note',text:'accepted'}]}:tool==='reminders'?{set:[{id:'new',atSeconds:71400,note:'accepted'}]}:{memory:{strategy:'accepted'}};
 try{
 await new SeatRunner(f.state,f.store,f.gateway,{step:async r=>{calls++;if(calls===2)assert.ok(r.prompt.includes('accepted'));return reply(calls===1?(tool==='strategy'?'notebook':tool):'finish',calls===1?args:{});}}).poll(0,true);
 assert.equal(calls,2);assert.equal(f.state.status,'waiting');assert.equal(f.store.latest('room',0,'tool-rejected'),null);assert.equal(f.requests(),0);
 }finally{f.store.close();}
});
test('seat and COMMIT failures retain old durable state and warm projections',()=>{
 for(const point of ['seat','commit']){
 const f=fixture();const db=(f.store as unknown as {db:DatabaseSync}).db;const exec=db.exec.bind(db);
 try{
 f.store.notebook('room',0,60000);
 if(point==='seat')exec("CREATE TEMP TRIGGER fail_seat BEFORE INSERT ON seats BEGIN SELECT RAISE(ABORT,'seat failure'); END;");
 else db.exec=(sql:string)=>{if(sql==='COMMIT')throw Error('commit failure');return exec(sql);};
 assert.throws(()=>f.store.saveLocalEvents({...f.state,memory:{...f.state.memory,strategy:'new'}},'local',[{kind:'notebook-set',details:note('new')},{kind:'tool-result',details:{id:'local',tool:'notebook',result:{ok:true}}}]));
 assert.equal(f.store.load('room',0)!.memory.strategy,'old');assert.deepEqual(f.store.notebook('room',0,60000).map(n=>n.id),['old']);assert.equal(f.store.queryResult('room',0,'local'),undefined);
 }finally{db.exec=exec;f.store.close();}
 }
});
