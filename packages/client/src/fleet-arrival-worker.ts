import {knownFleetArrivalSteps,labFleetArrivalSteps,type LabPredictionRoom} from '../../prediction/src/index.js';
import type {FleetArrivalRequest,FleetArrivalReply} from './local-fleet-arrival.js';
const scope=globalThis as unknown as {onmessage:(event:MessageEvent<FleetArrivalRequest>)=>void;postMessage:(reply:FleetArrivalReply)=>void};
const channel=new MessageChannel(),yields:(()=>void)[]=[];
channel.port1.onmessage=()=>yields.shift()?.();
const yieldToMessages=()=>new Promise<void>(resolve=>{yields.push(resolve);channel.port2.postMessage(0);});
let generation=0,activeId=0,sourceKey='',source:Promise<LabPredictionRoom>|undefined;
scope.onmessage=({data})=>{
  if(data.kind==='cancel'){if(activeId===data.id)generation++;return;}
  const job=++generation;activeId=data.id;
  void(async()=>{
    try{
      await yieldToMessages();if(job!==generation)return;
      let steps:Generator<void,import('../../prediction/src/index.js').FleetArrivalEstimate>;
      if(data.input.kind==='known'){
        // This branch receives only authenticated/filtered observations. It has
        // no reason to fetch an admin export or read an authoritative world.
        steps=knownFleetArrivalSteps(data.input.observation,data.fleetId,data.input.atTick);
      }else{
        const input=data.input,key=JSON.stringify([input.roomId,input.revision]);
        if(sourceKey!==key||!source){
          sourceKey=key;
          source=fetch(`/api/prediction-source?roomId=${encodeURIComponent(input.roomId)}&revision=${encodeURIComponent(input.revision)}`,{cache:'no-store'}).then(async response=>{
            if(!response.ok)throw Error('局势已更新，等待最新地图');
            const value=await response.json();
            if(value.roomId!==input.roomId||value.revision!==input.revision||value.room.state.economy.tick!==input.startTick)throw Error('预测起点已更新');
            return value.room as LabPredictionRoom;
          }).catch(error=>{if(sourceKey===key)source=undefined;throw error;});
        }
        const initial=await source;if(job!==generation)return;
        steps=labFleetArrivalSteps(initial,data.fleetId,input.atTick);
      }
      let next=steps.next();
      while(!next.done&&job===generation){await yieldToMessages();if(job!==generation)return;next=steps.next();}
      if(job===generation&&next.done)scope.postMessage({id:data.id,key:data.key,result:next.value});
    }catch(error){if(job===generation)scope.postMessage({id:data.id,key:data.key,error:error instanceof Error?error.message:'抵达预测暂不可用'});}
  })();
};
