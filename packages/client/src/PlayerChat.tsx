import {browserRequestId} from './browser-request-id.js';
import {gameAudio} from "./game-audio.js";
import React, { useEffect, useRef, useState } from "react";
import {
  chatConversationKey,
  type ChatMessage,
  type ChatConversation,
} from "../../contracts/src/index.js";
import { PlayerConnection } from "./player-connection.js";
import { colors, playerNames } from "./theme.js";
import { clockTime } from "./time.js";
import { ChatMessageText } from './ChatMessageText.js';
import { ChatChannels } from './ChatChannels.js';
export function PlayerChat({
  connection,
  readOnly=false,
  roomId,
  player,
  count,
  participants = Array.from({ length: count }, (_, i) => i),
  peers,
}: {
  connection: PlayerConnection;
  readOnly?: boolean;
  roomId: string;
  player: number;
  count: number;
  participants?: number[];
  peers?: Record<number, { name: string; color: string }>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]),
    [conversations, setConversations] = useState<ChatConversation[]>([]),
    [channel, setChannel] = useState("public");
  const [creating, setCreating] = useState(false),
    [recipients, setRecipients] = useState<number[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const cursor = useRef(0),
    loaded = useRef<ChatMessage[]>([]),
    selected = useRef(channel),
    messageId = useRef(browserRequestId()),
    refresh = useRef<() => Promise<void>>(async () => {});
  selected.current = channel;
  const readOnlyRef=useRef(readOnly);readOnlyRef.current=readOnly;
  const participantKey = participants.join(",");
  useEffect(
    () =>
      setRecipients((prior) => prior.filter((n) => participants.includes(n))),
    [participantKey],
  );
  const name = (seat: number) => peers?.[seat]?.name ?? playerNames[seat];
  const color = (seat: number) => peers?.[seat]?.color ?? colors[seat];
  function choose(id: string) {
    setChannel(id);
    setText("");
    messageId.current = browserRequestId();
  }
  useEffect(() => {
    let active = true,
      running = false,
      audioReady = false;
    const audioSeen = new Set<string>();
    cursor.current = 0;
    loaded.current = [];
    setMessages([]);
    setConversations([]);
    const load = async () => {
      if (running) return;
      running = true;
      try {
        let more = true;
        while (active && more) {
          const page = await connection.chat(cursor.current);
          if (!active) return;
          if (page.roomId !== roomId) throw Error("对局已更新，请重新连接。");
          const incoming=page.messages.filter(m=>!audioSeen.has(m.id));
          page.messages.forEach(m=>audioSeen.add(m.id));
          if(audioReady && incoming.some(m=>m.from!==player))gameAudio.play("message_received");
          cursor.current = page.nextCursor;
          loaded.current = [...loaded.current, ...page.messages];
          more = page.hasMore;
        }
        if (!active) return;
        audioReady=true;
        setMessages(loaded.current);
        const summary = await connection.conversations();
        if (!active) return;
        if (summary.roomId !== roomId) throw Error("对局已更新，请重新连接。");
        setConversations(summary.conversations);
        const key = selected.current,
          thread = summary.conversations.find((c) => c.id === key),
          through = loaded.current.filter(
            (m) => chatConversationKey(m) === key,
          ).length;
        if (
          !readOnlyRef.current && document.visibilityState === "visible" &&
          thread &&
          thread.unread > 0 &&
          through > 0
        ) {
          const read = await connection.markChatSeen(
            key,
            Math.min(through, thread.messageCount),
          );
          if (active && read.roomId === roomId)
            setConversations(read.conversations);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    refresh.current = load;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, roomId]);
  useEffect(() => {
    void refresh.current();
  }, [channel]);
  const visible = messages.filter((m) => chatConversationKey(m) === channel),
    members = channel === "public" ? null : channel.split(",").map(Number);
  const title = (id: string) =>
    id === "public"
      ? "公开频道 · 所有人"
      : id
          .split(",")
          .filter((n) => Number(n) !== player)
          .map((n) => name(Number(n)))
          .join("、");
  const directIds = participants
    .filter((n) => n !== player)
    .map((n) => [player, n].sort((a, b) => a - b).join(","));
  const groupIds = conversations
    .filter((c) => !!c.members && !directIds.includes(c.id))
    .map((c) => c.id);
  if (members && !directIds.includes(channel) && !groupIds.includes(channel))
    groupIds.push(channel);
  return (
    <section className="player-chat" aria-label="外交聊天">
      <button
        type="button"
        disabled={busy}
        onClick={() => setCreating(!creating)}
      >
        新建秘密会话
      </button>
      {creating && (
        <form
          className="player-group-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (!recipients.length) return;
            choose([player, ...recipients].sort((a, b) => a - b).join(","));
            setCreating(false);
            setRecipients([]);
          }}
        >
          <fieldset>
            <legend>选择会话成员</legend>
            {participants.map(
              (i) =>
                i !== player && (
                  <label className="player-check" key={i}>
                    <input
                      type="checkbox"
                      checked={recipients.includes(i)}
                      onChange={(e) =>
                        setRecipients(
                          e.target.checked
                            ? [...recipients, i]
                            : recipients.filter((n) => n !== i),
                        )
                      }
                    />
                    <span style={{ color: color(i) }}>{name(i)}</span>
                  </label>
                ),
            )}
          </fieldset>
          <p className="muted">
            只有选中的成员和你能看到此会话。成员组合不同，会建立另一段会话。
          </p>
          <button disabled={!recipients.length}>开始会话</button>
        </form>
      )}
      {members && (
        <p className="muted">成员：{members.map((n, i) => <React.Fragment key={n}>{i > 0 && "、"}<span style={{ color: color(n) }}>{name(n)}</span></React.Fragment>)}</p>
      )}
      <div className="player-messages" role="log" aria-live="polite">
        {!visible.length && (
          <p className="muted">
            {members ? "只有会话成员可见。" : "向所有玩家发言。"}
          </p>
        )}
        {visible.map((m) => (
          <article key={JSON.stringify([m.from, m.id])}>
            <b style={{ color: color(m.from) }}>
              {name(m.from)}
            </b>
            <time>
              {clockTime(m.sentAt)}
            </time>
            <p><ChatMessageText text={m.text}/></p>
          </article>
        ))}
      </div>
      <ChatChannels
        selected={channel}
        channels={['public',...directIds,...groupIds].map(id=>{
          const thread=conversations.find(c=>c.id===id);
          const others=id==='public'?[]:id.split(',').map(Number).filter(n=>n!==player);
          return {id,label:id==='public'?'公开':title(id),
            color:others.length===1?color(others[0]!):undefined,
            count:thread?.messageCount??messages.filter(m=>chatConversationKey(m)===id).length,
            unread:thread?.unread??0};
        })}
        disabled={busy}
        choose={choose}
      />
      <form className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || readOnlyRef.current || !text.trim()) return;
          setBusy(true);
          setError("");
          const others = members?.filter((n) => n !== player),
            to = others ? (others.length === 1 ? others[0]! : others) : null;
          void connection
            .sendChat(messageId.current, to, text)
            .then(async () => {
              setText("");
              messageId.current = browserRequestId();
              await refresh.current();
            })
            .catch((e) => setError((e as Error).message))
            .finally(() => setBusy(false));
        }}
      >
          <input type="text" className="chat-input"
            aria-label="聊天消息"
            placeholder={members ? '发送私聊消息…' : '发送公开消息…'}
            required
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy||readOnly}
          />
        <button disabled={busy || readOnly || !text.trim()}>
          {busy ? "发送中…" : "发送消息"}
        </button>
      </form>
      {error && (
        <p className="player-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
