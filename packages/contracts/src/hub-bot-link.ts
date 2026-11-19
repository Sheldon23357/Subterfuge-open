/** Public lobby-host connection presence; never contains owner credentials. */
export interface HubBotLink { seat:number; name:string; model:string; expiresAt:number }
export interface HubBotLinks { connections:HubBotLink[] }
export interface HubBotLinkCommand { id:string; name:string; model?:string }
export interface HubSeatIdentity {roomId:string;seat:number}
