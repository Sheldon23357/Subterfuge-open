import type {ProtocolCheckpointParticipant} from '../controller/transport/protocol-checkpoint.js';
import type {CommanderWorker} from '../controller/runtime/commander-worker.js';
import type {AgentDiagnostics} from '../controller/diagnostics/agent-diagnostics.js';
import type {SessionProvider} from './agent-provider.js';
import type {AgentSeatConfig} from '../controller/contracts/agent-config.js';
import type {AiStore} from '../controller/storage/store.js';
import type {SeatRunner} from './seat-runner.js';
import type {ProtocolPlayerGateway} from '../controller/transport/protocol-gateway.js';
import {createHash} from 'node:crypto';
export interface RuntimeEntry {checkpoint:ProtocolCheckpointParticipant|null;commander:CommanderWorker;diagnostics:AgentDiagnostics;capture:{enabled:boolean};token:string;provider:SessionProvider;config:AgentSeatConfig;store:AiStore;runner:SeatRunner;gateway:ProtocolPlayerGateway;lock:string;desired:boolean;active:Promise<void>|null;starting:Promise<void>|null;renewing:Promise<void>|null;stopping:Promise<void>|null;error:string|null}

export interface RuntimeEntry {foregroundOperation?:'observation'|'readiness';recoveryTimer?:ReturnType<typeof setTimeout>;recoveryAttempts?:number;watching?:Promise<void>;eventObservation?:Promise<void>;backgroundObservation?:Promise<void>;backgroundReadSignature?:string;reportedReadiness?:string;completedTick?:number;protocolWakeRevision?:number;observedProtocolWakeRevision?:number;observedBackgroundRevision?:number;backgroundEventRevision?:number;observedBackgroundEventRevision?:number}
export function agentStoreKey(config:AgentSeatConfig){return createHash('sha256').update(JSON.stringify([new URL(config.serverUrl).origin,config.roomId,config.lobbySeat,'live'])).digest('hex');}