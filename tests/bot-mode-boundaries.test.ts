import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { observation } from "../packages/server/src/player-api.js";
import {
  initialState,
  type AiSnapshot,
  type AgentRequest,
} from "../packages/ai/src/controller/contracts/types.js";
import type {
  BotModeInput,
  BotModeServices,
} from "../packages/ai/src/controller/contracts/bot-mode.js";
import { hybridMode } from "../plugins/hybrid/src/index.js";
import {
  initialHybridState,
  basisOf,
  type OperationState,
  type StrategicAssessment,
} from "../plugins/hybrid/src/contracts.js";
import { acceptOperationReceipt } from "../plugins/hybrid/src/operations.js";
import { publishHybridResult } from "../plugins/hybrid/src/publication.js";
import { botPlanMemory } from "../packages/ai/src/controller/local/plan-memory.js";

function fixture() {
  const setup = JSON.parse(readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  const o = observation(
    { state: createFleetScenario(setup), scheduled: [] },
    0,
    "bot-boundaries",
  );
  const snapshot: AiSnapshot = {
    observation: o,
    chat: [],
    notifications: [],
    chatCursor: 0,
    notificationCursor: 0,
    chatPlayer: 0,
    chatCount: o.view.playerCount,
  };
  const state = initialState(o.roomId, 0, {
    mode: "hybrid",
    model: "fake",
    personality: "sentinel",
  });
  state.sequence = 1;
  const saved = initialHybridState();
  saved.directive = {
    version: 1,
    basis: basisOf(o),
    summary: "",
    objectives: [],
    forbiddenPlayers: [],
    protectedSources: [],
    reserves: [],
    reviewOn: [],
    commanderVersion: 0,
    commanderConstraints: {
      forbiddenPlayers: [],
      protectedSources: [],
      reserves: [],
    },
    agreements: [],
  };
  const records = new Map<string, unknown>([["state", saved]]);
  const services: BotModeServices = {model:{step:async()=>{throw Error('Unexpected model call in local fixture');}},
    local: async (r, compute) => compute(r),
    latest: <T>(key: string) => records.get(key) as T | undefined,
    record: (k, v) => {
      records.set(k, structuredClone(v));
    },
    markAssessed: () => assert.fail("Must stop before search"),
  };
  return { o, snapshot, state, saved, records, services };
}

for (const boundary of ["room", "player", "chat-player", "cancel"] as const)
  test(`revision repair stops immediately on changed ${boundary}`, async () => {
    const f = fixture(),
      controller = new AbortController();
    const fresh = structuredClone(f.snapshot);
    if (boundary === "room") fresh.observation.roomId = "other-room";
    if (boundary === "player") fresh.observation.view.player = 1;
    if (boundary === "chat-player") fresh.chatPlayer = 1;
    f.services.refreshSnapshot = async () => {
      if (boundary === "cancel") controller.abort(Error("cancelled repair"));
      return fresh;
    };
    const input: BotModeInput = {
      state: f.state,
      snapshot: f.snapshot,
      history: [],
      feedback: [
        {
          id: "ai-0-1-0",
          tool: "batch",
          arguments: {},
          result: {
            results: [
              {
                status: "rejected",
                outcome: "rejected",
                code: "REVISION_CONFLICT",
              },
            ],
          },
        },
      ],
      efficiency: { cacheReports: true, cacheRoutes: true },
      suffix: "",
      routes: undefined,
    };
    const request: AgentRequest = {
      prompt: "",
      model: "fake",
      signal: controller.signal,
    };
    await assert.rejects(
      hybridMode.prepare(input).run(request, f.services),
      boundary === "cancel" ? /cancelled repair/ : /changed identity/,
    );
    assert.equal(f.records.has("search"), false);
  });

test("execution admission counts mining cost and launches together against the current reserve", () => {
  const f = fixture(),
    source = f.o.view.outposts.find((p) => p.owner === 0)!,
    target = f.o.view.outposts.find((p) => p.owner === 1)!;
  source.type = "generator";
  source.drillers = 100;
  f.o.view.self.mineCreationCost = 50;
  f.saved.directive!.reserves = [{ source: source.id, drillers: 40 }];
  const input = {
    state: f.state,
    snapshot: f.snapshot,
    tool: "batch",
    arguments: {
      actions: [
        {
          tool: "order",
          arguments: { action: { kind: "toggle-mine", outpostId: source.id } },
        },
        {
          tool: "order",
          arguments: {
            action: {
              kind: "launch",
              source: source.id,
              destination: target.id,
              drillers: 20,
            },
          },
        },
      ],
    },
    latest: f.services.latest,
  };
  assert.throws(() => hybridMode.beforeExecute!(input), /留守/);
  input.arguments.actions[1]!.arguments.action.drillers = 10;
  assert.doesNotThrow(() => hybridMode.beforeExecute!(input));
  source.minePending = true;
  source.drillers = 40;
  input.arguments.actions.splice(1);
  assert.doesNotThrow(
    () => hybridMode.beforeExecute!(input),
    "cancelling a pending mine does not spend construction troops again",
  );
});

test("new material invalidates only the exact diplomatic conversation", () => {
  const f = fixture();
  f.saved.messages.push({
    id: "send",
    conversation: "1",
    to: [1],
    text: "回复私聊",
    basis: basisOf(f.o),
    messageIds: [],
    status: "pending",
    agreement: {
      conversation: "1",
      players: [1],
      status: "none",
      summary: "",
      forbidAttack: false,
      forbiddenTargets: [],
      internalIntent: "",
      expiresWorldDay: null,
      evidence: [],
      tick: f.o.view.tick,
    },
  });
  f.records.set("message-attempt", { id: "send" });
  f.snapshot.chat = [
    {
      id: "group",
      from: 1,
      to: [0, 2],
      text: "群聊材料",
      tick: f.o.view.tick,
      sentAt: 0,
    },
  ];
  const input = {
    state: f.state,
    snapshot: f.snapshot,
    tool: "say",
    arguments: { to: 1, text: "回复私聊" },
    latest: f.services.latest,
  };
  assert.doesNotThrow(() => hybridMode.beforeExecute!(input));
  f.snapshot.chat.push({
    id: "private",
    from: 1,
    to: 0,
    text: "新私聊",
    tick: f.o.view.tick,
    sentAt: 0,
  });
  assert.throws(() => hybridMode.beforeExecute!(input), /新材料/);
});

test("restored background publication never reuses an existing diplomatic message identity", () => {
  const f = fixture();
  const assessment: StrategicAssessment = {
    summary: "讨论边界",
    objectives: [],
    forbiddenPlayers: [],
    protectedSources: [],
    reserves: [],
    reviewOn: [],
    message: "第一次提案",
    agreement: {
      status: "proposed",
      summary: "协商",
      forbidAttack: false,
      forbiddenTargets: [],
      internalIntent: "了解对方",
      expiresWorldDay: null,
    },
  };
  const context = {
    saved: f.saved,
    snapshot: f.snapshot,
    port: {
      state: f.state,
      model: {step:async()=>{throw Error('Publication does not call a model');}},
      latest: f.services.latest,
      record: f.services.record,
      wake: () => {},
    },
    persist: () => {},
    enqueue: () => {},
  };
  const task = {
    id: "diplomacy",
    kind: "diplomacy" as const,
    scope: "1",
    posts: [],
    players: [1],
    messageIds: [],
  };
  publishHybridResult(context, task, assessment, f.snapshot);
  const restored = { ...context, saved: structuredClone(f.saved) };
  publishHybridResult(
    restored,
    task,
    { ...assessment, message: "第二次提案" },
    f.snapshot,
  );
  assert.equal(restored.saved.messages.length, 2);
  assert.notEqual(
    restored.saved.messages[0]!.id,
    restored.saved.messages[1]!.id,
  );
});

test("malformed child receipts cannot partially alter an operation or crash recovery", () => {
  const f = fixture(),
    operation: OperationState = {
      id: "operation-1",
      objective: "test",
      basis: basisOf(f.o),
      strategyVersion: 1,
      status: "proposed",
      drafts: [
        { id: "draft", issueTick: f.o.view.tick, action: { kind: "check-in" } },
      ],
      orders: [],
      fleets: [],
      issues: [],
    };
  const before = structuredClone(operation);
  for (const item of [null, [], false, 4]) {
    assert.equal(
      acceptOperationReceipt(
        operation,
        {
          id: "batch",
          tool: "batch",
          result: { results: [{ index: 0, status: "accepted" }, item] },
        },
        f.o,
      ),
      false,
    );
    assert.deepEqual(operation, before);
  }
});

test("future independent review notes do not override a current programmatic objective", () => {
  const f = fixture();
  const note = {
    format: "bot-plan/1",
    objective: "current-plan",
    atTick: f.o.view.tick,
    independentReview: { objective: "future-plan", atTick: f.o.view.tick + 1 },
  };
  f.snapshot.notebook = [
    {
      id: "bot-plan",
      kind: "plan",
      priority: "high",
      text: JSON.stringify(note),
      updatedAt: 0,
      expiresAt: null,
    },
  ];
  assert.equal(
    botPlanMemory(f.snapshot, () => undefined, []).incumbentObjective,
    "current-plan",
  );
  note.independentReview.atTick = f.o.view.tick;
  f.snapshot.notebook[0]!.text = JSON.stringify(note);
  assert.equal(
    botPlanMemory(f.snapshot, () => undefined, []).incumbentObjective,
    "current-plan",
  );
});
