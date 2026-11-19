import type {AttackRoutes,PlayerObservation} from '../../../../contracts/src/index.js';
import {planBot as planShared,planBotAsync as planSharedAsync,type BotPlannerOptions as SharedOptions} from '../analysis/tactical-planner.js';
export * from '../analysis/tactical-planner.js';
export interface LocalPlannerOptions extends SharedOptions {skipInternal?:boolean}
function prepare(options:LocalPlannerOptions):SharedOptions {
 return {...options,internalTransfers:!options.skipInternal,preludeIndependent:!options.skipInternal};
}
export function planBot(o:PlayerObservation,routes:AttackRoutes,options:LocalPlannerOptions={}){return planShared(o,routes,prepare(options));}
export const planBotAsync:typeof planSharedAsync=(o,routes,options={},run)=>planSharedAsync(o,routes,prepare(options as LocalPlannerOptions),run);
