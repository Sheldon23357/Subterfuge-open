import { SerialExecutor } from "./player-access.js";
import { randomUUID } from "node:crypto";
import {
  DomainDocument,
  type DurableDomainDocument,
  type DomainChange,
} from "./durable-domain-store.js";
import {
  chatConversationKey,
  chatMembers,
  type ChatMessage,
  type ChatConversation,
} from "../../contracts/src/index.js";
interface ReadState {
  player: number;
  conversation: string;
  through: number;
}
function recipients(
  to: unknown,
  from: number,
  count: number,
): ChatMessage["to"] {
  if (to === null) return null;
  const values = Array.isArray(to) ? to : [to];
  if (
    values.length < 1 ||
    values.length >= count ||
    new Set(values).size !== values.length ||
    values.some(
      (v) =>
        !Number.isInteger(v) ||
        typeof v !== "number" ||
        v < 0 ||
        v >= count ||
        v === from,
    )
  )
    throw Error("请选择其他席位或公开频道");
  const sorted = [...values].sort((a, b) => Number(a) - Number(b)) as number[];
  return sorted.length === 1 ? sorted[0]! : sorted;
}
const visible = (m: ChatMessage, seat: number) =>
  m.to === null ||
  m.from === seat ||
  (Array.isArray(m.to) ? m.to.includes(seat) : m.to === seat);
