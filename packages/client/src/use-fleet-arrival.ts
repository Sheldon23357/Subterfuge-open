import {useEffect,useRef,useState} from 'react';
import type {FleetArrivalEstimate} from '../../prediction/src/index.js';
import type {GameView} from './game-view.js';
import {LocalFleetArrival,fleetArrivalKey,type FleetArrivalInput} from './local-fleet-arrival.js';

export function useFleetArrival(view:GameView|null,fleetId:string|undefined,source:GameView|null){
  const client=useRef<LocalFleetArrival|null>(null);
  const [stored,setStored]=useState<{key:string;result?:FleetArrivalEstimate;error?:string}|null>(null);
  const observation=view?.perspective?.arrivalObservation??view?.perspective?.observation;
  const input:FleetArrivalInput|undefined=!view?undefined:observation
    ?{kind:'known',observation,atTick:view.tick}
    :source?.predictionSource?{kind:'global',...source.predictionSource,startTick:source.tick,atTick:view.tick}:undefined;
  const key=input&&fleetId?fleetArrivalKey(input,fleetId):'';
  const context=observation?JSON.stringify(['known',observation.roomId,observation.view.player]):JSON.stringify(['global',source?.predictionSource?.roomId]);
  useEffect(()=>()=>{client.current?.dispose();client.current=null;},[context]);
  useEffect(()=>{
    if(!key||!input||!fleetId)return;
    const controller=new AbortController();
    client.current??=new LocalFleetArrival();
    void client.current.estimate(input,fleetId,controller.signal)
      .then(result=>{if(!controller.signal.aborted)setStored({key,result});})
      .catch(error=>{if(!controller.signal.aborted)setStored({key,error:error instanceof Error?error.message:'抵达预测暂不可用'});});
    return()=>controller.abort();
  },[key]);
  const current=stored?.key===key?stored:null;
  return {result:current?.result,loading:!!key&&!current,error:current?.error};
}
