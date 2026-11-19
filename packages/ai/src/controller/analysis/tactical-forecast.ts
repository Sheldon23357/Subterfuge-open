import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {forecastKnownPath,createKnownPrediction,type KnownPathRequest,type prepareKnownPrediction} from '../../../../prediction/src/index.js';
import {checkPlanResources,finalizePlanResources} from '../../controller/execution/plan-resource-check.js';

/** Only an authorized observation and an independent hypothetical branch cross
 * the worker boundary. No game state, credentials or writable store is exposed. */
export interface BotForecastRequest extends KnownPathRequest {resourcePrefix?:boolean}
export type BotForecastResult=
 |{kind:'result';result:ReturnType<typeof forecastKnownPath>}
 |{kind:'early';status:'invalid'|'unknown';reasons:string[]}
 |{kind:'error';message:string};
export function executeBotForecast(o:PlayerObservation,request:BotForecastRequest,prepared?:ReturnType<typeof prepareKnownPrediction>,cancelled?:()=>boolean):BotForecastResult {
 try{
  const lastIssue=Math.max(o.view.tick,...(request.drafts??[]).map(d=>d.issueTick));
  if(request.resourcePrefix&&lastIssue>o.view.tick&&lastIssue<request.targetTick){
   const context={snapshot:{observation:o}},drafts=request.drafts??[];
   const initial=checkPlanResources(drafts,undefined,context,{deferToForecast:true});
   const session=(prepared?.create??((options)=>createKnownPrediction(o,options)))({drafts,pathPredicates:request.predicates??[],collectResourceFrames:true,...(cancelled?{cancelled}:{})});
   const prefix=session.predict(lastIssue),resources=finalizePlanResources(initial,prefix,drafts,undefined,context);
   if(prefix.status==='unsupported'||resources.status==='conflict'||resources.status==='unknown')return {kind:'early',status:resources.status==='conflict'?'invalid':'unknown',reasons:prefix.status==='unsupported'?prefix.reasons:resources.conflicts.map(c=>c.code)};
   const {path,...forecast}=session.predict(request.targetTick);return {kind:'result',result:{forecast,path:path??null}};
  }
  if(!prepared&&!cancelled)return {kind:'result',result:forecastKnownPath(o,request)};
  const response=(prepared?.create??((options)=>createKnownPrediction(o,options)))({drafts:request.drafts??[],...(request.predicates?{pathPredicates:request.predicates}:{}),...(request.enemyWaiting?{enemyWaiting:request.enemyWaiting}:{}),...(request.enemyLaunches?{enemyLaunches:request.enemyLaunches}:{}),...(request.collectResourceFrames?{collectResourceFrames:true}:{}),...(cancelled?{cancelled}:{})}).predict(request.targetTick);
  const {path,...forecast}=response;
  return {kind:'result',result:{forecast,path:path??null}};
 }catch(error){return {kind:'error',message:error instanceof Error?error.message:'推演异常'};}
}
