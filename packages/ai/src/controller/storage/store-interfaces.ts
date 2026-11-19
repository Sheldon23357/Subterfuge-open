import { MemoryEvidence } from './memory-evidence.js';
import { ReviewReceipt } from './memory-consistency.js';
import { NotebookQuery } from './memory-records.js';
import { AiState } from "../contracts/types.js";
import { PlayerObservation } from '../../../../contracts/src/index.js';
import { AiReminder } from '../contracts/types.js';
import { NotebookEntry } from '../contracts/types.js';
import { MiningPhaseHistory } from '../analysis/mining-phase.js';
export type PerformanceTimingKind='protocol-request-timing'|'runtime-poll-timing'|'runtime-readiness-timing';

/** Capability contracts. SQLite implements these; contracts never derive from its class. */
export interface PrivateStateRepository {
recordTiming(room:string,seat:number,kind:PerformanceTimingKind,details:unknown):void;
load(room: string, seat: number): AiState | null;
save(state: AiState, kind?: string, details?: unknown, expectedBasis?: string): void;
saveEvents(state: AiState, events: {
        kind: string;
        details: unknown;
    }[], localId?: string, expectedBasis?: string, options?: {
        preserveMemory?: boolean;
    }): AiState;
saveLocalEvents(state: AiState, id: string, events: {
        kind: string;
        details: unknown;
    }[], expectedBasis?: string): AiState;
localWriteBasis(room: string, seat: number): string;
localDecisionView(room: string, seat: number, seconds: number): {
        state: AiState | null;
        notebook: NotebookEntry[];
        reminders: AiReminder[];
        basis: string;
    };
notebook(room: string, seat: number, now: number): NotebookEntry[];
queryNotebook(room: string, seat: number, now: number, q: NotebookQuery): {
        historical: boolean;
        entries: NotebookEntry[];
        nextCursor: number | null;
    } | {
        historical: boolean;
        entries: {
            cursor: number;
            kind: string;
            entry: unknown;
        }[];
        nextCursor: number | null;
    };
latestNotebookEntry(room: string, seat: number, id: string): NotebookEntry | undefined;
notebookDependencyHistory(room: string, seat: number, now: number): import("./notebook-dependencies.js").NotebookDependencySummary[];
reminders(room: string, seat: number): AiReminder[];
memoryReviews(room: string, seat: number): ReviewReceipt[];
}
export interface ReceiptEvidenceReader {
baseline(room: string, seat: number): PlayerObservation | null;
latest<T>(room: string, seat: number, kind: string): T | null;
history(room: string, seat: number, limit?: number): {
        kind: string;
        payload: unknown;
    }[];
historyPage(room: string, seat: number, before?: number): {
        entries: {
            kind: string;
            payload: unknown;
            id: number;
        }[];
        nextCursor: number | null;
    };
queryResult(room: string, seat: number, id: string, detail?: boolean): unknown;
comparisonEvidence(room: string, seat: number, resultRef: string, planId: string): import('../../../../prediction/src/index.js').KnownDefenseEvidence | null;
arrivalEstimates(room: string, seat: number): import('../observation/arrival-coalescing.js').ArrivalEstimates | null;
pendingWriteEvidence(room: string, seat: number, ids: readonly string[]): {
        evidence: {
            error?: {} | null;
            kind: string;
            result: {};
        } | {
            kind: string;
        };
        meaning: string;
        arguments?: {} | null;
        basisRevision?: string;
        id: string;
        tool: string;
        status: string;
        intentRecorded: boolean;
    }[];
observeManualCommands(room: string, seat: number, observation: PlayerObservation): boolean;
observeMiningPhase(room: string, seat: number, o: PlayerObservation): {
        stage: import("../analysis/mining-phase.js").MiningPhase | null;
        currentMilestone: import("../analysis/mining-phase.js").MiningPhase | null;
        history: MiningPhaseHistory | null;
        publicRosterComplete: boolean;
        missingPlayers: number[];
        goal: number | null;
        lateThreshold: number | null;
        maximumKnownNeptunium: number | null;
        leaderPlayers: number[];
        leaderProgress: number | null;
        self: {
            player: number;
            neptunium: number;
            progress: number | null;
            mines: number;
            position: string;
            staticVictoryWorldDays: number | null;
        };
        fastestKnownOpponent: {
            player: number;
            worldDays: number;
        } | null;
        interpretation: string;
    } | null;
manualReviewedReceiptIds(room: string, seat: number): string[];
pendingManualFacts(room: string, seat: number): import('../../../../contracts/src/index.js').ManualCommandReceipt[];
manualReceipt(room: string, seat: number, id: string): import('../../../../contracts/src/index.js').ManualCommandReceipt | undefined;
observedFleetIds(room: string, seat: number, reference: string): string[];
memoryEvidence(room: string, seat: number, reference: string): MemoryEvidence | undefined;
hasMemoryEvidence(room: string, seat: number, reference: string): boolean;
modeReceipt?(room: string, seat: number, kind: string, id: string): {
        requestId: string;
        receipt: unknown;
    } | undefined;
}
export interface SeatLifecycleRepository {
endSeat(state: AiState, observation: PlayerObservation): void;
}
export interface DiagnosticReadModel {
debugActionRows(room:string,seat:number):{round:number|null;tick:number|null;intent:unknown;events:{kind:string;payload:unknown}[]}[];
debugRows(room: string, seat: number, q?: {
        before?: number;
        after?: number;
        limit?: number;
        kinds?: string[];
        sequence?: number;
        from?: number;
        to?: number;
    }): {
        entries: {
            id: number;
            kind: string;
            payload: unknown;
            unavailable: boolean;
        }[];
        nextCursor: number | null;
    };
debugStrategyCalls(room: string, seat: number, eventKind:string, q: {
        before: number;
        after: number;
        limit: number;
        from?: number;
        to?: number;
    }): {
        entries: {
            id: number;
            payload: unknown;
            unavailable: boolean;
        }[];
        nextCursor: number | null;
    };
debugGetStrategyCall(room: string, seat: number, ref: number, eventKind:string): unknown;
debugGetCall(room: string, seat: number, callRef: number): unknown;
debugCallTrail(room: string, seat: number, callRef: number): Record<string, unknown>[];
debugReadTransaction<T>(read: () => T): T;
debugStatsRows(room: string, seat: number, before?: number, limit?: number): {
        entries: {
            id: number;
            payload: {
                sequence: unknown;
                step: unknown;
                attempt: unknown;
                promptContext: unknown;
                promptTools: {
                    results: {
                        total: unknown;
                    };
                    measurement: unknown;
                };
            };
            capture: {
                round: unknown;
                step: unknown;
                attempt: unknown;
                durationMs: unknown;
                usage: unknown;
                promptReceiptBreakdown: unknown;
                promptDecisionBreakdown?: unknown;
            } | null;
            promptBytes: number | null;
        }[];
        nextCursor: number | null;
    };
debugStatsPrompt(room: string, seat: number, callRef: number, maxBytes: number): string | null;
debugToolUsageRows(room: string, seat: number, after: number): {
        id: number;
        kind: string;
        sequence: unknown;
        logicalId: unknown;
        tool: unknown;
    }[];
debugExecutionRows(room: string, seat: number, after: number): {
        id: number;
        kind: string;
        metrics: unknown[];
    }[];
debugModelFailureRows(room: string, seat: number, after: number): {
        id: number;
        kind: string;
        metrics: unknown[];
    }[];
debugEntityPage(room: string, seat: number, entity: 'notebook' | 'reminders', before?: number, limit?: number, includeClosed?: boolean): {
        entries: {
            id: number;
            kind: string;
            payload: unknown;
            unavailable: boolean;
        }[];
        nextCursor: number | null;
    };
debugGetEvent(room: string, seat: number, id: number): unknown;
debugRoundBounds(room: string, seat: number, sequence: number): {
        after: number;
        before: number;
    } | null;
latest<T>(room: string, seat: number, kind: string): T | null;
baseline(room: string, seat: number): PlayerObservation | null;
notebook(room: string, seat: number, now: number): NotebookEntry[];
}
export interface DiagnosticCaptureRepository {
debugPutCall(room: string, seat: number, callRef: number, payload: unknown): void;
}
export interface CommanderRepository {
localWriteBasis(room:string,seat:number):string;
observeManualCommands(room:string,seat:number,observation:PlayerObservation):boolean;
load(room: string, seat: number): AiState | null;
save(state: AiState, kind?: string, details?: unknown, expectedBasis?: string): void;
saveEvents(state: AiState, events: {
        kind: string;
        details: unknown;
    }[], localId?: string, expectedBasis?: string, options?: {
        preserveMemory?: boolean;
    }): AiState;
localDecisionView(room: string, seat: number, seconds: number): {
        state: AiState | null;
        notebook: NotebookEntry[];
        reminders: AiReminder[];
        basis: string;
    };
pendingCommanderCleanup(room: string, seat: number): {
        requestId: string;
        cleanup: import('../../../../contracts/src/index.js').CommanderCleanup;
    } | null;
observeMiningPhase(room: string, seat: number, o: PlayerObservation): {
        stage: import("../analysis/mining-phase.js").MiningPhase | null;
        currentMilestone: import("../analysis/mining-phase.js").MiningPhase | null;
        history: MiningPhaseHistory | null;
        publicRosterComplete: boolean;
        missingPlayers: number[];
        goal: number | null;
        lateThreshold: number | null;
        maximumKnownNeptunium: number | null;
        leaderPlayers: number[];
        leaderProgress: number | null;
        self: {
            player: number;
            neptunium: number;
            progress: number | null;
            mines: number;
            position: string;
            staticVictoryWorldDays: number | null;
        };
        fastestKnownOpponent: {
            player: number;
            worldDays: number;
        } | null;
        interpretation: string;
    } | null;
queryResult(room: string, seat: number, id: string, detail?: boolean): unknown;
latest<T>(room: string, seat: number, kind: string): T | null;
notebook(room: string, seat: number, now: number): NotebookEntry[];
}
export type DecisionRepository=PrivateStateRepository & ReceiptEvidenceReader;
export type RunnerRepository=DecisionRepository & SeatLifecycleRepository;
export type PendingWriteEvidence=ReturnType<ReceiptEvidenceReader["pendingWriteEvidence"]>[number];
