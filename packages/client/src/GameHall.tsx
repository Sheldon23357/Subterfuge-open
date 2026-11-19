import {playerHref} from './player-route.js';
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Anchor,
  ArrowRight,
  LoaderCircle,
  Plus,
  Radio,
  RefreshCw,
  X,
} from "lucide-react";
import "./hall.css";
import {HallSeatReturn} from './HallSeatReturn.js';
import {hallLinkTarget,savedHallToken} from './hall-link-protocol.js';
import {
  hallClaim,
  hasHallClaim,
  rememberHallAdmission,
  rememberHallIdentity,
  restoreHallIdentity,
} from "./hall-identity.js";
try {
  restoreHallIdentity(sessionStorage, localStorage);
} catch {
  /* Storage errors are reported on admission. */
}
import type {HubRoomSummary as Room} from '../../contracts/src/index.js';
import {splitHallRooms,HallRoomList,EndedHallRooms} from './HallRoomList.js';
interface Admission extends Room {
  playerToken: string;
  player: number;
  roomId: string;
}
function key() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
async function api<T>(path: string, body?: unknown, token?:string): Promise<T> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(body ? 45000 : 15000),
    method: body ? "POST" : "GET",
    headers: {...(body ? { "Content-Type": "application/json" } : {}),...(token?{Authorization:`Bearer ${token}`}:{})},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw Error(value.error ?? "连接失败，请重试。");
  return value;
}
function Hall() {
  const [rooms, setRooms] = useState<Room[]>([]),
    [loading, setLoading] = useState(true),
    [mode, setMode] = useState<"create" | null>(null),
    [name, setName] = useState("深海远征"),
    [capacity, setCapacity] = useState(6),
    [timingMode,setTimingMode]=useState<'realtime'|'turn-based'>('realtime'),
    [tickSeconds,setTickSeconds]=useState(10),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [joining, setJoining] = useState<string | null>(null),
    [online, setOnline] = useState(true);
  const [background,setBackground]=useState<'loading'|'ready'|'error'>('loading');
  const [backgroundAttempt,setBackgroundAttempt]=useState(0);
  const artwork=<div className="hall-art" aria-hidden="true"><img src={'/assets/lobby/deep-harbor.jpg'+(backgroundAttempt?'?retry='+backgroundAttempt:'')} alt="" fetchPriority="high" onLoad={()=>setBackground('ready')} onError={()=>setBackground('error')}/></div>;
  useEffect(()=>{if(background!=='loading')return;const timer=setTimeout(()=>setBackground('error'),15000);return()=>clearTimeout(timer);},[background,backgroundAttempt]);
  const lock = useRef(false),
    dialog = useRef<HTMLDialogElement>(null),
    button = useRef<HTMLButtonElement | null>(null);
  async function refresh() {
    try {
      setRooms((await api<{ rooms: Room[] }>("/api/rooms")).rooms.filter(room => room.status !== "cancelled"));
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (mode) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    } else dialog.current?.close();
  }, [mode]);
  const currentCode=sessionStorage.getItem('subterfuge-room-code'),currentSeat=sessionStorage.getItem('subterfuge-hall-seat');
  const resumeHref=currentCode&&currentSeat!==null&&/^[0-9]$/.test(currentSeat)?playerHref(currentCode,Number(currentSeat)):'/player.html';
  const grouped=splitHallRooms(rooms);
  const returning=(code:string)=>{try{return !!savedHallToken(code,localStorage,sessionStorage)||hasHallClaim(sessionStorage,localStorage,code);}catch{return false;}};
  const listProps={busy,joining,returning,enter:(code:string)=>void enter(code)};
  function open() {
    setError("");
    setMode("create");
  }
  function close() {
    if (lock.current) return;
    setMode(null);
    setError("");
    button.current?.focus();
  }
  async function enter(roomCode?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setJoining(roomCode ?? null);
    setError("");
    try {
      const creating = roomCode === undefined;
      const codeKey = roomCode ?? "create";
      const savedToken=roomCode?savedHallToken(roomCode,localStorage,sessionStorage):null;
      if(roomCode&&savedToken){
        const identity=await api<{roomId:string;seat:number}>(`/api/rooms/${roomCode}/identity`,undefined,savedToken);
        rememberHallIdentity(sessionStorage,localStorage,{code:roomCode,roomId:identity.roomId,playerToken:savedToken,seat:identity.seat});
        window.location.assign(playerHref(roomCode,identity.seat));
        return;
      }
      const claim = hallClaim(sessionStorage, localStorage, codeKey, key);
      const value = await api<Admission>(
        creating ? "/api/rooms" : `/api/rooms/${codeKey}/join`,
        creating ? { key: claim, name, capacity,timing:timingMode==='realtime'?{mode:'realtime',tickSeconds}:{mode:'turn-based'} } : { key: claim },
      );
      rememberHallAdmission(
        sessionStorage,
        localStorage,
        value,
        claim,
        creating,
      );
      window.location.assign(playerHref(value.code,value.player));
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法连接，请重试。");
    } finally {
      lock.current = false;
      setBusy(false);
      setJoining(null);
    }
  }
  if(loading&&rooms.length===0||background==='loading')return <main className="hall-loading-shell" aria-busy="true">{artwork}<section className="hall-loading-card" role="status" aria-live="polite"><span className="hall-loading-emblem" aria-hidden="true"><Anchor/></span><h1>深 潜</h1><p className="hall-loading-message">正在连接大厅…</p><span className="hall-loading-track" aria-hidden="true"/></section></main>;
  return (
    <main className="hall">
      {artwork}
      <div className="hall-grain" />
      {background==='error'&&<div className="hall-art-error" role="status">背景图片加载失败<button className="hall-quiet" onClick={()=>{setBackground('loading');setBackgroundAttempt(n=>n+1);}}>重新加载</button></div>}
      <header className="hall-nav">
        <a href="/" className="hall-brand">
          <Anchor size={25} />
          <span>
            深 潜<small>SUBTERFUGE</small>
          </span>
        </a>
        <div className="hall-nav-actions"><a className="hall-quiet" href={`http://127.0.0.1:4400/#hall=${encodeURIComponent(location.origin)}`} target="_blank" rel="noreferrer">AI 控制台</a><span className={"hall-signal " + (!online ? "offline" : "")}>
          <i />
          {online ? "通讯链路在线" : "通讯中断 · 正在重连"}
        </span></div>
      </header>
      <section className="hall-hero">
        <h1>
          静水之下，
          <br />
          <span>暗潮已起。</span>
        </h1>
        <p>
          集结舰队，结成同盟。
          <br />
          下一场深海博弈，从这里开始。
        </p>
        <div className="hall-actions">
          {rooms.some(room=>room.code===currentCode&&!["recovering","unavailable","cancelled"].includes(room.status)) && (
            <a className="hall-secondary" href={resumeHref}>
              继续当前对局
              <ArrowRight size={18} />
            </a>
          )}
          <button
            className="hall-primary"
            ref={button}
            onClick={open}
            disabled={busy}
          >
            <Plus size={19} />
            创建游戏
            <ArrowRight size={18} />
          </button>
        </div>
      </section>
      <section className="hall-rooms">
        <div className="hall-section-heading">
          <div>
            <h2>
              作战大厅 <small>{grouped.active.length.toString().padStart(2, "0")}</small>
            </h2>
          </div>
          <button
            className="hall-quiet"
            onClick={() => {
              setLoading(true);
              void refresh();
            }}
            aria-label="刷新房间"
          >
            <RefreshCw size={16} className={loading ? "hall-spin" : ""} />
            刷新
          </button>
        </div>
        {!mode && error && (
          <p className="hall-error" role="alert">
            {error}
          </p>
        )}
        {loading && rooms.length === 0 ? (
          <div className="hall-empty" role="status">
            <LoaderCircle className="hall-spin" />
            正在接收房间信号…
          </div>
        ) : grouped.active.length === 0 ? (
          <div className="hall-empty">
            <Radio size={30} />
            <h3>
              {online ? "暂无房间" : "暂时无法取得房间列表"}
            </h3>
            <p>
              {online
                ? "创建游戏后，其他玩家可从房间列表加入。"
                : "检查大厅服务，连接恢复后会自动更新。"}
            </p>
          </div>
        ) : (
          <HallRoomList rooms={grouped.active} {...listProps}/>
        )}
        <EndedHallRooms rooms={grouped.ended} {...listProps}/>
      </section>
      <dialog
        ref={dialog}
        className="hall-dialog"
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="hall-dialog-body" key={mode ?? "closed"}>
          <button
            className="hall-close"
            aria-label="关闭"
            onClick={close}
            disabled={busy}
          >
            <X size={20} />
          </button>
          <>
            <h2>创建游戏</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void enter();
              }}
            >
              <fieldset disabled={busy}>
                <>
                  <label>
                    房间名称
                    <input
                      autoFocus
                      value={name}
                      maxLength={40}
                      required
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    席位数量
                    <select
                      value={capacity}
                      onChange={(e) => setCapacity(Number(e.target.value))}
                    >
                      {Array.from({ length: 9 }, (_, i) => (
                        <option key={i + 2} value={i + 2}>
                          {i + 2} 位指挥官
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>对局模式<select value={timingMode} onChange={e=>setTimingMode(e.target.value as typeof timingMode)}><option value="realtime">实时模式</option><option value="turn-based">回合模式</option></select></label>
                  {timingMode==='realtime'?<label>每 tick 时长（秒）<input type="number" min={1} max={3600} step={1} required value={tickSeconds} onChange={e=>setTickSeconds(Number(e.target.value))}/></label>:<p className="hall-help">所有存活玩家／AI 就绪后推进下一 tick。</p>}
                  <p className="hall-help">
                    你将成为房主。至少两人加入后，可由房主发起开局。
                  </p>
                </>
                <button className="hall-primary hall-submit" type="submit">
                  {busy ? (
                    <>
                      <LoaderCircle className="hall-spin" size={18} />
                      正在创建…
                    </>
                  ) : (
                    <>
                      创建并进入
                      <ArrowRight size={18} />
                    </>
                  )}
                </button>
              </fieldset>
            </form>
          </>
          {error && (
            <p className="hall-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </dialog>
    </main>
  );
}
const consoleTarget=hallLinkTarget(window.location.hash);
createRoot(document.getElementById("root")!).render(consoleTarget&&new URLSearchParams(location.hash.slice(1)).get('action')==='return'?<HallSeatReturn target={consoleTarget}/>:<Hall />);
