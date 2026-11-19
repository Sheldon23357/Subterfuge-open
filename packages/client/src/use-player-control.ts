import {useEffect,useState} from 'react';
import type {PlayerConnection} from './player-connection.js';
import {playerControlPresentation,validatePlayerControl,type PlayerControlView} from './player-control-view.js';
export type {PlayerControlView} from './player-control-view.js';
export function usePlayerControl(connection:PlayerConnection|null,roomId:string,player:number){
 const [record,setRecord]=useState<{connection:PlayerConnection;roomId:string;player:number;value:PlayerControlView}|null>(null),[error,setError]=useState('');
 const value=record?.connection===connection&&record.roomId===roomId&&record.player===player?record.value:null;
 useEffect(()=>{if(!connection||!roomId||player<0)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;setError('');
  async function poll(){try{const next=await connection!.request<PlayerControlView>('/player/v2/owner/control',undefined,controller.signal);if(controller.signal.aborted)return;validatePlayerControl(next,roomId,player);setRecord({connection:connection!,roomId,player,value:next});setError('');}catch(e){if(!controller.signal.aborted){setRecord(null);setError(e instanceof Error?e.message:'无法读取控制权。');}}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2000);}}
  void poll();return()=>{controller.abort();clearTimeout(timer);};
 },[connection,roomId,player]);
 return {value,error,...playerControlPresentation(value,error)};
}
