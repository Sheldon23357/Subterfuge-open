import test from 'node:test';
import assert from 'node:assert/strict';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState} from '../packages/ai/src/controller/contracts/types.js';
import {AgentDiagnostics,type DiagnosticStats} from '../packages/ai/src/controller/diagnostics/agent-diagnostics.js';
test('tool counts cover all pages, whole latest 50 rounds, failures and zero-tool rounds without counting receipts twice',()=>{
 const store=new AiStore(':memory:'),state=initialState('tools',0,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,v=>v);
 try{
  store.save(state,'tool-intent',{id:'unassigned-legacy',tool:'recall',arguments:{}});
  for(let round=1;round<=55;round++){
   state.sequence=round;store.save(state,'started',{sequence:round});
   if(round===55)continue;
   for(let step=0;step<5;step++){
    const id=`ai-0-${round}-${step}`,tool=step===0?'batch':'forecast';
    store.save(state,'tool-intent',{id,tool,arguments:{body:'large'.repeat(20000)}});
    store.save(state,'tool-intent',{id,tool,arguments:{}});
    store.save(state,'tool-rejected',{id,tool,error:'stale-observation'});
   }
  }
  const other=initialState('tools',1,{model:'fake',personality:'schemer'});store.save(other,'tool-intent',{id:'other-seat',tool:'intruder'});
  const result=diagnostics.read('stats') as DiagnosticStats;
  assert.equal(result.toolUsage.all.total,271);assert.deepEqual(result.toolUsage.all.counts,{forecast:216,batch:54,recall:1});
  assert.equal(result.toolUsage.unassigned,1);assert.deepEqual(result.toolUsage.recentRounds,Array.from({length:50},(_,i)=>i+6));
  assert.equal(result.toolUsage.recent.total,245);assert.deepEqual(result.toolUsage.recent.counts,{forecast:196,batch:49});
  store.save(state,'diagnostics-cleared',{});assert.equal((diagnostics.read('stats') as DiagnosticStats).toolUsage.all.total,0);
 }finally{store.close();}
});
test('encoded legacy rounds and unknown tool names remain available, with empty windows and safe keys',()=>{
 const store=new AiStore(':memory:'),state=initialState('legacy-tools',0,{model:'fake',personality:'schemer'}),diagnostics=new AgentDiagnostics(store,state,v=>v);
 try{
  assert.equal((diagnostics.read('stats') as DiagnosticStats).toolUsage.all.total,0);
  store.save(state,'tool-intent',{id:'ai-0-12-0',tool:'__proto__'});
  store.save(state,'tool-result',{id:'ai-0-12-0',tool:'__proto__'});
  store.save(state,'tool-intent',{id:'ai-0-12-1',tool:'futureTool',invalidArguments:true});
  const usage=(diagnostics.read('stats') as DiagnosticStats).toolUsage;
  assert.deepEqual(usage.recentRounds,[12]);assert.equal(usage.all.total,2);assert.equal(usage.all.counts['__proto__'],1);assert.equal(usage.all.counts.futureTool,1);
 }finally{store.close();}
});
