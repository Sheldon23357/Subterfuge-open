import type {PlayerObservation} from '../../contracts/src/index.js';
import type {FleetArrivalEstimate} from '../../prediction/src/index.js';

export type FleetArrivalInput =
  | {kind:'known';observation:PlayerObservation;atTick:number}
  | {kind:'global';roomId:string;revision:string;startTick:number;atTick:number};
export function fleetArrivalKey(input:FleetArrivalInput,fleetId:string) {
  if(input.kind==='known')return JSON.stringify(['known',input.observation.roomId,input.observation.view.player,input.observation.revision,input.atTick,fleetId]);
  return JSON.stringify(['global',input.roomId,input.atTick<input.startTick?'history':input.revision,input.atTick,fleetId]);
}
export type FleetArrivalRequest={kind:'cancel';id:number}|{kind:'estimate';id:number;key:string;fleetId:string;input:FleetArrivalInput};
export type FleetArrivalReply={id:number;key:string;result:FleetArrivalEstimate}|{id:number;key:string;error:string};
export interface FleetArrivalWorker {
  onmessage:((event:MessageEvent<FleetArrivalReply>)=>void)|null;
  onerror:((event:ErrorEvent)=>void)|null;
  postMessage(message:FleetArrivalRequest):void;
  terminate():void;
}

/** Lazy selected-fleet worker. Display clocks use absolute game seconds, so a
 * second-only refresh does not restart a calculation. No task without a click. */
export class LocalFleetArrival {
  private worker:FleetArrivalWorker|undefined;
  private sequence=0;
  private cache=new Map<string,FleetArrivalEstimate>();
  private pending:{id:number;reject:(error:Error)=>void;cleanup:()=>void}|undefined;
  constructor(private createWorker:()=>FleetArrivalWorker=()=>new Worker('/fleet-arrival-worker.js',{type:'module'})){}
  private cancel(reason:Error=new DOMException('Arrival superseded','AbortError')){
    if(!this.pending)return;
    const pending=this.pending;this.pending=undefined;
    this.worker?.postMessage({kind:'cancel',id:pending.id});pending.cleanup();pending.reject(reason);
  }
  estimate(input:FleetArrivalInput,fleetId:string,signal?:AbortSignal):Promise<FleetArrivalEstimate>{
    if(signal?.aborted)return Promise.reject(new DOMException('Arrival cancelled','AbortError'));
    this.cancel();
    const key=fleetArrivalKey(input,fleetId),cached=this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve(cached);}
    this.worker??=this.createWorker();
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const abort=()=>{if(this.pending?.id===id)this.cancel(new DOMException('Arrival cancelled','AbortError'));};
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      this.pending={id,reject,cleanup};signal?.addEventListener('abort',abort,{once:true});
      this.worker!.onmessage=({data})=>{
        if(data.id!==id||this.pending?.id!==id)return;
        this.pending=undefined;cleanup();
        if(data.key!==key){reject(Error('抵达预测版本已更新'));return;}
        if('error'in data){reject(Error(data.error));return;}
        if(data.result.fleetId!==fleetId){reject(Error('舰队预测已更新'));return;}
        this.cache.set(key,data.result);if(this.cache.size>16)this.cache.delete(this.cache.keys().next().value!);
        resolve(data.result);
      };
      this.worker!.onerror=()=>this.dispose(Error('抵达预测暂不可用'));
      try{this.worker!.postMessage({kind:'estimate',id,key,fleetId,input});}
      catch(error){this.pending=undefined;cleanup();reject(error);}
    });
  }
  dispose(reason:Error=new DOMException('Arrival context changed','AbortError')){
    this.cancel(reason);this.worker?.terminate();this.worker=undefined;this.cache.clear();
  }
}
