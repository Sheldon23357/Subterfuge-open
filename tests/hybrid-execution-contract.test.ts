import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TOOL_NAMES} from '../packages/ai/src/controller/contracts/tool-metadata.js';
import {executeTool,type ToolContext} from '../packages/ai/src/controller/execution/tools.js';
import {createSessionProvider} from '../packages/ai/src/application/agent-provider.js';

test('hybrid executor exposes only commands, communication and private state operations',()=>{
 assert.deepEqual([...TOOL_NAMES].sort(),['batch','finish','notebook','order','reminders','say']);
});
test('retired model query commands reject before reading arguments or touching the gateway',async()=>{
 let touched=0;const args={get targetTick(){touched++;return 100;}},context={gateway:{request:async()=>{touched++;throw Error('must not send');}}} as unknown as ToolContext;
 for(const name of ['decisionSupport','queries','attackCandidates','chatHistory','deploy','compare','forecast'])
  await assert.rejects(executeTool(name,args,context),/Tool not available/);
 assert.equal(touched,0);
});
test('no-model configuration cannot silently substitute a fake successful model response',async()=>{
 const p=createSessionProvider({kind:'offline'},undefined,{OPENAI_API_KEY:'must-not-use'});
 assert.equal(p.summary.hasKey,false);assert.equal(p.summary.model,'');
 await assert.rejects(p.current.step({model:'',prompt:'',signal:new AbortController().signal}),/未配置模型/);
});
