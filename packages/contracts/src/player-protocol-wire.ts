/** Public protocol primitives. No game engine, AI, storage or platform imports. */
import {parseDiplomacyAction} from './diplomacy.generated.js';
import type {CommanderThread} from './commander.js';
export const PLAYER_PROTOCOL_VERSION = { major: 2, minor: 0 } as const;
export const PLAYER_PROTOCOL_LIMITS = {
  requestBytes: 65_536, responsePageBytes: 262_144, jsonDepth: 32,
  counterDigits: 78, eventPageSize: 200, lookupBatchSize: 100,
  snapshotTtlMs: 60_000, snapshotsPerPlayer: 2, snapshotBytes: 8_388_608,
  acceptedCommandMs: 30_000, leaseDefaultMs: 30_000, leaseMinMs: 1_000, leaseMaxMs: 120_000,
} as const;
export type ProtocolCounter = string;
/** playerId is an opaque stable authorization subject, never a numeric seat or lobby index. */
export interface ProtocolScope { serverId: string; roomId: string; roomEpoch: string; playerId: string }
export interface ProtocolOwnerCommanderView {
 scope:ProtocolScope;
 thread:CommanderThread;
 proposals:{proposalId:string;baseVersion:ProtocolCounter;contentDigest:string;status:string;text:string}[];
}
export type ProtocolErrorCode = 'INVALID_REQUEST'|'UNAUTHORIZED'|'SCOPE_DENIED'|'IDENTITY_MISMATCH'|'PROTOCOL_INCOMPATIBLE'|'UNSUPPORTED_OPERATION'|'ROOM_EPOCH_CHANGED'|'LEASE_LOST'|'FENCE_STALE'|'CONTROL_BUSY'|'REVISION_CONFLICT'|'INSTRUCTIONS_CHANGED'|'IDEMPOTENCY_CONFLICT'|'RESYNC_REQUIRED'|'SNAPSHOT_EXPIRED'|'RATE_LIMITED'|'STORAGE_UNAVAILABLE'|'SERVER_RESTARTED'|'COMMAND_EXPIRED'|'MANUAL_COMMAND_CONFLICT'|'DISPATCH_SOURCE_LOCKED'|'BATCH_NOT_EXECUTED';
export interface ProtocolErrorBody { code: ProtocolErrorCode; category: 'permanent'|'authorization'|'ownership'|'replan'|'resync'|'transient'; outcome: 'read-only'|'rejected'|'unknown'; safeMessage: string; requestId: string; retryAfterMs?: number }
export interface ProtocolIdentity extends ProtocolScope { gamePlayer: number; lobbySeat: number; chatPlayer: number; chatCount: number; roster: {chatPlayer:number;gamePlayer:number}[] }
export type ExecutorScope = 'observe'|'events.read'|'commands.write'|'control.lease'|'chat.send'|'commander.worker';
export const EXECUTOR_SCOPES: readonly ExecutorScope[] = ['observe','events.read','commands.write','control.lease','chat.send','commander.worker'];
export interface ProtocolHelloRequest { supportedVersions: {major:number;minor:number}[]; requiredCapabilities: string[]; optionalCapabilities: string[]; executorInstanceId: string }
export interface ProtocolHelloResponse { scope: ProtocolScope; identity: ProtocolIdentity; sessionId: string; version: typeof PLAYER_PROTOCOL_VERSION; capabilities: string[]; authorizationVersion: ProtocolCounter; serverTime: string; limits: typeof PLAYER_PROTOCOL_LIMITS; rulesetId: string; rulesetVersion:string; observationSchema:string; commandSchema:string }
export interface ProtocolCommandRequest {
  roomEpoch: string; sessionId: string; fence: ProtocolCounter; authorizationVersion: ProtocolCounter;
  idempotencyKey: string; clientCommandId: string; expectedRevision: string; instructionsVersion: ProtocolCounter;
  actionBasis?:string;
  kind: 'order'|'order-batch'|'schedule'|'cancel-schedule'|'chat-send'|'chat-seen'|'readiness'; payload: Record<string, unknown>;
}
export interface ProtocolCommanderRequest {roomEpoch:string;sessionId:string;authorizationVersion:ProtocolCounter;idempotencyKey:string;clientCommandId:string;instructionsVersion:ProtocolCounter;kind:'commander-worker';payload:Record<string,unknown>}
export type ProtocolMutationRequest=ProtocolCommandRequest|ProtocolCommanderRequest;
export interface ProtocolCheckpointAcknowledgement {checkpointId:string;roomEpoch:string;sessionId:string;authorizationVersion:ProtocolCounter;phase:'prepared'|'frozen'|'resumed';receiptId?:string;sha256?:string}
export interface ProtocolReceipt {
  scope: ProtocolScope; commandId: string; idempotencyKey: string; clientCommandId: string;
  intentDigest: string; state: 'accepted'|'applied'|'scheduled'|'rejected'|'cancelled'; receiptVersion: ProtocolCounter;
  effectCommitted: boolean; createdAt: string; updatedAt: string;
  code?: ProtocolErrorCode; effects?: {agreementId?:string;agreementStatus?:string;orderId?:string;scheduleId?:string;messageId?:string;instructionsVersion?:ProtocolCounter;decisionInputVersion?:string;ready?:boolean;batchReceipts?:ProtocolReceipt[]};
  scheduleOutcome?: 'pending'|'fired'|'cancelled'|'failed';
}
export interface LedgerCoverage { roomEpoch: string; authoritative: boolean; retained: 'complete'|'unavailable'; queryUntil: string|null }
export type ProtocolLookup = {status:'found';receipt:ProtocolReceipt;coverage:LedgerCoverage}|{status:'absent_within_retained_scope'|'history_unavailable';idempotencyKey:string;coverage:LedgerCoverage};
export interface ProtocolEvent { scope: ProtocolScope; streamEpoch: string; seq: ProtocolCounter; cursor: string; type: string; schemaVersion: 1; required: boolean; payload: Record<string,unknown> }
export interface ProtocolEventPage { scope: ProtocolScope; streamEpoch: string; inputCursor: string; nextCursor: string; hasMore: boolean; coverage: {fromExclusive:ProtocolCounter;toInclusive:ProtocolCounter}; events: ProtocolEvent[] }
export interface ProtocolLease { scope: ProtocolScope; generation: ProtocolCounter; mode: 'manual'|'agent'; sessionId: string|null; expiresAt: string|null; ttlMs: number|null; remainingTtlMs:number; programmaticAutoAdvance?:boolean }

