import {BindSeatBot} from './BindSeatBot.js';
import React, { useEffect, useRef, useState } from "react";
import type {
  PlayerLobbyView,
  PlayerLobbyEvent,
} from "../../contracts/src/index.js";
import { PlayerConnection } from "./player-connection.js";
import { colors, playerNames } from "./theme.js";
import { countdown, minutes, clockTime } from "./time.js";
import { lobbyControls, lobbySeconds } from "./player-lobby.js";
import "./player-lobby.css";
import { AiLobbyPanel } from "./AiLobbyPanel.js";
import type {HubBotLink,HubBotLinks} from '../../contracts/src/index.js';
function savedRoomCode(roomId:string){try{return sessionStorage.getItem('subterfuge-hub-room-id')===roomId?sessionStorage.getItem('subterfuge-room-code'):null;}catch{return null;}}

const statuses = {
  waiting: "等待玩家",
  starting: "开局倒计时（现实时间）",
  "in-progress": "对局进行中",
  ended: "对局已结束",
  cancelled: "房间已取消",
};
type LobbyAction = "join" | "leave" | "cancel" | "start";
function useCountdown(lobby: PlayerLobbyView) {
  const [remaining, setRemaining] = useState(lobby.secondsRemaining ?? 0);
  useEffect(() => {
    const start = performance.now();
    setRemaining(lobby.secondsRemaining ?? 0);
    if (lobby.status !== "starting") return;
    const timer = setInterval(
      () => setRemaining(lobbySeconds(lobby, performance.now() - start)),
      250,
    );
    return () => clearInterval(timer);
  }, [lobby.status, lobby.secondsRemaining]);
  return remaining;
}
export function PlayerLobbyStatus({
  lobby,
  open,
}: {
  lobby: PlayerLobbyView;
  open: () => void;
}) {
  const remaining = useCountdown(lobby);
  if (!["waiting", "starting"].includes(lobby.status)) return null;
  return (
    <button
      className="player-lobby-status"
      data-audio-silent
      onClick={open}
      aria-label="查看房间状态"
    >
      <span>{statuses[lobby.status]}{lobby.timing&&(lobby.timing.mode==='turn-based'?' · 回合模式':` · 实时 ${lobby.timing.tickSeconds} 秒/tick`)}</span>
      <b>
        {lobby.status === "starting"
          ? remaining > 0
            ? countdown(remaining)
            : "正在开局…"
          : `${lobby.occupied.filter(Boolean).length} / ${lobby.capacity}`}
      </b>
      <small>房间信息</small>
    </button>
  );
}

