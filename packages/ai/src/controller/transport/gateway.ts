import {DISPATCH_LOCK_MESSAGE} from '../../../../contracts/src/index.js';
import {ActivityFacts,type FactBaseline} from '../observation/activity-facts.js';
import type {
  PlayerObservation,
  ChatMessage,
  PlayerNotification,
} from "../../../../contracts/src/index.js";
import type { GameGateway, AiSnapshot } from "../contracts/types.js";
import { PLAYER_NAMES } from '../../../../contracts/src/index.js';
import {diagnosticText,errorDiagnostic,type ErrorDiagnostic} from '../../../../contracts/src/index.js';
import {randomUUID} from 'node:crypto';
import { attackRoutes,compareKnownObservations, type KnownPredictionDraft } from '../../../../prediction/src/index.js';

export interface GameRequestDiagnostic {
  requestId:string;method:string;path:string;origin:string;timeoutMs:number;elapsedMs:number;
  stage:'connect-or-send'|'read-response'|'validate-response'|'http-response';
  failure:string;outcome:'read-only'|'unknown'|'rejected';status?:number;contentType?:string;cause?:ErrorDiagnostic;
  code?:string;expectedRevision?:string;currentRevision?:string;
}
export class GameRequestError extends Error {
  constructor(readonly status: number, readonly observation?:PlayerObservation, readonly code?:string, readonly detail?:string,readonly diagnostic?:GameRequestDiagnostic) {
    super(code??(status === 409 ? observation?"stale-observation":"request-conflict" : `game-request-${status}`));
  }
  get displayReason(){
    if(this.code==='DISPATCH_SOURCE_LOCKED')return DISPATCH_LOCK_MESSAGE;
    const labels:Record<number,string>={401:'身份验证失败',403:'访问被拒绝',409:!this.code&&!!this.observation||['REVISION_CONFLICT','stale-observation'].includes(this.code??'')?'情报版本冲突':'请求冲突',429:'请求过于频繁',500:'服务端处理失败',503:'服务暂不可用'};
    return `玩家接口${this.diagnostic?` ${this.diagnostic.method} ${this.diagnostic.path}`:''}：HTTP ${this.status} ${labels[this.status]??'请求被拒绝'}${this.code?`（${diagnosticText(this.code,80)}）`:''}；请检查日志后恢复 AI。`;
  }
}
export class GameTransportError extends Error {
  constructor(readonly diagnostic?:GameRequestDiagnostic) {
    super("Game request outcome unknown");
  }
  get displayReason(){
    const d=this.diagnostic;if(!d)return '玩家接口连接失败，操作结果可能不明；请检查日志后恢复 AI。';
    if(d.failure==='accepted-write-followup-failed')return '游戏操作已提交，后续局势读取失败；保留回执并等待自动刷新、查账。';
    if(d.failure==='UNRESOLVED_OUTBOX')return '协议查账后仍有未核实的历史请求，暂未取得写入控制权；请查看启动失败记录和协议回执。旧请求不会自动重发。';
    if(d.failure==='COMMAND_PENDING')return '服务端已接收该请求，仍在处理；结果尚未确定，程序在恢复时查询权威回执。';
    if(d.failure==='FENCE_STALE')return '旧控制权已失效，已停止使用旧凭证；恢复前核对身份、当前租约与未决回执。';
    if(d.failure==='LEASE_LOST')return '执行会话已失效，已停止写入；恢复时将重新核验玩家身份、控制权与未决回执。';
    if(d.failure==='COMMAND_EFFECT_UNCONFIRMED')return '服务端回执尚未确认操作效果已提交，程序保留未知状态，在恢复时查询权威回执。';
    const labels:Record<string,string>={timeout:'请求超时','connection-refused':'连接被拒绝','connection-reset':'连接中断',dns:'域名解析失败',tls:'TLS连接失败',connection:'网络请求失败','invalid-json':'响应不是有效JSON','invalid-response':'响应结构无效','room-mismatch':'响应房间不匹配'};
    return `玩家接口 ${d.method} ${d.path}：${labels[d.failure]??'请求失败'}（${d.elapsedMs}ms）。${d.outcome==='read-only'?'本次为只读请求，请检查日志后恢复 AI。':'操作结果未确认，请核对回执后恢复 AI。'}`;
  }
}
export interface CompactGameError {
  code?:string;httpStatus?:number;requestId?:string;expectedRevision?:string;currentRevision?:string;
  outcome:GameRequestDiagnostic['outcome'];
  diagnostic?:{method:string;path:string;stage:GameRequestDiagnostic['stage'];failure:string;elapsedMs:number};
}
/** Small allowlisted evidence for receipts, not a copy of response bodies,
 * snapshots, headers or nested transport causes. Never changes retry policy. */
