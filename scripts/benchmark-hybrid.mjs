/** Offline authorized-observation performance probe. Never connects to a live game or a model.
 * node scripts/benchmark-hybrid.mjs [--samples=20] [--parallel=1] [--output=runtime/outputs/hybrid-performance.json]
 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createFleetScenario,submitFleetOrder} from '../dist/packages/engine/src/index.js';
import {observation} from '../dist/packages/server/src/player-api.js';
import {attackRoutes} from '../dist/packages/prediction/src/index.js';
import {computeBot} from '../dist/packages/ai/src/controller/analysis/tactical-worker.js';
import {closeBotForecastPool} from '../dist/packages/ai/src/controller/analysis/tactical-forecast-pool.js';
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const [k,v]=x.replace(/^--/,'').split('=');return[k,v];}));
const budget=Number(args.budget??5000),threat=args.threat==='true';
const samples=Number(args.samples??20),parallel=Number(args.parallel??1),output=args.output??'runtime/outputs/hybrid-performance.json';
if(![5000,10000].includes(budget))throw Error('Budget must be 5000 or 10000');
if(!Number.isInteger(samples)||samples<1||samples>200||!Number.isInteger(parallel)||parallel<1||parallel>8)throw Error('Invalid sample or concurrency');
function fixture(seed,seat){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial;
 setup.match={mode:'mining',neptuniumGoal:200};setup.economy.outposts=[];setup.positions={};
 let state=seed>>>0;const random=()=>((state=(Math.imul(state,1664525)+1013904223)>>>0)/4294967296);
 for(let owner=0;owner<2;owner++)for(let i=0;i<20;i++){
  const id=`p${owner}-${i}`;setup.positions[id]={x:random()*10,y:random()*10};
  setup.economy.outposts.push({id,owner,type:i===0?'mine':i%2?'factory':'generator',drillers:20+Math.floor(random()*70),shield:5,shieldMax:10,shieldsEnabled:true,productionProgress:random()*40,miningProgress:0,shieldProgress:0,minePending:false,shieldDisablePending:false});
 }
 let scenario=createFleetScenario(setup);if(threat)scenario=submitFleetOrder(scenario,{id:'pressure',player:1-seat,action:{kind:'launch',source:`p${1-seat}-0`,destination:`p${seat}-0`,drillers:15}}).state;
 return observation({state:scenario,scheduled:[]},seat,`hybrid-bench-${seed}-${seat}`);
}
const rows=[];
try{
 for(let start=0;start<samples;start+=parallel)await Promise.all(Array.from({length:Math.min(parallel,samples-start)},async(_,j)=>{
  const index=start+j,seed=4300+Math.floor(index/2),seat=index%2,o=fixture(seed,seat),began=performance.now(),routes=attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24});
  const decision=await computeBot(o,routes,{maxElapsedMs:budget-250,maxSimulations:50,guidance:{forbiddenPlayers:[],protectedSources:[],reserves:[],objectives:[],rotation:index}});
  rows.push({seed,seat,owned:o.view.self.outpostCount,elapsedMs:performance.now()-began,selected:decision.selected.objective,coverage:decision.coverage});
 }));
}finally{closeBotForecastPool();}
const sorted=rows.map(r=>r.elapsedMs).sort((a,b)=>a-b),p95=sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)];
const report={format:'hybrid-performance/1',at:new Date().toISOString(),hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem()},parallel,samples,budget,threat,p95Ms:p95,maximumMs:sorted.at(-1),targetMet:p95<=budget,rows,limitations:['Synthetic 20-outpost authorized observations, finite search','No model calls, live commands or full-game strength comparison','p95 is a sample measurement, not a hard real-time guarantee']};
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,samples,parallel,p95Ms:p95,targetMet:report.targetMet}));
