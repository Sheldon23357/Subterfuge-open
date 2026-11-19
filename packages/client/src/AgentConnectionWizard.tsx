import React from 'react';
import {AgentHallSeatPicker} from './AgentHallSeatPicker.js';
export type ConsoleRequest=<T>(path:string,data?:unknown,signal?:AbortSignal)=>Promise<T>;
export function AgentConnectionWizard({request,onCancel,slotId}:{request:ConsoleRequest;onAdded:(id:string)=>Promise<void>;onCancel:()=>void;count:number;slotId?:string|undefined}){
 return <AgentHallSeatPicker request={request} slotId={slotId} onCancel={onCancel}/>;
}
