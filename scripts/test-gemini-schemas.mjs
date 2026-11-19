import {modelWireInstructionsFor} from '../dist/plugins/hybrid/src/prompts.js';
import fs from "node:fs";
import assert from "node:assert/strict";
import { GeminiProvider, DEFAULT_GEMINI_MODEL } from "../dist/packages/ai/src/application/providers/gemini.js";
import {
  parseIntentResult,
} from "../dist/plugins/hybrid/src/intent-protocol.js";
import {
  fixedModelResponseSchema,
  decodeModelResponse,
} from "../dist/plugins/hybrid/src/model-wire.js";
import { normalizeIntentResult } from "../dist/plugins/hybrid/src/intent-compatibility.js";
import {
  commanderOutputInstruction,
  parseCommanderResult,
} from "../dist/packages/ai/src/controller/contracts/commander-protocol.js";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const dir =
  outIndex >= 0 ? args[outIndex + 1] : "runtime/gemini-schema-verification";
if (!dir) throw Error("Missing --out directory");
fs.mkdirSync(dir, { recursive: true });
const posts = Array.from(
    { length: 80 },
    (_, i) => "POST-" + String(i + 1).padStart(3, "0"),
  ),
  ids = Array.from({ length: 12 }, (_, i) => "intent-" + (i + 1)),
  fleets = Array.from({ length: 8 }, (_, i) => "F" + (i + 1));
const cases = [];
function hybrid(
  name,
  kind,
  expected,
  { agreements = [], active = [] } = {},
) {
  const schema = fixedModelResponseSchema(kind, true);
  cases.push({ name, kind, expected, schema, agreements, active });
}
hybrid("strategy-empty", "strategy", {
  summary: "暂无额外任务",
  tasks: [],
  cancel: [],
});
hybrid("strategy-capture", "strategy", {
  summary: "优先占领中立点",
  tasks: [
    { kind: "capture", target: posts[5], until: 120, maxDrillersPerPlan: 40 },
  ],
});
hybrid("strategy-configure-transfer", "strategy", {
  tasks: [
    {
      kind: "configure",
      target: posts[0],
      minDrillers: 10,
      maintain: true,
      until: 120,
    },
    {
      kind: "transfer",
      source: posts[1],
      target: posts[0],
      drillers: 12,
      until: 120,
    },
  ],
});
hybrid("strategy-edit-cancel-return", "strategy", {
  tasks: [
    { id: "intent-1", kind: "avoid", target: posts[5], until: 120 },
    { kind: "return-fleet", fleetId: "F1", until: 120 },
  ],
  cancel: ["intent-2"],
});
hybrid("strategy-capacity", "strategy", {
  tasks: posts
    .slice(5, 17)
    .map((target) => ({ kind: "avoid", target, until: 120 })),
  reviewOn: Array.from({ length: 16 }, (_, i) => "复查条件" + (i + 1)),
});
hybrid("commander-constraints-focus", "commander", {
  tasks: [{ kind: "focus", target: posts[5], rally: posts[0], until: 120 }],
  forbiddenPlayers: [2],
  protectedSources: [posts[0]],
  reserves: [{ source: posts[0], drillers: 10 }],
});
hybrid("commander-empty-constraints", "commander", {
  forbiddenPlayers: [],
  protectedSources: [],
  reserves: [],
});
hybrid("diplomacy-none", "diplomacy", {
  action: "none",
  message: "暂不签约",
  agreementSummary: "保持接触",
  internalIntent: "等待明确共同利益",
});
hybrid("diplomacy-ceasefire", "diplomacy", {
  action: "ceasefire",
  peer: 1,
  outposts: [posts[0]],
  agreementSummary: "有限停战",
  internalIntent: "保护边界",
});
hybrid("diplomacy-joint-attack", "diplomacy", {
  action: "joint-attack",
  peer: 1,
  enemy: 2,
  ownCommitment: 10,
  peerCommitment: 20,
  subsidyPayer: 0,
  subsidyAmount: 1,
});
for (const action of ["accept", "reject"])
  hybrid(
    "diplomacy-" + action,
    "diplomacy",
    { action, agreementId: "offer-in" },
    { agreements: [{ id: "offer-in", status: "proposed", players: [1, 0] }] },
  );
hybrid(
  "diplomacy-withdraw",
  "diplomacy",
  { action: "withdraw", agreementId: "offer-out" },
  { agreements: [{ id: "offer-out", status: "proposed", players: [0, 1] }] },
);
hybrid(
  "diplomacy-counteroffer",
  "diplomacy",
  {
    action: "joint-attack",
    peer: 1,
    enemy: 2,
    ownCommitment: 20,
    peerCommitment: 20,
    counterTo: "offer-in",
  },
  { agreements: [{ id: "offer-in", status: "proposed", players: [1, 0] }] },
);
hybrid(
  "diplomacy-fulfillment",
  "diplomacy",
  {
    action: "none",
    fulfillAgreementId: "signed-1",
    tasks: [{ kind: "capture", target: posts[5], until: 120 }],
  },
  {
    active: ["signed-1"],
    agreements: [{ id: "signed-1", status: "active", players: [0, 1] }],
  },
);
for (const [name, mode, memory] of [
  ["discussion-no-proposal", "discuss", null],
  ["discussion-proposal", "discuss", { strategy: "优先保护己方矿场。" }],
  [
    "discussion-reconcile",
    "reconcile",
    { strategy: "优先保护己方矿场，保留十兵驻守。" },
  ],
])
  cases.push({
    name,
    mode,
    expected: {
      request: { tool: "finish", arguments: { memory } },
      summary: "已理解当前要求。",
      nextContext: null,
    },
  });
