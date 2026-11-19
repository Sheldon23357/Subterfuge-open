import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import type {BotModeInput} from '../packages/ai/src/controller/contracts/bot-mode.js';
import {basisOf,type OperationState} from '../plugins/hybrid/src/contracts.js';
import {finalizeRoundOperations} from '../plugins/hybrid/src/execution-recovery.js';

test('receipt-only finalization links exact accepted children without accepting unrelated or unknown commands',()=>{
 const o=observation({state:createFleetScenario(JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial),scheduled:[]},0,'finalization');
 const state=initialState(o.roomId,0,{model:'',personality:'sentinel'});state.sequence=3;
 const snapshot:AiSnapshot={observation:o,chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:0,chatCount:2};
 const action={kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:10};
 const operation:OperationState={id:'operation-3',phase:'strategy',objective:'capture',basis:basisOf(o),strategyVersion:0,status:'proposed',drafts:[{id:'draft',issueTick:o.view.tick,action}],orders:[],fleets:[],issues:[]};
 const row={id:'ai-0-3-0',tool:'batch',arguments:{actions:[{tool:'order',arguments:{action}}]},result:{results:[{index:0,id:'accepted-child',status:'accepted'}]}};
 const input={state,snapshot,feedback:[row],history:[],efficiency:{cacheRoutes:true,cacheReports:true},suffix:'',routes:undefined} satisfies BotModeInput;
 const original=structuredClone(operation),accepted=finalizeRoundOperations(input,[operation])[0]!;
 assert.equal(accepted.status,'accepted');assert.equal(accepted.commands?.[0]?.requestId,'accepted-child');assert.equal(accepted.orders.length,1);
 assert.deepEqual(operation,original);
 for(const variant of [
  {...row,id:'ai-1-3-0'}, {...row,id:'ai-0-4-0'},
  {...row,arguments:{actions:[{tool:'order',arguments:{action:{...action,drillers:11}}}]}},
 ])assert.equal(finalizeRoundOperations({...input,feedback:[variant]},[operation])[0]!.orders.length,0);
 for(const status of ['rejected','unknown']){
  const result=finalizeRoundOperations({...input,feedback:[{...row,result:{results:[{index:0,id:'child',status}]}}]},[operation])[0]!;
  assert.equal(result.orders.length,0);assert.notEqual(result.status,'accepted');
 }
});