export function PlayerLobby({
  lobby,
  connection,
  busy,
  error,
  retry,
  command,
  disconnect,
  onPreview,
}: {
  lobby: PlayerLobbyView;
  connection: PlayerConnection;
  busy: boolean;
  error: string;
  retry: (() => void) | null;
  command: (kind: LobbyAction, revision: number) => Promise<boolean>;
  disconnect: () => void;
  onPreview?: () => void;
}) {
  const controls = lobbyControls(lobby),
    remaining = useCountdown(lobby);
  const [confirmation, setConfirmation] = useState<{
    kind: LobbyAction;
    revision: number;
  } | null>(null);
  const membership = JSON.stringify([
    lobby.roomId,
    lobby.status,
    lobby.occupied,
  ]);
  useEffect(() => setConfirmation(null), [membership]);
  const pending = confirmation?.kind;
  const roomCode=savedRoomCode(lobby.roomId);
  const [botLinks,setBotLinks]=useState<HubBotLink[]>([]);
  useEffect(()=>{
    setBotLinks([]);if(!roomCode)return;
    const controller=new AbortController();let running=false;
    const poll=async()=>{if(running)return;running=true;try{const response=await fetch(`/api/rooms/${roomCode}/bots`,{signal:controller.signal,credentials:'omit'});if(!response.ok)throw Error('无法读取连接状态');const result=await response.json() as HubBotLinks;if(!Array.isArray(result.connections))throw Error('连接状态无效');if(!controller.signal.aborted)setBotLinks(result.connections);}catch{if(!controller.signal.aborted)setBotLinks([]);}finally{running=false;}};
    void poll();const timer=setInterval(()=>void poll(),3000);
    return()=>{controller.abort();clearInterval(timer);};
  },[roomCode,connection]);
  const labels = {
    join: "加入对局",
    leave: "离开房间",
    cancel: "离开房间",
    start: controls.count === lobby.capacity ? "开始对局" : "提前开局",
  };
  return (
    <div className="player-lobby-content">
      <div className="lobby-summary">
        <span>{statuses[lobby.status]}{lobby.timing&&(lobby.timing.mode==='turn-based'?' · 回合模式':` · 实时 ${lobby.timing.tickSeconds} 秒/tick`)}</span>
        <b>
          {lobby.status === "starting"
            ? countdown(remaining)
            : `${controls.count} / ${lobby.capacity}`}
          <small>
            {lobby.status === "starting" ? "后正式开始" : "玩家已加入"}
          </small>
        </b>
      </div>
      {lobby.gameSeat === null &&
      lobby.status !== "waiting" &&
      lobby.status !== "cancelled" ? (
        <p>本局已进入开局流程，你未加入本局。</p>
      ) : lobby.status === "cancelled" ? (
        <p>房主已取消这个房间。</p>
      ) : null}
      <ol className="lobby-seats" aria-label="房间席位">
        {lobby.occupied.map((occupied, seat) => (
          <li key={seat} className={occupied ? "occupied" : ""} data-occupied={occupied}>
            <i style={{ background: occupied ? colors[seat] : undefined }} />
            <span>
              {occupied
                ? `${playerNames[seat]}`
                : lobby.status === "waiting"
                  ? "等待加入"
                  : "未加入"}
              <small>
                {seat === lobby.player ? "你的席位" : `席位 ${seat + 1}`}
                {seat === 0 ? " · 房主" : ""}
              </small>
              {occupied&&botLinks.find(link=>link.seat===seat)&&<small className="lobby-bot-model">{botLinks.find(link=>link.seat===seat)!.model}</small>}
            </span>
            <b>
              {occupied&&botLinks.some(link=>link.seat===seat)
                ? `${botLinks.find(link=>link.seat===seat)!.name} 已连接`
                : occupied
                ? "已加入"
                : lobby.status === "waiting"
                  ? "空位"
                  : "未入局"}
            </b>
            {roomCode&&!botLinks.some(link=>link.seat===seat)&&!['ended','cancelled'].includes(lobby.status)&&(occupied?seat===lobby.player:lobby.status==='waiting')&&<BindSeatBot code={roomCode} roomId={lobby.roomId} seat={seat} own={!!occupied}/>}
          </li>
        ))}
      </ol>
      {controls.host && !roomCode && lobby.status !== "cancelled" && (
        <AiLobbyPanel connection={connection} lobby={lobby} />
      )}
      {error && (
        <p className="player-error" role="alert">
          {error}
          {retry && (
            <button disabled={busy} onClick={retry}>
              重试同一操作
            </button>
          )}
        </p>
      )}
      {confirmation ? (
        <div className="lobby-confirmation-backdrop">
        <section
          className="lobby-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-describedby="lobby-confirmation-consequence"
          onKeyDown={e=>{
            if(e.key==='Escape'&&!busy){e.preventDefault();setConfirmation(null);}
            if(e.key==='Tab'){
              const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const first=buttons[0],last=buttons.at(-1);
              if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
              else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
            }
          }}
          aria-label={"确认" + labels[confirmation.kind]}
        >
          <h3>{pending === "start" ? "准备开局？" : "离开房间？"}</h3>
          <p id="lobby-confirmation-consequence">
            {pending === "cancel"
              ? "你是房主，离开将取消房间，所有已加入玩家都将退出。"
              : pending === "leave"
                ? "离开会撤回等待中的舰队，并归还舰数。"
                : pending === "start"
                  ? controls.count < lobby.capacity
                    ? `将按当前 ${controls.count} 人重新生成海图，清空已有预约，并在现实 ${minutes(controls.delayHours * 60)}后正式开局。`
                    : `保留当前海图和预约，在现实 ${minutes(controls.delayHours * 60)}后正式开局。`
                  : ""}
          </p>
          <div className="two-buttons">
            <button autoFocus disabled={busy} onClick={() => setConfirmation(null)}>
              {pending === "start" ? "继续等待" : "返回"}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void command(confirmation.kind, confirmation.revision).then(
                  (ok) => {
                    if (ok && confirmation.kind === "start") setConfirmation(null);
                  },
                )
              }
            >
              {busy ? "正在处理…" : "确认" + labels[confirmation.kind]}
            </button>
          </div>
        </section>
        </div>
      ) : (
        <div className="lobby-actions" aria-label="房间操作">
          {onPreview && <button disabled={busy} onClick={onPreview}>预览我的海域</button>}
          {lobby.status === "waiting" && (!controls.joined ? (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void command("join", lobby.revision)}
            >
              加入对局
            </button>
          ) : (
            <>
              {controls.host && (
                <button
                  className="primary"
                  disabled={busy || !controls.canStart}
                  onClick={() =>
                    setConfirmation({ kind: "start", revision: lobby.revision })
                  }
                >
                  {labels.start}
                </button>
              )}

            </>
          ))}
        <button className="lobby-disconnect" disabled={busy} onClick={() => {
          if (lobby.status === 'waiting' && controls.joined) {
            setConfirmation({kind: controls.host ? 'cancel' : 'leave', revision: lobby.revision});
          } else {
            disconnect();
            if (roomCode) window.location.assign('/');
          }
        }}>
          {lobby.status === 'waiting' && controls.joined ? '离开房间' : '返回大厅'}
        </button>

        </div>
      )}
      <details className="lobby-history">
        <summary>房间记录</summary>
        <PlayerLobbyEvents
          connection={connection}
          roomId={lobby.roomId}
          visible
        />
      </details>

    </div>
  );
}

