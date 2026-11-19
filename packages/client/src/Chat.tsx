import {browserRequestId} from './browser-request-id.js';
import { X, LockKeyhole, RotateCcw } from "./OriginalIcon.js";
import { tickTime } from "./time.js";
import React, { useEffect, useRef, useState } from "react";
import { Globe2, Send } from "lucide-react";
import type { ChatMessage } from "../../contracts/src/index.js";
import { colors, playerNames } from "./theme.js";
import { ChatMessageText } from './ChatMessageText.js';
import { ChatChannels } from './ChatChannels.js';
export function Chat({
  seat,
  open,
  count,
  close,
  embedded = false,
}: {
  seat: number;
  open: boolean;
  count: number;
  close: () => void;
  embedded?: boolean;
}) {
  const [recipient, setRecipient] = useState<number | null>(null),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [sending, setSending] = useState(false),
    [retry, setRetry] = useState(0);
  const token = useRef(""),
    epoch = useRef(0),
    end = useRef<HTMLDivElement>(null),
    messageId = useRef(browserRequestId());
  useEffect(() => {
    const generation = ++epoch.current;
    setMessages([]);
    setReady(false);
    setDraft("");
    setRecipient(null);
    setError("");
    let stopped = false;
    let polling = false;
    const controller = new AbortController();
    async function call(path: string, data: unknown) {
      const r = await fetch("/api/chat/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lab-seat-token": token.current,
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      const json = await r.json();
      if (!r.ok) throw Error(json.error);
      return json;
    }
    async function poll() {
      if (polling || stopped) return;
      polling = true;
      try {
        if (!token.current) {
          const session = await call("session", { seat });
          if (stopped) return;
          token.current = session.token;
        }
        const data = await call("list", {});
        if (!stopped) {
          setMessages(data.messages);
          setReady(true);
          setError("");
        }
      } catch (e) {
        if (!stopped) {
          setError((e as Error).message);
          setReady(false);
          if ((e as Error).message === "聊天会话已失效，请重新连接") token.current = "";
        }
      } finally {
        polling = false;
      }
    }
    void poll();
    const timer = setInterval(() => {
      if (!stopped && epoch.current === generation)
        void poll();
    }, 2000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      token.current = "";
    };
  }, [seat, retry]);
  const visible = messages.filter((m) =>
    recipient === null
      ? m.to === null
      : m.to !== null &&
        ((m.from === seat && m.to === recipient) ||
          (m.from === recipient && m.to === seat)),
  );
  useEffect(() => {
    const parent = end.current?.parentElement;
    if (parent) parent.scrollTop = parent.scrollHeight;
  }, [visible.length, recipient]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || sending || !draft.trim()) return;
    setSending(true);
    setError("");
    const generation = epoch.current;
    try {
      const r = await fetch("/api/chat/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lab-seat-token": token.current,
        },
        body: JSON.stringify({
          id: messageId.current,
          to: recipient,
          text: draft,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (generation === epoch.current) {
        setMessages(data.messages);
        setDraft("");
        messageId.current = browserRequestId();
      }
    } catch (e) {
      if (generation === epoch.current) setError((e as Error).message);
    } finally {
      if (generation === epoch.current) setSending(false);
    }
  }
  return (
    <section
      className={
        "chat-window " + (open ? "is-open " : "") + (embedded ? "embedded" : "")
      }
      aria-label="聊天"
      aria-hidden={!open}
      inert={!open}
    >
      {!embedded && (
        <header>
          <span>
            {recipient === null ? (
              <Globe2 size={17} />
            ) : (
              <LockKeyhole size={17} />
            )}
            <b style={{ color: recipient === null ? undefined : colors[recipient] }}>{recipient === null ? "公开频道" : playerNames[recipient]}</b>
          </span>
          <button
            className="icon"
            aria-label="关闭聊天"
            title="关闭聊天"
            onClick={close}
          >
            <X />
          </button>
        </header>
      )}
      <div className="chat-messages" role="log" aria-live="polite">
        {!visible.length && (
          <div className="chat-empty">
            {recipient === null ? <Globe2 /> : <LockKeyhole />}
            <p>
              {recipient === null ? "向海域中的所有人广播" : "仅双方可见的对话"}
            </p>
          </div>
        )}
        {visible.map((m) => (
          <article
            key={m.from + ":" + m.id}
            className={m.from === seat ? "own" : ""}
          >
            <div>
              <b style={{ color: colors[m.from] }}>{playerNames[m.from]}</b>
              <time>{tickTime(m.tick)}</time>
            </div>
            <p><ChatMessageText text={m.text}/></p>
          </article>
        ))}
        <div ref={end} />
      </div>
      {error && (
        <div className="chat-error" role="alert">
          {error}
          <button
            className="icon"
            title="重新连接"
            aria-label="重新连接聊天"
            onClick={() => setRetry((n) => n + 1)}
          >
            <RotateCcw />
          </button>
        </div>
      )}
      <ChatChannels
        selected={recipient === null ? 'public' : String(recipient)}
        channels={[
          {id:'public',label:'公开',count:messages.filter(m=>m.to===null).length},
          ...playerNames.slice(0,count).flatMap((name,i)=>i===seat?[]:[{
            id:String(i),label:name,color:colors[i],
            count:messages.filter(m=>(m.from===seat&&m.to===i)||(m.from===i&&m.to===seat)).length,
          }]),
        ]}
        disabled={sending}
        choose={id=>{setRecipient(id==='public'?null:Number(id));setDraft('');messageId.current=browserRequestId();}}
      />
      <form onSubmit={send}>
        <input type="text" className="chat-input"
          aria-label="聊天消息"
          placeholder={recipient === null ? "发送公开消息…" : "发送私聊消息…"}
          maxLength={2000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send(e);
            }
          }}
        />
        <button
          type="submit"
          disabled={!ready || sending || !draft.trim()}
          aria-label="发送消息"
          title="发送 · Enter"
        >
          <Send size={18} />
        </button>
      </form>
    </section>
  );
}
