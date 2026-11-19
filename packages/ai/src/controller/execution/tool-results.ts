import type {prepareNotebook,prepareReminders,prepareFinish} from '../storage/private-state-preparation.js';
import {executeTool,type ToolContext} from './tools.js';

/** Internal discriminants only: public result bodies and persisted receipts stay unchanged. */
export interface LocalToolResultMap {
 notebook:ReturnType<typeof prepareNotebook>;
 reminders:ReturnType<typeof prepareReminders>;
 finish:Awaited<ReturnType<typeof prepareFinish>>;
}
export type ToolExecution={ [K in keyof LocalToolResultMap]:{kind:K;result:LocalToolResultMap[K]} }[keyof LocalToolResultMap]|{kind:'other';result:unknown};
export async function executeToolResult(name:string,raw:unknown,c:ToolContext):Promise<ToolExecution>{
 switch(name){
  case 'notebook':return {kind:name,result:await executeTool(name,raw,c)};
  case 'reminders':return {kind:name,result:await executeTool(name,raw,c)};
  case 'finish':return {kind:name,result:await executeTool(name,raw,c)};
  default:return {kind:'other',result:await executeTool(name,raw,c)};
 }
}