cases.push({
  name: "default-agent-envelope",
  expected: {
    request: { tool: "finish", arguments: { memory: null } },
    summary: "测试完成",
    nextContext: null,
  },
});
function checkExpected(actual, expected, path = "") {
  if (
    [
      "summary",
      "message",
      "agreementSummary",
      "internalIntent",
      "reason",
    ].includes(path.split(".").at(-1))
  )
    return;
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((v, i) => checkExpected(actual[i], v, path + "." + i));
    return;
  }
  if (expected && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected))
      checkExpected(actual?.[k], v, path + "." + k);
    return;
  }
  assert.deepEqual(actual, expected, path);
}
const selected =
  outIndex < 0
    ? args
    : args.filter(
        (value, index) => index !== outIndex && index !== outIndex + 1,
      );
if (selected.some((name) => !cases.some((c) => c.name === name)))
  throw Error("Unknown schema case");
const tests = selected.length
  ? cases.filter((c) => selected.includes(c.name))
  : cases;
const previous = fs.existsSync(dir + "/results.json")
  ? JSON.parse(fs.readFileSync(dir + "/results.json"))
  : [];
const results = previous.filter((r) => !tests.some((c) => c.name === r.name));
if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY)
  throw Error("Set GEMINI_API_KEY or GOOGLE_API_KEY for this opt-in live test");
const provider = new GeminiProvider({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  defaultModel: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  timeoutMs: 90000,
});
let next = 0;
await Promise.all(
  Array.from({ length: 2 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tests.length) return;
      const c = tests[i];
      if (c.schema)
        fs.writeFileSync(
          dir + "/" + c.name + "-schema.json",
          JSON.stringify(c.schema, null, 2),
        );
      const start = Date.now();
      let r, lastResult;
      try {
        const prompt =
          (c.kind
            ? modelWireInstructionsFor(c.kind,c.schema)
            : c.mode
              ? commanderOutputInstruction(c.mode)
              : "返回request、summary、nextContext标准工具信封，工具为finish。") +
          "\n这是隔离的协议保真测试，不做战略选择，也不进行游戏写入。原样转录指定测试结果，不能因为认为可选而删除指定字段。测试事实：" +
          JSON.stringify({
            activeAgreementIds: c.active,
            agreements: c.agreements,
          }) +
          "。己方据点：" +
          JSON.stringify(posts.slice(0, 5)) +
          "。授权名称：" +
          JSON.stringify(posts) +
          "。既有任务：" +
          JSON.stringify(ids) +
          "。可返航舰队：" +
          JSON.stringify(fleets) +
          "。请严格原样返回以下测试结果，不添加其他字段，不改动作、名称、数量或字符串：" +
          JSON.stringify(c.expected);
        const result = (lastResult = await provider.step({
          model: process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
          effort: "low",
          prompt,
          signal: new AbortController().signal,
          ...(c.schema ? { responseSchema: c.schema } : {}),
          ...(c.mode ? { commanderMode: c.mode } : {}),
        }));
        let parsed,
          audit = [];
        if (c.kind) {
          const raw = result.reply.arguments;
          checkExpected(raw, c.expected);
          const decoded = decodeModelResponse(raw, c.kind, audit);
          const normalized = normalizeIntentResult(
            decoded,
            [],
            c.kind,
            0,
            [],
            c.kind === "diplomacy",
          );
          parsed = parseIntentResult(
            normalized.value,
            c.kind,
            8,
            new Set(posts),
            new Set(fleets),
          );
        } else if (c.mode) parsed = parseCommanderResult(result.reply, c.mode);
        else assert.equal(result.reply.tool, "finish");
        r = {
          name: c.name,
          passed: true,
          ms: Date.now() - start,
          output: result.reply,
          usage: result.usage,
          parsed,
          audit,
        };
      } catch (e) {
        r = {
          name: c.name,
          passed: false,
          ms: Date.now() - start,
          error: e.code ?? e.message,
          diagnostic: e.diagnostic,
          output: lastResult?.reply,
        };
      }
      results.push(r);
      fs.writeFileSync(dir + "/results.json", JSON.stringify(results, null, 2));
      console.log(
        JSON.stringify({
          name: r.name,
          passed: r.passed,
          error: r.error,
          diagnostic: r.diagnostic,
          ms: r.ms,
        }),
      );
    }
  }),
);
if (tests.some((c) => !results.find((r) => r.name === c.name)?.passed))
  process.exitCode = 1;
