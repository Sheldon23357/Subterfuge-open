import {TurnReadiness} from './TurnReadiness.js';
import {playerRoute,playerHref,resolvePlayerRoute} from './player-route.js';
import {browserRequestId} from './browser-request-id.js';
import {PlayerControlStatus} from './PlayerControlStatus.js';
import {manualCancellationQuestion,playerManualCommandNotice} from './manual-command-feedback.js';
import {AudioSettings, useGameAudio} from "./AudioSettings.js";
import {gameAudio} from "./game-audio.js";
import {actionSound} from "./audio-policy.js";
import {usePlayerControl} from './use-player-control.js';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  playerLobbyGameSeat,
  type PlayerObservation,
  type PlayerLobbyView,
} from "../../contracts/src/index.js";
import { Game } from "./Game.js";
import { PlayerConnection, PlayerRequestError } from "./player-connection.js";
import { PlayerChat } from "./PlayerChat.js";
import { PlayerStandings } from "./PlayerStandings.js";
import { PlayerNotifications } from "./PlayerNotifications.js";
import {
  PlayerLobby,
  PlayerLobbyStatus,
  PlayerLobbyEvents,
} from "./PlayerLobby.js";
import { lobbyStage, lobbyChatPeople } from "./player-lobby.js";
import { playerGameView } from "./game-view.js";
import {
  playerGameCommand,
  playerGameQuery,
} from "./player-game.js";
import { Check, X, Gear } from "./OriginalIcon.js";
import { Info, Volume2 } from "lucide-react";
import type { Settings } from "./theme.js";
import "./style.css";
import "./typography.css";
import "./original-theme.css";
import "./scrollbars.css";
import "./player-integration.css";
import {HubWaitingRoom} from './HubWaitingRoom.js';
import {restoreHallIdentity, forgetActiveHallIdentity,rememberHallIdentity} from './hall-identity.js';

