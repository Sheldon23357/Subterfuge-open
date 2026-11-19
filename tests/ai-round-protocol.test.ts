import {commanderOutputInstruction} from '../plugins/hybrid/src/prompts.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AGENT_REPLY_SCHEMA,parseAgentReply} from '../packages/ai/src/controller/contracts/reply-protocol.js';
import {parseCommanderResult} from '../packages/ai/src/controller/contracts/commander-protocol.js';

test('round reply schema and parser reject obsolete per-call focus',()=>{
 assert.deepEqual(AGENT_REPLY_SCHEMA.properties.nextContext,{type:'null'});
 const wire={request:{tool:'finish',arguments:{}},summary:'完成',nextContext:null};
 assert.equal(parseAgentReply(JSON.stringify(wire)).nextContext,null);
 assert.throws(()=>parseAgentReply(JSON.stringify({...wire,nextContext:{mode:'global'}})),/nextContext must be null/);
});

test('retired model workset controls are rejected before instruction execution',()=>{
 const wire={request:{tool:'finish',arguments:{}},summary:'done',nextContext:null};
 for(const workset of [null,{release:['a'],replace:[]},{}])assert.throws(()=>parseAgentReply(JSON.stringify({...wire,workset})),/Invalid Codex reply/);
});

test('reply parser does not silently flatten retired say parameters',()=>{
 const args={to:1,text:'等待',arguments:{act:'probe'}};
 const reply=parseAgentReply(JSON.stringify({request:{tool:'say',arguments:args},summary:'发送',nextContext:null}));
 // Preserve invalid fields for the strict tool validator and original audit.
 assert.deepEqual(reply.arguments,args);
});

test('commander reconciliation only accepts the bounded strategy it advertises',()=>{
 const parse=(memory:unknown,extra={})=>parseCommanderResult({tool:'finish',arguments:{memory,...extra},summary:'已整理战略'},'reconcile');
 assert.deepEqual(parse({strategy:'守住北矿'}).memory,{strategy:'守住北矿'});
 for(const key of ['relations','agreements','deceptions']){
  assert.throws(()=>parse({strategy:'守住北矿',[key]:null}),/Invalid discussion field/);
 }
 assert.throws(()=>parse({strategy:'字'.repeat(1001)}),/Invalid discussion field/);
 assert.throws(()=>parse({strategy:'守住北矿'},{preview:false}),/Unexpected discussion output/);
 assert.doesNotMatch(commanderOutputInstruction('reconcile'),/relations|agreements|deceptions/);
 assert.match(commanderOutputInstruction('reconcile'),/1000/);
 assert.equal(parseCommanderResult({tool:'finish',arguments:{memory:{strategy:'字'.repeat(1500)}},summary:'请确认指令'},'discuss').memory.strategy?.length,1500);
});
