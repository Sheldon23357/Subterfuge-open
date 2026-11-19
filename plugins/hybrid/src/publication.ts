import type { BotBackgroundServices } from "@subterfuge/bot-sdk/contracts/bot-mode";
import type { AiSnapshot } from "@subterfuge/bot-sdk/contracts/types";
import type { BriefTask } from "./brief.js";
import {
  basisOf,
  type HybridState,
  type StrategicAssessment,
  type StrategicDirective,
  type Agreement,
} from "./contracts.js";
import {
  reconcileStrategy,
  currentObjectives,
} from "./strategy-freshness.js";
import {
  updatedAgreement,
  isConfirmedContinuation,
  defaultNonAggressionDeadline,
} from "./diplomacy-execution.js";
import { applyIntentEdits, reconcileIntents } from "./intents.js";
import {validateCommanderEdits,validateCommanderTransferSources,commanderPlanIssue} from './commander-commitments.js';
import { conversationKey as conversation } from "./conversation-evidence.js";
import {publishContractIntent} from './server-contracts.js';
import {assertModelPermissions,modelAuthorization} from './model-permissions.js';

export interface PublicationContext {
  saved: HybridState;
  snapshot: Readonly<AiSnapshot>;
  port: BotBackgroundServices;
  persist: () => void;
  enqueue: (task: BriefTask, fingerprint: string) => void;
}
/** Publish a validated result; scheduling and rollback remain with the owner. */
export function publishHybridResult(
  { saved, snapshot, port, persist, enqueue }: PublicationContext,
  task: BriefTask,
  a: StrategicAssessment,
  captured: Readonly<AiSnapshot>,
): void {
  const o = snapshot.observation,
    cv = port.state.commanderDirectives?.version ?? 0;
  const permissions=modelAuthorization(task,snapshot,saved).permissions;
  assertModelPermissions(a,permissions,o.outpostNames??{},true);
  reconcileStrategy(o, saved);
  if(o.diplomacy&&task.kind==='strategy'&&a.betrayAgreements){
    if(a.betrayAgreements.some(id=>!o.diplomacy!.agreements.some(c=>c.id===id&&c.status==='active'&&c.players.includes(o.view.player))))throw Error('只能放弃本人仍生效协议的守约策略');
    saved.betrayAgreements=[...new Set(a.betrayAgreements)];
  }

  const old = saved.directive;
  const d: StrategicDirective = structuredClone(
    old ?? {
      version: 0,
      basis: basisOf(o, cv),
      summary: "",
      objectives: [],
      forbiddenPlayers: [],
      protectedSources: [],
      reserves: [],
      reviewOn: [],
      commanderVersion: cv === 0 ? 0 : -1,
      commanderConstraints: {
        forbiddenPlayers: [],
        protectedSources: [],
        reserves: [],
      },
      agreements: [],
    },
  );
  d.version++;
  d.basis = basisOf(o, cv);
  if (task.kind === "commander") {
    const count = task.commanderPart?.count ?? 1,
      index = task.commanderPart?.index ?? 0;
    if (saved.commanderParts?.version !== cv)
      saved.commanderParts = { version: cv, parts: {}, count };
    saved.commanderParts.parts[String(index)] = a;
    if (Object.keys(saved.commanderParts.parts).length < count) {
      persist();
      return;
    }
    const parts = Object.values(saved.commanderParts.parts);
    for(const part of parts)assertModelPermissions(part,permissions,o.outpostNames??{});
    a = {
      ...a,
      intentEdits: {
        upsert: parts.flatMap((p) => p.intentEdits?.upsert ?? []),
        cancel: [...new Set(parts.flatMap((p) => p.intentEdits?.cancel ?? []))],
      },
      summary: parts.map((p) => p.summary).join("；"),
      objectives: parts.flatMap((p) => p.objectives),
      forbiddenPlayers: [...new Set(parts.flatMap((p) => p.forbiddenPlayers))],
      protectedSources: [...new Set(parts.flatMap((p) => p.protectedSources))],
      reserves: parts.flatMap((p) => p.reserves),
    };
    if(a.intentEdits){validateCommanderTransferSources(a.intentEdits,a.protectedSources);validateCommanderEdits(a.intentEdits,o,port.state.commanderDirectives?.text??'',saved.intents?.filter(t=>t.authority==='commander'&&t.commanderVersion===cv)??[]);}
    d.commanderVersion = cv;
    d.commanderConstraints = {
      forbiddenPlayers: a.forbiddenPlayers,
      protectedSources: a.protectedSources,
      reserves: a.reserves,
    };
    d.objectives = d.objectives.filter((x) => !x.id.startsWith("commander:"));
    d.summary = a.summary;
    d.summaryBasis = basisOf(captured.observation, cv);
  } else if (task.kind === "strategy") {
    if (task.scope === "coordination") {
      const ids = new Set(task.posts);
      d.objectives = d.objectives.filter(
        (g) =>
          g.id.startsWith("commander:") || !g.targets.some((t) => ids.has(t)),
      );
    }
    const prefix = task.scope + ":";
    d.objectives = d.objectives.filter((x) => !x.id.startsWith(prefix));
    d.summary = a.summary;
    saved.assessments = { ...saved.assessments, [task.scope]: a };
    saved.assessmentDependencies = {
      ...saved.assessmentDependencies,
      [task.scope]: {
        basis: basisOf(captured.observation, cv),
        posts: [...task.posts],
      },
    };
    const summaryScope =
      task.scope === "coordination"
        ? task.scope
        : saved.assessments.overview
          ? "overview"
          : task.scope;
    d.summaryBasis = saved.assessmentDependencies[summaryScope]!.basis;
    const assessments = Object.values(saved.assessments);
    d.summary =
      task.scope === "coordination"
        ? a.summary
        : (saved.assessments.overview?.summary ?? a.summary);
    d.reviewOn = [...new Set(assessments.flatMap((a) => a.reviewOn))];
    d.forbiddenPlayers = [
      ...new Set(assessments.flatMap((a) => a.forbiddenPlayers)),
    ];
    d.protectedSources = [
      ...new Set(assessments.flatMap((a) => a.protectedSources)),
    ];
    d.reserves = assessments.flatMap((a) => a.reserves);
  } else if(o.diplomacy){
    const gamePlayers=task.players.map(p=>snapshot.roster?.find(r=>r.chatPlayer===p)?.gamePlayer??(snapshot.chatPlayer===o.view.player?p:undefined)).filter((p):p is number=>p!==undefined&&p!==o.view.player);
    publishContractIntent(saved,o,a,task.scope,gamePlayers,cv,captured.observation,port.latest<{operations:import('./contracts.js').OperationState[]}>('operations')?.operations??[]);
    d.agreements=d.agreements.filter(g=>g.conversation!==task.scope);
    if(a.message&&!saved.messages.some(m=>m.conversation===task.scope&&m.status!=='failed'&&m.text===a.message))saved.messages.push({
      id:'diplomacy-'+crypto.randomUUID(),conversation:task.scope,to:task.scope==='public'?null:task.players,text:a.message,basis:basisOf(o,cv),messageIds:[...task.messageIds],status:'pending',
      agreement:{conversation:task.scope,players:gamePlayers,...a.agreement,status:'none',forbidAttack:false,forbiddenTargets:[],jointAttack:null,evidence:task.messageIds,tick:o.view.tick},
      fulfillment:{state:'none',taskIds:[],reason:'外交发言不是正式签署或履约回执'},
    });
    saved.handledMessages=[...new Set([...(saved.handledMessages??[]),...task.messageIds])];
  } else {
    const covered = task.messageIds;
    const messages = saved.chat.filter((m) => covered.includes(m.id)),
      hasOwn = messages.some((m) => m.from === snapshot.chatPlayer),
      hasOther = messages.some((m) => m.from !== snapshot.chatPlayer);
    const currentAgreement = d.agreements.find(
        (g) => g.conversation === task.scope,
      ),
      now = o.view.tick + o.secondsSinceLastTick / 600;
    a = {
      ...a,
      agreement: defaultNonAggressionDeadline(
        a.agreement,
        currentAgreement,
        now,
      ),
    };
    const continuation = isConfirmedContinuation(
      currentAgreement,
      a.agreement,
      now,
    );
    if (
      a.agreement.status === "confirmed" &&
      !continuation &&
      (!hasOther || (!hasOwn && !a.message))
    )
      throw Error("双方确认缺少原文依据");
    const gamePlayers = task.players
      .map(
        (p) =>
          snapshot.roster?.find((r) => r.chatPlayer === p)?.gamePlayer ??
          (snapshot.chatPlayer === o.view.player ? p : undefined),
      )
      .filter((p): p is number => p !== undefined);
    if (gamePlayers.length !== task.players.length)
      throw Error("外交身份映射不完整");
    const joint = a.agreement.jointAttack;
    if (
      joint &&
      (joint.enemy === o.view.player ||
        gamePlayers.includes(joint.enemy) ||
        joint.until <= o.view.tick + o.secondsSinceLastTick / 600)
    )
      throw Error("联合进攻需要有效共同敌人和未来截止时间");
    const agreement: Agreement = {
      conversation: task.scope,
      players: gamePlayers,
      ...a.agreement,
      evidence: [
        ...new Set([
          ...(continuation ? (currentAgreement?.evidence ?? []) : []),
          ...(task.messageIds),
        ]),
      ],
      tick: o.view.tick,
    };
    if (a.agreement.status === "confirmed" && task.scope === "public")
      throw Error("公开讨论不能自动成为与所有玩家的协议");
    const staged = [...saved.messages]
      .reverse()
      .find(
        (m) =>
          m.conversation === task.scope &&
          m.status === "accepted" &&
          m.fulfillment?.state === "staged",
      );
    if (
      a.agreement.status === "confirmed" &&
      a.agreement.fulfillment === "tasks" &&
      !a.intentEdits?.upsert.length &&
      !a.intentEdits?.cancel.length &&
      staged?.intentEdits
    )
      a = { ...a, intentEdits: structuredClone(staged.intentEdits) };
    if (
      a.agreement.status === "confirmed" &&
      a.agreement.fulfillment === "tasks" &&
      !a.intentEdits?.upsert.length &&
      !a.intentEdits?.cancel.length &&
      !saved.intents?.some(
        (t) =>
          t.origin?.conversation === task.scope &&
          !["completed", "cancelled", "expired"].includes(t.status),
      )
    )
      throw Error(
        "协议承诺军事履约但没有tasks：普通战略任务不等于同会话履约。请在tasks.upsert复制已有任务ID及完整task以关联本会话，或仅沿用reusableTaskIds中的有效任务；仅规则合作可选择rules，纯信息选择message，假意接受选择deception。",
      );
    if (
      !a.message &&
      a.agreement.fulfillment === "tasks" &&
      a.agreement.status !== "confirmed" &&
      (a.intentEdits?.upsert.length || a.intentEdits?.cancel.length)
    )
      throw Error(
        "未确认的军事提案不能直接执行：发送提案以暂存tasks，或等待确认",
      );
    if (a.message) {
      const id = "diplomacy-" + task.scope + "-" + crypto.randomUUID();
      const duplicate = saved.messages.some(
        (m) =>
          m.conversation === task.scope &&
          m.status !== "failed" &&
          m.text === a.message,
      );
      if (!duplicate)
        saved.messages.push({
          id,
          conversation: task.scope,
          to: task.scope === "public" ? null : task.players,
          text: a.message,
          basis: basisOf(o, cv),
          messageIds: [...(task.messageIds)],
          status: "pending",
          previousAgreement:
            d.agreements.find((g) => g.conversation === task.scope) ?? null,
          objectives: [],
          agreement,
          intentEdits: structuredClone(
            a.intentEdits ?? { upsert: [], cancel: [] },
          ),
          fulfillment: {
            state: "staged",
            taskIds: [],
            reason: "等待消息确认发送后启用履约任务",
          },
        });
      // An outward commitment constrains us before sending; it is not recorded as sent or mutually confirmed.
      if (
        !duplicate &&
        !d.agreements.some(
          (g) => g.conversation === task.scope && g.status === "confirmed",
        ) &&
        (agreement.forbidAttack || agreement.forbiddenTargets.length > 0) &&
        ["proposed", "negotiating", "confirmed"].includes(agreement.status)
      )
        d.agreements = d.agreements
          .filter((g) => g.conversation !== task.scope)
          .concat({ ...agreement, status: "proposed" });
    } else {
      if (agreement.status !== "none")
        d.agreements = d.agreements
          .filter((g) => g.conversation !== task.scope)
          .concat(
            updatedAgreement(
              d.agreements.find((g) => g.conversation === task.scope),
              agreement,
              o.view.tick + o.secondsSinceLastTick / 600,
            ),
          );
      const prefix = "diplomacy:" + task.scope + ":";
      d.objectives = d.objectives.filter((g) => !g.id.startsWith(prefix));
    }
  }
  if (task.kind === "diplomacy") {
    saved.handledMessages = [
      ...new Set([
        ...(saved.handledMessages ?? []),
        ...(task.messageIds),
      ]),
    ];
    saved.conversations = {
      ...saved.conversations,
      [task.scope]: {
        summary: a.summary,
        internalIntent: a.agreement.internalIntent,
        archived: saved.conversations?.[task.scope]?.archived ?? 0,
      },
    };
    const keep = new Set([
      ...d.agreements.flatMap((g) => g.evidence),
      ...saved.messages
        .filter((m) => m.status === "pending" || m.status === "unknown")
        .flatMap((m) => m.messageIds),
    ]);
    const transcript = saved.chat.filter(
      (m) => conversation(m, snapshot.chatPlayer) === task.scope,
    );
    for (const m of transcript.slice(-12)) keep.add(m.id);
    const before = saved.chat.length;
    saved.chat = saved.chat.filter(
      (m) =>
        conversation(m, snapshot.chatPlayer) !== task.scope ||
        keep.has(m.id) ||
        !(saved.handledMessages ?? []).includes(m.id),
    );
    saved.conversations[task.scope]!.archived += before - saved.chat.length;
  }
  if (d.objectives.length > 256) throw Error("战略目标容量超限，需要协调收敛");
  d.objectives = currentObjectives(o, d.objectives);
  saved.directive = d;
  if (a.intentEdits && !(task.kind === "diplomacy" && a.message)) {
    applyIntentEdits(
      saved,
      a.intentEdits,
      task.kind === "commander" ? "commander" : "model",
      cv,
      o,
      task.kind === "diplomacy" &&
        a.agreement.status !== "none" &&
        a.agreement.fulfillment !== "deception"
        ? { kind: "diplomacy", conversation: task.scope }
        : undefined,
    );
    if (
      task.kind === "diplomacy" &&
      (a.intentEdits.upsert.length || a.intentEdits.cancel.length)
    )
      for (const m of saved.messages.filter(
        (m) =>
          m.conversation === task.scope &&
          ["blocked", "staged"].includes(m.fulfillment?.state ?? ""),
      ))
        m.fulfillment = {
          state: "active",
          taskIds: (saved.intents ?? [])
            .filter(
              (t) =>
                t.origin?.conversation === task.scope &&
                !["completed", "cancelled", "expired"].includes(t.status),
            )
            .map((t) => t.id),
          reason: "已按当前事实修复履约任务",
        };
  }
  reconcileIntents(
    o,
    saved,
    port.latest<{ operations: import("./contracts.js").OperationState[] }>(
      "operations",
    )?.operations ?? [],
  );
  saved.directive = d;
  if(task.kind==='commander'){
    const issue=commanderPlanIssue(saved,o);
    if(issue)throw Error(issue);
  }
  persist();
  if (task.kind === "strategy" && task.scope !== "coordination") {
    const conflicts = d.objectives.filter((g) =>
      g.targets.some((id) =>
        d.objectives.some(
          (other) =>
            other.id !== g.id &&
            other.targets.includes(id) &&
            ((g.kind === "capture" && other.kind === "hold") ||
              (g.kind === "hold" && other.kind === "capture")),
        ),
      ),
    );
    if (conflicts.length) {
      const posts = [...new Set(conflicts.flatMap((g) => g.targets))];
      enqueue(
        {
          id: "coordination",
          kind: "strategy",
          scope: "coordination",
          posts,
          messageIds: [],
          players: [],
        },
        JSON.stringify(conflicts),
      );
    }
  }
}
