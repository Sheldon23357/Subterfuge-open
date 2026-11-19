import type { BotMode } from "@subterfuge/bot-sdk/contracts/bot-mode";
import { resolveOutpostReferences } from "@subterfuge/bot-sdk/presentation/outpost-references";
import { tacticalGuidanceAllows } from "@subterfuge/bot-sdk/analysis/tactical-planner";
import type { HybridState, OperationState } from "./contracts.js";
import { conversationKey } from "./conversation-evidence.js";
import { constraints } from "./operations.js";
import { awaitingCommander } from "./execution-recovery.js";
import {commanderProtectedFleets,commanderPlanIssue} from './commander-commitments.js';
import {ceasefirePlan} from './ceasefire.js';

/** Recheck the entire batch against current constraints immediately before execution. */
export const guardHybridExecution: NonNullable<BotMode["beforeExecute"]> = ({
  state,
  snapshot,
  tool,
  arguments: args,
  batchEffect,
  latest,
}) => {
  if (["finish", "reminders", "notebook"].includes(tool)) return;
  const saved = latest<HybridState>("state"),
    d = saved?.directive,
    cv = state.commanderDirectives?.version ?? 0;
  if (awaitingCommander(state, d ?? null))
    throw Error("指挥官约束正在更新，禁止使用旧战略执行");
  if(saved&&commanderPlanIssue(saved,snapshot.observation))throw Error('指挥官路线或阶段尚未结构化，停止提交旧方案');
  if (tool === "say") {
    const attempt = latest<{ id: string }>("message-attempt"),
      m = saved?.messages.find((m) => m.id === attempt?.id);
    if (
      !m ||
      !["pending", "unknown"].includes(m.status) ||
      m.basis.commanderVersion !== cv
    )
      throw Error("外交消息已失效");
    const to=m.to===null?null:m.to.length===1?m.to[0]:m.to;
    if(args.text!==m.text||JSON.stringify(args.to)!==JSON.stringify(to))
      throw Error('外交消息内容与当前发送记录不一致');
    const incoming = snapshot.chat.filter(
      (c) =>
        c.from !== snapshot.chatPlayer &&
        conversationKey(c, snapshot.chatPlayer) === m.conversation,
    );
    if (incoming.some((c) => !m.messageIds.includes(c.id)))
      throw Error("外交会话出现新材料，重新协商");
    return;
  }
  const now =
    snapshot.observation.view.tick +
    snapshot.observation.secondsSinceLastTick / 600;
  const proposed =
    latest<{ operations: OperationState[] }>("operations")?.operations.filter(
      (p) =>
        p.status === "proposed" &&
        (p.id === "operation-" + state.sequence ||
          p.id === "operation-" + state.sequence + "-internal"),
    ) ?? [];
  if (
    proposed.some((p) =>
      p.intentBindings?.some((b) => {
        const task = saved?.intents?.find((t) => t.id === b.id);
        return (
          !task ||
          task.version !== b.version ||
          ["completed", "cancelled", "expired"].includes(task.status) ||
          task.spec.until <= now
        );
      }),
    )
  )
    throw Error("当前意图已结束、到期或改变，停止提交旧方案");
  const hard = constraints(d ?? null, snapshot.observation, saved),
    items =
      tool === "batch"
        ? ((args.actions as {
            tool: string;
            arguments: Record<string, unknown>;
          }[]) ?? [])
        : [{ tool, arguments: args }];
  const drafts = items
    .filter((item) => item.tool === "order")
    .map((item, index) => ({
      id: "admission-" + index,
      issueTick: snapshot.observation.view.tick,
      action: resolveOutpostReferences(
        item.arguments.action,
        snapshot.observation,
      ) as Record<string, unknown>,
    }));
  const withdrawal=latest<{id:string;sequence:number}>('contract-withdrawal-attempt');
  if(withdrawal?.sequence===state.sequence){
    const command=saved?.contractCommands?.find(c=>c.id===withdrawal.id&&c.status==='pending'),review=command?.ceasefireReview;
    if(!saved||!review||review.withdrawalStatus!=='unknown'||drafts.length!==items.length||drafts.some(d=>d.action.kind!=='return-fleet'))throw Error('停战撤军批次与已评估舰队不一致');
    const approved=review.withdrawals.map(f=>f.fleetId);
    if(tool==='batch'){
      if(batchEffect||JSON.stringify(drafts.map(d=>d.action.fleetId))!==JSON.stringify(approved))throw Error('停战撤军批次与已评估舰队不一致');
    }else{
      if(tool!=='order'||!batchEffect||drafts.length!==1||!Number.isSafeInteger(batchEffect.index)||batchEffect.index<0||batchEffect.index>=approved.length)throw Error('停战撤军缺少执行器批次依据');
      const original=batchEffect.actions.map(item=>item.tool==='order'?resolveOutpostReferences(item.arguments.action,snapshot.observation) as Record<string,unknown>:null);
      if(original.some(a=>a?.kind!=='return-fleet')||JSON.stringify(original.map(a=>a?.fleetId))!==JSON.stringify(approved)||drafts[0]!.action.fleetId!==approved[batchEffect.index])throw Error('停战撤军子命令与已评估批次不一致');
      if(batchEffect.accepted.length!==batchEffect.index||batchEffect.accepted.some((r,i)=>r.index!==i||r.requestId!==`${batchEffect.id}-item-${i}`))throw Error('停战撤军前序命令缺少实际成功回执');
    }
    const current=ceasefirePlan(snapshot.observation,review.peer,review.outposts,saved,latest<{operations:OperationState[]}>('operations')?.operations??[]);
    const remaining=batchEffect?review.withdrawals.slice(batchEffect.index):review.withdrawals;
    if(current.externalSignature!==review.externalSignature||JSON.stringify(current.withdrawals)!==JSON.stringify(remaining)||current.blockers.length)throw Error('停战撤军损失或安全依据已变化');
  }
  for (const { action: a } of drafts) {
    if(a.kind==='propose-agreement'||a.kind==='respond-agreement'){
      const attempt=latest<{id:string}>('contract-attempt');
      const command=saved?.contractCommands?.find(c=>c.id===attempt?.id&&c.status==='unknown');
      if(!command||command.basis.commanderVersion!==cv||JSON.stringify(command.action)!==JSON.stringify(a))throw Error('正式协议操作与当前持久意图或指挥官版本不一致');
      const terms=command.action.kind==='propose-agreement'?command.action.terms:command.action.response==='accept'?snapshot.observation.diplomacy?.agreements.find(g=>g.id===(command.action as {agreementId:string}).agreementId)?.terms:null;
      if(terms?.kind==='ceasefire'){
        const review=command.ceasefireReview;
        if(!saved||!review||review.withdrawalStatus!=='confirmed')throw Error('停战撤军尚未确认，禁止签约');
        const current=ceasefirePlan(snapshot.observation,review.peer,terms.outposts,saved,latest<{operations:OperationState[]}>('operations')?.operations??[]);
        if(current.withdrawals.length||current.externalSignature!==review.externalSignature)throw Error('停战范围或在途风险已变化，禁止按旧依据签约');
      }
    }
    if(saved&&a.kind==='return-fleet'&&commanderProtectedFleets(snapshot.observation,saved,latest<{operations:OperationState[]}>('operations')?.operations??[]).includes(String(a.fleetId))){
      const explicit=proposed.some(p=>p.phase==='fleet-intent'&&p.intentBindings?.some(b=>saved.intents?.some(t=>t.id===b.id&&t.version===b.version&&t.authority==='commander'&&t.commanderVersion===cv)));
      if(!explicit)throw Error('指挥官运输承诺仍在执行，普通规划不得撤回或改向');
    }
    if (
      a.kind === "return-fleet" &&
      proposed.some((p) => p.phase === "fleet-intent")
    ) {
      const f = snapshot.observation.view.fleets.find(
        (f) => f.id === a.fleetId,
      );
      if (!f || f.owner !== snapshot.observation.view.player)
        throw Error("舰队已失效或不属于己方");
      if (a.kind === "return-fleet" && f.canReturn !== true)
        throw Error("当前舰队已不能返航");
    }
  }
  if (
    !tacticalGuidanceAllows(snapshot.observation, drafts, {
      ...hard,
      objectives: [],
      rotation: 0,
    })
  )
    throw Error("当前禁止派兵、来源保护、留守或目标投入上限禁止此行动");
};
