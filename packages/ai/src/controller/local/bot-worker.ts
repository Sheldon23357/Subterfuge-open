import {isMainThread,workerData} from 'node:worker_threads';
import type {AttackRoutes,PlayerObservation} from '../../../../contracts/src/index.js';
import {computeBotWithEntry,runBotWorkerPlanner} from '../analysis/tactical-worker.js';
import {planBotAsync,type LocalPlannerOptions} from './bot-planner.js';
const format='local-planner-worker/1';
if(!isMainThread&&workerData?.format===format)runBotWorkerPlanner(planBotAsync);
export function computeBot(o:PlayerObservation,routes:AttackRoutes,options:LocalPlannerOptions={}){
 return computeBotWithEntry(new URL('./bot-worker.js',import.meta.url),format,o,routes,options);
}
