import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDevReload,resumeDevReload} from '../packages/ai/src/application/agent-dev-reload.js';

const seat=(id:string,enabled:boolean)=>({id,serverUrl:'http://127.0.0.1:4311',roomId:'room',lobbySeat:Number(id),gamePlayer:Number(id),bound:true,status:enabled?'waiting':'paused',enabled,owned:enabled,error:null as string|null});
function fixture(){
 const seats=[seat('0',true),seat('1',true),seat('2',false),{...seat('3',false),bound:false}];
 const starts:string[]=[],pauses:string[]=[];
 return {seats,starts,pauses,runtime:{status:()=>seats,
  pause:async(id:string)=>{pauses.push(id);const s=seats.find(s=>s.id===id)!;s.enabled=false;s.owned=false;s.status='paused';},
  start:async(id:string)=>{starts.push(id);const s=seats.find(s=>s.id===id)!;s.enabled=true;s.owned=true;s.status='waiting';}}};
}
test('development handoff restores only previously running seats after draining and restarting',async()=>{
 const f=fixture(),before=await prepareDevReload(f.runtime);
 assert.deepEqual(before.map(s=>s.id),['0','1']);assert.deepEqual(f.pauses,['0','1']);
 assert.ok(f.seats.every(s=>!s.enabled));
 assert.deepEqual(await resumeDevReload(f.runtime,before),[{id:'0',status:'resumed'},{id:'1',status:'resumed'}]);
 assert.deepEqual(f.starts,['0','1']);assert.equal(f.seats[2]!.enabled,false);assert.equal(f.seats[3]!.enabled,false);
});
test('a changed room, player or binding never inherits another seat autorun intent',async()=>{
 for(const change of [{roomId:'another-room'},{gamePlayer:9},{lobbySeat:9},{serverUrl:'http://127.0.0.1:9999'},{status:'ended'}]){
  const f=fixture(),before=await prepareDevReload(f.runtime);Object.assign(f.seats[0]!,change);
  const result=await resumeDevReload(f.runtime,before,0);
  assert.equal(result.find(s=>s.id==='0')!.status,'skipped');assert.deepEqual(f.starts,['1']);
 }
 const f=fixture(),before=await prepareDevReload(f.runtime);f.seats[0]!.bound=false;
 const result=await resumeDevReload(f.runtime,before,0);assert.equal(result.find(s=>s.id==='0')!.status,'failed');assert.deepEqual(f.starts,['1']);
});
test('cold startup has no resume intent and checkpoint coordination prevents handoff',async()=>{
 const f=fixture();f.seats.forEach(s=>{s.enabled=false;s.owned=false;s.status='paused';});
 assert.deepEqual(await prepareDevReload(f.runtime),[]);assert.deepEqual(await resumeDevReload(f.runtime,[]),[]);assert.deepEqual(f.starts,[]);
 const blocked={...f.runtime,status:()=>[{...seat('0',true),checkpoint:{blocked:true}}]};
 await assert.rejects(prepareDevReload(blocked),/checkpoint/);assert.deepEqual(f.pauses,[]);
});
test('failed drain restores old run intent; resume failure is reported without claiming success',async()=>{
 const f=fixture();
 await assert.rejects(prepareDevReload({...f.runtime,pause:async id=>{await f.runtime.pause(id);if(id==='1')throw Error('drain failure');}}),/drain/);
 assert.ok(f.seats.slice(0,2).every(s=>s.enabled));
 const before=await prepareDevReload(f.runtime);
 const result=await resumeDevReload({...f.runtime,start:async id=>{if(id==='0')throw Error('acquire failure');await f.runtime.start(id);}},before);
 assert.equal(result.find(s=>s.id==='0')!.status,'failed');assert.equal(result.find(s=>s.id==='1')!.status,'resumed');
});
