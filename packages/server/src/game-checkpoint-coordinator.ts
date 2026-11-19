import { randomUUID } from "node:crypto";
import {
  PlayerProtocolError,
  type ProtocolPrincipal,
  requireExecutorScope,
} from "./player-protocol-auth.js";
import type { PlayerProtocolRepository } from "./player-protocol-store.js";
import type { SerialExecutor } from "./player-access.js";
import type {
  CheckpointCoordinationManifest,
  GameOnlyCheckpointManifest,
} from "./game-only-checkpoint.js";

type Phase =
  | "preparing"
  | "draining"
  | "freezing"
  | "publishing"
  | "resuming"
  | "completed"
  | "aborted";
type Receipt = { receiptId: string; sha256: string };
type Participant = {
  player: number;
  playerId: string;
  grantId: string | null;
  sessionId: string | null;
  supported: boolean;
  prepared: boolean;
  frozen?: Receipt;
  resumed: boolean;
  missing?:
    | "unsupported"
    | "prepare_timeout"
    | "freeze_timeout"
    | "resume_timeout";
};
interface RecordState {
  checkpointId: string;
  mode: "game-only" | "coordinated";
  roomEpoch: string;
  attemptId: string;
  phase: Phase;
  createdAtMs: number;
  deadlineAtMs: number;
  participants: Participant[];
  unsettledCommands: number;
  result?: GameOnlyCheckpointManifest;
  reason?: string;
  finishedAtMs?: number;
}
interface State {
  format: "game-checkpoints/1";
  activeId: string | null;
  records: { [id: string]: RecordState };
}
export interface GameCheckpointTimeouts {
  prepareMs: number;
  drainMs: number;
  freezeMs: number;
  publishMs?: number;
  resumeMs: number;
}
export interface GameCheckpointOptions {
  repository: PlayerProtocolRepository;
  roomId: () => string;
  serial: SerialExecutor;
  head: () => { tick: number; revision: number };
  publish: (
    metadata: CheckpointCoordinationManifest,
    signal: AbortSignal,
    beforePublish: () => void,
  ) => Promise<GameOnlyCheckpointManifest>;
  now?: () => number;
  timeouts?: GameCheckpointTimeouts;
  /** Run on the shared serial queue immediately before a new pause, never for replay/recovery. */
  beforePause?: () => void | Promise<void>;
  /** Synchronous same-connection callback; resume the world clock without consuming the paused interval. */
  resumeClock?: (pausedAtMs: number, resumedAtMs: number) => void;
}
const empty = (): State => ({
  format: "game-checkpoints/1",
  activeId: null,
  records: {},
});
const terminal = (phase: Phase) => phase === "completed" || phase === "aborted";
const identifier = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(value)
  )
    throw new PlayerProtocolError(
      "INVALID_REQUEST",
      400,
      "Invalid checkpoint identifier",
    );
  return value;
};
function decode(payload: string): State {
  const value = JSON.parse(payload) as State;
  if (
    !value ||
    value.format !== "game-checkpoints/1" ||
    !value.records ||
    typeof value.records !== "object" ||
    Array.isArray(value.records) ||
    Object.keys(value).sort().join(",") !== "activeId,format,records" ||
    (value.activeId !== null && typeof value.activeId !== "string") ||
    Object.keys(value.records).length > 512
  )
    throw Error("Invalid checkpoint coordinator state");
  for (const [id, record] of Object.entries(value.records)) {
    if (
      identifier(id) !== record.checkpointId ||
      !["game-only", "coordinated"].includes(record.mode) ||
      typeof record.roomEpoch !== "string" ||
      typeof record.attemptId !== "string" ||
      ![
        "preparing",
        "draining",
        "freezing",
        "publishing",
        "resuming",
        "completed",
        "aborted",
      ].includes(record.phase) ||
      !Number.isSafeInteger(record.createdAtMs) ||
      !Number.isSafeInteger(record.deadlineAtMs) ||
      !Array.isArray(record.participants) ||
      record.participants.length > 10 ||
      !Number.isInteger(record.unsettledCommands) ||
      record.unsettledCommands < 0
    )
      throw Error("Invalid checkpoint record");
    for (const p of record.participants)
      if (
        !Number.isInteger(p.player) ||
        p.player < 0 ||
        p.player > 9 ||
        typeof p.playerId !== "string" ||
        typeof p.supported !== "boolean" ||
        typeof p.prepared !== "boolean" ||
        typeof p.resumed !== "boolean" ||
        (p.grantId !== null && typeof p.grantId !== "string") ||
        (p.sessionId !== null && typeof p.sessionId !== "string") ||
        (p.frozen &&
          (typeof p.frozen.receiptId !== "string" ||
            !/^[a-f0-9]{64}$/.test(p.frozen.sha256)))
      )
        throw Error("Invalid checkpoint participant");
  }
  if (
    value.activeId !== null &&
    (!Object.hasOwn(value.records, value.activeId) ||
      terminal(value.records[value.activeId]!.phase))
  )
    throw Error("Invalid active checkpoint");
  return value;
}
function document(repository: PlayerProtocolRepository, roomId: string) {
  const doc = repository.domainDocument(
    () => repository.currentEpoch(roomId),
    "checkpoint",
    "coordinator",
  );
  if (doc.read() === null) doc.initialize(JSON.stringify(empty()), null);
  return doc;
}
function event(
  repository: PlayerProtocolRepository,
  roomId: string,
  record: RecordState,
  type: string,
) {
  for (const p of repository.checkpointParticipants(roomId))
    repository.domainEvent(
      roomId,
      p.player,
      type,
      {
        checkpointId: record.checkpointId,
        phase: record.phase,
        deadlineAtMs: record.deadlineAtMs,
      },
      false,
      false,
    );
}
/** Restart never restores an indefinite freeze. The old receipt record remains queryable. */
export function recoverGameCheckpointCoordinator(
  repository: PlayerProtocolRepository,
  roomId: string,
  now: () => number = Date.now,
  reason: "server_restart" | "restored_clone" = "server_restart",
) {
  return repository.atomic(() =>
    document(repository, roomId).transact((payload) => {
      const state = decode(payload),
        id = state.activeId;
      if (id) {
        const record = state.records[id]!;
        record.phase = record.result ? "completed" : "aborted";
        if (record.result)
          for (const participant of record.participants)
            if (participant.frozen && !participant.resumed)
              participant.missing = "resume_timeout";
        record.reason = reason;
        record.finishedAtMs = now();
        state.activeId = null;
        event(repository, roomId, record, "checkpoint.resumed");
      }
      return { payload: JSON.stringify(state), result: undefined };
    }),
  );
}

