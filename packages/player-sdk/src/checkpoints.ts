import {protocolIdentifier,protocolInteger,protocolObject,type ProtocolCheckpointAcknowledgement,type ProtocolScope} from '../../contracts/src/protocol-index.js';
export interface ProtocolCheckpointStatus {
  checkpointId:string;mode:'game-only'|'coordinated';roomEpoch:string;
  phase:'preparing'|'draining'|'freezing'|'publishing'|'resuming'|'completed'|'aborted';
  deadlineAtMs:number;finishedAtMs:number|null;reason:string|null;unsettledCommands:number;
  participant:null|{sessionId:string|null;supported:boolean;prepared:boolean;frozen:null|{receiptId:string;sha256:string};resumed:boolean;missing:null|'unsupported'|'prepare_timeout'|'freeze_timeout'|'resume_timeout'};
  summary:{participants:number;supported:number;prepared:number;frozen:number;resumed:number;missing:number};
}
export interface CheckpointAckOutboxEntry {scope:ProtocolScope;request:ProtocolCheckpointAcknowledgement;attempts:number;state:'prepared'|'unknown'|'confirmed'|'closed';reason:string|null}
export function parseCheckpointStatus(value:unknown):ProtocolCheckpointStatus|null {
  const envelope=protocolObject(value);if(envelope.checkpoint===null)return null;
  const v=protocolObject(envelope.checkpoint);protocolIdentifier(v.checkpointId);protocolIdentifier(v.roomEpoch);
  if(!['game-only','coordinated'].includes(String(v.mode))||!['preparing','draining','freezing','publishing','resuming','completed','aborted'].includes(String(v.phase)))throw Error('Invalid checkpoint phase');
  protocolInteger(v.deadlineAtMs,0,Number.MAX_SAFE_INTEGER);if(v.finishedAtMs!==null)protocolInteger(v.finishedAtMs,0,Number.MAX_SAFE_INTEGER);
  if(v.reason!==null&&(typeof v.reason!=='string'||v.reason.length>1000))throw Error('Invalid checkpoint reason');protocolInteger(v.unsettledCommands,0,Number.MAX_SAFE_INTEGER);
  const summary=protocolObject(v.summary);for(const field of ['participants','supported','prepared','frozen','resumed','missing'])protocolInteger(summary[field],0,Number.MAX_SAFE_INTEGER);
  if(v.participant!==null){const p=protocolObject(v.participant);if(p.sessionId!==null)protocolIdentifier(p.sessionId);for(const f of ['supported','prepared','resumed'])if(typeof p[f]!=='boolean')throw Error('Invalid checkpoint participant');if(p.missing!==null&&!['unsupported','prepare_timeout','freeze_timeout','resume_timeout'].includes(String(p.missing)))throw Error('Invalid checkpoint participant state');if(p.frozen!==null){const frozen=protocolObject(p.frozen);protocolIdentifier(frozen.receiptId);if(typeof frozen.sha256!=='string'||frozen.sha256.length!==64||!/^[a-f0-9]{64}$/.test(frozen.sha256))throw Error('Invalid checkpoint digest');}}
  return v as unknown as ProtocolCheckpointStatus;
}
export function checkpointAckMatches(status:ProtocolCheckpointStatus,request:ProtocolCheckpointAcknowledgement):boolean {
  if(status.checkpointId!==request.checkpointId||status.roomEpoch!==request.roomEpoch)return false;
  const p=status.participant;if(!p||p.sessionId!==request.sessionId)return false;
  return request.phase==='prepared'?p.prepared:request.phase==='resumed'?p.resumed:p.frozen!==null&&p.frozen.receiptId===request.receiptId&&p.frozen.sha256===request.sha256;
}
