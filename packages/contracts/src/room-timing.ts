export type RoomTiming={mode:'realtime';tickSeconds:number}|{mode:'turn-based'};
export const DEFAULT_ROOM_TIMING:RoomTiming={mode:'realtime',tickSeconds:10};
export function parseRoomTiming(value:unknown=DEFAULT_ROOM_TIMING):RoomTiming{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('无效对局时间设置');
 const raw=value as Record<string,unknown>;
 if(raw.mode==='turn-based'&&Object.keys(raw).length===1)return {mode:'turn-based'};
 if(raw.mode==='realtime'&&Object.keys(raw).length===2&&Number.isInteger(raw.tickSeconds)&&Number(raw.tickSeconds)>=1&&Number(raw.tickSeconds)<=3600)return {mode:'realtime',tickSeconds:Number(raw.tickSeconds)};
 throw Error('实时 tick 时长须为 1–3600 秒的整数');
}
export interface TurnStatus {tick:number;players:{player:number;ready:boolean;automated:boolean}[];self:number}
