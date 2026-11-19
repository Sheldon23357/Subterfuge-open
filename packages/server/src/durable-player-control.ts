import type {IncomingHttpHeaders} from 'node:http';
import {PlayerControl,PlayerControlError} from './player-control.js';
import {PlayerProtocolError} from './player-protocol-auth.js';
import type {PlayerProtocolRepository} from './player-protocol-store.js';
/** Trusted local facade over the same durable control fence used by v2. */
export class DurablePlayerControl extends PlayerControl {
 constructor(private repository:PlayerProtocolRepository){super();}
 private call<T>(run:()=>T):T{try{return run();}catch(error){if(error instanceof PlayerProtocolError)throw new PlayerControlError(error.status===400?400:409,error.message);throw error;}}
 override isExternal(roomId:string,player:number){return this.call(()=>this.repository.ownerIsExternal(roomId,player));}
 override status(roomId:string,player:number,headers:IncomingHttpHeaders={}){return this.call(()=>this.repository.ownerStatus(roomId,player,headers));}
 override command(roomId:string,player:number,input:Record<string,unknown>,headers:IncomingHttpHeaders={}){return this.call(()=>this.repository.ownerControl(roomId,player,input,headers));}
 override assertWrite(roomId:string,player:number,headers:IncomingHttpHeaders){return this.call(()=>this.repository.ownerAssertWrite(roomId,player,headers));}
 override reportReadiness(roomId:string,player:number,input:Record<string,unknown>,headers:IncomingHttpHeaders){return this.call(()=>this.repository.ownerReadiness(roomId,player,input,headers));}
 override readyToAdvance(roomId:string,player:number,revision:string,chatCursor:number,tick?:number){return this.call(()=>this.repository.ownerReadyToAdvance(roomId,player,revision,chatCursor,tick));}
}
