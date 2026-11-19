import type {PlayerObservation,PlayerActivityEvent,ManualCommandReceipt} from '../../../../contracts/src/index.js';
import {isDeepStrictEqual} from 'node:util';
import {parseManualCommandView,parseManualCommandReceiptPage} from '../../../../player-sdk/src/index.js';

/** Only a complete parsed model reply acknowledges facts. Polls do not. */
export interface FactBaseline {roomId:string;player:number;activityCursor?:number|undefined;manualVersion?:number|undefined;manualFacts?:readonly ManualCommandReceipt[]}
export class ActivityFacts {
 baseline:((current:PlayerObservation)=>FactBaseline|undefined)|undefined;
 async hydrate(observation:PlayerObservation,read:(after:number,through:number)=>Promise<unknown>,readManual?:((after:number,limit:number)=>Promise<unknown>)):Promise<PlayerObservation>{
  const upper=observation.activityCursor;
  if(upper!==undefined&&(!Number.isSafeInteger(upper)||upper<0))throw Error('Invalid activity snapshot cut');
  // Validate before a runner may persist the first durable origin.
  if(observation.manualCommands)observation={...observation,manualCommands:parseManualCommandView(observation.manualCommands,observation.view.player)};
  const prior=this.baseline?.(observation);
  // A transport used without a runner (for example commander discussion) has
  // no durable application acknowledgement. Keep its ordinary snapshot tail;
  // do not accidentally load the whole match on a generic snapshot request.
  if(!prior)return observation;
  if(prior.roomId!==observation.roomId||prior.player!==observation.view.player)throw Error('Activity baseline scope mismatch');
  const [activity,manual]=await Promise.all([this.activity(observation,prior,read),this.manual(observation,prior,readManual)]);
  return {...manual,...(activity.activity===undefined?{}:{activity:activity.activity})};
 }
 private async activity(observation:PlayerObservation,prior:FactBaseline,read:(after:number,through:number)=>Promise<unknown>):Promise<PlayerObservation>{
  const upper=observation.activityCursor;if(upper===undefined)return observation;
  let cursor=prior.activityCursor;
  if(typeof cursor!=='number'||!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid activity fact baseline');
  // Independent reads can return a cut older than the durable acknowledgement.
  // It needs no backfill; validate its own tail without importing newer facts.
  const facts=new Map<number,PlayerActivityEvent>((observation.activity??[]).map(e=>[e.id,e]));
  for(const event of observation.activity??[]){
   if(!event||!Number.isSafeInteger(event.id)||event.id<0||event.id>=upper||!Number.isSafeInteger(event.tick)||typeof event.kind!=='string'||typeof event.subject!=='string')throw Error('Invalid activity snapshot fact');
  }
  while(cursor<upper){
   // Authorized contiguous snapshot facts already cover this interval.
   if(facts.has(cursor)){cursor++;continue;}
   const raw=await read(cursor,upper);
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid activity page');
   const page=raw as {events:PlayerActivityEvent[];nextCursor:number;through:number;hasMore:boolean};
   if(!Array.isArray(page.events)||page.events.length===0||page.events.length>200||page.through!==upper||page.nextCursor!==cursor+page.events.length||page.nextCursor>upper||page.hasMore!==(page.nextCursor<upper))throw Error('Incomplete activity page');
   for(const [i,event] of page.events.entries()){
    if(!event||event.id!==cursor+i||!Number.isSafeInteger(event.tick)||typeof event.kind!=='string'||typeof event.subject!=='string')throw Error('Activity sequence mismatch');
    const previous=facts.get(event.id);
    if(previous&&!isDeepStrictEqual(previous,event))throw Error('Activity changed under a stable identity');
    facts.set(event.id,event);
   }
   cursor=page.nextCursor;
  }
  return {...observation,activity:[...facts.values()].sort((a,b)=>a.id-b.id)};
 }
 private async manual(observation:PlayerObservation,prior:FactBaseline,read?:((after:number,limit:number)=>Promise<unknown>)):Promise<PlayerObservation>{
  if(!observation.manualCommands)return observation;
  const current=parseManualCommandView(observation.manualCommands,observation.view.player),upper=current.version;
  let cursor=prior.manualVersion;
  if(typeof cursor!=='number'||!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid manual fact baseline');
  const facts=new Map(current.receipts.map(receipt=>[receipt.version,receipt]));
  if(prior.manualFacts?.length){
   const pending=prior.manualFacts.filter(receipt=>receipt.version<=upper).slice().sort((a,b)=>a.version-b.version);
   parseManualCommandView({...current,receipts:pending,receiptsFromVersion:pending[0]?.version??0},observation.view.player);
   for(const receipt of pending){
    const previous=facts.get(receipt.version);
    if(previous&&!isDeepStrictEqual(previous,receipt))throw Error('Manual fact changed under a stable identity');
    facts.set(receipt.version,receipt);
   }
  }
  while(cursor<upper){
   // The normal snapshot tail often contains the whole required interval.
   if(facts.has(cursor+1)){cursor++;continue;}
   if(!read)throw Error('Manual fact history channel is unavailable');
   const limit=Math.min(100,upper-cursor);
   const page=parseManualCommandReceiptPage(await read(cursor,limit),observation.view.player);
   if(page.version<upper||!page.receipts.length||page.receipts.length>limit||page.nextCursor!==cursor+page.receipts.length||page.nextCursor>upper||page.hasMore!==(page.nextCursor<page.version))throw Error('Incomplete manual fact page');
   for(const [index,receipt] of page.receipts.entries()){
    if(receipt.version!==cursor+index+1)throw Error('Manual fact sequence mismatch');
    const previous=facts.get(receipt.version);
    if(previous&&!isDeepStrictEqual(previous,receipt))throw Error('Manual fact changed under a stable identity');
    facts.set(receipt.version,receipt);
   }
   cursor=page.nextCursor;
  }
  const receipts=[...facts.values()].sort((a,b)=>a.version-b.version);
  return {...observation,manualCommands:{...current,receipts,receiptsFromVersion:receipts[0]?.version??0,hasEarlierReceipts:receipts.length<upper}};
 }
}