interface ChatState {
  messages: ChatMessage[];
  reads: ReadState[];
}
type ChatInput = { id?: unknown; to?: unknown; text?: unknown };
function decodeChat(text: string): ChatState {
  if (text.length > 64_000_000) throw Error("Chat file too large");
  const data = JSON.parse(text),
    messages = Array.isArray(data) ? data : data?.messages,
    reads = Array.isArray(data) ? [] : data?.reads;
  if (
    (!Array.isArray(data) &&
      (data?.format !== "chat-store/2" ||
        Object.keys(data).sort().join(",") !== "format,messages,reads")) ||
    !Array.isArray(messages) ||
    messages.length > 20000 ||
    !Array.isArray(reads) ||
    reads.length > 10240
  )
    throw Error("Invalid chat file");
  const ids = new Set<string>(),
    counts = new Map<string, number[]>();
  for (const m of messages) {
    if (
      !m ||
      typeof m !== "object" ||
      Object.keys(m).sort().join(",") !== "from,id,sentAt,text,tick,to" ||
      typeof m.id !== "string" ||
      !m.id.length ||
      m.id.length > 128 ||
      typeof m.text !== "string" ||
      !m.text.trim() ||
      m.text.length > 2000 ||
      !Number.isInteger(m.from) ||
      m.from < 0 ||
      m.from >= 10 ||
      !Number.isSafeInteger(m.tick) ||
      m.tick < 0 ||
      !Number.isSafeInteger(m.sentAt) ||
      m.sentAt < 0
    )
      throw Error("Invalid chat record");
    let to: ChatMessage["to"];
    try {
      to = recipients(m.to, m.from, 10);
    } catch {
      throw Error("Invalid chat recipient");
    }
    if (JSON.stringify(to) !== JSON.stringify(m.to))
      throw Error("Invalid chat recipient order");
    const key = JSON.stringify([m.from, m.id]);
    if (ids.has(key)) throw Error("Invalid chat duplicate");
    ids.add(key);
    const conversation = chatConversationKey(m);
    const seats = counts.get(conversation) ?? Array<number>(10).fill(0);
    for (let seat = 0; seat < 10; seat++)
      if (visible(m, seat)) seats[seat] = seats[seat]! + 1;
    counts.set(conversation, seats);
  }
  const states = new Set<string>();
  for (const r of reads) {
    if (
      !r ||
      typeof r !== "object" ||
      Object.keys(r).sort().join(",") !== "conversation,player,through" ||
      !Number.isInteger(r.player) ||
      r.player < 0 ||
      r.player >= 10 ||
      typeof r.conversation !== "string" ||
      !Number.isSafeInteger(r.through) ||
      r.through < 0
    )
      throw Error("Invalid chat read state");
    const count = counts.get(r.conversation)?.[r.player] ?? 0;
    if (
      (r.conversation !== "public" && !count) ||
      r.through > count ||
      states.has(JSON.stringify([r.player, r.conversation]))
    )
      throw Error("Invalid chat read state");
    states.add(JSON.stringify([r.player, r.conversation]));
  }
  return { messages, reads };
}
function encodeChat(state: ChatState) {
  const encoded = JSON.stringify({ format: "chat-store/2", ...state });
  if (encoded.length > 64_000_000) throw Error("Chat file too large");
  return encoded;
}
function validateSeat(seat: number) {
  if (!Number.isInteger(seat) || seat < 0 || seat >= 10)
    throw Error("Invalid chat seat");
}
function conversations(state: ChatState, seat: number): ChatConversation[] {
  validateSeat(seat);
  const messages = state.messages.filter((m) => visible(m, seat)),
    threads = new Map<string, ChatMessage[]>([["public", []]]);
  for (const m of messages) {
    const key = chatConversationKey(m);
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key)!.push(m);
  }
  return [...threads]
    .map(([id, rows]) => {
      const through =
          state.reads.find((r) => r.player === seat && r.conversation === id)
            ?.through ?? 0,
        last = rows.at(-1) ?? null;
      return {
        id,
        members: last ? chatMembers(last) : null,
        unread: rows.slice(through).filter((m) => m.from !== seat).length,
        messageCount: rows.length,
        lastMessage: last,
      };
    })
    .sort(
      (a, b) =>
        (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0) ||
        a.id.localeCompare(b.id),
    );
}
/** Lab seat claiming stays on the admin listener. Messages and read marks commit atomically. */
export class ChatStore {
  private serial = new SerialExecutor();
  private tokens = new Map<string, number>();
  private document: DomainDocument<ChatState>;
  constructor(file?: string) {
    this.document = new DomainDocument(
      file,
      { messages: [], reads: [] },
      decodeChat,
      encodeChat,
    );
  }
  load() {
    return this.serial.run(() => this.document.load());
  }
  /** Call instead of load at durable startup; existing SQL skips the file entirely. */
  bindDurable(document: DurableDomainDocument) {
    return this.serial.run(() => this.document.bindDurable(document));
  }
  claim(seat: unknown, count: number) {
    if (!Number.isInteger(seat) || Number(seat) < 0 || Number(seat) >= count)
      throw Error("无效席位");
    const token = randomUUID();
    this.tokens.set(token, Number(seat));
    return token;
  }
  identity(token: unknown) {
    if (typeof token !== "string" || !this.tokens.has(token))
      throw Error("聊天会话已失效，请重新连接");
    return this.tokens.get(token)!;
  }
  list(token: unknown) {
    return this.listForSeat(this.identity(token));
  }
  listForSeat(seat: number) {
    validateSeat(seat);
    return structuredClone(
      this.document.current().messages.filter((m) => visible(m, seat)),
    );
  }
  /** Admin-listener OB transcript. Does not claim a seat or change read marks. */
  observerPage({before,after,limit=100}:{before?:number;after?:number;limit?:number}={}) {
    const all=this.document.current().messages;
    if(before!==undefined&&after!==undefined||!Number.isInteger(limit)||limit<1||limit>200||
      [before,after].some(value=>value!==undefined&&(!Number.isSafeInteger(value)||value<0||value>all.length)))throw Error('无效聊天分页参数');
    const fromCursor=after??Math.max(0,(before??all.length)-limit);
    const toCursor=after===undefined?(before??all.length):Math.min(all.length,fromCursor+limit);
    return {messages:structuredClone(all.slice(fromCursor,toCursor)),fromCursor,toCursor,total:all.length};
  }
  /** Same cursor as the v2 owner chat route, without cloning the transcript. */
  cursorForSeat(seat: number) {
    validateSeat(seat);
    return this.document
      .current()
      .messages.reduce((n, m) => n + Number(visible(m, seat)), 0);
  }
  conversationsForSeat(seat: number): ChatConversation[] {
    return structuredClone(conversations(this.document.current(), seat));
  }
  private seenChange(player: number, conversation: unknown, through: unknown) {
    return (state: ChatState): DomainChange<ChatState, void> => {
      const thread = conversations(state, player).find(
        (c) => c.id === conversation,
      );
      if (
        !thread ||
        !Number.isSafeInteger(through) ||
        Number(through) < 0 ||
        Number(through) > thread.messageCount
      )
        throw Error("Invalid chat read mark");
      const previous =
        state.reads.find(
          (r) => r.player === player && r.conversation === conversation,
        )?.through ?? 0;
      if (Number(through) <= previous) return { state, result: undefined };
      const reads = [
        ...state.reads.filter(
          (r) => r.player !== player || r.conversation !== conversation,
        ),
        { player, conversation: thread.id, through: Number(through) },
      ];
      return { state: { messages: state.messages, reads }, result: undefined };
    };
  }
  markSeenFromSeat(player: number, conversation: unknown, through: unknown) {
    return this.serial.run(() =>
      this.document.mutate(this.seenChange(player, conversation, through)),
    );
  }
  markSeenFromSeatSync(
    player: number,
    conversation: unknown,
    through: unknown,
  ) {
    return this.document.mutateSync(
      this.seenChange(player, conversation, through),
    );
  }
  send(token: unknown, input: ChatInput, count: number, tick: number) {
    return this.serial.run(() =>
      this.document.mutate(
        this.sendChange(this.identity(token), input, count, tick),
      ),
    );
  }
  sendFromSeat(from: number, input: ChatInput, count: number, tick: number) {
    return this.serial.run(() =>
      this.document.mutate(this.sendChange(from, input, count, tick)),
    );
  }
  sendFromSeatSync(
    from: number,
    input: ChatInput,
    count: number,
    tick: number,
  ) {
    return this.document.mutateSync(this.sendChange(from, input, count, tick));
  }
  private sendChange(
    from: number,
    input: ChatInput,
    count: number,
    tick: number,
  ) {
    return (state: ChatState): DomainChange<ChatState, ChatMessage> => {
      if (
        !Number.isInteger(count) ||
        count < 2 ||
        count > 10 ||
        !Number.isInteger(from) ||
        from < 0 ||
        from >= count ||
        !Number.isSafeInteger(tick) ||
        tick < 0
      )
        throw Error("Invalid chat seat or time");
      if (
        typeof input.id !== "string" ||
        !input.id.length ||
        input.id.length > 128 ||
        typeof input.text !== "string" ||
        !input.text.trim() ||
        input.text.length > 2000
      )
        throw Error("消息须为1～2000字");
      const to = recipients(input.to, from, count),
        old = state.messages.find((m) => m.id === input.id && m.from === from);
      if (old) {
        if (
          JSON.stringify(old.to) !== JSON.stringify(to) ||
          old.text !== input.text.trim()
        )
          throw Error("消息编号冲突");
        return { state, result: structuredClone(old) };
      }
      if (state.messages.length >= 20000) throw Error("本局聊天记录已达上限");
      const message: ChatMessage = {
        id: input.id,
        from,
        to,
        text: input.text.trim(),
        tick,
        sentAt: Date.now(),
      };
      return {
        state: { messages: [...state.messages, message], reads: state.reads },
        result: structuredClone(message),
      };
    };
  }
  private trimChange(tick: number) {
    return (state: ChatState) => {
      if (!Number.isSafeInteger(tick) || tick < 0)
        throw Error("Invalid chat history boundary");
      const messages = state.messages.filter((message) => message.tick <= tick);
      const reads = state.reads.flatMap((read) => {
        const count = messages.filter(
          (message) =>
            visible(message, read.player) &&
            chatConversationKey(message) === read.conversation,
        ).length;
        if (read.conversation !== "public" && count === 0) return [];
        return [{ ...read, through: Math.min(read.through, count) }];
      });
      return {
        state: { messages, reads },
        result: state.messages.length - messages.length,
      };
    };
  }
  trimToTick(tick: number) {
    return this.serial.run(() => this.document.mutate(this.trimChange(tick)));
  }
  trimToTickSync(tick: number) {
    return this.document.mutateSync(this.trimChange(tick));
  }
  reset() {
    return this.serial.run(async () => {
      await this.document.mutate(() => ({
        state: { messages: [], reads: [] },
        result: undefined,
      }));
      this.tokens.clear();
    });
  }
  /** Install a fixed scenario transcript before AI runners start. */
  seed(messages: readonly ChatMessage[]) {
    return this.serial.run(() => {
      if (messages.length > 20000) throw Error("Chat seed too large");
      const state = decodeChat(
        encodeChat({ messages: structuredClone([...messages]), reads: [] }),
      );
      return this.document.mutate(() => ({ state, result: undefined }));
    });
  }
}