const sessionKey = "subterfuge-player-code";
function savedConnection() {
  try {
    if(new URLSearchParams(location.search).has('room')||new URLSearchParams(location.search).has('seat'))return null;
    try { restoreHallIdentity(sessionStorage, localStorage); } catch { /* Existing session access remains usable. */ }
    const token = sessionStorage.getItem(sessionKey);
    return token ? new PlayerConnection(token) : null;
  } catch {
    return null;
  }
}
function savedSettings(): Settings {
  try {
    return {
      sound: 25,
      labels: true,
      grid: true,
      motion: true,
      ...JSON.parse(localStorage.getItem("abyss-settings") ?? "{}"),
    };
  } catch {
    return { sound: 25, labels: true, grid: true, motion: true };
  }
}
function PlayerApp() {
  const [entryPending,setEntryPending]=useState(()=>new URLSearchParams(location.search).has('room')||new URLSearchParams(location.search).has('seat'));
  const [waitingPreview,setWaitingPreview]=useState(false);
  const [connection, setConnection] = useState(savedConnection),
    [observation, setObservation] = useState<PlayerObservation | null>(null);
  const control=usePlayerControl(connection,observation?.roomId??'',observation?.view.player??-1);
  const [settings, setSettings] = useState(savedSettings),
    [modal, setModal] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [unread, setUnread] = useState(0);
  const [lobby, setLobby] = useState<PlayerLobbyView | null>(null),
    [lobbyRetry, setLobbyRetry] = useState<{
      kind: "join" | "leave" | "cancel" | "start";
      id: string;
      revision: number;
      roomId: string;
    } | null>(null);
  const lobbyLatest = useRef(lobby);
  const [retry, setRetry] = useState<{
    command: ReturnType<typeof playerGameCommand>;
    revision: string;
    roomId: string;
    message: string;
  } | null>(null);
  const latest = useRef(observation),
    currentConnection = useRef(connection),
    locked = useRef(false),
    requestEpoch = useRef(0);
  currentConnection.current = connection;
  useEffect(()=>{
    let active=true;const abort=new AbortController();
    void (async()=>{try{
      const target=playerRoute(location.search);if(!target)return;
      const identity=await resolvePlayerRoute(target,sessionStorage,localStorage,async(code,token)=>{
        const response=await fetch(`/api/rooms/${code}/identity`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
        if(!response.ok)throw Object.assign(Error(response.status===503?'房间正在恢复，请稍后重新加载。':'无法核验该席位。'),{status:response.status});
        return response.json();
      });
      if(!active)return;
      rememberHallIdentity(sessionStorage,localStorage,identity);
      setConnection(new PlayerConnection(identity.playerToken));
    }catch(e){if(active)setError(e instanceof Error?e.message:'无法恢复该席位。');}
    finally{if(active)setEntryPending(false);}})();
    return()=>{active=false;abort.abort();};
  },[]);
  function installLobby(next: PlayerLobbyView | null) {
    if(next){try{const code=sessionStorage.getItem('subterfuge-room-code');const token=sessionStorage.getItem(sessionKey);if(code&&token&&sessionStorage.getItem('subterfuge-hub-room-id')===next.roomId&&/^[A-Z0-9]{6}$/.test(code)){rememberHallIdentity(sessionStorage,localStorage,{code,roomId:next.roomId,playerToken:token,seat:next.player});history.replaceState(null,'',playerHref(code,next.player));document.title=`深潜 · ${code} · 席位 ${next.player+1}`;}}catch{ /* The verified connection remains usable if browser storage is unavailable. */ }}
    const previous = lobbyLatest.current;
    const worldChanged =
      !!previous &&
      !!next &&
      (previous.roomId !== next.roomId ||
        lobbyStage(previous) !== lobbyStage(next) ||
        playerLobbyGameSeat(previous) !== playerLobbyGameSeat(next));
    lobbyLatest.current = next;
    setLobby(next);
    if (next && (playerLobbyGameSeat(next) === null || worldChanged)) {
      latest.current = null;
      setObservation(null);
      setRetry(null);
      setUnread(0);
    }
  }
  function installSession(
    next: Awaited<ReturnType<PlayerConnection["session"]>>,
  ) {
    installLobby(next.lobby);
    if (next.observation) install(next.observation);
  }
  function install(next: PlayerObservation) {
    if (latest.current?.roomId !== next.roomId) {
      setRetry(null);
      setUnread(0);
    }
    latest.current = next;
    setObservation(next);
  }
  function returnToHall() {
    try { forgetActiveHallIdentity(sessionStorage, localStorage); } catch {}
    try {
      sessionStorage.removeItem(sessionKey);
      sessionStorage.removeItem('subterfuge-room-code');
      sessionStorage.removeItem('subterfuge-hub-room-id');
    } catch {}
    ++requestEpoch.current;
    currentConnection.current = null;
    window.location.assign('/');
  }
  function logout() {
    try { forgetActiveHallIdentity(sessionStorage, localStorage); } catch {}
    try {
      sessionStorage.removeItem(sessionKey);
      sessionStorage.removeItem('subterfuge-room-code');
      sessionStorage.removeItem('subterfuge-hub-room-id');
    } catch {}
    ++requestEpoch.current;
    currentConnection.current = null;
    latest.current = null;
    setConnection(null);
    setObservation(null);
    setRetry(null);
    setModal("");
    setError("");
    setNotice("");
    installLobby(null);
    setLobbyRetry(null);
  }
  function failed(e: unknown) {
    if (e instanceof PlayerRequestError && e.lobby) installLobby(e.lobby);
    if (e instanceof PlayerRequestError && e.observation)
      install(e.observation);
    if (e instanceof PlayerRequestError && e.status === 401) {
      const conn = currentConnection.current;
      if (conn && lobbyLatest.current) {
        void conn
          .session()
          .then((next) => {
            if (currentConnection.current === conn) {
              installSession(next);
              setError("");
            }
          })
          .catch((error) => {
            if (currentConnection.current === conn) {
              if (error instanceof PlayerRequestError && error.status === 401)
                logout();
              setError((error as Error).message);
            }
          });
        return;
      }
      logout();
    }
    setError(e instanceof Error ? e.message : "连接失败，请重试。");
  }
  useGameAudio(settings.sound);
  function openModal(value:string) { gameAudio.play("ui_panel_open");setModal(value); }
  function ping() { gameAudio.play("order_confirm"); }
  useEffect(() => {
    localStorage.setItem("abyss-settings", JSON.stringify(settings));
    document.documentElement.dataset.motion =
      settings.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "on"
        : "off";
  }, [settings]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!connection) return;
    let active = true,
      running = false;
    const load = async () => {
      if (running || locked.current || document.visibilityState !== "visible")
        return;
      running = true;
      const epoch = ++requestEpoch.current;
      try {
        const session = await connection.session();
        if (!active || epoch !== requestEpoch.current || locked.current) return;
        installLobby(session.lobby);
        const next = session.observation;
        if (!next) return;
        install(next);

      } catch (e) {
        if (active && epoch === requestEpoch.current) failed(e);
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    const wake = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [connection]);
  useEffect(() => {
    if (!modal) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModal("");
      if (e.key === "Tab") {
        const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".modal button:not(:disabled),.modal input:not(:disabled)",
            ),
          ),
          first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [modal]);
  async function submit(
    command: ReturnType<typeof playerGameCommand>,
    revision: string,
    roomId: string,
    message: string,
  ) {
    const conn = currentConnection.current;
    if (control.blocked) { setError(control.error || '当前连接尚未允许手动下令，请确认控制状态。'); return false; }
    if (!conn || locked.current || latest.current?.roomId !== roomId)
      return false;
    locked.current = true;
    ++requestEpoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setRetry({ command, revision, roomId, message });
    try {
      const next =
        command.kind === "cancel"
          ? await conn.cancel(command.id, revision).catch(async error=>{
              if(!(error instanceof PlayerRequestError)||error.code!=='MANUAL_COMMAND_CONFLICT'||!error.cancelledScheduleIds||!error.cancellationToken||!error.cancelledSchedules||error.cancelledSchedules.some(row=>row.player!==latest.current?.view.player)||currentConnection.current!==conn||latest.current?.roomId!==roomId)throw error;
              const current=latest.current;
              if(!window.confirm(manualCancellationQuestion(error.cancelledScheduleIds,error.cancelledSchedules,current.outpostNames??{})))throw error;
              return conn.cancel(command.id,revision,error.cancelledScheduleIds,error.cancellationToken);
            })
          : await conn.order(
              command.action,
              command.id,
              revision,
              command.issueTick,
            );
      if (currentConnection.current !== conn||latest.current?.roomId!==roomId||next.roomId!==roomId) return false;
      install(next);
      if (lobbyLatest.current)
        try {
          const fresh = await conn.lobby();
          if (currentConnection.current === conn) installLobby(fresh);
        } catch {}
      setRetry(null);
      const receiptNotice=await playerManualCommandNotice(next,command);
      if(currentConnection.current!==conn||latest.current?.roomId!==roomId||latest.current?.view.player!==next.view.player)return false;
      if (receiptNotice||message) setNotice(receiptNotice??message);
      const cue = actionSound(command.kind === "cancel" ? "cancel-schedule" : command.issueTick !== undefined ? "schedule-order" : "order", command.kind === "order" ? {action:command.action} : null);
      if(cue) gameAudio.play(cue);
      return true;
    } catch (e) {
      if (currentConnection.current === conn) {
        if (e instanceof PlayerRequestError) setRetry(null);
        failed(e);
        gameAudio.play("order_reject");
      }
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function act(path: string, input: unknown, message = "指令已执行") {
    const now = latest.current;
    if (!now) return false;
    try {
      return await submit(
        playerGameCommand(now, path, input),
        now.revision,
        now.roomId,
        message,
      );
    } catch (e) {
      failed(e);
      return false;
    }
  }
  async function submitLobby(request: NonNullable<typeof lobbyRetry>) {
    const conn = currentConnection.current;
    if (
      !conn ||
      locked.current ||
      lobbyLatest.current?.roomId !== request.roomId
    )
      return false;
    locked.current = true;
    ++requestEpoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setLobbyRetry(request);
    try {
      const next = await conn.lobbyCommand(
        request.kind,
        request.id,
        request.revision,
      );
      if (currentConnection.current !== conn) return false;
      if (request.kind === 'leave' || request.kind === 'cancel') {
        const hub = sessionStorage.getItem('subterfuge-hub-room-id') === request.roomId;
        if (hub) returnToHall(); else logout();
        return true;
      }
      installLobby(next);
      setLobbyRetry(null);
      setModal("");
      ping();
      try {
        const session = await conn.session();
        if (currentConnection.current === conn) installSession(session);
      } catch {}
      return true;
    } catch (e) {
      if (currentConnection.current === conn) {
        if (e instanceof PlayerRequestError) setLobbyRetry(null);
        failed(e);
        if (!(e instanceof PlayerRequestError && e.status === 401))
          try {
            const next = await conn.session();
            if (currentConnection.current === conn) installSession(next);
          } catch {}
      }
      return false;
    } finally {
      if (currentConnection.current === conn) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  async function lobbyCommand(
    kind: "join" | "leave" | "cancel" | "start",
    revision: number,
  ) {
    const now = lobbyLatest.current;
    if (!now) return false;
    return submitLobby({
      kind,
      revision,
      id: browserRequestId(),
      roomId: now.roomId,
    });
  }
  async function query(path: string, input: unknown, signal?: AbortSignal) {
    const conn = currentConnection.current,
      now = latest.current;
    if (!conn || !now) throw Error("请重新连接。");
    try {
      const result = await playerGameQuery(conn, now, path, input, signal);
      if (
        currentConnection.current !== conn ||
        latest.current?.roomId !== now.roomId ||
        latest.current?.revision !== now.revision
      )
        throw Error("局势已更新，请重试。");
      return result;
    } catch (e) {
      if (
        currentConnection.current === conn &&
        !signal?.aborted &&
        !locked.current &&
        latest.current?.revision === now.revision &&
        e instanceof PlayerRequestError &&
        (e.status === 401 || e.status === 409)
      )
        failed(e);
      throw e;
    }
  }
  if (connection && !observation && !lobby)
    return (
      <main className="player-connecting" aria-busy={!error}>
        <div className="player-login-mark">深 潜</div>
        <p role="status">{error ? '暂时无法连接对局' : '正在连接对局…'}</p>
        {error && <p className="player-error" role="alert">{error}</p>}
        <a href="/">返回大厅</a>
      </main>
    );
  if (!connection)
    return (
      <main className="player-connecting">
        <div className="player-login-mark">深 潜</div>
        <p role="status">{entryPending?'正在核验房间与席位…':error||'请从大厅选择房间进入对局。'}</p>
        <a href="/">返回大厅</a>
      </main>
    );
  let hubRoom=false;
  try{hubRoom=!!lobby&&sessionStorage.getItem('subterfuge-hub-room-id')===lobby.roomId;}catch{}
  if(hubRoom&&lobby&&['waiting','starting'].includes(lobby.status)&&!waitingPreview)return <HubWaitingRoom lobby={lobby} connection={connection} busy={busy} error={error} retry={lobbyRetry?()=>void submitLobby(lobbyRetry):null} command={lobbyCommand} disconnect={()=>{if(hubRoom)returnToHall();else logout();}} onPreview={()=>setWaitingPreview(true)}/>;
  if (!observation)
    return (
      <main className="player-lobby-page">
        <header>
          <b>深潜</b>
          <span className="player-eyebrow">SUBTERFUGE</span>
        </header>
        <h1>玩家房间</h1>
        <PlayerLobby
          lobby={lobby!}
          connection={connection}
          busy={busy}
          error={error}
          retry={lobbyRetry ? () => void submitLobby(lobbyRetry) : null}
          command={lobbyCommand}
          disconnect={()=>{if(hubRoom)returnToHall();else logout();}}
        />
      </main>
    );
  const view = playerGameView(observation),
    player = observation.view.player;
  return (
    <div className="app player-session">
      <Game
        key={`${observation.roomId}:${player}:${lobbyStage(lobby)}`}
        view={view}
        settings={settings}
        inert={!!modal || busy}
        openSettings={() => openModal("settings")}
        openHelp={() => openModal("help")}
        exit={logout}
        act={act}
        access={{
          player,
          readOnly: control.blocked,
          controllerStatus: <PlayerControlStatus value={control.value} error={control.error}/>,
          roomId: observation.roomId,
          revision: observation.revision,
          query,
          commander:async(action,data,signal)=>{
            const conn=currentConnection.current,now=latest.current;
            if(!conn||!now)throw Error('请重新连接。');
            const result=await conn.commander(action,data,signal);
            // Discussion is independent of world revisions and cannot block time progression.
            if(currentConnection.current!==conn||latest.current?.roomId!==now.roomId)throw Error('对局已更新。');
            return result;
          },
          unread,
          ...(lobby ? { openRoom: () => openModal("lobby") } : {}),
          chat: (
            <PlayerChat
              readOnly={control.exclusiveBlocked}
              connection={connection}
              roomId={observation.roomId}
              {...(lobby
                ? lobbyChatPeople(lobby)
                : { player, count: view.players.length })}
            />
          ),
          log: (visible) => (
            <>
              {lobby && (
                <PlayerLobbyEvents
                  connection={connection}
                  roomId={lobby.roomId}
                  visible={visible}
                />
              )}
              <PlayerNotifications
                connection={connection}
                roomId={observation.roomId}
                player={player}
                visible={visible}
                onUnread={setUnread}
                scope={lobby ? lobbyStage(lobby) : ""}
              />
            </>
          ),
          final: observation.view.match?.ended ? (
            <PlayerStandings
              connection={connection}
              roomId={observation.roomId}
              player={player}
            />
          ) : null,
          roomStatus: lobby ? (
            <>{lobby.status==='in-progress'&&lobby.timing?.mode==='turn-based'&&<TurnReadiness connection={connection} currentTick={observation.view.tick} disabled={busy||control.blocked}/>}<PlayerLobbyStatus lobby={lobby} open={() => openModal("lobby")} /></>
          ) : null,
          notice: observation.view.self.activity?.inactivityWarningCount ? (
            <div className="player-activity" role="alert">
              <span>{observation.view.match?.activityRules==='realtime-3h'?'现实时间连续 3 小时未下达行动将自动退出，保留已有矿量。下达有效行动即可解除警告。':'长时间未下达行动将自动退出。下达有效行动即可解除警告。'}</span>
            </div>
          ) : null,
        }}
      />
      {modal && (
        <div className="scrim" onClick={() => setModal("")}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="player-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">COMMAND ROOM</span>
                <h2 id="player-dialog-title">
                  {modal === "settings" ? (
                    <>
                      <Gear /> 指挥室设置
                    </>
                  ) : modal === "lobby" ? (
                    "房间信息"
                  ) : (
                    "操作手册"
                  )}
                </h2>
              </div>
              <button
                autoFocus
                className="icon"
                aria-label="关闭弹窗"
                onClick={() => setModal("")}
              >
                <X size={22} />
              </button>
            </header>
            {modal === "lobby" && lobby ? (
              <PlayerLobby
                lobby={lobby}
                connection={connection}
                busy={busy}
                error={error}
                retry={lobbyRetry ? () => void submitLobby(lobbyRetry) : null}
                command={lobbyCommand}
                disconnect={()=>{if(hubRoom)returnToHall();else logout();}}
              />
            ) : modal === "settings" ? (
              <>
                <p className="muted">偏好自动保存在此浏览器。</p>
                <label className="setting-row">
                  <span>
                    <Volume2 /> 界面提示音
                  </span>
                  <input
                    aria-label="提示音音量"
                    type="range"
                    min={0}
                    max={100}
                    value={settings.sound}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        sound: Number(e.target.value),
                      })
                    }
                  />
                  <b>{settings.sound}%</b>
                </label>
                <AudioSettings />
                {(
                  [
                    ["labels", "海图文字", "显示据点名称与舰数"],
                    ["grid", "测绘网格", "显示坐标参考线"],
                    ["motion", "界面动态效果", "关闭以减少动画与过渡"],
                  ] as const
                ).map(([key, title, desc]) => (
                  <label className="setting-row" key={key}>
                    <span>
                      {title}
                      <small>{desc}</small>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={settings[key]}
                      onChange={(e) =>
                        setSettings({ ...settings, [key]: e.target.checked })
                      }
                    />
                  </label>
                ))}
              </>
            ) : (
              <>
                <div className="help-grid">
                  <article>
                    <span>01 / 观察</span>
                    <h3>阅读深海</h3>
                    <p>
                      拖动海图平移，滚轮缩放，点击单位查看详情。声呐范围外的单位情报随可见范围显示。
                    </p>
                  </article>
                  <article>
                    <span>02 / 部署</span>
                    <h3>选择你的航向</h3>
                    <p>
                      在当前时间将己方据点拖向目标，输入舰数后确认部署，舰队立即出发。
                    </p>
                  </article>
                  <article>
                    <span>03 / 时间</span>
                    <h3>安排你的计划</h3>
                    <p>
                      底部时间条用于回看历史和预览未来；出兵须返回当前时间操作，不支持预约出兵。其他可预约操作按所选整数世界日执行（1 tick = 1 世界日）；抵达时间仍可为小数天。
                    </p>
                  </article>
                </div>
                <button className="primary" data-audio-silent onClick={() => setModal("")}>
                  已了解 <Check />
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check />
          {notice}
        </div>
      )}
      {error && modal !== "lobby" && (
        <div className="error-toast" role="alert">
          <Info />
          <div>
            <b>操作未完成</b>
            <p>{error}</p>
            {retry && (
              <button
                disabled={busy}
                onClick={() =>
                  void submit(
                    retry.command,
                    retry.revision,
                    retry.roomId,
                    retry.message,
                  )
                }
              >
                重试同一指令
              </button>
            )}
          </div>
          <button
            className="icon"
            aria-label="关闭错误"
            onClick={() => setError("")}
          >
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<PlayerApp />);