export function PlayerLobbyEvents({
  connection,
  roomId,
  visible,
}: {
  connection: PlayerConnection;
  roomId: string;
  visible: boolean;
}) {
  const [events, setEvents] = useState<PlayerLobbyEvent[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  const cursor = useRef(0);
  useEffect(() => {
    cursor.current = 0;
    setEvents([]);
    setLoaded(false);
    setError("");
  }, [connection, roomId]);
  useEffect(() => {
    if (!visible) return;
    let active = true,
      running = false;
    const controller = new AbortController();
    const load = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        for (let page = 0; page < 5 && active; page++) {
          const next = await connection.lobbyEvents(
            cursor.current,
            controller.signal,
          );
          if (!active) return;
          if (next.roomId !== roomId) throw Error("房间已更新，请重新连接。");
          if (next.events.length)
            setEvents((prior) => [...prior, ...next.events]);
          cursor.current = next.nextCursor;
          setLoaded(true);
          setError("");
          if (!next.hasMore) break;
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    const wake = () => void load();
    document.addEventListener("visibilitychange", wake);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [connection, roomId, visible]);
  return (
    <section className="lobby-event-list" aria-label="房间事件记录">
      {error && (
        <p className="player-error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p role="status">正在读取房间记录…</p>
      ) : !events.length ? (
        <p className="muted">暂无房间记录。</p>
      ) : (
        <ol>
          {[...events].reverse().map((e) => (
            <li key={e.id}>
              <p>{e.text}</p>
              {e.atMs !== null && (
                <time>
                  {new Date(e.atMs).toLocaleDateString("zh-CN")}{" "}
                  {clockTime(e.atMs)}
                </time>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
