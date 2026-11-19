import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {PlayerProtocolClientError} from '../../../../player-sdk/src/index.js';
import type {AgentSeatConfig} from '../contracts/agent-config.js';

export interface OwnerDelegationRecord {
  format:'owner-delegation/1';origin:string;roomId:string;lobbySeat:number;ownerHash:string;
  roomEpoch:string;grantId:string;token:string;expiresAtMs:number;state:'prepared'|'registered';
}
export interface OwnerDelegationStore {
  loadDelegation?():OwnerDelegationRecord|null;
  saveDelegation?(record:OwnerDelegationRecord):void;
}
export function parseOwnerDelegation(raw:unknown):OwnerDelegationRecord {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid private delegation');
  const r=raw as OwnerDelegationRecord;
  if(Object.keys(r).sort().join(',')!=='expiresAtMs,format,grantId,lobbySeat,origin,ownerHash,roomEpoch,roomId,state,token'||r.format!=='owner-delegation/1'||typeof r.origin!=='string'||new URL(r.origin).origin!==r.origin||typeof r.roomId!=='string'||!r.roomId||!Number.isSafeInteger(r.lobbySeat)||r.lobbySeat<0||r.lobbySeat>9||! /^[a-f0-9]{64}$/.test(r.ownerHash)||typeof r.roomEpoch!=='string'||!r.roomEpoch||typeof r.grantId!=='string'||! /^[A-Za-z0-9._:-]{1,200}$/.test(r.grantId)||! /^[a-f0-9]{64}$/.test(r.token)||!Number.isSafeInteger(r.expiresAtMs)||r.expiresAtMs<=0||!['prepared','registered'].includes(r.state))throw Error('Invalid private delegation');
  return structuredClone(r);
}

/** Owner credentials authorize setup only. The SDK sends the delegated token.
 * A durable prepared grant retries the identical registration after interruption.
 * Registered grants are never replaced automatically after revocation or expiry. */
export class OwnerDelegation {
  private record:OwnerDelegationRecord|null;
  private pending:Promise<string>|null=null;
  private readonly ownerHash:string;
  constructor(private config:AgentSeatConfig,private ownerToken:string,private store:OwnerDelegationStore,private fetcher:typeof fetch){
    this.ownerHash=createHash('sha256').update(ownerToken).digest('hex');
    this.record=store.loadDelegation?.()??null;
    if(this.record&&(this.record.origin!==config.serverUrl||this.record.roomId!==config.roomId||this.record.lobbySeat!==config.lobbySeat||this.record.ownerHash!==this.ownerHash))throw Error('Private delegation belongs to a different owner binding');
  }
  token(){if(this.record?.state==='registered')return Promise.resolve(this.record.token);if(!this.pending)this.pending=this.register().finally(()=>{this.pending=null;});return this.pending;}
  private save(record:OwnerDelegationRecord){const checked=parseOwnerDelegation(record);this.store.saveDelegation?.(checked);this.record=checked;}
  private async request(path:string,data?:unknown,prefix='/player/v2/owner/'){
    const response=await this.fetcher(new URL(prefix+path,this.config.serverUrl),{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.ownerToken,Accept:'application/json','Content-Type':'application/json',Connection:'close'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok){await response.body?.cancel();throw new PlayerProtocolClientError('OWNER_DELEGATION_REJECTED','rejected',response.status);}
    const reader=response.body?.getReader();if(!reader)throw Error('Missing delegation response');const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>65536)throw Error('Delegation response exceeds limit');chunks.push(next.value);}}finally{await reader.cancel();}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid delegation response');return value as Record<string,unknown>;
  }
  private async register(){
    if(!this.record){
      if(this.config.lobbyConnection){
        const lobby=await this.request('',undefined,'/lobby/v2');
        if(lobby.roomId!==this.config.roomId||lobby.player!==this.config.lobbySeat)throw Error('Delegation lobby identity changed');
        if(lobby.status==='waiting')throw new PlayerProtocolClientError('GAME_NOT_STARTED','read-only',409);
      }
      const identity=await this.request('identity'),serverNow=typeof identity.serverTime==='string'?Date.parse(identity.serverTime):NaN;
      if(identity.roomId!==this.config.roomId||identity.lobbySeat!==this.config.lobbySeat||typeof identity.roomEpoch!=='string'||!identity.roomEpoch||!Number.isSafeInteger(identity.gamePlayer)||Number(identity.gamePlayer)<0||Number(identity.gamePlayer)>9||!Number.isFinite(serverNow))throw Error('Owner delegation identity changed');
      if(this.config.lobbyConnection)this.config.gamePlayer=Number(identity.gamePlayer);else if(identity.gamePlayer!==this.config.gamePlayer)throw Error('Owner delegation player changed');
      this.save({format:'owner-delegation/1',origin:this.config.serverUrl,roomId:this.config.roomId,lobbySeat:this.config.lobbySeat,ownerHash:this.ownerHash,roomEpoch:identity.roomEpoch,grantId:'controller-'+randomUUID(),token:randomBytes(32).toString('hex'),expiresAtMs:serverNow+30*86400000,state:'prepared'});
    }
    const record=this.record!;
    const grant=await this.request('grants',{grantId:record.grantId,tokenHash:createHash('sha256').update(record.token).digest('hex'),scopes:['observe','events.read','commands.write','control.lease','chat.send','commander.worker'],expiresAtMs:record.expiresAtMs});
    if(grant.grantId!==record.grantId||!grant.scope||typeof grant.scope!=='object'||(grant.scope as Record<string,unknown>).roomId!==record.roomId||(grant.scope as Record<string,unknown>).roomEpoch!==record.roomEpoch)throw Error('Delegation registration identity changed');
    this.save({...record,state:'registered'});return record.token;
  }
}
