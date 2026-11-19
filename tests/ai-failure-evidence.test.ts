
import {SeatRunner} from './helpers/scripted-controller.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AiStore,initialState,executeTool,type AiSnapshot} from '../packages/ai/src/index.js';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {GameRequestError} from '../packages/ai/src/controller/transport/gateway.js';

function fixture(){
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 const snapshot:AiSnapshot={observation:observation({state:createFleetScenario(cfg),scheduled:[]},0,'room'),chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:3};
 const state=initialState('room',0,{model:'',personality:'schemer'}),store=new AiStore(':memory:');
 const gateway={snapshot:async()=>structuredClone(snapshot),request:async()=>{throw Error('No real game writes');}};
 const context={snapshot,state,gateway,id:'test',spoken:0,now:60000,readMemoryEvidence:(r:string)=>store.memoryEvidence('room',0,r),hasMemoryEvidence:(r:string)=>store.hasMemoryEvidence('room',0,r)};
 const save=(kind:string,id:string,extra:object={})=>store.save(state,kind,{id,tool:'order',...extra});
 return {snapshot,state,store,gateway,context,save};
}
const note=(evidence:string[],status='blocked')=>({id:'operation',kind:'plan',priority:'medium',text:`原请求结果：${status}，原请求未被接受；先复核再决定下一步。依据 ${evidence.join('、')}`,expiresWorldDay:null});

test('exact failed and batch child receipts are private typed memory evidence, intents and aliases are not',()=>{
 const f=fixture();try{
  f.save('tool-rejected','denied',{result:{error:'stale-observation'}});
  f.save('batch-item-result','batch-item-0',{status:'accepted'});
  f.save('batch-item-result','batch-item-1',{status:'rejected',error:'invalid'});
  f.save('batch-item-unknown','batch-item-2');
  f.save('tool-intent','intent');
  f.save('query-result','q:query:choice',{tool:'forecast',result:{conditional:true}});
  for(const [id,outcome] of [['denied','rejected'],['batch-item-0','accepted'],['batch-item-1','rejected'],['batch-item-2','unconfirmed'],['q:query:choice','read']]){
   assert.equal(f.store.memoryEvidence('room',0,'tool:'+id)?.outcome,outcome);
   assert.equal(f.store.hasMemoryEvidence('room',0,'tool:'+id),true);
   assert.equal(f.store.memoryEvidence('room',1,'tool:'+id),undefined);
   assert.equal(f.store.memoryEvidence('other',0,'tool:'+id),undefined);
  }
  for(const ref of ['tool:intent','tool:invented','q:query:choice','tool:q','tool:batch','tool:'])assert.equal(f.store.hasMemoryEvidence('room',0,ref),false,ref);
 }finally{f.store.close();}
});

test('finish can atomically record failed facts and exposes outcomes without generating success or commands',async()=>{
 const f=fixture();try{
  f.save('tool-rejected','denied',{result:{error:'cooldown'}});
  const result=await executeTool('finish',{notebook:{set:[note(['tool:denied'])]}},f.context) as any;
  assert.match(result.notebook.set[0].text,/原请求未被接受/);
  assert.equal(f.store.memoryEvidence('room',0,'tool:denied')?.outcome,'rejected');
  assert.equal(result.notebook.evidenceOutcomes,undefined,'prose does not generate execution proof');
  assert.equal(f.store.notebook('room',0,60000).length,0,'validation itself never persists a partial finish');
  assert.equal(f.snapshot.campaigns,undefined,'memory validation never commits campaign orders');
  await assert.rejects(executeTool('finish',{notebook:{set:[note(['tool:denied']),{...note(['tool:fake']),id:'bad',record:{evidence:['tool:fake']}}]}},f.context),/INVALID_TOOL_FIELDS/);
  assert.equal(f.store.notebook('room',0,60000).length,0);
 }finally{f.store.close();}
});

