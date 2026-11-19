import type { IncomingHttpHeaders } from 'node:http';

export class PlayerControlError extends Error {
  constructor(readonly status: 400|409, message: string) { super(message); }
}
type Lease = {sessionId:string;expiresAt:number;readiness?:{revision:string;chatCursor:number}};
/** Ephemeral fencing only, never authentication. Call inside the room write queue.
 * Explicit external control disables trusted local writers for the lifetime of this room.
 */
export class PlayerControl {
  private seats = new Map<string,{lease?:Lease;external:boolean;retired:Set<string>}>();
  constructor(private now:()=>number=Date.now) {}
  private key(roomId:string,player:number) { return JSON.stringify([roomId,player]); }
  private seat(roomId:string,player:number) {
    const key=this.key(roomId,player);
    let state=this.seats.get(key);
    if(!state){state={external:false,retired:new Set()};this.seats.set(key,state);}
    if(state.lease&&state.lease.expiresAt<=this.now()){state.retired.add(state.lease.sessionId);delete state.lease;}
    return state;
  }
  isExternal(roomId:string,player:number) { return this.seat(roomId,player).external; }
  status(roomId:string,player:number,headers:IncomingHttpHeaders={}) {
    const state=this.seat(roomId,player),lease=state.lease;
    return {protocol:'player-control/2' as const,roomId,player,mode:lease?'agent' as const:'manual' as const,
      expiresAt:lease?.expiresAt??null,sessionId:lease&&headers['x-subterfuge-control-session']===lease.sessionId?lease.sessionId:null,
      manualCommandsAllowed:true};
  }
  command(roomId:string,player:number,input:Record<string,unknown>,headers:IncomingHttpHeaders={}) {
    const {action,sessionId,ttlMs,mode}=input;
    if(Object.keys(input).some(k=>!['action','sessionId','ttlMs','mode'].includes(k)))throw new PlayerControlError(400,'Invalid control fields');
    if(!['acquire','renew','release','takeover'].includes(action as string))throw new PlayerControlError(400,'Invalid control action');
    const needsSession=action!=='takeover'||mode==='agent';
    if(needsSession&&(typeof sessionId!=='string'||! /^[a-zA-Z0-9_-]{16,128}$/.test(sessionId)))throw new PlayerControlError(400,'Invalid control session');
    if(action==='takeover'&&mode!=='agent'&&mode!=='manual'||action!=='takeover'&&mode!==undefined)throw new PlayerControlError(400,'Invalid control mode');
    if((action==='release'||action==='takeover'&&mode==='manual')&&ttlMs!==undefined)throw new PlayerControlError(400,'Invalid control duration');
    if(action==='takeover'&&mode==='manual'&&sessionId!==undefined)throw new PlayerControlError(400,'Invalid control session');
    const ttl=ttlMs??30000;
    if(!Number.isInteger(ttl)||Number(ttl)<1000||Number(ttl)>120000)throw new PlayerControlError(400,'Invalid control duration');
    const state=this.seat(roomId,player);
    if(action==='acquire'&&state.lease&&state.lease.sessionId!==sessionId)throw new PlayerControlError(409,'Player control is owned by another agent');
    if((action==='renew'||action==='release')&&state.lease?.sessionId!==sessionId)throw new PlayerControlError(409,'Player control lease is no longer owned');
    if(needsSession&&state.retired.has(sessionId as string))throw new PlayerControlError(409,'Control session is retired; use a new session');
    if(state.lease&&(action==='release'||action==='takeover'&&state.lease.sessionId!==sessionId))state.retired.add(state.lease.sessionId);
    state.external=true;
    if(action==='release'||action==='takeover'&&mode==='manual')delete state.lease;
    else state.lease={sessionId:sessionId as string,expiresAt:this.now()+Number(ttl),...(action==='renew'&&state.lease?.readiness?{readiness:state.lease.readiness}:{})};
    return this.status(roomId,player,{...headers,'x-subterfuge-control-session':sessionId as string|undefined});
  }
  assertWrite(roomId:string,player:number,headers:IncomingHttpHeaders) {
    const state=this.seat(roomId,player),mode=headers['x-subterfuge-controller'],session=headers['x-subterfuge-control-session'];
    if(mode!==undefined&&mode!=='agent'&&mode!=='manual')throw new PlayerControlError(400,'Invalid controller');
    if(mode==='agent'||session!==undefined){
      if(mode!=='agent'||typeof session!=='string'||!state.lease||state.lease.sessionId!==session)throw new PlayerControlError(409,'An active owned agent lease is required');
    }
  }
  reportReadiness(roomId:string,player:number,input:Record<string,unknown>,headers:IncomingHttpHeaders){
    this.assertWrite(roomId,player,headers);
    if(headers['x-subterfuge-controller']!=='agent')throw new PlayerControlError(409,'Only the owned agent can report readiness');
    const lease=this.seat(roomId,player).lease!;
    if(typeof input.ready!=='boolean'||Object.keys(input).some(k=>!['ready','revision','chatCursor'].includes(k))||input.ready&&(typeof input.revision!=='string'||! /^[a-f0-9]{64}$/.test(input.revision)||!Number.isSafeInteger(input.chatCursor)||Number(input.chatCursor)<0)||!input.ready&&(input.revision!==undefined||input.chatCursor!==undefined))throw new PlayerControlError(400,'Invalid readiness');
    if(input.ready)lease.readiness={revision:input.revision as string,chatCursor:input.chatCursor as number};else delete lease.readiness;
  }
  readyToAdvance(roomId:string,player:number,revision:string,chatCursor:number,_tick?:number){
    const ready=this.seat(roomId,player).lease?.readiness;
    return !!ready&&ready.revision===revision&&ready.chatCursor===chatCursor;
  }
}