export interface ProtocolControlOperationReceipt {operationResult:ProtocolLease;current:ProtocolLease}
export class ProtocolValidationError extends Error {}
export interface ProtocolSnapshotPage {scope:ProtocolScope;snapshotId:string;bootstrapExpiresAt:string;streamEpoch:string;highWatermark:ProtocolCounter;cursor:string;decisionInputVersion:string;snapshotDigest:string;page:{index:number;count:number;encoding:'json-text/1';text:string;nextPageToken:string|null}}
/** Atomic authorized live cut; null document means the supplied cursor is current. */
export interface ProtocolSync {scope:ProtocolScope;streamEpoch:string;highWatermark:ProtocolCounter;cursor:string;decisionInputVersion:string;document:Record<string,unknown>|null;control:ProtocolLease}
export interface ProtocolBatchCommandResponse {receipt:ProtocolReceipt;snapshot:ProtocolSnapshotPage}

export function protocolObject(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolValidationError('Expected a JSON object');
  return value as Record<string,unknown>;
}
export function protocolFields(value: Record<string,unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))) throw new ProtocolValidationError('Unknown or missing request field');
}
export function protocolString(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new ProtocolValidationError('Invalid protocol string');
  assertUnicode(value); return value;
}
export function protocolIdentifier(value: unknown): string {
  const text=protocolString(value); if (/[^A-Za-z0-9._:-]/.test(text)) throw new ProtocolValidationError('Invalid protocol identifier'); return text;
}
export function protocolCounter(value: unknown): ProtocolCounter {
  if (typeof value !== 'string' || value.length > PLAYER_PROTOCOL_LIMITS.counterDigits || !/^(0|[1-9][0-9]*)$/.test(value) || /[^0-9]/.test(value)) throw new ProtocolValidationError('Invalid decimal counter');
  return value;
}
export function incrementProtocolCounter(value: ProtocolCounter): ProtocolCounter { const next=(BigInt(protocolCounter(value))+1n).toString();if(next.length>PLAYER_PROTOCOL_LIMITS.counterDigits)throw Error('Protocol counter exhausted');return next; }
export function compareProtocolCounters(a: ProtocolCounter,b: ProtocolCounter) { const left=BigInt(protocolCounter(a)),right=BigInt(protocolCounter(b)); return left<right?-1:left>right?1:0; }
export function protocolInteger(value: unknown, min: number, max: number): number {
  if (typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) throw new ProtocolValidationError('Invalid bounded integer');return value;
}
export function parseProtocolHello(value:unknown): ProtocolHelloRequest {
  const v=protocolObject(value); protocolFields(v,['supportedVersions','requiredCapabilities','optionalCapabilities','executorInstanceId']);
  if(!Array.isArray(v.supportedVersions)||!v.supportedVersions.length||v.supportedVersions.length>8)throw new ProtocolValidationError('Invalid protocol versions');
  const supportedVersions=v.supportedVersions.map(raw=>{const r=protocolObject(raw);protocolFields(r,['major','minor']);return{major:protocolInteger(r.major,1,1000),minor:protocolInteger(r.minor,0,1000)};});
  const caps=(raw:unknown)=>{if(!Array.isArray(raw)||raw.length>32)throw new ProtocolValidationError('Invalid capabilities');const result=raw.map(c=>protocolString(c,100));if(new Set(result).size!==result.length)throw new ProtocolValidationError('Duplicate capability');return result;};
  return{supportedVersions,requiredCapabilities:caps(v.requiredCapabilities),optionalCapabilities:caps(v.optionalCapabilities),executorInstanceId:protocolIdentifier(v.executorInstanceId)};
}
/** Syntax mirrors engine/fleet-scenario.ts action(), not a new gameplay policy. */
export const PROTOCOL_PLAYER_ACTIONS=['resign','check-in','cancel-inactivity-warning','launch','cancel-launch','return-fleet','toggle-mine','set-shields','toggle-funding','propose-agreement','respond-agreement'] as const;
export function parseProtocolAction(value:unknown):Record<string,unknown>{
 const a=protocolObject(value),kind=a.kind;
 const id=(name:string)=>protocolString(a[name]);
 switch(kind){
  case 'propose-agreement':case 'respond-agreement':
   try{return parseDiplomacyAction(a) as unknown as Record<string,unknown>;}catch(e){throw new ProtocolValidationError(e instanceof Error?e.message:'Invalid diplomacy action');}
  case 'resign':case 'check-in':case 'cancel-inactivity-warning':protocolFields(a,['kind']);break;
  case 'cancel-launch':case 'return-fleet':protocolFields(a,['kind','fleetId']);id('fleetId');break;
  case 'toggle-mine':protocolFields(a,['kind','outpostId']);id('outpostId');break;
  case 'set-shields':protocolFields(a,['kind','outpostId','enabled']);id('outpostId');if(typeof a.enabled!=='boolean')throw new ProtocolValidationError('Expected boolean');break;
  case 'toggle-funding':protocolFields(a,['kind','recipient']);protocolInteger(a.recipient,0,9);break;
  case 'launch':protocolFields(a,['kind','source','destination','drillers'],['delaySeconds','fleetId']);id('source');id('destination');protocolInteger(a.drillers,1,1e9);
   if(a.delaySeconds!==undefined)protocolInteger(a.delaySeconds,0,86400);if(a.fleetId!==undefined)id('fleetId');
   break;
  default:throw new ProtocolValidationError('Unsupported player action');
 }
 return a;
}
export function parseProtocolCommand(value:unknown): ProtocolCommandRequest {
  const v=protocolObject(value);protocolFields(v,['roomEpoch','sessionId','fence','authorizationVersion','idempotencyKey','clientCommandId','expectedRevision','instructionsVersion','kind','payload'],['actionBasis']);
  if(typeof v.kind!=='string'||!['order','order-batch','schedule','cancel-schedule','chat-send','chat-seen','readiness'].includes(v.kind))throw new ProtocolValidationError('Unsupported command kind');
  const revision=protocolString(v.expectedRevision,64);if(!/^[0-9a-f]{64}$/.test(revision))throw new ProtocolValidationError('Invalid observation revision');
  const payload={...protocolObject(v.payload)};if(v.kind==='chat-send'){protocolFields(payload,['id','to','text']);protocolString(payload.id);protocolString(payload.text,2000);if(payload.to!==null){const targets=Array.isArray(payload.to)?payload.to:[payload.to];if(!targets.length||targets.length>9||new Set(targets).size!==targets.length)throw new ProtocolValidationError('Invalid chat recipients');for(const target of targets)protocolInteger(target,0,9);}}
  else if(v.kind==='chat-seen'){protocolFields(payload,['conversation','through']);protocolString(payload.conversation,128);protocolInteger(payload.through,0,Number.MAX_SAFE_INTEGER);}
  else if(v.kind==='readiness'){protocolFields(payload,['ready'],['tick']);if(typeof payload.ready!=='boolean'||!payload.ready&&payload.tick!==undefined)throw new ProtocolValidationError('Invalid readiness tick');if(payload.ready)protocolInteger(payload.tick,0,Number.MAX_SAFE_INTEGER);}
  else if(v.kind==='order-batch'){
    protocolFields(payload,['commands']);if(!Array.isArray(payload.commands)||payload.commands.length<1||payload.commands.length>8)throw new ProtocolValidationError('Invalid order batch');
    const keys=new Set([v.idempotencyKey]),ids=new Set([v.clientCommandId]);
    payload.commands=payload.commands.map(raw=>{const item=protocolObject(raw);if(item.kind!=='order')throw new ProtocolValidationError('Batch children must be orders');
      const command=parseProtocolCommand(item);for(const key of ['roomEpoch','sessionId','fence','authorizationVersion','instructionsVersion','expectedRevision'] as const)if(command[key]!==v[key])throw new ProtocolValidationError('Batch child authority or basis differs');
      if(keys.has(command.idempotencyKey)||ids.has(command.clientCommandId))throw new ProtocolValidationError('Duplicate batch child identity');keys.add(command.idempotencyKey);ids.add(command.clientCommandId);return command;});
  }
  else if(v.kind==='cancel-schedule'){protocolFields(payload,['id']);protocolString(payload.id);}else{protocolFields(payload,v.kind==='schedule'?['action','issueTick']:['action']);parseProtocolAction(payload.action);if(v.kind==='schedule')protocolInteger(payload.issueTick,0,Number.MAX_SAFE_INTEGER);}
  if(v.actionBasis!==undefined&&(v.kind!=='order'||typeof v.actionBasis!=='string'||v.actionBasis.length!==64||! /^[0-9a-f]{64}$/.test(v.actionBasis)||!['launch','return-fleet'].includes(String(protocolObject(payload.action).kind))||(protocolObject(payload.action).kind==='launch'&&(protocolObject(payload.action).delaySeconds??0)!==0)))throw new ProtocolValidationError('Invalid action basis');
  return{roomEpoch:protocolIdentifier(v.roomEpoch),sessionId:protocolIdentifier(v.sessionId),fence:protocolCounter(v.fence),authorizationVersion:protocolCounter(v.authorizationVersion),idempotencyKey:protocolIdentifier(v.idempotencyKey),clientCommandId:protocolIdentifier(v.clientCommandId),expectedRevision:revision,instructionsVersion:protocolCounter(v.instructionsVersion),...(v.actionBasis===undefined?{}:{actionBasis:v.actionBasis as string}),kind:v.kind as ProtocolCommandRequest['kind'],payload};
}
/** Discussion workers have a separate, non-gameplay authority lane but share the durable operation ledger. */
export function parseProtocolCommander(value:unknown):ProtocolCommanderRequest{
 const v=protocolObject(value);protocolFields(v,['roomEpoch','sessionId','authorizationVersion','idempotencyKey','clientCommandId','instructionsVersion','kind','payload']);if(v.kind!=='commander-worker')throw new ProtocolValidationError('Invalid discussion operation');
 const p=protocolObject(v.payload);if(p.op==='notice'){protocolFields(p,['op','id','reply']);protocolIdentifier(p.id);protocolString(p.reply,1500);}
 else if(p.op==='ack'){protocolFields(p,['op','version','reply']);protocolInteger(p.version,0,Number.MAX_SAFE_INTEGER);protocolString(p.reply,1500);}
 else{protocolFields(p,['op','messageId','reply'],['proposal','error']);if(p.op!=='reply'||p.error!==undefined&&typeof p.error!=='boolean')throw new ProtocolValidationError('Invalid discussion reply');protocolIdentifier(p.messageId);protocolString(p.reply,2000);if(p.proposal!==undefined){if(p.error)throw new ProtocolValidationError('Failed reply cannot propose instructions');const proposal=protocolObject(p.proposal);protocolFields(proposal,['baseVersion','text','summary']);protocolInteger(proposal.baseVersion,0,Number.MAX_SAFE_INTEGER);if(typeof proposal.text!=='string'||proposal.text.length>6000)throw new ProtocolValidationError('Invalid instructions');assertUnicode(proposal.text);protocolString(proposal.summary,500);}}
 return{roomEpoch:protocolIdentifier(v.roomEpoch),sessionId:protocolIdentifier(v.sessionId),authorizationVersion:protocolCounter(v.authorizationVersion),idempotencyKey:protocolIdentifier(v.idempotencyKey),clientCommandId:protocolIdentifier(v.clientCommandId),instructionsVersion:protocolCounter(v.instructionsVersion),kind:'commander-worker',payload:p};
}
/** The logical key indexes this immutable intent; request IDs and key itself do not change its digest. */
export function protocolCommandIntent(scope:ProtocolScope, request:ProtocolMutationRequest) { const {idempotencyKey:_,...intent}=request;return{scope,...intent}; }