export function compactGameError(error:GameRequestError|GameTransportError,basis:{expectedRevision?:string;currentRevision?:string}={}):CompactGameError {
  const d=error.diagnostic,code=error instanceof GameRequestError?error.code??d?.code:d?.code;
  const status=error instanceof GameRequestError?error.status:d?.status;
  const expected=d?.expectedRevision??basis.expectedRevision,current=d?.currentRevision??(error instanceof GameRequestError?error.observation?.revision:undefined)??basis.currentRevision;
  return {
    ...(code?{code:diagnosticText(code,80)}:{}),
    ...(status!==undefined&&Number.isInteger(status)?{httpStatus:status}:{}),
    ...(d?.requestId?{requestId:diagnosticText(d.requestId,128)}:{}),
    ...(expected?{expectedRevision:diagnosticText(expected,128)}:{}),
    ...(current?{currentRevision:diagnosticText(current,128)}:{}),
    outcome:d?.outcome??(error instanceof GameRequestError?'rejected':'unknown'),
    ...(d?{diagnostic:{method:diagnosticText(d.method,12),path:diagnosticText(d.path.split(/[?#]/)[0]!,160),stage:d.stage,failure:diagnosticText(d.failure,80),elapsedMs:Number.isFinite(d.elapsedMs)?Math.max(0,d.elapsedMs):0}}:{}),
  };
}
export function isReadOnlyRequest(method:string,_path:string){return method==='GET';}
export function transportFailure(cause:ErrorDiagnostic,aborted:boolean):string{
  const codes=JSON.stringify(cause);
  return aborted||/TimeoutError|UND_ERR_\w*TIMEOUT|ETIMEDOUT/.test(codes)?'timeout':/ECONNREFUSED/.test(codes)?'connection-refused':/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(codes)?'connection-reset':/ENOTFOUND|EAI_AGAIN/.test(codes)?'dns':/CERT_|TLS|SSL/.test(codes)?'tls':'connection';
}
export class PlayerGateway implements GameGateway {
  private facts=new ActivityFacts();
  private controlSessionId:string|null=null;
  factBaseline(read:(current:PlayerObservation)=>FactBaseline|undefined){this.facts.baseline=read;}
  async forecastBatch(observation:PlayerObservation,scenarios:{id:string;targetTick:number;drafts:unknown[]}[]){
    return compareKnownObservations(observation,scenarios.map(s=>({...s,drafts:s.drafts as KnownPredictionDraft[]})));
  }
  async attackRoutes(observation:PlayerObservation,windows?:{attackTicks:number;localTicks:number;holdTicks:number}){
    return attackRoutes(observation,windows);
  }
  private async controlRequest(action:'acquire'|'renew',sessionId:string){
    const signal=this.options.signal?.();const response=await fetch(new URL('/player/v2/owner/control',this.baseUrl),{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json','X-Subterfuge-Control-Session':sessionId,Connection:'close'},body:JSON.stringify({action,sessionId}),redirect:'error',...(signal?{signal}:{})});
    const value=await response.json().catch(()=>({}));
    if(!response.ok||value.roomId!==this.roomId)throw new GameRequestError(response.status||503,undefined,typeof value.code==='string'?value.code:'control-lease-failed',typeof value.safeMessage==='string'?value.safeMessage:undefined);
    return value;
  }
  private async ensureControl(){
    const sessionId=this.controlSessionId??`local-ai-${randomUUID()}`;
    const signal=this.options.signal?.();const response=await fetch(new URL('/player/v2/owner/control',this.baseUrl),{headers:{Authorization:`Bearer ${this.token}`,'X-Subterfuge-Control-Session':sessionId,Connection:'close'},redirect:'error',...(signal?{signal}:{})});
    const status=await response.json().catch(()=>({}));
    if(!response.ok||status.roomId!==this.roomId)throw new GameRequestError(response.status||503,undefined,typeof status.code==='string'?status.code:'control-status-failed',typeof status.safeMessage==='string'?status.safeMessage:undefined);
    if(status.mode==='agent'){
      if(status.sessionId!==sessionId)throw new GameRequestError(409,undefined,'control-owned-by-another-executor');
      if(typeof status.expiresAt!=='number'||status.expiresAt-Date.now()<12000)await this.controlRequest('renew',sessionId);
    }else await this.controlRequest('acquire',sessionId);
    this.controlSessionId=sessionId;
  }
  constructor(
    private baseUrl: string,
    private token: string,
    private roomId: string,
    private chatPlayer: number,
    private chatCount: number,
    private roster?: { chatPlayer: number; gamePlayer: number }[],
    private options: { signal?: () => AbortSignal | undefined } = {},
  ) {}
  /** Version authority only: never changes the caller's owner/agent identity. */
  async manualCheck(version:number){
    const observation=await this.request('/tool/observation') as PlayerObservation;
    const expected=this.roster?.find(r=>r.chatPlayer===this.chatPlayer)?.gamePlayer??this.chatPlayer;
    if(observation.view.player!==expected)throw Error('Manual authority identity mismatch');
    if((observation.manualCommands?.version??0)!==version)throw new GameRequestError(409,observation,'manual-replan-required');
  }
  async request(path: string, data?: unknown): Promise<unknown> {
    const url=new URL(path,this.baseUrl),logicalPath=url.pathname,startedAt=Date.now(),timeoutMs=15000,requestId=randomUUID();
    if(url.origin!==new URL(this.baseUrl).origin)throw new GameRequestError(400,undefined,'unsupported-player-origin');
    let requestBody=data;
    if(logicalPath.startsWith('/tool/')){
      const owner='/player/v2/owner';
      const plain:Record<string,string>={'/tool/observation':'/observation','/tool/activity':'/activity','/tool/manual-commands':'/manual-commands','/tool/chat':'/chat','/tool/chat/search':'/chat/search','/tool/chat/seen':'/chat/seen','/tool/notifications':'/notifications','/tool/announcements':'/announcements','/tool/standings':'/standings'};
      if(plain[logicalPath])url.pathname=owner+plain[logicalPath]!;
      else if(logicalPath==='/tool/order'){
        url.pathname=`${owner}/commands`;
        if(data&&typeof data==='object'&&!Array.isArray(data)){
          const input=data as Record<string,unknown>,order=input.order as Record<string,unknown>|undefined;
          requestBody={kind:'order',clientCommandId:String(order?.id??''),expectedRevision:input.revision,payload:{action:order?.action}};
        }
      }else throw new GameRequestError(404,undefined,'unsupported-player-operation');
    }
    const method=requestBody===undefined?'GET':'POST';
    if(method==='POST'&&['/player/v2/owner/commands','/player/v2/owner/chat','/player/v2/owner/chat/seen'].includes(url.pathname))await this.ensureControl();
    const externalSignal=this.options.signal?.(),timeoutSignal=AbortSignal.timeout(timeoutMs);
    const expectedRevision=data&&typeof data==='object'&&'revision'in data&&typeof data.revision==='string'?diagnosticText(data.revision,128):undefined;
    const signal=externalSignal?AbortSignal.any([externalSignal,timeoutSignal]):timeoutSignal;
    const diagnostic=(stage:GameRequestDiagnostic['stage'],failure:string,r?:Response,cause?:ErrorDiagnostic):GameRequestDiagnostic=>({requestId,method,path:url.pathname,origin:url.origin,timeoutMs,elapsedMs:Math.max(0,Date.now()-startedAt),stage,failure,
      outcome:method==='GET'?'read-only':'unknown',...(expectedRevision?{expectedRevision}:{}),
      ...(r?{status:r.status,contentType:(r.headers.get('content-type')??'').split(';')[0]!.replace(/[^\w/+.-]/g,'').slice(0,80)}:{}),...(cause?{cause}:{})});
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          'X-Request-Id':requestId,

          ...(this.controlSessionId&&['/player/v2/owner/commands','/player/v2/owner/chat','/player/v2/owner/chat/seen'].includes(url.pathname)?{'X-Subterfuge-Controller':'agent','X-Subterfuge-Control-Session':this.controlSessionId}:{}),
          // Five-second observation polls can meet the server's idle socket
          // timeout. Do not reuse a closing connection for a game command.
          Connection:'close',
        },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        signal,
        redirect: "error",
      });
    } catch(error) {
      const cause=errorDiagnostic(error);
      throw new GameTransportError(diagnostic('connect-or-send',transportFailure(cause,signal.aborted),undefined,cause));
    }
    if (!r.ok) {
      let body,bodyError:ErrorDiagnostic|undefined;
      try{body=await r.json();}catch(error){bodyError=errorDiagnostic(error);}
      const fresh=body?.observation;
      if(r.status===409&&fresh&&fresh.roomId!==this.roomId)throw new GameTransportError(diagnostic('validate-response','room-mismatch',r));
      const observation=r.status===409&&fresh?.view&&typeof fresh.revision==='string'?fresh:undefined;
      const code=typeof body?.code==='string'?diagnosticText(body.code,80):undefined;
      throw new GameRequestError(r.status,observation,code,
        (r.status===400||r.status===409)&&typeof (body?.safeMessage??body?.message)==='string'?diagnosticText(body.safeMessage??body.message):undefined,
        {...diagnostic('http-response','http-error',r,bodyError),outcome:'rejected',...(code?{code}:{}),...(observation?{currentRevision:diagnosticText(observation.revision,128)}:{})});
    }
    let value;
    try {
      value = await r.json();
    } catch(error) {
      const cause=errorDiagnostic(error);
      throw new GameTransportError(diagnostic('read-response',signal.aborted||transportFailure(cause,false)==='timeout'?'timeout':cause.name==='SyntaxError'?'invalid-json':transportFailure(cause,false),r,cause));
    }
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.roomId!=='string')throw new GameTransportError(diagnostic('validate-response','invalid-response',r));
    if (value.roomId !== this.roomId) throw new GameTransportError(diagnostic('validate-response','room-mismatch',r));
    if(path==='/tool/observation'&&data===undefined)return this.facts.hydrate(value as PlayerObservation,(after,through)=>this.request(`/tool/activity?after=${after}&through=${through}&limit=100`),
      (after,limit)=>this.request(`/tool/manual-commands?after=${after}&limit=${limit}`));
    return value;
  }
  async snapshot(
    chatCursor: number,
    notificationCursor: number,
  ): Promise<AiSnapshot> {
    const observation = (await this.request(
      "/tool/observation",
    )) as PlayerObservation;
    // Bound each poll. Actionable chat advances after a completed thought; unread pages remain available.
    const chat = (await this.request(
      `/tool/chat?after=${chatCursor}&limit=100`,
    )) as { messages: ChatMessage[]; nextCursor: number; hasMore?:boolean };
    const notices = (await this.request(
      `/tool/notifications?after=${notificationCursor}&limit=100`,
    )) as { notifications: PlayerNotification[]; nextCursor: number; hasMore?:boolean };
    return {
      observation,
      hasMore:chat.hasMore===true||notices.hasMore===true,
      chat: chat.messages,
      notifications: notices.notifications,
      chatCursor: chat.nextCursor,
      notificationCursor: notices.nextCursor,
      chatPlayer: this.chatPlayer,
      chatCount: this.chatCount,
      roster: (this.roster ?? Array.from({length:this.chatCount},(_,player)=>({chatPlayer:player,gamePlayer:player})))
        .map(entry=>({...entry,displayName:PLAYER_NAMES[entry.chatPlayer]??`玩家 ${entry.chatPlayer+1}`})),
    };
  }
}
