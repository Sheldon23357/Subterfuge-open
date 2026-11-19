import {threadId,workerData,parentPort} from 'node:worker_threads';
import {runBotWorkerPlanner} from '../../packages/ai/src/controller/analysis/tactical-worker.js';
import {resolveBotSettings} from '../../packages/contracts/src/index.js';
import type {BotDecision} from '../../packages/ai/src/controller/analysis/tactical-planner.js';
let rounds=0;
if(workerData?.format==='coordinator-fixture/1')runBotWorkerPlanner(async(o,_routes,options,run)=>{
 const rotation=options.guidance?.rotation??0;rounds++;
 const decision:BotDecision={format:'deterministic-bot-decision/1',basisRevision:o.revision,observedTick:o.view.tick,
  parameters:resolveBotSettings(),utilityScale:{id:'driller-anchor-v1',unit:'weighted-driller-equivalent',drillerValue:1},
  situation:{} as BotDecision['situation'],selected:{id:'hold',kind:'hold',objective:'hold',targets:[],drafts:[],priority:0,reasons:[]},
  assessments:[],coverage:{generated:0,evaluated:0,simulations:0,complete:true,stopReason:'complete'},assumptions:[],
  policyDiagnostics:{workerId:threadId,round:rounds,player:o.view.player}};
 if(rotation===1)throw Error('fixture planner failed');
 if(rotation===3)process.exit(17);
 if(rotation===7)return new Promise(()=>{});
 options.onProgress?.({basisRevision:o.revision,observedTick:o.view.tick,elapsedMs:0,stage:'discovery',generated:0,evaluated:0,simulations:0,maximum:80,horizon:196,timeLimitMs:2000,stages:{discovery:0,refinement:0,combination:0,continuation:0,stress:0},branches:[]});
 options.onCheckpoint?.(decision);
 if(rotation===2||rotation===4)return new Promise(()=>{});
 // An unsolicited old job response must never finish the active job.
 parentPort!.postMessage({jobId:0,decision:{...decision,basisRevision:'stale'}});
 const responses=await run!([{targetTick:o.view.tick+1}]);
 if(responses.length!==1)throw Error('Missing forecast response');
 return decision;
});