/** Same-database coordination metadata, not a remote AI state store. */
export class GameCheckpointCoordinator {
  private now: () => number;
  private timeouts: Required<GameCheckpointTimeouts>;
  private running = new Map<
    string,
    {
      mode: "game-only" | "coordinated";
      promise: Promise<GameOnlyCheckpointManifest>;
      abort: AbortController;
    }
  >();
  private closed = false;
  constructor(private options: GameCheckpointOptions) {
    this.now = options.now ?? Date.now;
    this.timeouts = {
      prepareMs: 5000,
      drainMs: 5000,
      freezeMs: 5000,
      publishMs: 5000,
      resumeMs: 2000,
      ...options.timeouts,
    };
    for (const duration of Object.values(this.timeouts))
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120000)
        throw Error("Invalid checkpoint phase duration");
    options.repository.atomic(() => {
      const state = this.state(),
        active = state.activeId ? state.records[state.activeId] : undefined;
      recoverGameCheckpointCoordinator(
        options.repository,
        options.roomId(),
        this.now,
      );
      if (active) options.resumeClock?.(active.createdAtMs, this.now());
    });
  }
  private state() {
    return decode(
      document(this.options.repository, this.options.roomId()).read()!,
    );
  }
  private update<T>(change: (state: State) => T): T {
    return this.options.repository.atomic(() =>
      document(this.options.repository, this.options.roomId()).transact(
        (payload) => {
          const state = decode(payload),
            result = change(state);
          return { payload: JSON.stringify(state), result };
        },
      ),
    );
  }
  private active(id: string, attempt: string) {
    const state = this.state(),
      record = state.records[id];
    if (
      state.activeId !== id ||
      !record ||
      record.attemptId !== attempt ||
      record.roomEpoch !==
        this.options.repository.currentEpoch(this.options.roomId()) ||
      terminal(record.phase)
    )
      throw new PlayerProtocolError(
        "CONTROL_BUSY",
        409,
        "Checkpoint attempt is no longer active",
        "transient",
      );
    return record;
  }
  private expire() {
    const state = this.state(),
      record = state.activeId ? state.records[state.activeId] : undefined;
    if (
      record &&
      this.now() > record.deadlineAtMs &&
      !this.running.has(record.checkpointId)
    )
      this.finish(
        record.checkpointId,
        record.attemptId,
        "aborted",
        "phase_timeout",
      );
  }
  isPaused() {
    this.expire();
    return this.state().activeId !== null;
  }
  assertMutationAllowed(kind: string, stage: "admit" | "settle" = "admit") {
    this.expire();
    const state = this.state(),
      active = state.activeId ? state.records[state.activeId] : undefined;
    if (!active) return;
    if (
      (active.phase === "preparing" || active.phase === "draining") &&
      (stage === "settle" ||
        [
          "commander-worker",
          "readiness",
          "status",
          "control-renew",
          "control-release",
        ].includes(kind))
    )
      return;
    throw new PlayerProtocolError(
      "CONTROL_BUSY",
      409,
      "Checkpoint write barrier is active",
      "transient",
    );
  }
  current(principal: ProtocolPrincipal, checkpointId?: string) {
    return this.options.repository.atomic(() => {
      // Even read-only history must recheck the live grant after queueing.
      if (principal.roomId !== this.options.roomId())
        throw new PlayerProtocolError(
          "IDENTITY_MISMATCH",
          403,
          "Checkpoint belongs to another room",
          "authorization",
        );
      requireExecutorScope(principal, "observe");
      this.options.repository.stream(principal);
      this.expire();
      const state = this.state(),
        id =
          checkpointId === undefined
            ? state.activeId
            : identifier(checkpointId);
      if (!id) return { checkpoint: null };
      const record = Object.hasOwn(state.records, id)
        ? state.records[id]
        : undefined;
      if (!record)
        throw new PlayerProtocolError(
          "INVALID_REQUEST",
          404,
          "Checkpoint not found",
        );
      const subject = this.options.repository.scope(
          principal.roomId,
          principal.roomEpoch,
          principal.player,
        ).playerId,
        p = record.participants.find((entry) => entry.playerId === subject);
      return {
        checkpoint: {
          checkpointId: record.checkpointId,
          mode: record.mode,
          roomEpoch: record.roomEpoch,
          phase: record.phase,
          deadlineAtMs: record.deadlineAtMs,
          finishedAtMs: record.finishedAtMs ?? null,
          reason: record.reason ?? null,
          unsettledCommands: record.unsettledCommands,
          participant: p
            ? {
                sessionId: p.sessionId,
                supported: p.supported,
                prepared: p.prepared,
                frozen: p.frozen ?? null,
                resumed: p.resumed,
                missing: p.missing ?? null,
              }
            : null,
          summary: {
            participants: record.participants.length,
            supported: record.participants.filter((x) => x.supported).length,
            prepared: record.participants.filter((x) => x.prepared).length,
            frozen: record.participants.filter((x) => !!x.frozen).length,
            resumed: record.participants.filter((x) => x.resumed).length,
            missing: record.participants.filter((x) => !!x.missing).length,
          },
        },
      };
    });
  }
  ack(principal: ProtocolPrincipal, input: Record<string, unknown>) {
    return this.options.repository.atomic(() => {
      if (principal.roomId !== this.options.roomId())
        throw new PlayerProtocolError(
          "IDENTITY_MISMATCH",
          403,
          "Checkpoint belongs to another room",
          "authorization",
        );
      const allowed = [
        "checkpointId",
        "roomEpoch",
        "sessionId",
        "authorizationVersion",
        "phase",
        ...(input.phase === "frozen" ? ["receiptId", "sha256"] : []),
      ];
      if (
        Object.keys(input).length !== allowed.length ||
        Object.keys(input).some((key) => !allowed.includes(key)) ||
        !["prepared", "frozen", "resumed"].includes(String(input.phase))
      )
        throw new PlayerProtocolError(
          "INVALID_REQUEST",
          400,
          "Invalid checkpoint acknowledgement",
        );
      const checkpointId = identifier(input.checkpointId),
        roomEpoch = identifier(input.roomEpoch),
        sessionId = identifier(input.sessionId);
      if (typeof input.authorizationVersion !== "string")
        throw new PlayerProtocolError(
          "INVALID_REQUEST",
          400,
          "Invalid authorization version",
        );
      this.options.repository.assertReadSession(principal, {
        roomEpoch,
        sessionId,
        authorizationVersion: input.authorizationVersion,
      });
      const receipt =
        input.phase === "frozen"
          ? { receiptId: identifier(input.receiptId), sha256: input.sha256 }
          : undefined;
      if (
        receipt &&
        (typeof receipt.sha256 !== "string" ||
          receipt.sha256.length !== 64 ||
          !/^[a-f0-9]{64}$/.test(receipt.sha256))
      )
        throw new PlayerProtocolError(
          "INVALID_REQUEST",
          400,
          "Invalid checkpoint digest",
        );
      this.update((state) => {
        const record = Object.hasOwn(state.records, checkpointId)
          ? state.records[checkpointId]
          : undefined;
        if (!record)
          throw new PlayerProtocolError(
            "INVALID_REQUEST",
            404,
            "Checkpoint not found",
          );
        const p = record.participants.find(
          (entry) =>
            entry.player === principal.player &&
            entry.grantId === principal.grantId &&
            entry.sessionId === sessionId,
        );
        if (!p || record.roomEpoch !== roomEpoch || !p.supported)
          throw new PlayerProtocolError(
            "SCOPE_DENIED",
            403,
            "Session is not a checkpoint participant",
            "authorization",
          );
        // A committed ack can be recovered/replayed after later phases/checkpoints.
        if (
          (input.phase === "prepared" && p.prepared) ||
          (input.phase === "resumed" && p.resumed)
        )
          return;
        if (input.phase === "frozen" && p.frozen) {
          if (
            p.frozen.receiptId !== receipt!.receiptId ||
            p.frozen.sha256 !== receipt!.sha256
          )
            throw new PlayerProtocolError(
              "IDEMPOTENCY_CONFLICT",
              409,
              "Checkpoint acknowledgement has different content",
            );
          return;
        }
        const phase =
          input.phase === "prepared"
            ? "preparing"
            : input.phase === "frozen"
              ? "freezing"
              : "resuming";
        if (
          state.activeId !== checkpointId ||
          record.phase !== phase ||
          this.now() >= record.deadlineAtMs
        )
          throw new PlayerProtocolError(
            "CONTROL_BUSY",
            409,
            "Checkpoint acknowledgement arrived outside its phase",
            "transient",
          );
        if (input.phase === "prepared") p.prepared = true;
        else if (input.phase === "frozen") {
          if (!p.prepared)
            throw new PlayerProtocolError(
              "CONTROL_BUSY",
              409,
              "Checkpoint participant did not prepare",
              "transient",
            );
          p.frozen = receipt as Receipt;
        } else {
          if (!p.frozen)
            throw new PlayerProtocolError(
              "CONTROL_BUSY",
              409,
              "Checkpoint participant did not freeze",
              "transient",
            );
          p.resumed = true;
        }
        this.options.repository.domainEvent(
          this.options.roomId(),
          principal.player,
          "checkpoint.acknowledged",
          { checkpointId, phase: input.phase },
          false,
          false,
        );
      });
      return this.current(principal, checkpointId);
    });
  }
  save(
    checkpointId: string,
    mode: "game-only" | "coordinated" = "game-only",
  ): Promise<GameOnlyCheckpointManifest> {
    identifier(checkpointId);
    if (!["game-only", "coordinated"].includes(mode))
      return Promise.reject(Error("Invalid checkpoint mode"));
    if (this.closed)
      return Promise.reject(Error("Checkpoint coordinator is closed"));
    const running = this.running.get(checkpointId);
    if (running) {
      if (running.mode !== mode)
        return Promise.reject(
          new PlayerProtocolError(
            "IDEMPOTENCY_CONFLICT",
            409,
            "Checkpoint ID has a different intent",
          ),
        );
      return running.promise;
    }
    const abort = new AbortController(),
      promise = this.run(checkpointId, mode, abort).finally(() => {
        this.running.delete(checkpointId);
      });
    this.running.set(checkpointId, { mode, promise, abort });
    return promise;
  }
  private async wait(
    id: string,
    attempt: string,
    duration: number,
    complete: (record: RecordState) => boolean,
    abort: AbortSignal,
  ) {
    const deadline = performance.now() + duration;
    while (true) {
      if (abort.aborted) throw Error("Checkpoint interrupted");
      const ready = await this.options.serial.run(() =>
        complete(this.active(id, attempt)),
      );
      if (ready) return true;
      if (
        performance.now() >= deadline ||
        this.now() >= this.active(id, attempt).deadlineAtMs
      )
        return false;
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(20, Math.max(1, deadline - performance.now())),
        ),
      );
    }
  }
  private phase(
    id: string,
    attempt: string,
    phase: Phase,
    duration: number,
    change?: (record: RecordState) => void,
  ) {
    this.active(id, attempt);
    return this.update((state) => {
      const record = state.records[id]!;
      change?.(record);
      record.phase = phase;
      record.deadlineAtMs = this.now() + duration;
      event(
        this.options.repository,
        this.options.roomId(),
        record,
        phase === "resuming"
          ? "checkpoint.resumed"
          : "checkpoint.phase.changed",
      );
      return record;
    });
  }
  private finish(
    id: string,
    attempt: string,
    phase: "completed" | "aborted",
    reason?: string,
  ) {
    this.update((state) => {
      const record = state.records[id];
      if (
        !record ||
        record.attemptId !== attempt ||
        terminal(record.phase) ||
        state.activeId !== id
      )
        return;
      record.phase = phase;
      if (reason) record.reason = reason;
      record.finishedAtMs = this.now();
      state.activeId = null;
      this.options.resumeClock?.(record.createdAtMs, this.now());
      event(
        this.options.repository,
        this.options.roomId(),
        record,
        "checkpoint.resumed",
      );
    });
  }
  private async run(
    id: string,
    mode: "game-only" | "coordinated",
    abort: AbortController,
  ): Promise<GameOnlyCheckpointManifest> {
    let attempt = "";
    try {
      const begun = await this.options.serial.run(async () => {
        const current = this.state();
        if (!Object.hasOwn(current.records, id) && current.activeId === null)
          await this.options.beforePause?.();
        if (abort.signal.aborted) throw Error("Checkpoint interrupted");
        return this.update((state) => {
          const prior = Object.hasOwn(state.records, id)
            ? state.records[id]
            : undefined;
          if (prior) {
            if (prior.mode !== mode)
              throw new PlayerProtocolError(
                "IDEMPOTENCY_CONFLICT",
                409,
                "Checkpoint ID has a different intent",
              );
            if (prior.phase === "completed" && prior.result)
              return { done: prior.result };
            throw new PlayerProtocolError(
              "CONTROL_BUSY",
              409,
              "Checkpoint ID is already used; query its durable status",
              "transient",
            );
          }
          if (state.activeId)
            throw new PlayerProtocolError(
              "CONTROL_BUSY",
              409,
              "Another checkpoint is active",
              "transient",
            );
          if (Object.keys(state.records).length >= 512)
            throw new PlayerProtocolError(
              "RATE_LIMITED",
              429,
              "Checkpoint record retention limit reached",
              "transient",
            );
          const record: RecordState = {
            checkpointId: id,
            mode,
            roomEpoch: this.options.repository.currentEpoch(
              this.options.roomId(),
            ),
            attemptId: randomUUID(),
            phase: "preparing",
            createdAtMs: this.now(),
            deadlineAtMs: this.now() + this.timeouts.prepareMs,
            participants:
              mode === "game-only"
                ? []
                : this.options.repository
                    .checkpointParticipants(this.options.roomId())
                    .map((p) => ({
                      ...p,
                      supported: !!p.sessionId,
                      prepared: false,
                      resumed: false,
                      ...(!p.sessionId
                        ? { missing: "unsupported" as const }
                        : {}),
                    })),
            unsettledCommands: 0,
          };
          state.records[id] = record;
          state.activeId = id;
          event(
            this.options.repository,
            this.options.roomId(),
            record,
            "checkpoint.phase.changed",
          );
          return { record };
        });
      });
      if ("done" in begun) return begun.done!;
      attempt = begun.record!.attemptId;
      await this.wait(
        id,
        attempt,
        this.timeouts.prepareMs,
        (r) => r.participants.every((p) => !p.supported || p.prepared),
        abort.signal,
      );
      await this.options.serial.run(() =>
        this.phase(id, attempt, "draining", this.timeouts.drainMs, (r) => {
          for (const p of r.participants)
            if (p.supported && !p.prepared) p.missing = "prepare_timeout";
        }),
      );
      const drained = await this.wait(
        id,
        attempt,
        this.timeouts.drainMs,
        () =>
          this.options.repository.pendingCommands(this.options.roomId()) === 0,
        abort.signal,
      );
      if (!drained && mode === "coordinated")
        throw Error("Checkpoint drain deadline exceeded");
      await this.options.serial.run(() =>
        this.phase(id, attempt, "freezing", this.timeouts.freezeMs, (r) => {
          r.unsettledCommands = this.options.repository.pendingCommands(
            this.options.roomId(),
          );
        }),
      );
      await this.wait(
        id,
        attempt,
        this.timeouts.freezeMs,
        (r) => r.participants.every((p) => !p.prepared || !!p.frozen),
        abort.signal,
      );
      const metadata = await this.options.serial.run(() => {
        const record = this.phase(
            id,
            attempt,
            "publishing",
            this.timeouts.publishMs,
            (r) => {
              for (const p of r.participants)
                if (p.prepared && !p.frozen) p.missing = "freeze_timeout";
            },
          ),
          head = this.options.head();
        return {
          checkpointId: id,
          mode,
          roomId: this.options.roomId(),
          roomEpoch: record.roomEpoch,
          ...head,
          frozenAtMs: record.createdAtMs,
          unsettledCommands: record.unsettledCommands,
          participants: record.participants.map((p) => ({
            playerId: p.playerId,
            supported: p.supported,
            prepared: p.prepared,
            ...(p.frozen ? { frozen: p.frozen } : {}),
            ...(p.missing
              ? {
                  missing: p.missing as
                    | "unsupported"
                    | "prepare_timeout"
                    | "freeze_timeout",
                }
              : {}),
          })),
        } satisfies CheckpointCoordinationManifest;
      });
      let timeout: ReturnType<typeof setTimeout> | undefined,
        interrupted: (() => void) | undefined;
      const interruption = new Promise<never>((_, reject) => {
        interrupted = () => reject(Error("Checkpoint interrupted"));
        abort.signal.addEventListener("abort", interrupted, { once: true });
        if (abort.signal.aborted) interrupted();
      });
      const limit = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = Error("Checkpoint publication deadline exceeded");
          reject(error);
          abort.abort(error);
        }, this.timeouts.publishMs);
      });
      let manifest: GameOnlyCheckpointManifest;
      try {
        manifest = await Promise.race([
          this.options.publish(metadata, abort.signal, () => {
            const record = this.active(id, attempt);
            if (
              abort.signal.aborted ||
              record.phase !== "publishing" ||
              this.now() >= record.deadlineAtMs
            )
              throw Error("Checkpoint publication is no longer authorized");
          }),
          limit,
          interruption,
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (interrupted) abort.signal.removeEventListener("abort", interrupted);
      }
      await this.options.serial.run(() =>
        this.phase(id, attempt, "resuming", this.timeouts.resumeMs, (r) => {
          r.result = manifest;
        }),
      );
      await this.wait(
        id,
        attempt,
        this.timeouts.resumeMs,
        (r) => r.participants.every((p) => !p.frozen || p.resumed),
        abort.signal,
      );
      await this.options.serial.run(() => {
        this.update((state) => {
          for (const p of state.records[id]!.participants)
            if (p.frozen && !p.resumed) p.missing = "resume_timeout";
        });
        this.finish(id, attempt, "completed");
      });
      return manifest;
    } catch (error) {
      abort.abort();
      let published: GameOnlyCheckpointManifest | undefined;
      if (attempt)
        await this.options.serial
          .run(() => {
            const state = this.state(),
              record = state.records[id];
            published = record?.result;
            this.finish(
              id,
              attempt,
              published ? "completed" : "aborted",
              this.closed ? "shutdown" : "checkpoint_failed",
            );
          })
          .catch(() => {});
      if (published) return published;
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.running.values()];
    for (const running of pending) running.abort.abort();
    await this.options.serial.run(() => {
      const state = this.state(),
        record = state.activeId ? state.records[state.activeId] : undefined;
      if (record)
        this.finish(
          record.checkpointId,
          record.attemptId,
          record.result ? "completed" : "aborted",
          "shutdown",
        );
    });
    await Promise.allSettled(pending.map((item) => item.promise));
  }
}
