import {prepareCommanderCleanup} from '../../contracts/src/index.js';
import { createHash,randomUUID } from "node:crypto";
import {
  DomainDocument,
  domainValidation,
  type DurableDomainDocument,
} from "./durable-domain-store.js";
import type {
  CommanderThread,
  CommanderMessage,
  CommanderReference,
  PlayerObservation,
} from "../../contracts/src/index.js";
import { SerialExecutor } from "./player-access.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("无效对话请求");
  return value as Record<string, unknown>;
}
function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    throw Error("无效对话字段");
}
function text(value: unknown, max: number, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw Error("无效对话内容");
  return value.trim();
}
function integer(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("无效指示版本");
  return value;
}
function id(value: unknown) {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw Error("无效消息标识");
  return result;
}
const key = (roomId: string, player: number) =>
  JSON.stringify([roomId, player]);
function decodeCommander(payload: string): Map<string, CommanderThread> {
  if (payload.length > 32_000_000) throw Error("Commander journal too large");
  const data: unknown = JSON.parse(payload);
  const root = object(data);
  fields(root, ["format", "threads"]);
  if (
    root.format !== "commander-store/1" ||
    !Array.isArray(root.threads) ||
    root.threads.length > 1000
  )
    throw Error("Invalid commander journal");
  const loaded = new Map<string, CommanderThread>();
  for (const raw of root.threads) {
    const v = object(raw);
    fields(v, ["roomId", "player", "messages", "directives"]);
    const roomId = text(v.roomId, 200),
      player = integer(v.player);
    if (player >= 10 || !Array.isArray(v.messages) || v.messages.length > 20000)
      throw Error("Invalid commander thread");
    const d = object(v.directives);
    fields(d, ["version", "text", "appliedVersion"]);
    const version = integer(d.version),
      appliedVersion = integer(d.appliedVersion);
    if (
      typeof d.text !== "string" ||
      d.text.length > 6000 ||
      appliedVersion > version
    )
      throw Error("Invalid commander directives");
    const ids = new Set<string>();
    for (const rawMessage of v.messages) {
      const m = object(rawMessage);
      fields(
        m,
        ["id", "role", "text", "references", "tick", "sentAt", "status"],
        ["replyTo", "proposal"],
      );
      const mid = id(m.id);
      if (ids.has(mid)) throw Error("Duplicate commander message");
      ids.add(mid);
      if (
        typeof m.role !== "string" ||
        !["player", "assistant", "system"].includes(m.role) ||
        typeof m.status !== "string" ||
        !["queued", "completed", "failed"].includes(m.status)
      )
        throw Error("Invalid commander message");
      text(m.text, 8000);
      integer(m.tick);
      integer(m.sentAt);
      if (!Array.isArray(m.references) || m.references.length > 12)
        throw Error("Invalid commander reference");
      for (const rawRef of m.references) {
        const r = object(rawRef);
        fields(r, ["kind", "id"], ["label"]);
        if (
          typeof r.kind !== "string" ||
          !["fleet", "outpost"].includes(r.kind)
        )
          throw Error("Invalid commander reference");
        text(r.id, 200);
        if (r.label !== undefined) text(r.label, 120);
      }
      if (m.replyTo !== undefined) id(m.replyTo);
      if (m.proposal !== undefined) {
        const p = object(m.proposal);
        fields(p, ["id", "baseVersion", "text", "summary", "status"]);
        id(p.id);
        integer(p.baseVersion);
        text(p.text, 6000, true);
        text(p.summary, 500);
        if (
          typeof p.status !== "string" ||
          !["pending", "confirmed", "superseded"].includes(p.status)
        )
          throw Error("Invalid commander proposal");
      }
    }
    const k = key(roomId, player);
    if (loaded.has(k)) throw Error("Duplicate commander thread");
    loaded.set(k, structuredClone(raw) as CommanderThread);
  }
  return loaded;
}
function encodeCommander(threads: Map<string, CommanderThread>) {
  const encoded = JSON.stringify({
    format: "commander-store/1",
    threads: [...threads.values()],
  });
  if (encoded.length > 32_000_000) throw Error("对话存储已满");
  return encoded;
}
function readThread(
  threads: Map<string, CommanderThread>,
  roomId: string,
  player: number,
): CommanderThread {
  return structuredClone(
    threads.get(key(roomId, player)) ?? {
      roomId,
      player,
      messages: [],
      directives: { version: 0, text: "", appliedVersion: 0 },
    },
  );
}
/** A separate private journal: no mutation to game time, readiness, or diplomacy. */
export class CommanderStore {
  private document: DomainDocument<Map<string, CommanderThread>>;
  private serial = new SerialExecutor();
  private workers = new Map<string, number>();
  heartbeat(roomId: string, player: number) {
    this.workers.set(key(roomId, player), Date.now());
  }
  available(roomId: string, player: number) {
    return Date.now() - (this.workers.get(key(roomId, player)) ?? 0) < 15000;
  }
  constructor(file?: string) {
    this.document = new DomainDocument(
      file,
      new Map(),
      decodeCommander,
      encodeCommander,
      0o600,
    );
  }
  load() {
    return this.serial.run(() => this.document.load());
  }
  /** Call instead of load at durable startup; existing SQL skips the file entirely. */
  bindDurable(document: DurableDomainDocument) {
    return this.serial.run(() => this.document.bindDurable(document));
  }
  read(roomId: string, player: number): CommanderThread {
    return readThread(this.document.current(), roomId, player);
  }
  version(roomId: string, player: number) {
    return (
      this.document.current().get(key(roomId, player))?.directives.version ?? 0
    );
  }
  private transform(
    roomId: string,
    player: number,
    change: (thread: CommanderThread) => void,
  ) {
    return (threads: Map<string, CommanderThread>) => {
      const thread = readThread(threads, roomId, player);
      change(thread);
      if (thread.messages.length > 20000) throw Error("本局对话记录已满");
      const next = new Map(threads);
      next.set(key(roomId, player), thread);
      return { state: next, result: structuredClone(thread) };
    };
  }
  private update(
    roomId: string,
    player: number,
    change: (thread: CommanderThread) => void,
  ) {
    return this.serial.run(() =>
      this.document.mutate(this.transform(roomId, player, change)),
    );
  }
  private updateSync(
    roomId: string,
    player: number,
    change: (thread: CommanderThread) => void,
  ) {
    return this.document.mutateSync(this.transform(roomId, player, change));
  }
  async send(
    roomId: string,
    player: number,
    raw: unknown,
    observation: PlayerObservation,
  ) {
    return this.update(
      roomId,
      player,
      this.sendChange(roomId, player, raw, observation),
    );
  }
  sendSync(
    roomId: string,
    player: number,
    raw: unknown,
    observation: PlayerObservation,
  ) {
    return this.updateSync(
      roomId,
      player,
      this.sendChange(roomId, player, raw, observation),
    );
  }
  async confirm(roomId: string, player: number, raw: unknown, tick: number) {
    return this.update(roomId, player, this.confirmChange(raw, tick));
  }
  confirmSync(roomId: string, player: number, raw: unknown, tick: number) {
    return this.updateSync(roomId, player, domainValidation(()=>this.confirmChange(raw, tick)));
  }
  async worker(roomId: string, player: number, raw: unknown, tick: number) {
    return this.update(roomId, player, this.workerChange(raw, tick));
  }
  workerSync(roomId: string, player: number, raw: unknown, tick: number) {
    return this.updateSync(roomId, player, domainValidation(()=>this.workerChange(raw, tick)));
  }
  private sendChange(
    roomId: string,
    player: number,
    raw: unknown,
    observation: PlayerObservation,
  ) {
    const input = object(raw);
    fields(input, ["id", "text", "references"]);
    const messageId = id(input.id),
      content = text(input.text, 4000);
    if (!Array.isArray(input.references) || input.references.length > 12)
      throw Error("最多引用十二个对象");
    if (observation.roomId !== roomId || observation.view.player !== player)
      throw Error("对局身份已变化");
    const refs: CommanderReference[] = input.references.map((rawRef) => {
      const r = object(rawRef);
      fields(r, ["kind", "id"], ["label"]);
      const refId = text(r.id, 200);
      if (
        r.kind === "outpost" &&
        observation.view.outposts.some((o) => o.id === refId)
      )
        return {
          kind: "outpost",
          id: refId,
          label: (observation.outpostNames?.[refId] ?? refId).slice(0, 120),
        };
      if (
        r.kind === "fleet" &&
        observation.view.fleets.some((f) => f.id === refId)
      )
        return {
          kind: "fleet",
          id: refId,
          label: `舰队 ${refId.slice(0, 8)}`,
        };
      throw Error("引用对象当前不可见");
    });
    if (new Set(refs.map((r) => r.kind + ":" + r.id)).size !== refs.length)
      throw Error("重复引用");
    return (thread: CommanderThread) => {
      const old = thread.messages.find((m) => m.id === messageId);
      if (old) {
        if (
          old.role !== "player" ||
          old.text !== content ||
          JSON.stringify(
            old.references.map(({ kind, id }) => ({ kind, id })),
          ) !== JSON.stringify(refs.map(({ kind, id }) => ({ kind, id })))
        )
          throw Error("消息标识冲突");
        return;
      }
      if (thread.messages.filter((m) => m.status === "queued").length >= 5)
        throw Error("请等当前讨论回复后再发送");
      thread.messages.push({
        id: messageId,
        role: "player",
        text: content,
        references: refs,
        tick: observation.view.tick,
        sentAt: Date.now(),
        status: "queued",
      });
    };
  }
  private confirmChange(raw: unknown, tick: number) {
    const input = object(raw);
    fields(input, ["proposalId", "version"]);
    const proposalId = id(input.proposalId),
      version = integer(input.version);
    return (thread: CommanderThread) => {
      const proposal = thread.messages.find(
        (m) => m.proposal?.id === proposalId,
      )?.proposal;
      if (!proposal) throw Error("方案不存在");
      if (proposal.status === "confirmed") {
        if (version !== proposal.baseVersion) throw Error("方案版本不匹配");
        return;
      }
      if (
        proposal.status !== "pending" ||
        version !== proposal.baseVersion ||
        version !== thread.directives.version
      )
        throw Error("指挥官指令已经更新，请重新讨论此方案");
      thread.directives = {
        version: version + 1,
        text: proposal.text,
        appliedVersion: thread.directives.appliedVersion,
      };
      proposal.status = "confirmed";
      for (const m of thread.messages)
        if (m.proposal?.status === "pending") m.proposal.status = "superseded";
      thread.messages.push({
        id: randomUUID(),
        role: "system",
        text: "指挥官指令已保存，AI 将调整原有策略。",
        references: [],
        tick,
        sentAt: Date.now(),
        status: "completed",
      });
    };
  }
  private workerChange(raw: unknown, tick: number) {
    const input = object(raw);
    if(input.op==='cleanup'){
      fields(input,['op','requestId','cleanup']);const requestId=id(input.requestId);if(requestId.length>64)throw Error('Invalid cleanup request ID');
      const prefix='cleanup-'+requestId+'-',marker=prefix+createHash('sha256').update(JSON.stringify(input.cleanup)).digest('hex').slice(0,24);
      return (thread:CommanderThread)=>{
        const old=thread.messages.find(m=>m.id.startsWith(prefix));
        if(old){if(old.id!==marker)throw Error('Cleanup request ID conflict');return;}
        if(thread.directives.appliedVersion!==thread.directives.version)throw Error('Commander reconciliation is still pending');
        const {cleanup,text:remaining}=prepareCommanderCleanup(thread.directives,input.cleanup);
        const version=thread.directives.version+1;
        thread.directives={version,text:remaining,appliedVersion:version};
        for(const message of thread.messages)if(message.proposal?.status==='pending')message.proposal.status='superseded';
        const now=Date.now();thread.messages.push({id:marker,role:'system',text:`已从当前指挥官指令清理 ${cleanup.completed.length} 项已完成要求；未完成目标和持续约束继续保留。`,references:[],tick,sentAt:now,status:'completed'});
        const archive=cleanup.completed.map(item=>'已完成并清理：'+item.quote+'\n完成依据：'+item.reason+'\n证据：'+item.evidence.join('、')).join('\n\n');
        for(let offset=0,index=0;offset<archive.length;offset+=1500,index++)thread.messages.push({id:marker+'-'+index,role:'system',text:archive.slice(offset,offset+1500),references:[],tick,sentAt:now,status:'completed'});
      };
    }
    if (input.op === "notice") {
      fields(input, ["op", "id", "reply"]);
      const noticeId = "notice-" + id(input.id),
        reply = text(input.reply, 1500);
      if (noticeId.length > 128) throw Error("无效通知标识");
      return (thread: CommanderThread) => {
        const old = thread.messages.find((m) => m.id === noticeId);
        if (old) {
          if (old.role !== "assistant" || old.text !== reply)
            throw Error("通知标识冲突");
          return;
        }
        thread.messages.push({
          id: noticeId,
          role: "assistant",
          text: reply,
          references: [],
          tick,
          sentAt: Date.now(),
          status: "failed",
        });
      };
    }
    if (input.op === "ack") {
      fields(input, ["op", "version", "reply"]);
      const version = integer(input.version);
      text(input.reply, 1500);
      return (thread: CommanderThread) => {
        if (version !== thread.directives.version)
          throw Error("指挥官指令已更新");
        thread.messages=thread.messages.filter(m=>m.id!==`notice-reconcile-error-${version}`);
        if (thread.directives.appliedVersion >= version) return;
        thread.directives.appliedVersion = version;
        // Reconciliation is an internal receipt. Confirmation already emitted
        // the sole progress message; do not append another success reply.
      };
    }
    fields(input, ["op", "messageId", "reply"], ["proposal", "error"]);
    if (
      input.op !== "reply" ||
      (input.error !== undefined && typeof input.error !== "boolean")
    )
      throw Error("无效回复");
    const messageId = id(input.messageId),
      reply = text(input.reply, 2000);
    let proposed:
      | { baseVersion: number; text: string; summary: string }
      | undefined;
    if (input.proposal !== undefined) {
      if (input.error) throw Error("失败回复不能附带方案");
      const p = object(input.proposal);
      fields(p, ["baseVersion", "text", "summary"]);
      proposed = {
        baseVersion: integer(p.baseVersion),
        text: text(p.text, 6000, true),
        summary: text(p.summary, 500),
      };
    }
    return (thread: CommanderThread) => {
      const original = thread.messages.find(
        (m) => m.id === messageId && m.role === "player",
      );
      if (!original) throw Error("消息不存在");
      if (original.status !== "queued") return;
      original.status = input.error ? "failed" : "completed";
      const message: CommanderMessage = {
        id: randomUUID(),
        role: "assistant",
        text: reply,
        references: structuredClone(original.references),
        tick,
        sentAt: Date.now(),
        status: input.error ? "failed" : "completed",
        replyTo: messageId,
      };
      if (proposed)
        message.proposal = {
          id: randomUUID(),
          ...proposed,
          status:
            proposed.baseVersion === thread.directives.version
              ? "pending"
              : "superseded",
        };
      thread.messages.push(message);
    };
  }
}
