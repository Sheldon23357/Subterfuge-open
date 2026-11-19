/** Offline end-to-end planner replay on authorized observations. A large fixed
 * budget compares exact decisions; bounded budgets measure useful coverage. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const at=a.indexOf('=');return[a.slice(2,at),a.slice(at+1)];}));
if(!args.input||!args.output)throw Error('Use --input=observations.json --output=report.json [--modules=dist] [--budget=60000]');
const load=relative=>import(pathToFileURL(path.resolve(args.modules??'dist','packages',relative)).href);
const {computeBot}=await load('ai/src/controller/analysis/tactical-worker.js');
const {closeBotForecastPool,botForecastPoolStats}=await load('ai/src/controller/analysis/tactical-forecast-pool.js');
const {attackRoutes}=await load('prediction/src/index.js');
const data=JSON.parse(fs.readFileSync(args.input,'utf8')),budget=Number(args.budget??60000),rows=[],start=performance.now();
if(!Array.isArray(data)||!data.length||data.some(v=>!v.observation?.view)||!Number.isSafeInteger(budget)||budget<1||budget>60000)throw Error('Expected authorized observations and budget=1..60000');
try{
 await Promise.all(data.map(async({observation:o})=>{
  const began=performance.now(),routes=attackRoutes(o,{attackTicks:144,localTicks:144,holdTicks:24});
  const decision=await computeBot(o,routes,{maxElapsedMs:budget,maxSimulations:50,internalTransfers:true,preludeIndependent:true,guidance:{forbiddenPlayers:[],protectedSources:[],reserves:[],objectives:[],rotation:0}});
  rows.push({seat:o.view.player,elapsedMs:performance.now()-began,selected:decision.selected.objective,coverage:decision.coverage,hash:createHash('sha256').update(JSON.stringify(decision)).digest('hex')});
 }));
}finally{closeBotForecastPool();}
rows.sort((a,b)=>a.seat-b.seat);
const report={at:new Date().toISOString(),modules:args.modules??'dist',budget,elapsedMs:performance.now()-start,rows,poolStats:botForecastPoolStats?.(),limitations:['Captured player observations only; no hidden world, live orders or model calls','Empty strategic guidance; not a reproduction of the bots historical private strategy','Fixed-budget hash equivalence is separate from deadline-dependent search coverage']};
fs.writeFileSync(args.output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
