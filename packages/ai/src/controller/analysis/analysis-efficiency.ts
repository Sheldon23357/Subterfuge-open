import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import type {PlayerObservation,AttackRoutes} from '../../../../contracts/src/index.js';
import {GameRequestError} from '../transport/gateway.js';

/** A known read-only route precondition raced again after the one allowed
 * refresh. Preserve the server cause; recover with backoff, never a tight loop. */
export class AttackRouteConflictError extends GameRequestError {
  constructor(error:GameRequestError){super(error.status,error.observation,error.code,error.detail,error.diagnostic);this.name='AttackRouteConflictError';}
}

/** A discarded read result, never an unknown game command. Cross-room results
 * remain non-retryable because they may indicate an identity/binding failure. */
export class StaleAnalysisResultError extends Error {
  readonly retryable:boolean;
  readonly displayReason='进攻路线结果与当前观察不一致，已丢弃异常结果';
  constructor(readonly expected:{roomId:string;revision:string;tick:number},readonly actual:{roomId:string;revision:string;tick:number}){
    super('Stale attack route matrix');this.name='StaleAnalysisResultError';this.retryable=expected.roomId===actual.roomId;
  }
}

export function assertCurrentAttackRoutes(o:PlayerObservation,routes:AttackRoutes){
  if(routes.roomId!==o.roomId||routes.revision!==o.revision||routes.observedTick!==o.view.tick)
    throw new StaleAnalysisResultError({roomId:o.roomId,revision:o.revision,tick:o.view.tick},{roomId:routes.roomId,revision:routes.revision,tick:routes.observedTick});
}

/** Geometry can survive a revision change only while all route dependencies
 * match. Fresh server responses must match the complete observation basis. */
type RouteWindows={attackTicks:number;localTicks:number;holdTicks:number};
export async function prepareAttackRoutes(o:PlayerObservation,windows:RouteWindows,cache:{routeKey:string;routes?:AttackRoutes},read:(o:PlayerObservation,windows:RouteWindows)=>Promise<AttackRoutes>,enabled:boolean,refresh?:()=>Promise<PlayerObservation>){
  let key=analysisKey([routeInput(o),windows]),observation=o,refreshed=false;
  const hit=enabled&&!!cache.routes&&cache.routeKey===key;
  const routes=hit?{...cache.routes!,revision:o.revision}:await read(o,windows);
  try{assertCurrentAttackRoutes(o,routes);}catch(error){
    // The server may accept a compatible baseline but return
    // routes labelled with its newer observation. Read that authority once;
    // never relabel the returned routes or follow a different room/seat.
    if(hit||!(error instanceof StaleAnalysisResultError)||!error.retryable||!refresh)throw error;
    observation=await refresh();
    if(observation.roomId!==o.roomId)throw new StaleAnalysisResultError(error.expected,{roomId:observation.roomId,revision:observation.revision,tick:observation.view.tick});
    if(observation.view.player!==o.view.player)throw Error('Attack route refresh changed player identity');
    assertCurrentAttackRoutes(observation,routes);
    key=analysisKey([routeInput(observation),windows]);refreshed=true;
  }
  cache.routes=routes;cache.routeKey=key;
  return {routes,hit,observation,refreshed};
}

export const DEFAULT_ANALYSIS_EFFICIENCY={cacheReports:true,cacheRoutes:true};
export type AnalysisEfficiency=typeof DEFAULT_ANALYSIS_EFFICIENCY;
export function analysisEfficiency(raw:unknown={}):AnalysisEfficiency{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid AI analysis efficiency config');
  const result={...DEFAULT_ANALYSIS_EFFICIENCY};
  for(const [key,value] of Object.entries(raw)){
    if(!Object.hasOwn(result,key)||typeof value!==typeof result[key as keyof AnalysisEfficiency])throw Error(`Invalid AI analysis efficiency: ${key}`);
    Object.assign(result,{[key]:value});
  }
  return result;
}
export function loadAnalysisEfficiency(){return analysisEfficiency(process.env.AI_ANALYSIS_EFFICIENCY_CONFIG?JSON.parse(readFileSync(process.env.AI_ANALYSIS_EFFICIENCY_CONFIG,'utf8')):{});}
export const analysisKey=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Ignore only transport metadata, never military information or game time. */
export function reportInput(o:PlayerObservation){return {roomId:o.roomId,view:o.view,intel:o.intel,scheduled:o.scheduled,outpostNames:o.outpostNames,seconds:o.secondsSinceLastTick};}
/** Mirrors attackRoutes dependencies. Garrison changes need a new score, not new geometry. */
export function routeInput(o:PlayerObservation){const v=o.view;return {roomId:o.roomId,player:v.player,tick:v.tick,size:v.size,
  posts:v.outposts.map(p=>({id:p.id,owner:p.owner,destroyed:p.destroyed,position:p.position})),
  fleets:v.fleets.map(f=>({id:f.id,owner:f.owner,gift:f.gift,position:f.position,destination:f.destination,state:f.state,secondsUntilLaunch:f.secondsUntilLaunch,launchRemainingSeconds:f.launchRemainingSeconds}))};}