function assertUnicode(text:string) {
  for(let i=0;i<text.length;i++) { const unit=text.charCodeAt(i);if(unit>=0xd800&&unit<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw new ProtocolValidationError('Unpaired Unicode surrogate');}else if(unit>=0xdc00&&unit<=0xdfff)throw new ProtocolValidationError('Unpaired Unicode surrogate'); }
}
/** RFC 8785 JCS for the strict I-JSON subset: UTF-16 key order, ECMAScript binary64 serialization, no Unicode normalization. */
export function canonicalProtocolJson(value:unknown):string {
  const seen=new Set<object>();
  const encode=(v:unknown,depth:number):string=>{
    if(depth>PLAYER_PROTOCOL_LIMITS.jsonDepth)throw new ProtocolValidationError('JSON depth limit exceeded');
    if(v===null)return'null';if(typeof v==='boolean')return String(v);
    if(typeof v==='string'){assertUnicode(v);return JSON.stringify(v);}
    if(typeof v==='number'){if(!Number.isFinite(v))throw new ProtocolValidationError('Non-finite JSON number');return JSON.stringify(v);}
    if(typeof v!=='object'||seen.has(v))throw new ProtocolValidationError('Not a JSON value');
    if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw new ProtocolValidationError('Not a JSON object');
    seen.add(v);let result:string;
    if(Array.isArray(v))result='['+Array.from(v,item=>encode(item,depth+1)).join(',')+']';
    else result='{'+Object.keys(v).sort().map(key=>{assertUnicode(key);return JSON.stringify(key)+':'+encode((v as Record<string,unknown>)[key],depth+1);}).join(',')+'}';
    seen.delete(v);return result;
  };return encode(value,0);
}
/** JSON.parse alone silently accepts duplicate keys. This bounded parser does not. */
export function parseStrictProtocolJson(text:string,maxBytes:number=PLAYER_PROTOCOL_LIMITS.requestBytes):unknown {
  if(new TextEncoder().encode(text).byteLength>maxBytes)throw new ProtocolValidationError('JSON byte limit exceeded');
  let at=0;const whitespace=()=>{while(at<text.length&&/[\x20\t\r\n]/.test(text[at]!))at++;};
  const string=()=>{const start=at++;for(;at<text.length;at++){const char=text[at]!;if(char==='"'){at++;const value=JSON.parse(text.slice(start,at)) as string;assertUnicode(value);return value;}if(char==='\\')at++;else if(char.charCodeAt(0)<32)throw new ProtocolValidationError('Invalid JSON string');}throw new ProtocolValidationError('Unterminated JSON string');};
  const value=(depth:number):unknown=>{
    if(depth>PLAYER_PROTOCOL_LIMITS.jsonDepth)throw new ProtocolValidationError('JSON depth limit exceeded');whitespace();const char=text[at];
    if(char==='"')return string();
    if(char==='{'||char==='['){at++;whitespace();const isObject=char==='{',end=isObject?'}':']',entries:unknown[]=[],object:Record<string,unknown>={},keys=new Set<string>();if(text[at]===end){at++;return isObject?object:entries;}
      while(true){whitespace();if(isObject){if(text[at]!=='"')throw new ProtocolValidationError('Object key expected');const key=string();if(keys.has(key))throw new ProtocolValidationError('Duplicate JSON object key');keys.add(key);whitespace();if(text[at++]!==':')throw new ProtocolValidationError('Colon expected');Object.defineProperty(object,key,{value:value(depth+1),enumerable:true,writable:true,configurable:true});}else entries.push(value(depth+1));whitespace();if(text[at]===end){at++;return isObject?object:entries;}if(text[at++]!==',')throw new ProtocolValidationError('Comma expected');}
    }
    for(const [literal,result] of [['true',true],['false',false],['null',null]] as const)if(text.startsWith(literal,at)){at+=literal.length;return result;}
    const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));if(!number)throw new ProtocolValidationError('Invalid JSON value');at+=number[0].length;const parsed=Number(number[0]);if(!Number.isFinite(parsed))throw new ProtocolValidationError('Non-finite JSON number');return parsed;
  };const parsed=value(0);whitespace();if(at!==text.length)throw new ProtocolValidationError('Trailing JSON content');return parsed;
}

/** A checkpoint acknowledgement contains opaque local-state evidence, never a path or uploaded private state. */
export function parseProtocolCheckpointAcknowledgement(value:unknown):ProtocolCheckpointAcknowledgement{const v=protocolObject(value);if(!['prepared','frozen','resumed'].includes(String(v.phase)))throw new ProtocolValidationError('Invalid checkpoint phase');protocolFields(v,['checkpointId','roomEpoch','sessionId','authorizationVersion','phase',...(v.phase==='frozen'?['receiptId','sha256']:[])]);const result:ProtocolCheckpointAcknowledgement={checkpointId:protocolIdentifier(v.checkpointId),roomEpoch:protocolIdentifier(v.roomEpoch),sessionId:protocolIdentifier(v.sessionId),authorizationVersion:protocolCounter(v.authorizationVersion),phase:v.phase as ProtocolCheckpointAcknowledgement['phase']};if(v.phase==='frozen'){result.receiptId=protocolIdentifier(v.receiptId);if(typeof v.sha256!=='string'||v.sha256.length!==64||!/^[a-f0-9]{64}$/.test(v.sha256))throw new ProtocolValidationError('Invalid opaque checkpoint digest');result.sha256=v.sha256;}return result;}
