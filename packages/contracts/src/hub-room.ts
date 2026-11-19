import type {RoomTiming} from './room-timing.js';
/** Public room metadata only; no player credentials or world state. */
export interface HubRoomSummary {
 code:string;name:string;createdAt:number;capacity:number;players:number;
 status:'waiting'|'starting'|'in-progress'|'ended'|'cancelled'|'recovering'|'unavailable';
 endedAt?:number;timing?:RoomTiming;
}
