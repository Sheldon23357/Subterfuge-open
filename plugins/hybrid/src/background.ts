import { publishHybridResult } from "./publication.js";
import {assertModelPermissions,ModelPermissionDenied} from './model-permissions.js';
import {decisionActions} from './tactical-material.js';
import {acknowledgeReceipts} from './receipt-context.js';
import {foregroundNeedsUpdate} from './foreground-input.js';
import {intentReviewKey,hasNewIntentIssue} from './intent-feasibility.js';
import {canInitiateDiplomacy,pressureReviewKey,recordDiplomacyReview,pressureReviewInterval} from './diplomacy-review.js';
import type {
  BotBackground,
  BotBackgroundServices,
} from "@subterfuge/bot-sdk/contracts/bot-mode";
import type { AiSnapshot } from "@subterfuge/bot-sdk/contracts/types";
import type { AgentResult } from "@subterfuge/bot-sdk/contracts/types";
import { providerCallTimeout } from "@subterfuge/bot-sdk/contracts/provider-timeout";
import { ProviderError } from "@subterfuge/bot-sdk/contracts/provider-error";
import { ModelAdmissionStale } from "@subterfuge/bot-sdk/runtime/model-queue";
import { hybridHasModel } from './model-availability.js';
import { openingContestCurrent } from "@subterfuge/bot-sdk/analysis/opening-expansion";
import {
  updateDiplomacyPressure,
  diplomacyPeers,
} from "./diplomacy-pressure.js";
import { resolveIntentNames, mentionedOutposts } from "./model-names.js";
import {commanderPlanIssue} from './commander-commitments.js';
import {
  conversationKey as conversation,
  conversationEvidence,
} from "./conversation-evidence.js";
import {
  parseIntentResult,
} from "./intent-protocol.js";
import { compactHybrid } from "./compact.js";
import { reconcileDiplomacy } from "./diplomacy-execution.js";
import {validateDiplomacyMessage} from './diplomacy-message.js';
import { reconcileOperations } from "./operations.js";
import { reconcileIntents } from "./intents.js";
import {
  reconcileStrategy,
} from "./strategy-freshness.js";
import { makeBrief, splitTask, type BriefTask } from "./brief.js";
import {normalizeIntentResult,type IntentNormalization} from './intent-compatibility.js';
import {decodeModelResponse} from './model-wire.js';
import {expandModelReferences} from './model-material.js';
import {
  strategyReviewKeys,
  strategyReviewIntervals as reviewIntervals,
} from "./strategy-review.js";
import {
  basisOf,
  initialHybridState,
  scopeMatches,
  type HybridState,
  type StrategicAssessment,
  type TacticalFeedback,
} from "./contracts.js";
interface Job {
  rootId: string;
  task: BriefTask;
  fingerprint: string;
  commanderVersion: number;
  attempt: number;
  after: number;
}
/** Owned by the seat runner; durable results, cancellation, no game writes. */
export class HybridBackground implements BotBackground {
  private snapshot: Readonly<AiSnapshot> | undefined;
  private saved: HybridState;
  private queue: Job[] = [];
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private running = false;
  private generation = 0;
  private serial = 0;
  private fingerprints = new Map<string, string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly port: BotBackgroundServices,
    private readonly now: () => number = () => Date.now(),
    private readonly buildBrief:typeof makeBrief=makeBrief,
  ) {
    this.saved = structuredClone(
      port.latest<HybridState>("state") ?? initialHybridState(),
    );
    if (this.saved.format !== "hybrid-state/1")
      throw Error("Unsupported hybrid state");
    this.saved.tasks = this.saved.tasks.map((t) => ({
      ...t,
      status: ["queued", "running"].includes(t.status)
        ? "interrupted"
        : t.status,
    }));
  }
  get activity(){return {active:this.active.size,queued:this.running?this.queue.length:0};}
  get settling() {
    return !this.running && this.active.size > 0;
  }
  pause() {
    if (this.pumpContinuation) {
      clearImmediate(this.pumpContinuation);
      this.pumpContinuation = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.sync();
    for (const t of this.saved.tasks)
      if (["queued", "running"].includes(t.status)) t.status = "cancelled";
    this.persist();
    this.running = false;
    this.generation++;
    this.fingerprints.clear();
    for (const a of this.active.values()) a.controller.abort();
    this.queue = [];
  }
  async drain() {
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
  private sync() {
    const latest = this.port.latest<HybridState>("state");
    if (latest)
      this.saved = { ...structuredClone(latest), tasks: this.saved.tasks };
  }
  private persist() {
    this.port.record("state", this.saved as unknown as Record<string, unknown>);
  }
  private ingestChat(snapshot:Readonly<AiSnapshot>){
    const seen=new Set(this.saved.chat.map(m=>m.id));let changed=false;
    for(const message of snapshot.chat)if(!seen.has(message.id)&&!(this.saved.handledMessages??[]).includes(message.id)){
      this.saved.chat.push(structuredClone(message));seen.add(message.id);changed=true;
    }
    return changed;
  }
  observe(snapshot: Readonly<AiSnapshot>) {
    if (!this.port.state.enabled) return;
    this.sync();
    const o=snapshot.observation;
    if(this.saved.directive&&!scopeMatches(this.saved.directive.basis,o))throw Error("Hybrid scope mismatch");
    if (!hybridHasModel(this.port.state.settings)) {
      if(this.running||this.active.size)this.pause();
      if(this.ingestChat(snapshot))this.persist();
      return;
    }
    this.snapshot = snapshot;
    if (!this.running) {
      this.running = true;
      this.generation++;
    }
    let changed = reconcileStrategy(o, this.saved);
    const priorOperations = this.port.latest<{
      operations: import("./contracts.js").OperationState[];
    }>("operations")?.operations;
    if (priorOperations) {
      const operations = reconcileOperations(
        priorOperations,
        o,
        this.port.receipt,
      );
      if (JSON.stringify(operations) !== JSON.stringify(priorOperations))
        this.port.record("operations", { operations });
    }
    const beforeIntents = JSON.stringify(this.saved.intents);
    reconcileIntents(
      o,
      this.saved,
      this.port.latest<{
        operations: import("./contracts.js").OperationState[];
      }>("operations")?.operations ?? [],
    );
    if (beforeIntents !== JSON.stringify(this.saved.intents)) changed = true;
    const tick = o.view.tick + o.secondsSinceLastTick / 600;
    if (reconcileDiplomacy(this.saved, o)) changed = true;
    if(this.ingestChat(snapshot))changed=true;
    // Keep all unprocessed evidence; processed conversations are compacted only after publication.
    const cv = this.port.state.commanderDirectives?.version ?? 0,
      ct = this.port.state.commanderDirectives?.text ?? "";
    if (this.saved.commanderVersion !== cv || this.saved.commanderText !== ct) {
      this.saved.commanderVersion = cv;
      this.saved.commanderText = ct;
      changed = true;
    }
    const planIssue=commanderPlanIssue(this.saved,o);
    const invalidatedPlan=!!(planIssue&&this.saved.directive&&this.saved.directive.commanderVersion===cv);
    if(invalidatedPlan&&this.saved.directive){
      this.saved.directive.commanderVersion=-1;
      delete this.saved.commanderParts;
      this.port.record('commander-plan-invalid',{version:cv,reason:planIssue,tick:o.view.tick});
      changed=true;
    }
    const commanderNeeded =
      !!ct.trim() && (this.saved.directive?.commanderVersion ?? -1) !== cv;
    if (
      !ct.trim() &&
      this.saved.directive &&
      this.saved.directive.commanderVersion !== cv
    ) {
      this.saved.directive.commanderVersion = cv;
      this.saved.directive.commanderConstraints = {
        forbiddenPlayers: [],
        protectedSources: [],
        reserves: [],
      };
      this.saved.directive.objectives = this.saved.directive.objectives.filter(
        (g) => !g.id.startsWith("commander:"),
      );
      this.saved.directive.version++;
      changed = true;
    }
    const own = o.view.outposts.filter(
      (p) => p.owner === o.view.player && !p.destroyed,
    );
    if (commanderNeeded) {
      const count = Math.ceil(ct.length / 5000);
      for (let i = 0; i < count; i++) {
        const text = ct.slice(i * 5000, (i + 1) * 5000);
        if(invalidatedPlan)this.fingerprints.delete('commander-'+i);
        this.enqueue(
          {
            id: "commander-" + i,
            kind: "commander",
            scope: "commander",
            posts: mentionedOutposts(text, o),
            messageIds: [],
            players: [],
            commanderPart: { index: i, count, text },
            ...(planIssue?{validationError:planIssue}:{}),
          },
          JSON.stringify([cv, ct, i,'transfer-focus']),
        );
      }
    }
    const feedback = this.port.latest<TacticalFeedback>("feedback");
    const previousPressure = JSON.stringify(this.saved.diplomacyPressure);
    const pressure = feedback
      ? updateDiplomacyPressure(this.saved, feedback, o, cv).slice(0, 3)
      : [];
    if (previousPressure !== JSON.stringify(this.saved.diplomacyPressure))
      changed = true;
    const peers = diplomacyPeers(
      snapshot,
      pressure,
      this.saved.chat,
      this.saved.diplomacyPressure?.contacts,
    );
    const { important, urgent, threat } = strategyReviewKeys(
      o,
      cv,
      this.saved.directive,
    );
    const initial = !this.fingerprints.has("strategic-input"),
      elapsedTicks = o.view.tick - this.saved.reviewTick,
      elapsedMs = this.now() - this.saved.reviewWall;
    const emergency =
      !initial && this.fingerprints.get("strategic-urgent") !== urgent;
    const threatChanged = !initial && this.fingerprints.get('strategic-threat') !== threat &&
      elapsedTicks >= reviewIntervals.threatTicks && elapsedMs >= reviewIntervals.threatMs;
    const intentKey=intentReviewKey(o,this.saved,this.port.latest<{operations:import('./contracts.js').OperationState[]}>('operations')?.operations??[]);
    const intentChanged=!initial&&hasNewIntentIssue(intentKey,this.fingerprints.get('strategic-intents'))&&
      elapsedTicks>=reviewIntervals.threatTicks&&elapsedMs>=reviewIntervals.threatMs;
    const periodic =
      !initial &&
      elapsedTicks >= reviewIntervals.periodicTicks &&
      elapsedMs >= reviewIntervals.periodicMs;
    const ordinary =
      !initial &&
      this.fingerprints.get("strategic-input") !== important &&
      elapsedTicks >= reviewIntervals.changedTicks &&
      elapsedMs >= reviewIntervals.changedMs;
    const reviewReasons=[initial?'initial':null,emergency?'critical-change':null,threatChanged?'threat-change':null,intentChanged?'intent-blocked':null,ordinary?'coalesced-change':null,periodic?'periodic':null].filter((reason):reason is string=>reason!==null);
    if (reviewReasons.length) {
      this.fingerprints.set("strategic-input", important);
      this.fingerprints.set("strategic-urgent", urgent);
      this.fingerprints.set('strategic-threat',threat);
      this.fingerprints.set('strategic-intents',intentKey);
      this.saved.reviewTick = o.view.tick;
      this.saved.reviewWall = this.now();
      changed = true;
      this.port.record("strategy-trigger", {
        reason: initial
          ? "initial"
          : emergency
            ? "critical-change"
            : threatChanged
              ? 'threat-change'
            : intentChanged
              ? 'intent-blocked'
            : ordinary
              ? "coalesced-change"
              : "periodic",
        tick: o.view.tick,
        elapsedTicks,
        elapsedMs,
      });
      // One global strategic review; the brief supplies program candidates and hydrates details on demand.
      const critical = new Set([
        ...own.filter((p) => p.type === "mine").map((p) => p.id),
        ...o.view.fleets
          .filter(
            (f) =>
              f.owner !== o.view.player &&
              !f.gift &&
              own.some((p) => p.id === f.destination?.id),
          )
          .map((f) => f.destination!.id),
      ]);
      const tactical = this.port.latest<TacticalFeedback>("feedback");
      for (const p of (tactical?.proposals ?? [])
        .filter((p) => p.utility !== null)
        .sort((a, b) => (b.utility ?? 0) - (a.utility ?? 0))
        .slice(0, 3))
        for (const id of p.dependencies) critical.add(id);
      this.enqueue(
        {
          id: "overview",
          kind: "strategy",
          scope: "overview",
          posts: [...critical],
          messageIds: [],
          players: [],
          triggers:reviewReasons.map(reason=>({kind:'strategy-review',reason,entities:[]})),
        },
        JSON.stringify([important, this.saved.reviewTick, "overview"]),
      );
    }
    const evidence = (scope: string) =>
      conversationEvidence(
        this.saved.chat.filter(
          (m) => conversation(m, snapshot.chatPlayer) === scope,
        ),
        this.saved.handledMessages ?? [],
        snapshot.chatPlayer,
      );
    const grouped = new Map<string, string[]>();
    for (const m of this.saved.chat.filter(
      (m) =>
        m.from !== snapshot.chatPlayer &&
        !(this.saved.handledMessages ?? []).includes(m.id),
    )) {
      const key = conversation(m, snapshot.chatPlayer),
        ids = grouped.get(key) ?? [];
      ids.push(m.id);
      grouped.set(key, ids);
    }
    for(const proposal of o.diplomacy?.agreements.filter(a=>a.status==='proposed'&&a.players[1]===o.view.player)??[]){
      const peer=snapshot.roster?.find(r=>r.gamePlayer===proposal.players[0])?.chatPlayer??(snapshot.chatPlayer===o.view.player?proposal.players[0]:undefined);
      if(peer!==undefined&&!grouped.has(String(peer)))grouped.set(String(peer),[]);
    }
    for (const [key, ids] of grouped) {
      if(this.saved.contractCommands?.some(c=>c.conversation===key&&['pending','unknown'].includes(c.status)))continue;
      if (
        this.saved.messages.some(
          (m) =>
            m.conversation === key && ["pending", "unknown"].includes(m.status),
        )
      )
        continue;
      const players = key === "public" ? [] : key.split(",").map(Number);
      this.enqueue(
        {
          id: "diplomacy-" + key,
          kind: "diplomacy",
          scope: key,
          posts: [
            ...new Set([
              ...pressure.flatMap((n) => n.targets),
            ]),
          ],
          messageIds: evidence(key),
          players,
          ...(pressure.length
            ? {
                diplomacyPurpose: {
                  needs: pressure,
                  role:
                    peers.find((p) => players.includes(p.chat))?.role ??
                    "review-options",
                },
              }
            : {}),
        },
        // A tactical feedback refresh is not new conversation evidence. Keep
        // the in-flight review unless unread messages or commander authority change.
        JSON.stringify([ids, cv,o.diplomacy?.agreements.filter(a=>a.status==='proposed').map(a=>[a.id,a.status,a.terms])]),
      );
    }
    for (const m of this.saved.messages.filter(
      (m) =>
        m.status === "accepted" &&
        m.fulfillment?.state === "blocked" &&
        m.to !== null,
    )) {
      if (
        grouped.has(m.conversation) ||
        this.saved.messages.some(
          (other) =>
            other.conversation === m.conversation &&
            ["pending", "unknown"].includes(other.status),
        )
      )
        continue;
      this.enqueue(
        {
          id: "diplomacy-" + m.conversation,
          kind: "diplomacy",
          scope: m.conversation,
          posts: [],
          messageIds: evidence(m.conversation),
          players: m.to!,
          diplomacyPurpose: { needs: [], role: "repair-fulfillment" },
        },
        JSON.stringify([
          "fulfillment",
          m.id,
          m.fulfillment!.reason,
          cv,
          Math.floor(tick / 24),
        ]),
      );
    }
    // One new pressure conversation at a time; incoming conversations always retain priority.
    const due = pressure.filter((n) => {
      const a = this.saved.diplomacyPressure?.attempts[n.id];
      return !a || (this.now() - a.wall >= pressureReviewInterval.ms && o.view.tick - a.tick >= pressureReviewInterval.ticks);
    });
    let pressureQueued = false;
    if (due.length && !commanderNeeded) {
      const peer = peers.find(
        (p) =>
          canInitiateDiplomacy(snapshot,this.port.state,[p.chat]) &&
          this.saved.diplomacyPressure?.contacts?.[String(p.game)]?.reviewKey!==pressureReviewKey(snapshot,this.saved,pressure,p.chat) &&
          !grouped.has(String(p.chat)) &&
          !this.active.has("diplomacy-" + p.chat) &&
          !this.queue.some((j) => j.rootId === "diplomacy-" + p.chat) &&
          !this.saved.messages.some(
            (m) =>
              m.conversation === String(p.chat) &&
              ["pending", "unknown"].includes(m.status),
          ),
      );
      if (peer) {
        const key = String(peer.chat),
          prior = this.saved.diplomacyPressure!.attempts;
        const queued=this.enqueue(
          {
            id: "diplomacy-" + key,
            kind: "diplomacy",
            scope: key,
            posts: [...new Set(pressure.flatMap((n) => n.targets))],
            messageIds: evidence(key),
            players: [peer.chat],
            pressureOnly: true,
            diplomacyPurpose: { needs: pressure, role: peer.role },
          },
          JSON.stringify(["pressure",pressureReviewKey(snapshot,this.saved,pressure,peer.chat),o.view.tick]),
        );
        if(queued){
          for (const n of pressure)
            prior[n.id] = {
              wall: this.now(),
              tick: o.view.tick,
              peer: peer.game,
            };
          (this.saved.diplomacyPressure!.contacts ??= {})[String(peer.game)] = {
            ...this.saved.diplomacyPressure!.contacts?.[String(peer.game)],
            wall: this.now(),
            tick: o.view.tick,
          };
          this.port.record("diplomacy-trigger", {
            basis: feedback!.basis,
            needs: pressure,
            peer: { game: peer.game, chat: peer.chat, role: peer.role },
            status: "review-queued",
          });
          changed = true;
          pressureQueued = true;
        }
      }
    }
    // Periodic proactive diplomacy rotates opponents, avoiding identical openers.
    if (periodic && !grouped.size && !pressure.length && !pressureQueued) {
      const rivals = o.intel.filter(
          (p) => p.player !== o.view.player && p.active,
        ),
        peer =
          rivals[Math.floor(o.view.tick / 24) % Math.max(1, rivals.length)];
      const chatPeer = snapshot.roster?.find(
        (r) => r.gamePlayer === peer?.player,
      )?.chatPlayer;
      if (chatPeer !== undefined && canInitiateDiplomacy(snapshot,this.port.state,[chatPeer]))
        this.enqueue(
          {
            id: "diplomacy-" + chatPeer,
            kind: "diplomacy",
            scope: String(chatPeer),
            posts: [],
            messageIds: evidence(String(chatPeer)),
            players: [chatPeer],
          },
          JSON.stringify(["proactive", Math.floor(o.view.tick / 24), cv]),
        );
    }
    const workingBefore = JSON.stringify(this.saved),
      stored =
        this.port.latest<{
          operations: import("./contracts.js").OperationState[];
        }>("operations")?.operations ?? [],
      compacted = compactHybrid(this.saved, stored, snapshot.chatPlayer);
    if (compacted.length !== stored.length)
      this.port.record("operations", { operations: compacted });
    if (workingBefore !== JSON.stringify(this.saved)) changed = true;
    if (changed) this.persist();
    this.pump();
  }
  private enqueue(task: BriefTask, fingerprint: string) {
    if (this.fingerprints.get(task.id) === fingerprint) return false;
    this.fingerprints.set(task.id, fingerprint);
    this.queue = this.queue.filter((j) => j.rootId !== task.id);
    this.queue.push({
      rootId: task.id,
      task,
      fingerprint,
      commanderVersion: this.port.state.commanderDirectives?.version ?? 0,
      attempt: 0,
      after: 0,
    });
    return true;
  }
  private tacticalBrief(task: BriefTask) {
    const f = this.port.latest<TacticalFeedback>("feedback");
    if (!f) return null;
    const proposals = f.proposals.filter(
      (p) =>
        !task.posts.length ||
        p.dependencies.some((id) => task.posts.includes(id)),
    );
    const selected=f.proposals.find(p=>p.id===f.selectedProposalId);
    const plan=(p:typeof f.proposals[number])=>({actions:decisionActions(p.drafts),targets:p.dependencies,plannedOrders:p.drafts.length,status:p.status,decision:p.decision});
    return {
      basis: f.basis,
      assessedAtWorldDay: f.basis.tick,
      selected: f.selected,
      ...(selected?{selectedPlan:plan(selected)}:{}),
      coverage: f.coverage,
      considered: proposals.length,
      conditionalAlternatives: proposals
        .filter((p) => p.utility !== null)
        .sort((a, b) => (b.utility ?? 0) - (a.utility ?? 0))
        .slice(0, 4)
        .map(plan),
      unverified: proposals
        .filter((p) => p.utility === null)
        .slice(0, 2)
        .map(plan),
      limitations: f.limitations,
    };
  }
  private pressureCurrent(task: BriefTask) {
    if (!task.pressureOnly) return true;
    const f = this.port.latest<TacticalFeedback>("feedback"),
      o = this.snapshot!.observation;
    return (
      !!f &&
      scopeMatches(f.basis, o) &&
      f.basis.commanderVersion ===
        (this.port.state.commanderDirectives?.version ?? 0) &&
      o.view.tick - f.basis.tick <= 24 &&
      f.basis.tick <= o.view.tick &&
      !!task.diplomacyPurpose?.needs.every(
        (n) =>
          f.diplomacyNeeds?.some((current) => current.id === n.id) &&
          (n.kind === "stalemate"
            ? f.selected === "hold"
            : n.kind === "opening-contest"
              ? openingContestCurrent(o, n.targets, n.opponents)
              : n.targets.every((id) => {
                  const p = o.view.outposts.find((p) => p.id === id);
                  return (
                    p &&
                    !p.destroyed &&
                    (n.kind === "defense-pressure"
                      ? p.owner === o.view.player
                      : p.owner != null && n.opponents.includes(p.owner))
                  );
                })),
      )
    );
  }
  private pumpContinuation: ReturnType<typeof setImmediate> | undefined;
  private continuePump() {
    if (!this.running || this.pumpContinuation) return;
    this.pumpContinuation = setImmediate(() => {
      this.pumpContinuation = undefined;
      if (this.running) this.pump();
    });
    this.pumpContinuation.unref();
  }
  private pump() {
    if (this.pumpContinuation) return;
    while (this.running && this.snapshot && this.active.size < 1) {
      this.queue.sort(
        (a, b) =>
          Number(b.task.kind === "commander") -
          Number(a.task.kind === "commander"),
      );
      const i = this.queue.findIndex(
        (j) =>
          j.after <= this.now() &&
          !this.active.has(j.task.kind === "diplomacy" ? j.rootId : j.task.id),
      );
      if (i < 0) {
        this.scheduleRetry();
        return;
      }
      const job = this.queue.splice(i, 1)[0]!;
      if (
        job.commanderVersion !==
          (this.port.state.commanderDirectives?.version ?? 0) ||
        this.fingerprints.get(job.rootId) !== job.fingerprint ||
        !this.pressureCurrent(job.task)
      )
        continue;
      let material: ReturnType<typeof makeBrief>;
      try {
        material = this.buildBrief(
          job.task,
          this.port.state,
          this.snapshot,
          this.saved,
          this.tacticalBrief(job.task),
          this.port.latest<{operations:import('./contracts.js').OperationState[]}>('operations')?.operations??[],
        );
      } catch (error) {
        try {
          if (!(error instanceof Error) || error.message !== "BRIEF_REQUIRES_SPLIT") throw error;
          const parts = splitTask(job.task);
          for (const task of parts)
            this.queue.push({
              ...job,
              task,
            });
        } catch {
          this.saved.tasks = this.saved.tasks.filter(
            (t) => t.id !== job.task.id,
          );
          this.saved.tasks.push({
            id: job.task.id,
            kind: job.task.kind,
            status: "blocked-context",
            attempt: job.attempt,
            characters:
              typeof (error as { characters?: number }).characters === "number"
                ? (error as { characters: number }).characters
                : 0,
            error: error instanceof Error ? error.message : String(error),
          });
          this.saved.tasks = this.saved.tasks.slice(-40);
          this.persist();
        }
        // Context partitioning is CPU work. Let socket callbacks and lease timers
        // run before constructing another partition, including terminal failures.
        this.continuePump();
        return;
      }
      const capturedIntents=structuredClone(this.saved.intents??[]);
      let normalizations:IntentNormalization[]=[];
      const captured = structuredClone(this.snapshot),
        controller = new AbortController(),
        generation = this.generation,
        sequence = ++this.serial;
      const row: HybridState["tasks"][number] = {
        id: job.task.id,
        kind: job.task.kind,
        status: "queued",
        attempt: job.attempt,
        characters: material.prompt.length,
      };
      this.saved.tasks = this.saved.tasks
        .filter((t) => t.id !== row.id)
        .concat(row)
        .slice(-40);
      this.persist();
      const callStarted = this.now();
      let queueWaitMs: number | null = null,
        handedOff = false,
        usageRecorded = false,
        providerReturned = false,
        capturedAuthorized = false,
        providerStarted: number | null = null;
      const effort = this.port.state.settings.reasoningEffort ?? "low",
        timeoutMs = providerCallTimeout(effort);
      const callId = crypto.randomUUID();
      let returned: import('@subterfuge/bot-sdk/contracts/types').ModelResult<unknown> | undefined;
      let failure: Record<string, unknown> | null = null;
      const recordCall = (finished: boolean) =>
        this.port.record("model-call", {
          callId,
          callPhase:'publication',
          sequence,
          task: job.task.id,
          kind: job.task.kind,
          attempt: job.attempt,
          status: row.status,
          model: this.port.state.settings.model,
          effort,
          timeoutMs,
          basis: material.brief.basis,
          queuedAt: new Date(callStarted).toISOString(),
          sentAt:
            providerStarted === null
              ? null
              : new Date(providerStarted).toISOString(),
          finishedAt: finished ? new Date(this.now()).toISOString() : null,
          queueWaitMs,
          durationMs: finished ? this.now() - callStarted : null,
          providerDurationMs:
            providerStarted === null
              ? null
              : (providerFinished ?? this.now()) - providerStarted,
          prompt: material.prompt,
          responseSchema: material.responseSchema,
          output: returned?.reply ?? null,
          completion:returned?.completion??null,
          tokens: returned?.tokens ?? null,
          usage: returned?.usage ?? null,
          usageKnown: returned?.usageKnown ?? null,
          providerContext: returned?.providerContext ?? null,
          error: row.error ?? null,
          failure,
          normalizations,
          contextSelection:material.contextSelection,
          modelReferences:material.modelReferences,
          receiptCoverage:(material.modelBrief.guidance as Record<string,unknown>).receiptCoverage??null,
          sent: handedOff,
        });
      let providerFinished: number | null = null;
      recordCall(false);
      const promise = (async () => {
        try {
          // The provider owns the per-call timer after queue admission. Queuing
          // must never consume the model's inference allowance; pause still aborts both.
          const result = await this.port.model.step({
            audit:{callId,kind:job.task.kind,task:job.task.id,attempt:job.attempt},
            providerSessionScope:{kind:job.task.kind,task:job.task.kind==='diplomacy'?job.task.scope:job.rootId},
            prompt: material.prompt,
            responseSchema: material.responseSchema,
            model: this.port.state.settings.model,
            ...(this.port.state.settings.provider
              ? { provider: this.port.state.settings.provider }
              : {}),
            ...(this.port.state.settings.serviceTier
              ? { serviceTier: this.port.state.settings.serviceTier }
              : {}),
            effort,
            timeoutMs,
            onSend: (wait) => {
              queueWaitMs = wait;
              providerStarted = this.now();
              handedOff = true;
              row.status = "running";
              recordCall(false);
              this.persist();
              this.port.record("task-dispatched", {
                id: job.task.id,
                sequence,
                attempt: job.attempt,
                queueWaitMs: wait,
                timeoutMs,
              });
            },
            signal: controller.signal,
            beforeSend: () => {
              if (
                !this.running ||
                generation !== this.generation ||
                !this.port.state.enabled
              )
                throw new ModelAdmissionStale("background-stopped");
              if(job.task.pressureOnly&&!canInitiateDiplomacy(this.snapshot!,this.port.state,job.task.players))
                throw new ModelAdmissionStale('diplomacy-cooldown');
              if (
                (this.port.state.commanderDirectives?.version ?? 0) !==
                  material.brief.basis.commanderVersion ||
                this.fingerprints.get(job.rootId) !== job.fingerprint ||
                !this.pressureCurrent(job.task)
              )
                throw new ModelAdmissionStale("background-superseded");
            },
          });
          returned = result;
          providerFinished = this.now();
          providerReturned = true;
          if (!this.running || generation !== this.generation) return;
          this.port.record("usage", {
            task: job.task.id,
            sequence,
            tokens: result.tokens,
            usage: result.usage ?? null,
            usageKnown: result.usageKnown ?? null,
            characters: material.prompt.length,
            queueWaitMs,
            durationMs: this.now() - callStarted,
            providerDurationMs:
              providerStarted === null ? null : this.now() - providerStarted,
          });
          this.sync();
          this.saved.usage ??= {};
          const usage = this.saved.usage[job.task.kind] ?? {
            calls: 0,
            tokens: 0,
            unknown: 0,
          };
          usage.calls++;
          usage.tokens += result.tokens;
          if (!result.usageKnown?.input || !result.usageKnown?.output)
            usage.unknown++;
          this.saved.usage[job.task.kind] = usage;
          usageRecorded = true;
          this.persist();
          const wireAudit:IntentNormalization[]=[];
          const decoded = resolveIntentNames(decodeModelResponse(expandModelReferences(result.reply,material.modelReferences),job.task.kind,wireAudit,{peer:material.permissions.diplomacy.peer}), captured.observation);
          const currentObservation=(this.snapshot??captured).observation;
          const normalized=normalizeIntentResult(decoded,capturedIntents,job.task.kind,
            currentObservation.view.tick+currentObservation.secondsSinceLastTick/600,this.saved.intents??[],!!captured.observation.diplomacy);
          normalizations=[...wireAudit,...normalized.changes];
          const assessment = parseIntentResult(
            normalized.value,
            job.task.kind,
            captured.observation.view.playerCount,
            new Set(captured.observation.view.outposts.map((p) => p.id)),
            new Set(
              captured.observation.view.fleets
                .filter((f) => f.owner === captured.observation.view.player)
                .map((f) => f.id),
            ),
          );
          assertModelPermissions(assessment,material.permissions,captured.observation.outpostNames??{});
          capturedAuthorized = true;
          validateDiplomacyMessage(assessment,material.brief,captured.observation.outpostNames??{});
          if (
            (this.port.state.commanderDirectives?.version ?? 0) !==
              material.brief.basis.commanderVersion
          ) {
            row.status = "superseded";
            return;
          }
          const current = this.snapshot!.observation;
          if (!scopeMatches(material.brief.basis, current)) {
            row.status = "stale-dependency";
            return;
          }
          // A newer observation, queued review or message does not invalidate a
          // returned answer. Publication checks current permissions and concrete
          // conflicts atomically; only the captured messages are acknowledged.
          this.sync();
          const foregroundBefore=structuredClone(this.saved);
          this.publish(
            { ...job.task, posts: material.contextPosts },
            assessment,
            captured,
          );
          const commanderComplete=this.saved.commanderParts?.version===material.brief.basis.commanderVersion&&Object.keys(this.saved.commanderParts.parts).length===(job.task.commanderPart?.count??1)&&this.saved.directive?.commanderVersion===material.brief.basis.commanderVersion;
          if(job.task.kind!=='commander'||commanderComplete){
            acknowledgeReceipts(this.saved,material.receiptScope,material.receiptDelivery);
            this.persist();
          }
          row.status = "completed";
          const foregroundChanged=foregroundNeedsUpdate(foregroundBefore,this.saved,this.snapshot!.observation);
          this.port.record('foreground-update',{taskId:job.task.id,changed:foregroundChanged});
          if(job.task.kind==='diplomacy'){
            recordDiplomacyReview(this.saved,captured,job.task.diplomacyPurpose?.needs??[],job.task.players,this.now());
            this.persist();
          }
          if(foregroundChanged)this.port.wake();
        } catch (error) {
          providerFinished ??= this.now();
          if (!this.running || controller.signal.aborted) return;
          this.sync();
          if(error instanceof ModelPermissionDenied&&capturedAuthorized){
            // The answer obeyed the sent catalog. An expiry/ownership change
            // during the call is a new factual trigger, not a malformed reply.
            row.status='stale-dependency';
            this.port.record('task-skipped',{id:job.task.id,reason:'publication-permissions-changed',path:error.path,attempt:job.attempt,sent:handedOff,durationMs:this.now()-callStarted});
            if(this.fingerprints.get(job.rootId)===job.fingerprint&&job.commanderVersion===(this.port.state.commanderDirectives?.version??0)){
              if(job.task.kind==='commander'&&(job.task.commanderPart?.count??1)>1){
                // A previously completed part can be the stale one. Rebuild
                // the complete version instead of repeatedly replacing its peer.
                delete this.saved.commanderParts;this.persist();
                for(let i=0;i<job.task.commanderPart!.count;i++)this.fingerprints.delete('commander-'+i);
                this.observe(this.snapshot!);
              }else this.queue.push({...job,after:this.now()});
            }
            return;
          }
          if (error instanceof ModelAdmissionStale) {
            row.status = "superseded";
            this.port.record("task-skipped", {
              id: job.task.id,
              reason: error.reason,
              attempt: job.attempt,
              sent: false,
              durationMs: this.now() - callStarted,
            });
            return;
          }
          if (handedOff && !usageRecorded) {
            this.saved.usage ??= {};
            const u = this.saved.usage[job.task.kind] ?? {
              calls: 0,
              tokens: 0,
              unknown: 0,
            };
            u.calls++;
            u.unknown++;
            this.saved.usage[job.task.kind] = u;
            this.persist();
          }
          row.status = "failed";
          row.error = error instanceof Error ? error.message : String(error);
          failure = {
            stage: providerReturned
              ? "validation"
              : handedOff
                ? "provider"
                : "queue",
            ...(error instanceof ProviderError
              ? {
                  code: error.code,
                  timeoutSource: error.timeoutSource ?? null,
                  reason: error.diagnostic?.reason ?? null,
                  httpStatus: error.diagnostic?.httpStatus ?? null,
                  providerStage: error.diagnostic?.stage ?? null,
                  outputBytes: error.diagnostic?.outputBytes ?? null,
                  contentCharacters: error.diagnostic?.contentCharacters ?? null,
                  finishReason: error.diagnostic?.finishReason ?? null,
                  truncated: error.diagnostic?.truncated ?? null,
                }
              : {}),
          };
          this.port.record("task-failed", {
            id: job.task.id,
            error: row.error,
            attempt: job.attempt,
            queueWaitMs,
            durationMs: this.now() - callStarted,
            providerDurationMs:
              providerStarted === null ? null : this.now() - providerStarted,
            stage: providerReturned
              ? "validation"
              : handedOff
                ? "provider"
                : "queue",
            ...(error instanceof ProviderError
              ? {
                  code: error.code,
                  timeoutSource: error.timeoutSource ?? null,
                  diagnostic: error.diagnostic ?? null,
                }
              : {}),
          });
          // Invalid replies end this attempt. Only provider availability failures
          // may reschedule a model call; never append a repair prompt or turn a
          // rejected response into a partial publication.
          const retryable = !providerReturned && error instanceof ProviderError &&
            error.code !== 'invalid-response' && error.recoverableModelFailure;
          if (
            retryable &&
            this.fingerprints.get(job.rootId) === job.fingerprint &&
            (job.attempt < 2 || job.task.kind === "commander")
          ) {
            const delay = job.attempt < 2 ? [5000, 30000][job.attempt]! : 60000;
            failure.retryDelayMs = delay;
            this.queue.push({
              ...job,
              attempt: job.attempt + 1,
              after: this.now() + delay,
            });
          }
        } finally {
          if (!this.running || generation !== this.generation)
            row.status = "cancelled";
          recordCall(true);
          if (this.running && generation === this.generation) {
            this.sync();
            this.persist();
          }
        }
      })()
        .finally(() => {
          this.active.delete(
            job.task.kind === "diplomacy" ? job.rootId : job.task.id,
          );
          if (this.running) this.pump();
        })
        .catch((error) => {
          this.pause();
          this.port.fail?.(error);
        });
      this.active.set(
        job.task.kind === "diplomacy" ? job.rootId : job.task.id,
        { controller, promise },
      );
    }
  }
  private scheduleRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.running) return;
    const next = this.queue
      .filter(
        (j) =>
          !this.active.has(j.task.kind === "diplomacy" ? j.rootId : j.task.id),
      )
      .reduce((n, j) => Math.min(n, j.after), Infinity);
    if (Number.isFinite(next) && next > this.now()) {
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.pump();
        },
        Math.max(1, next - this.now()),
      );
      this.retryTimer.unref();
    }
  }
  private publish(
    task: BriefTask,
    a: StrategicAssessment,
    captured: Readonly<AiSnapshot>,
  ) {
    const previous = structuredClone(this.saved);
    previous.tasks = this.saved.tasks;
    try {
      publishHybridResult(
        {
          saved: this.saved,
          snapshot: this.snapshot!,
          port: this.port,
          persist: () => this.persist(),
          enqueue: (task, fingerprint) => this.enqueue(task, fingerprint),
        },
        task,
        a,
        captured,
      );
    } catch (error) {
      this.saved = previous;
      throw error;
    }
  }
}
