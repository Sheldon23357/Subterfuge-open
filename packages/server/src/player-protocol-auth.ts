import {createHash,timingSafeEqual} from 'node:crypto';
import type {ExecutorScope,ProtocolErrorCode,ProtocolErrorBody} from '../../contracts/src/index.js';
export class PlayerProtocolError extends Error {
  constructor(readonly code:ProtocolErrorCode,readonly status:number,message:string,readonly category:ProtocolErrorBody['category']='permanent',readonly outcome:ProtocolErrorBody['outcome']='rejected'){super(message);}
}
export interface ProtocolPrincipal { grantId:string;roomId:string;roomEpoch:string;player:number;scopes:ExecutorScope[];authorizationVersion:string }
/** Authentication never trusts controller/worker headers, requested seats or a client label. */
export function executorTokenHash(header:unknown):string|null {
  if(typeof header!=='string'||/^Bearer [A-Za-z0-9_-]{32,256}$/.exec(header)?.[0]!==header)return null;
  return createHash('sha256').update(header.slice(7),'utf8').digest('hex');
}
export function sameTokenHash(a:string,b:string){return a.length===64&&b.length===64&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export function requireExecutorScope(principal:ProtocolPrincipal,scope:ExecutorScope){if(!principal.scopes.includes(scope))throw new PlayerProtocolError('SCOPE_DENIED',403,'This grant does not authorize that operation','authorization');}
