import {validateSettings, type AiSettings} from './types.js';

/** Maximum configured AI instances per runtime, across all servers and rooms. */
export const MAX_AGENT_INSTANCES=8;

export interface AgentSeatConfig {
  id: string;
  serverUrl: string;
  roomId: string;
  /** Public hall routing code for owner browser entry in configured runtimes. */
  roomCode?: string;
  lobbySeat: number;
  gamePlayer: number;
  chatPlayer: number;
  chatCount: number;
  tokenEnv: string;
  /** Follow the authoritative lobby-to-game seat mapping for room-code admissions. */
  lobbyConnection?:boolean;
  /** Owner credential authorizes one durable scoped executor grant; it is never sent to executor endpoints. */
  ownerCredential?:boolean;
  /** Opt-in remote checkpoint participation; private backups stay in storeDirectory. */
  coordinatedCheckpoints?:boolean;
  settings: AiSettings;
  /** Explicit seat opt-in; never enabled by ordinary AI activation. */
  mechanicalKeepalive?:boolean;
  /** Independent operator authorization for this exact configured room. */
  roomMaintenancePolicy?:{roomId:string;allowMechanicalKeepalive:boolean};
  roster?: {chatPlayer:number;gamePlayer:number}[];
}
export interface AgentRuntimeConfig {storeDirectory:string; seats:AgentSeatConfig[]; pollMs:number; live:true}
export function parseAgentConfig(raw:unknown):AgentRuntimeConfig {
  const c=raw as AgentRuntimeConfig;
  if((raw as {live?:unknown})?.live===false)throw Error('AI runtime only supports live play');
  if(!c||typeof c.storeDirectory!=='string'||!c.storeDirectory.trim()||!Array.isArray(c.seats))throw Error('Expected storeDirectory and seats array');
  if(c.seats.length>MAX_AGENT_INSTANCES)throw Error(`At most ${MAX_AGENT_INSTANCES} AI instances are allowed across all servers and rooms`);
  const ids=new Set<string>(),identities=new Set<string>();
  const seats=c.seats.map(s=>{
    if(!s||typeof s.id!=='string'||!s.id.trim()||ids.has(s.id)||typeof s.roomId!=='string'||!s.roomId.trim()||typeof s.tokenEnv!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.tokenEnv))throw Error('Invalid or duplicate seat configuration');
    if(s.roomCode!==undefined&&(typeof s.roomCode!=='string'||!/^[A-Z0-9]{6}$/.test(s.roomCode)))throw Error('Invalid room code');
    if(s.ownerCredential!==undefined&&typeof s.ownerCredential!=='boolean')throw Error('Invalid owner credential flag');
    if(s.lobbyConnection!==undefined&&typeof s.lobbyConnection!=='boolean')throw Error('Invalid lobby connection flag');
    if(Object.hasOwn(s,'protocol'))throw Error('The player protocol is v2-only; remove the legacy protocol field');
    if(s.coordinatedCheckpoints!==undefined&&typeof s.coordinatedCheckpoints!=='boolean')throw Error('coordinatedCheckpoints must be boolean');
    if(s.mechanicalKeepalive!==undefined&&typeof s.mechanicalKeepalive!=='boolean')throw Error('mechanicalKeepalive must be boolean');
    if(s.roomMaintenancePolicy!==undefined){const p=s.roomMaintenancePolicy;if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['roomId','allowMechanicalKeepalive'].includes(k))||p.roomId!==s.roomId||typeof p.allowMechanicalKeepalive!=='boolean')throw Error('roomMaintenancePolicy must explicitly name this room and its boolean permission');}
    const url=new URL(s.serverUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('serverUrl must be an explicit HTTP(S) origin without credentials');
    if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Remote player tokens require HTTPS');
    for(const value of [s.lobbySeat,s.gamePlayer,s.chatPlayer,s.chatCount])if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid seat identity');
    if(s.chatCount<1||s.chatPlayer>=s.chatCount)throw Error('Invalid chat identity');
    const identity=JSON.stringify([url.origin,s.roomId,s.lobbySeat]);
    if(identities.has(identity))throw Error('Duplicate server/room/seat');
    if(s.roster&&(!Array.isArray(s.roster)||s.roster.some(r=>!Number.isSafeInteger(r.chatPlayer)||r.chatPlayer<0||r.chatPlayer>=s.chatCount||!Number.isSafeInteger(r.gamePlayer)||r.gamePlayer<0)||!s.roster.some(r=>r.chatPlayer===s.chatPlayer&&r.gamePlayer===s.gamePlayer)))throw Error('Invalid roster');
    identities.add(identity);ids.add(s.id);
    return {...s,serverUrl:url.origin,settings:validateSettings(s.settings)};
  });
  const pollMs=c.pollMs??1000;
  if(!Number.isSafeInteger(pollMs)||pollMs<1000||pollMs>300000)throw Error('pollMs must be 1000..300000');
  return {storeDirectory:c.storeDirectory,seats,pollMs,live:true};
}