test('partial and unknown receipts stay distinct; lifecycle labels are not execution proof',async()=>{
 const f=fixture();try{
  f.save('batch-item-unknown','uncertain');
  f.save('tool-result','mixed',{tool:'batch',result:{complete:false,results:[{status:'accepted'},{status:'rejected'}]}});
  f.save('tool-rejected','transport',{result:{error:'network'},diagnostic:{request:{outcome:'unknown'}}});
  assert.equal(f.store.memoryEvidence('room',0,'tool:transport')?.outcome,'unconfirmed');
  assert.equal(f.store.memoryEvidence('room',0,'tool:uncertain')?.outcome,'unconfirmed');
  assert.equal(f.store.memoryEvidence('room',0,'tool:mixed')?.outcome,'partial');
  f.save('tool-rejected','denied',{result:{error:'no'}});
  // A completed investigation of infeasibility is legitimate. Do not infer
  // execution from the model-authored lifecycle or use a prose keyword filter.
  const completed={...note(['tool:denied'],'completed'),text:'已完成不可行性验证，原命令被拒绝，未执行。'};
  const result=await executeTool('notebook',{set:[completed]},f.context) as any;
  assert.equal(result.evidenceOutcomes,undefined);assert.equal(f.store.memoryEvidence('room',0,'tool:denied')?.outcome,'rejected');
  assert.equal(f.snapshot.campaigns,undefined);
 }finally{f.store.close();}
});

test('mixed batch children preserve their own outcomes and failed say is never a chat message',async()=>{
 const f=fixture();try{
  f.save('batch-item-result','b-item-0',{status:'accepted'});
  f.save('batch-item-result','b-item-1',{status:'rejected'});
  const result=await executeTool('notebook',{set:[note(['tool:b-item-0','tool:b-item-1'])]},f.context) as any;
  assert.match(result.set[0].text,/tool:b-item-0.*tool:b-item-1/);assert.deepEqual(['b-item-0','b-item-1'].map(id=>f.store.memoryEvidence('room',0,'tool:'+id)?.outcome),['accepted','rejected']);
  f.save('tool-rejected','say-failure',{tool:'say',result:{error:'cooldown',roomId:'room',message:{id:'not-sent'}}});
  assert.equal(f.store.hasMemoryEvidence('room',0,'chat:not-sent'),false);
  assert.equal(f.store.memoryEvidence('room',0,'tool:say-failure')?.outcome,'rejected');
  await assert.rejects(executeTool('notebook',{set:[{...note(['chat:not-sent']),record:{evidence:['chat:not-sent']}}]},f.context),/INVALID_TOOL_FIELDS/);
 }finally{f.store.close();}
});

test('runner records a rejected say in the next finish without a second protocol rejection',async()=>{
 const f=fixture();let calls=0,writes=0,failedId='';try{
  f.state.enabled=true;
  const gateway={...f.gateway,request:async()=>{writes++;throw new GameRequestError(400,undefined,'cooldown');}};
  const runner=new SeatRunner(f.state,f.store,gateway,{step:async()=>{
   calls++;assert.ok(calls<=2);
   if(calls===1)return {tokens:1,reply:{tool:'say',summary:'试探停战',arguments:JSON.stringify({to:1,text:'是否停战？'})}};
   failedId=f.store.latest<{id:string}>('room',0,'tool-rejected')!.id;
   return {tokens:1,reply:{tool:'finish',summary:'未发送，无新协议',arguments:{notebook:{set:[note(['tool:'+failedId])]}}}};
  }});
  await runner.poll(0,true);
  assert.equal(calls,2);assert.equal(writes,1);assert.equal(f.state.status,'waiting');
  assert.ok(f.store.notebook('room',0,60000)[0]!.text.includes('tool:'+failedId));
  assert.equal(f.store.latest<{id:string}>('room',0,'tool-rejected')!.id,failedId);
  const saved=f.store.latest<any>('room',0,'tool-result');
  assert.equal(saved.tool,'finish');assert.equal(saved.result.notebook.evidenceOutcomes,undefined);assert.equal(f.store.memoryEvidence('room',0,'tool:'+failedId)?.outcome,'rejected');
 }finally{f.store.close();}
});
