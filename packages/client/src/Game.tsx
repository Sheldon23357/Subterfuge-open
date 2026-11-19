import {browserRequestId} from './browser-request-id.js';
import './server-agreements.css';
import {CommanderChat} from './CommanderChat.js';
import {BattleLossMatrix} from './BattleLossMatrix.js';
import {RelationsTable} from './RelationsTable.js';
import {DiplomacyPanel} from './DiplomacyPanel.js';
import './battle-loss-matrix.css';
import {gameAudio} from './game-audio.js';
import {AudioDayCursor} from './audio-policy.js';
import {createLabCommanderTransport} from './commander-transport.js';
import type {CommanderTransport} from './commander-chat-model.js';
import type {CommanderReference} from '../../contracts/src/index.js';
import './commander-chat.css';

import {Tip} from './Tip.js';
import { useFleetArrival } from "./use-fleet-arrival.js";
import { LocalGlobalPrediction } from './local-global-prediction.js';
import { globalDecisionRevision } from './prediction-source.js';
import { FleetCountdowns } from "./FleetCountdowns.js";
import { AiHistory } from './AiHistory.js';
import { AiStatusStrip,type AiMapStatus } from './AiStatusStrip.js';

import { OrderAgenda } from "./OrderAgenda.js";
import { X, OriginalIcon } from "./OriginalIcon.js";
import { OutpostDetails } from "./OutpostDetails.js";
import { worldCountdown as countdown, worldMinutes as minutes, arrivalWorldDays, tickTime, worldFleetProductionEstimate } from "./time.js";
import {
  Anchor,
  Info,
  Eye,
  StepForward,
  Crosshair,
  MessageCircle,
  Crown,
  ClipboardList,
  Settings as SettingsIcon,
  ArrowRight,
  RotateCcw,
  Play,
  Pause,
  Users,
  Send,
  Shield,
  Pickaxe,
  CircleHelp,
  TrendingUp,
} from "lucide-react";
import { Chat } from "./Chat.js";
import {ObserverChat} from './ObserverChat.js';
import './observer-chat.css';
import { ChatMapContext } from './ChatMessageText.js';


import { Timebar } from "./Timebar.js";
import { PreviewFrames } from "./preview-frames.js";
import { HistoryFrames } from "./history-frames.js";
import { LocalPrediction } from "./local-prediction.js";
import { LocalLabHistory } from "./local-lab-history.js";
import { playerNames, colors } from "./theme.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fleetArrivalOffset, playerGameView, type GameView } from "./game-view.js";
import type { Settings } from "./theme.js";
import { SeaMap } from "./SeaMap.js";
import {LiveEvents} from './LiveEvents.js';
import "./game.css";
import "./command-header.css";
import { headerClockState } from "./header-state.js";

const names = playerNames,
  types: Record<string, string> = {
    factory: "工厂",
    generator: "发电站",
    mine: "矿场",
  };
const time = tickTime;
export interface PlayerGameAccess {
  player: number;
  roomId: string;
  revision: string;
  query: (path: string, data: unknown, signal?: AbortSignal) => Promise<any>;
  chat: React.ReactNode;
  log: (visible: boolean) => React.ReactNode;
  final: React.ReactNode;
  notice?: React.ReactNode;
  unread?: number;
  openRoom?: () => void;
  roomStatus?: React.ReactNode;
  readOnly?: boolean;
  controllerStatus?: React.ReactNode;
  commander?: CommanderTransport;
}
type Props = {
  access?: PlayerGameAccess;
  view: GameView | null;
  settings: Settings;
  inert: boolean;
  openSettings: () => void;
  openHelp: () => void;
  exit: () => void;
  act: (
    path: string,
    data: unknown,
    message?: string,
  ) => Promise<boolean | undefined>;
};
export function Game({
  view: sourceView,
  settings,
  inert,
  openSettings,
  openHelp,
  exit,
  act,
  access,
}: Props) {
  const [selected, select] = useState(""),
    [pane, setPane] = useState(""),
    [mineHelp, setMineHelp] = useState(""),
    [mode, setMode] = useState(""),
    [labSeat, setSeat] = useState(() => {
      try {
        const n = Number(sessionStorage.getItem("lab-seat") ?? 0);
        return Number.isInteger(n) && n >= -1 && n < 10 ? n : 0;
      } catch {
        return 0;
      }
    }),
    [anchor, setAnchor] = useState({ x: 400, y: 300 }),
    [target, setTarget] = useState(""),
    [troops, setTroops] = useState(30),
    [timeSelection, setTimeSelection] = useState({ offset: 0, tick: null as number | null }),
    [labHistoryStartTick, setLabHistoryStartTick] = useState(0),
    [forecast, setForecast] = useState<GameView | null>(null),
    [predicting, setPredicting] = useState(false),
    [failure, setFailure] = useState(""),
    [pending, setPending] = useState(false),
    [dragging, setDragging] = useState(false),
    [routeLabel, setRouteLabel] = useState(""),
    [mapKey, setMapKey] = useState(0);
  const seat = access?.player ?? labSeat;
  const [commanderReference,setCommanderReference]=useState<{reference:CommanderReference;nonce:number;scope:string}|null>(null);
  const commanderReferenceCounter=useRef(0);
  const commanderAccess=useRef(access);commanderAccess.current=access;
  const commanderRoom=access?.roomId??sourceView?.perspective?.roomId??sourceView?.commanderRoomId??sourceView?.predictionSource?.roomId??'';
  const commanderTransport=useMemo<CommanderTransport>(()=>access
    ?(action,data,signal)=>{const current=commanderAccess.current;if(!current?.commander||current.roomId!==commanderRoom||current.player!==seat)throw Error('Commander identity changed');return current.commander(action,data,signal);}
    :createLabCommanderTransport(seat),[!!access,seat,commanderRoom]);
  const addToCommander=(reference:CommanderReference)=>setCommanderReference({reference,nonce:++commanderReferenceCounter.current,scope:`${commanderRoom}:${seat}`});
  const playing = !access && sourceView?.autoAdvance?.enabled === true;
  const communicationsOpen = ['chat','score','losses','relations'].includes(pane);
  const audioDays = useRef(new AudioDayCursor());
  useEffect(() => {
    if (!sourceView) return;
    const cue = audioDays.current.accept(commanderRoom, sourceView.tick,
      !!access || sourceView.realtime === true || sourceView.autoAdvance?.enabled === true);
    if (cue) gameAudio.play(cue);
  }, [commanderRoom, sourceView, !!access]);
  const [aiMapStatus,setAiMapStatus]=useState<AiMapStatus>({seats:[],unavailable:false});
  const [mapFocus, setMapFocus] = useState<{id: string} | null>(null);
  const [labView,setLabView]=useState<{source:GameView|null;seat:number;view:GameView}|null>(null);
  // Keep the last filtered frame mounted while this seat's next frame loads.
  // Clearing it on every source update unmounts the canvas and resets animation.
  // A seat change must still hide the previous player's frame immediately.
  const observer=!access&&seat===-1;
  const view=access||observer?sourceView:labView?.seat===seat?labView.view:null;
  const offset = timeSelection.tick === null ? timeSelection.offset : timeSelection.tick - (view?.tick ?? sourceView?.tick ?? 0);
  function setOffset(value: number) {
    setTimeSelection({ offset: value, tick: value < 0 ? (view?.tick ?? sourceView?.tick ?? 0) + value : null });
  }
  const refreshingPerspective=!access&&!observer&&labView?.source!==sourceView;
  useEffect(()=>{
    if(access||observer||!sourceView)return;
    if(seat>=sourceView.players.length){setSeat(0);return;}
    const controller=new AbortController();
    void query('perspective',{player:seat},controller.signal).then(result=>{
      const next=playerGameView(result.observation);
      if(!controller.signal.aborted)setLabView({source:sourceView,seat,view:next});
    }).catch(error=>{if(!controller.signal.aborted)setFailure(error.message);});
    return()=>controller.abort();
  },[access,sourceView,seat]);
  useEffect(()=>{select('');setMapFocus(null);setMode('');setForecast(null);setOffset(0);setCommanderReference(null);routeContext.current=null;lastRoute.current=null;},[seat,commanderRoom]);
  const phase = (view?.perspective?.seconds ?? view?.secondsSinceLastTick ?? 0) / 600;
  const accessRef = useRef(access);
  const localPrediction = useRef<LocalPrediction | null>(null);
  const localHistory = useRef<LocalLabHistory | null>(null);
  const globalPrediction = useRef<LocalGlobalPrediction | null>(null);
  accessRef.current = access;
  const decisionRevision = access?.revision ?? view?.perspective?.revision ?? globalDecisionRevision(view);
  useEffect(() => () => { localPrediction.current?.dispose(); localPrediction.current = null; }, [decisionRevision, seat, access?.roomId]);
  useEffect(() => () => { localHistory.current?.dispose(); localHistory.current = null; }, [access?.roomId, sourceView?.predictionSource?.roomId, sourceView?.map?.seed]);
  useEffect(() => () => { globalPrediction.current?.dispose(); globalPrediction.current = null; }, [decisionRevision, seat]);
  function labHistory() {
    return localHistory.current ??= new LocalLabHistory(start => {
      setLabHistoryStartTick(start);
      setTimeSelection(selected => selected.tick !== null && selected.tick < start ? { offset: 0, tick: start } : selected);
    });
  }
  async function prepareHistory(signal: AbortSignal, progress: (fraction: number) => void) {
    if (accessRef.current) { await query('preview', { ticks: -1 }, signal); return; }
    await labHistory().read(view?.tick ?? 0, seat, signal, progress);
  }
  async function query(path: string, data: unknown, signal?: AbortSignal) {
    if (path === 'preview' && !accessRef.current && (data as { ticks: number }).ticks < 0) {
      const historical = await labHistory().read((view?.tick ?? 0) + (data as { ticks: number }).ticks, seat, signal);
      if ('global' in historical) return historical.global;
      const observation = view?.perspective?.observation;
      if (!observation) throw Error('正在同步当前视野，请稍后重试。');
      return playerGameView({ ...observation, activity: historical.activity, scheduled: [] }, historical.player, historical.intel, 0);
    }
    if (path === 'preview' && observer && (data as {ticks:number}).ticks > 0) {
      globalPrediction.current ??= new LocalGlobalPrediction();
      if (!view?.predictionSource) throw Error('正在同步全局推演版本，请刷新网页重试。');
      return globalPrediction.current.predict(view.tick + (data as {ticks:number}).ticks, { ...view.predictionSource, startTick: view.tick }, signal, view.activity);
    }
    if (path === 'preview' && !observer && (data as { ticks: number }).ticks > 0) {
      const observation = view?.perspective?.observation;
      if (!observation) throw Error('正在同步当前视野，请稍后重试。');
      localPrediction.current ??= new LocalPrediction();
      const future = await localPrediction.current.predict(observation, observation.view.tick + (data as { ticks: number }).ticks, signal);
      if (future.status !== 'conditional') throw Error('这段未来的已知数据暂不足以推演。');
      return playerGameView(observation, future.result, [], 0);
    }
    if (accessRef.current) return accessRef.current.query(path, data, signal);
    const restricted=!observer&&(path==='preview'||path==='deployment-preview');
    const payload=restricted?{...(data as object),player:seat,kind:path==='preview'?'preview':'deployment'}:data;
    const response = await fetch("/api/" + (restricted?'perspective':path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? "请求失败");
    return path==='preview'&&!observer?playerGameView(result.observation,result.frame,[],0):result;
  }
  const routeContext = useRef<{
      offset: number;
      tick: number;
      view: GameView;
    } | null>(null),
    lastRoute = useRef<{ offset: number; tick: number; view: GameView } | null>(
      null,
    ),
    routeTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    routeAbort = useRef<AbortController | null>(null),
    routeSeq = useRef(0);
  function endRoute(valid: boolean) {
    const context = routeContext.current;
    if (context) {
      setOffset(context.offset);
      lastRoute.current = valid ? context : null;
    }
    routeContext.current = null;
    routeSeq.current++;
    routeAbort.current?.abort();
    if (routeTimer.current) clearTimeout(routeTimer.current);
    routeTimer.current = null;
    setDragging(false);
    setRouteLabel("");
  }
  function previewRoute(source: string, point: { x: number; y: number }) {
    if (!view || !display || offset < 0) return;
    if (!routeContext.current) {
      routeContext.current = {
        offset,
        tick: view.tick + offset,
        view: display,
      };
      setDragging(true);
      setMode("");
    }
    if (routeTimer.current) return;
    const context = routeContext.current,
      id = ++routeSeq.current;
    routeAbort.current?.abort();
    if (!routeLabel) setRouteLabel("计算抵达时间…");
    routeTimer.current = setTimeout(async () => {
      routeTimer.current = null;
      const controller = new AbortController();
      routeAbort.current = controller;
      try {
        const result = await query(
          "route-preview",
          { source, point, issueTick: context.tick },
          controller.signal,
        );
        if (id !== routeSeq.current || !routeContext.current) return;
        setRouteLabel(
          result.minutes === null
            ? "超出推演范围"
            : `预计抵达 ${arrivalWorldDays(result.minutes)}`,
        );
        if (result.arrivalTick !== null)
          setOffset(
            Math.min(1440, Math.max(0, result.arrivalTick - view.tick)),
          );
      } catch (e) {
        if (id === routeSeq.current && !controller.signal.aborted)
          setRouteLabel("无法估算航线");
      }
    }, 70);
  }
  useEffect(
    () => () => {
      routeAbort.current?.abort();
      if (routeTimer.current) clearTimeout(routeTimer.current);
    },
    [],
  );
  const operation = useRef(false);
  const previewOffset = useRef(offset);
  previewOffset.current = offset;
  const refreshPreview = useRef<() => void>(() => {});
  const historical = timeSelection.tick !== null;
  const historyReady = !!view;
  const historyQuery = useRef(query);
  historyQuery.current = query;
  useEffect(() => {
    if (!access) sessionStorage.setItem("lab-seat", String(seat));
  }, [seat]);
  useEffect(() => {
    if (!access && view && seat >= view.players.length) setSeat(0);
  }, [view?.players.length, seat]);
  useEffect(() => {
    if (historical) { refreshPreview.current = () => {}; return; }
    setForecast(null);
    const frames = new PreviewFrames<GameView>(
      (ticks, signal) => query("preview", { ticks }, signal),
      setForecast,
      (loading, error) => { setPredicting(loading); setFailure(error); },
      16, 32, observer || !!view?.perspective?.observation,
    );
    refreshPreview.current = () => {
      if (view) frames.select(previewOffset.current);
    };
    return () => frames.dispose();
  }, [decisionRevision, seat, access?.roomId, historical]);
  const historicalFrames = useRef<HistoryFrames<GameView> | null>(null);
  const currentViewTick = useRef(view?.tick ?? 0);
  currentViewTick.current = view?.tick ?? 0;
  useEffect(() => {
    if (!historical || !historyReady) return;
    const frames = new HistoryFrames<GameView>(
      (tick, signal) => historyQuery.current('preview', { ticks: tick - currentViewTick.current }, signal),
      setForecast,
      (loading, error) => { setPredicting(loading); setFailure(error); },
    );
    historicalFrames.current = frames;
    setForecast(null);
    return () => { frames.dispose(); historicalFrames.current = null; };
  }, [historical, seat, access?.roomId, sourceView?.predictionSource?.roomId, historyReady]);
  useEffect(() => {
    if (timeSelection.tick !== null) historicalFrames.current?.select(timeSelection.tick);
  }, [timeSelection.tick, historical, seat, access?.roomId, sourceView?.predictionSource?.roomId, historyReady]);
  useEffect(() => {
    refreshPreview.current();
    if (!offset) {
      setForecast(null);
      setFailure("");
      setPredicting(false);
      return;
    }
  }, [offset, decisionRevision, seat, access?.roomId]);
  async function execute(path: string, data: unknown, message: string) {
    const autoControl = path === 'auto-advance';
    if (
      (observer && !["step","auto-advance"].includes(path)) ||
      operation.current ||
      (!autoControl && (refreshingPerspective || offset < 0)) ||
      (access &&
        !["order", "schedule", "schedule-order", "cancel-schedule"].includes(
          path,
        )) ||
      (!autoControl && offset &&
        !["schedule", "schedule-order", "cancel-schedule"].includes(path))
    )
      return;
    operation.current = true;
    setPending(true);
    try {
      const ok = await act(path, data, message);
      return ok;
    } finally {
      operation.current = false;
      setPending(false);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inert) {
        endRoute(false);
        select("");
        setMode("");
        setPane("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [inert]);
  const validForecast =
    forecast &&
    forecast.tick === (view?.tick ?? 0) + offset &&
    (observer || forecast.perspective?.player === seat) && (historical || !access || forecast.perspective?.revision === access.revision)
      ? forecast
      : null;
  const lastPreview = (observer || forecast?.perspective?.player === seat) &&
    (historical || !access || forecast?.perspective?.revision === access.revision)
      ? forecast : null;
  const display = offset
      ? (validForecast ??
        lastPreview ??
        (dragging ? routeContext.current?.view : null) ??
        view)
      : view,
    post = display?.outposts.find((o) => o.id === selected),
    selectedFleet = display?.fleets.find((f) => f.id === selected);
  const selectedArrival=useFleetArrival(display??null,predicting?undefined:selectedFleet?.id,sourceView);
  const fleet=selectedFleet?{...selectedFleet,
    arrivalTick:selectedArrival.result?.arrivalTick??null,
    arrivalMinutes:selectedArrival.result?.arrivalSeconds==null?null:Math.max(0,(selectedArrival.result.arrivalSeconds-display!.tick*600-(display!.perspective?.seconds??display!.secondsSinceLastTick??0))/60),
  }:undefined;
  const unit=post??fleet;
  const relativeArrival =
    fleet && display
      ? fleetArrivalOffset(
          fleet,
          display.tick,
          display.perspective?.seconds ?? 0,
        )
      : null;
  const arrivalOffset =
    relativeArrival === null
      ? null
      : (display?.tick ?? 0) - (view?.tick ?? 0) + relativeArrival;
  const name = (id: string) =>
    display?.outposts.find((o) => o.id === id)?.name ??
    display?.perspective?.outpostNames[id] ??
    display?.perspective?.unseenOutposts.find((o) => o.id === id)?.id ??
    (id.length > 25 ? "潜艇 " + id.slice(0, 4).toUpperCase() : id);

  const isOwner = unit?.owner === seat,
    active =
      !!display?.players[seat]?.active &&
      !!view?.players[seat]?.active &&
      !view?.match?.ended &&
      !display?.match?.ended,
    orderActionsVisible =
      offset >= 0 &&
      isOwner &&
      active &&
      (!offset || (!predicting && !failure && !!validForecast)),
    canOrder = !access?.readOnly && !refreshingPerspective && orderActionsVisible,
    canLaunch =
      !access?.readOnly && !refreshingPerspective &&
      offset === 0 &&
      isOwner &&
      active;
  const draftContext = JSON.stringify([
    seat,
    selected,
    target,
    troops,
    access?.revision,
    view?.tick,
    offset,
  ]);
  const [storedDraftResult, setDraftResult] = useState<{
    context: string;
    target: (Partial<GameView["outposts"][number]> & { id: string }) | null;
    arrivalTick: number | null;
    outcome: string;
  } | null>(null);
  const draftResult =
    mode === "deploy" && storedDraftResult?.context === draftContext
      ? storedDraftResult
      : null;
  const [draftError, setDraftError] = useState("");
  useEffect(() => {
    setDraftError("");
    if (mode !== "deploy" || !post || !target || !view) {
      setDraftResult(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await query(
          "deployment-preview",
          {
            order: {
              id: "draft-" + browserRequestId(),
              player: seat,
              action: {
                kind: "launch",
                source: selected,
                destination: target,
                drillers: troops,
              },
            },
          },
          controller.signal,
        );
        if (!controller.signal.aborted)
          setDraftResult({ ...result, context: draftContext });
      } catch (error) {
        if (!controller.signal.aborted) {
          setDraftResult(null);
          setDraftError((error as Error).message);
        }
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    mode,
    selected,
    target,
    troops,
    seat,
    decisionRevision,
    offset,
  ]);
  const draftTarget = mode === "deploy" ? draftResult?.target : null;
  const mapDisplay =
    display && draftTarget
      ? {
          ...display,
          outposts: display.outposts.map((o) =>
            o.id === draftTarget.id ? { ...o, ...draftTarget } : o,
          ),
        }
      : display;
  function choose(id: string, point?: { x: number; y: number }) {
    if (
      mode === "deploy" &&
      id &&
      id !== selected &&
      canLaunch && !display?.fleets.some(f=>f.id===id)
    ) {
      setTarget(id);
      return;
    }
    inspectUnit(id, point);
  }
  function inspectUnit(id: string, point?: {x: number; y: number}) {
    if (point) setAnchor(point);
    select(id);
    setMineHelp("");
    setMode("");

    setTarget("");
    setTroops(
      Math.min(30, display?.outposts.find((o) => o.id === id)?.drillers ?? 30),
    );
  }
  async function order(action: unknown) {
    if(offset && (action as {kind?:string})?.kind === "launch"){setFailure("请返回当前时间后出兵。");return;}
    if(offset && !Number.isInteger((view?.tick??0)+offset)){setFailure("预约执行日必须为整数世界日，请选择整数日期。");return;}
    if (
      await execute(
        offset ? "schedule-order" : "order",
        offset
          ? {
              order: { id: browserRequestId(), player: seat, action },
              issueTick: (view?.tick ?? 0) + offset,
            }
          : { id: browserRequestId(), player: seat, action },
        offset ? "指令已预约" : "指令已执行",
      )
    )
      setMode("");
  }
  function scrub(value: number) {
    setOffset(value);
    setMode("");
  }
  const headerClock = headerClockState({offset, playing, pending, realtime: sourceView?.realtime === true, ready: !!sourceView, refreshing: refreshingPerspective});
  return (
    <ChatMapContext.Provider value={{
      outposts:[
        ...(display?.outposts??[]).map(o=>({id:o.id,name:o.name})),
        ...(display?.perspective?.unseenOutposts??[]).map(o=>({id:o.id,name:display?.perspective?.outpostNames[o.id]})),
      ],
      locate:id=>setMapFocus({id}),
    }}>
    <main className="command-room" inert={inert}>
      <header className="quiet-header command-header">
        <div className="command-identity">
        <button
          className="home-mark"
          onClick={exit}
          aria-label={access ? "断开连接并返回" : "返回启动菜单"}
          title={access ? "断开连接" : "返回启动菜单"}
        >
          <Anchor size={23} />
          <b>深潜</b>
        </button>
        <span
          className="room-name"
          title={
            view?.map
              ? `种子 ${view.map.seed} · 初始潜在领地差 ${view.map.score}`
              : undefined
          }
        >
          环海疆域{" "}
          <small>
            {access ? `${names[seat]} · ` : ""}
            {view?.players.length ?? 8} 席
            {view?.map
              ? view.map.algorithm === "quantity-priority-v1"
                ? " · 数量优先"
                : " · 原版"
              : ""}
            {view?.scenario ? ` · ${view.scenario.title}` : ""}
          </small>
        </span>
        </div>
        <div className="command-context">
          {!access ? <div className="lab-header-controls" role="group" aria-label="视角与真实对局推进">
            <label className="perspective-picker"><Eye size={16} aria-hidden="true"/><span className="sr-only">控制视野</span>
              <select aria-label="控制视野" title="切换控制席位与迷雾视野" value={seat} style={{color:colors[seat]??'#b9c6cb'}} onChange={e=>{setSeat(Number(e.target.value));setMode('');}}>
                <option value={-1}>OB · 全局只读</option>
                {names.slice(0,sourceView?.players.length??8).map((name,i)=><option value={i} key={i}>{name} · 玩家视野</option>)}
              </select>
            </label>
            <div className="clock-actions" role="group" aria-label="真实对局时间控制">
              <button className="lab-header-button" title={headerClock.stepReason || '推进 1 世界日（1 tick；现实推进速度不变）'} aria-label={headerClock.stepReason ? `单步推进：${headerClock.stepReason}` : '推进1世界日'} disabled={!!headerClock.stepReason} onClick={()=>void execute('step',{ticks:1},'已推进 1 世界日')}><StepForward size={16}/><span>+1天</span></button>
              <button className={'lab-header-button'+(playing?' is-active':'')} title={headerClock.autoReason || sourceView?.autoAdvance?.error || (playing?'暂停真实对局自动推进':'自动推进真实对局；关闭页面后继续，等待当前 AI 任务与外交回复处理完再推进')} aria-label={headerClock.autoReason ? `自动推进：${headerClock.autoReason}` : playing?'暂停真实对局自动推进':'开启真实对局自动推进'} aria-pressed={playing} disabled={!!headerClock.autoReason} onClick={()=>void execute('auto-advance',{enabled:!playing},playing?'已停止自动推进':'已开启自动推进')}>{playing?<Pause size={16}/>:<Play size={16}/>}<span>{playing?'暂停':'自动'}</span></button>
            </div>
          </div> : <span className="player-perspective"><Eye size={15}/>{names[seat]} · 玩家视野</span>}
          {!!offset&&<div className="command-status"><span className="is-preview">{headerClock.timeLabel}</span><button onClick={()=>scrub(0)}>回到现在</button></div>}
        </div>
        {!access&&<AiStatusStrip playerCount={sourceView?.players.length??0} onChange={setAiMapStatus} select={player=>{setSeat(player);setMode('');}}/>}
        {observer ? <div className="observer-resources"><b>全局观察</b><span>资源按玩家统计 · 切换席位查看</span></div> : <div className="quiet-resources" aria-label={`${names[seat]} · ${headerClock.timeLabel}资源`}>
          <span title="当前控制席位拥有的据点">
            {display?.perspective
              ? (display.perspective.self?.outpostCount ?? "—")
              : (display?.outposts.filter((o) => o.owner === seat).length ??
                "—")}{" "}
            <small>据点</small>
          </span>
          <span title="海王星矿">
            {display?.players[seat]?.neptunium ?? "—"} <small>矿量</small>
          </span>


          <span title="据点与舰队总舰数 / 全阵营共享电能容量">
            <b>
              {!display
                ? "—"
                : display?.perspective
                  ? (display.perspective.self?.drillers ?? "—")
                  : (display?.outposts
                      .filter((o) => o.owner === seat)
                      .reduce((n, o) => n + o.drillers, 0) ?? 0) +
                    (display?.fleets
                      .filter((f) => f.owner === seat)
                      .reduce((n, f) => n + f.drillers, 0) ?? 0)}
              <em>
                /
                {!display
                  ? "—"
                  : display?.perspective
                    ? (display.perspective.self?.capacity ?? "—")
                    : (display?.outposts.find((o) => o.owner === seat)?.metrics
                        ?.capacity ?? 0)}
              </em>
            </b>
            <small>舰数/上限</small>
          </span>
        </div>}
      </header>
      <section className="ocean-stage">
        {!offset && access?.roomStatus}
        {access?.controllerStatus}
        {view && (
          <SeaMap
            key={"map-" + mapKey}
            view={mapDisplay ?? view}
            aiStatus={aiMapStatus}
            obscured={!display}
            animateFleets={offset === 0 && !dragging && !predicting}
            selected={selected}
            focus={mapFocus}
            select={choose}
            settings={settings}
            player={seat}
            onRoute={previewRoute}
            estimate={(source, point, issueTick, signal) =>
              query("route-preview", { source, point, issueTick }, signal)
            }
            onRouteEnd={endRoute}
            draftRoute={
              mode === "deploy" && target ? { source: selected, target } : null
            }
            routeLabel={routeLabel}
            dispatch={(source, destination, point) => {
              const context = lastRoute.current;
              lastRoute.current = null;
              if ((context?.offset ?? offset) !== 0) return;
              if (!context && (predicting || failure)) return;
              select(source);
              setTarget(destination);
              setAnchor(point);
              setMode("deploy");

              setTroops(
                Math.min(
                  30,
                  (context?.view ?? display ?? view).outposts.find(
                    (o) => o.id === source,
                  )?.drillers ?? 0,
                ),
              );

            }}
          />
        )}
        {!display && (
          <div className="preview-loading">
            {failure || "正在计算海域状态…"}
          </div>
        )}
        <div className="ocean-tools" role="toolbar" aria-label="海图工具">
          <Tool
            tip="聊天、计分板、战损与关系"
            active={communicationsOpen}
            onClick={() =>
              setPane(
                communicationsOpen
                  ? ""
                  : "chat",
              )
            }
          >
            <MessageCircle />
          </Tool>
          <Tool
            tip="回到我的据点"
            onClick={() => {
              select("");
              setMapFocus(null);
              setMode("");
              setMapKey((k) => k + 1);
            }}
          >
            <Crosshair />
          </Tool>

          <Tool
            tip="预约指令"
            active={pane === "agenda"}
            onClick={() => setPane(pane === "agenda" ? "" : "agenda")}
          >
            <ClipboardList />
          </Tool>
          {access?.openRoom && (
            <Tool tip="房间信息" silent onClick={access.openRoom}>
              <Users />
            </Tool>
          )}
          <Tool tip="操作手册" silent onClick={openHelp}>
            <Info />
          </Tool>
          <Tool tip={access ? "设置" : "设置与存档"} silent onClick={openSettings}>
            <SettingsIcon />
          </Tool>
        </div>

        {dragging && (
          <output className="drag-route-status" aria-live="polite">
            {routeLabel || "计算抵达时间…"}
          </output>
        )}
        {!!offset && (
          <div className="prediction-banner">
            <span className="dot" />
            {predicting
              ? offset < 0 ? "正在读取历史…" : "正在推演…"
              : failure
                ? offset < 0 ? "历史读取失败" : "推演失败"
                : offset < 0
                  ? `历史回看 ${time(display?.tick ?? 0)}`
                  : `预览未来 ${minutes(offset * 10)}`}

            <button onClick={() => scrub(0)}>回到现在</button>
          </div>
        )}
        {!offset && view?.match?.ended && (
          <div className="prediction-banner" role="status">
            本局已结束，可查看海图和日志。
          </div>
        )}
        <aside
          className={
            "communications-panel " + (pane === 'losses' ? 'is-losses ' : '') +
            (communicationsOpen
              ? "is-open"
              : "")
          }
          aria-label="聊天、计分板、战损与关系"
          aria-hidden={!communicationsOpen}
          inert={!communicationsOpen}
        >
          <header>
            <div
              className="communications-tabs"
              role="tablist"
              aria-label="通信面板"
            >
              <button
                id="chat-tab"
                role="tab"
                aria-selected={pane === "chat"}
                aria-controls="chat-content"
                onClick={() => setPane("chat")}
              >
                <OriginalIcon name="CommButton" /> 聊天
              </button>
              <button
                id="score-tab"
                role="tab"
                aria-selected={pane === "score"}
                aria-controls="score-content"
                onClick={() => setPane("score")}
              >
                <Users size={16} /> 计分板
              </button>
              <button id="losses-tab" role="tab" aria-selected={pane === 'losses'} aria-controls="losses-content" onClick={()=>setPane('losses')}>战损</button>
              <button id="relations-tab" role="tab" aria-selected={pane === 'relations'} aria-controls="relations-content" onClick={()=>setPane('relations')}>关系</button>
            </div>
            <Tool tip="收起通信面板" onClick={() => setPane("")}>
              <X />
            </Tool>
          </header>
          <div
            id="chat-content"
            role="tabpanel"
            aria-labelledby="chat-tab"
            hidden={pane !== "chat"}
          >
            {access ? (
              access.chat
            ) : observer ? <ObserverChat key={commanderRoom} roomId={commanderRoom} open={pane === 'chat'}/> : (
              <Chat
                key={"chat-" + seat}
                seat={seat}
                open={pane === "chat"}
                embedded
                count={view?.players.length ?? 8}
                close={() => setPane("")}
              />
            )}
          </div>
          {/* Keep authorized notification polling and alert sounds mounted without a log tab. */}
          {access && <div hidden>{access.log(false)}</div>}
          <div
            id="score-content"
            className="scoreboard-panel"
            role="tabpanel"
            aria-labelledby="score-tab"
            hidden={pane !== "score"}
          >
            <div className="scoreboard-context">
              <span>
                {offset < 0 ? "历史局势" : offset ? "未来预览" : "当前局势"}
              </span>
              <time>{time(display?.tick ?? 0)}</time>
              <Tip label="计分板">悬浮图标查看说明。矿率按世界天计算；舰产能为144天理论估计，非连续产出，电能不足时暂停。</Tip>
            </div>
            <div className="scoreboard-scroll">
              <table className="scoreboard-table">
                <caption className="sr-only">
                  各玩家矿量与世界天矿率、144天理论舰产能、据点构成、舰数和电能容量
                </caption>
                <thead>
                  <tr>
                    <th scope="col">玩家</th>
                    <th scope="col">矿量</th>
                    <th scope="col">据点</th>
                    <th scope="col">舰数 / 上限</th>
                  </tr>
                </thead>
                <tbody>
                  {display?.players.map((p, i) => {
                    const posts = display.outposts.filter((o) => o.owner === i);
                    const troops =
                      posts.reduce((n, o) => n + o.drillers, 0) +
                      display.fleets
                        .filter((f) => f.owner === i)
                        .reduce((n, f) => n + f.drillers, 0);
                    const intel = (display.perspective ? display.perspective.intel : display.intel)?.find(
                      (row) => row.player === i,
                    );
                    const capacity = display.perspective
                      ? (intel?.output ?? null)
                      : (posts[0]?.metrics?.capacity ?? 0);
                    return (
                      <tr key={i} className={i === seat ? "is-self" : ""}>
                        <th scope="row">
                          <span className="scoreboard-player">
                            <i style={{ background: colors[i] }} />
                            <span>
                              {names[i]}
                              {i === seat && <small>你</small>}
                              {!p.active && <small>出局</small>}
                            </span>
                          </span>
                        </th>
                        <td>
                          <span title="海王星矿总量（kg）">{p.neptunium ?? "—"}</span>
                          <span className="scoreboard-detail" title="海王星矿增长量（kg / 144天）" aria-label={`矿量增长：${intel ? intel.npPerDay : '未知'} kg / 144天`}>
                            <TrendingUp size={12} aria-hidden="true" />
                            {intel ? `+${intel.npPerDay}` : '—'}<small>/144天</small>
                          </span>
                        </td>
                        <td>
                          {display.perspective
                            ? (intel?.numOutposts ?? "—")
                            : posts.length}
                          <span className="scoreboard-buildings">
                            {([
                              ['mine','SmallMine','矿场'],
                              ['factory','SmallFactory','工厂'],
                              ['generator','SmallGenerator','发电站'],
                            ] as const).map(([kind,icon,label])=>(
                              <span key={kind} title={label} aria-label={`${label}：${intel?.outposts[kind] ?? '未知'}`}>
                                <OriginalIcon name={icon} size={12} />{intel?.outposts[kind] ?? '—'}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>
                          {display.perspective
                            ? (intel?.drillers ?? "—")
                            : troops}
                          <span className="scoreboard-capacity">
                            {" "}
                            / {capacity ?? "—"}
                          </span>
                          <span className="scoreboard-detail" title="144天产能估计，非每日连续产出；实际周期见据点，电能不足时暂停" aria-label={`产能：${intel ? worldFleetProductionEstimate(intel.drillerRate) : '未知'}`}>
                            <TrendingUp size={12} aria-hidden="true" />{intel ? worldFleetProductionEstimate(intel.drillerRate) : '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div id="losses-content" role="tabpanel" aria-labelledby="losses-tab" hidden={pane !== 'losses'}>
            <BattleLossMatrix matrix={view?.battleLosses} count={view?.players.length??0} tick={view?.tick??0}/>
          </div>
          <div id="relations-content" role="tabpanel" aria-labelledby="relations-tab" hidden={pane !== 'relations'}>
            <RelationsTable value={view?.diplomacy} player={view?.perspective?.player??null}/>
            {view?.perspective?.observation&&<DiplomacyPanel key={`${commanderRoom}:${seat}`} observation={view.perspective.observation} disabled={inert||pending||!!access?.readOnly||refreshingPerspective||offset!==0||!active} onSubmit={action=>execute('order',{id:browserRequestId(),player:seat,action},'协议操作已提交')}/>}
          </div>
        </aside>
        {pane === "agenda" && view && (
          <aside
            className="utility-popover rules-popover"
            aria-label="预约指令"
          >
            <div className="popover-title">
              <b>预约指令</b>
              <Tool tip="收起" onClick={() => setPane("")}>
                <X />
              </Tool>
            </div>
            <OrderAgenda
              view={view}
              player={seat}
              manualCommands={view.perspective?.observation?.manualCommands}
              busy={
                pending || access?.readOnly ||
                offset < 0 ||
                !view.players[seat]?.active ||
                !!view.match?.ended
              }
              execute={execute}
            />
          </aside>
        )}

        {!access && !observer && pane==='ai-log' && <AiHistory key={seat} seat={seat} close={()=>setPane('')}/>}
        {unit && !dragging && (
          <section
            className={
              "selection-card " +
              (mode ? "expanded " : "") +
              (mode === "deploy" ? "deployment-card" : "")
            }
            aria-label="所选单位信息"
            style={
              {
                "--owner-color":
                  unit.owner === null ? "#a49e8b" : colors[unit.owner],
              } as React.CSSProperties
            }
          >
            <header className="unit-panel-heading">
              <span>
                {mode === "deploy"
                  ? "舰队部署"
                    : mode === "more"
                      ? "据点指令"
                      : post
                        ? "据点概览"
                        : "舰船概览"}
              </span>
              <div className="unit-heading-actions">
                {orderActionsVisible && mode !== "deploy" && !post && (
                  <div className="header-secondary-actions" inert={!canOrder} aria-busy={refreshingPerspective}>
                    {!post && (
                      <>
                        <button
                          title={fleet?.returned ? "该舰队已返航，不能再次返航" : "返回出发据点，舰数减半向下取整；只能返航一次"}
                          disabled={!fleet?.canReturn}
                          onClick={() =>
                            void order({
                              kind: "return-fleet",
                              fleetId: selected,
                            })
                          }
                        >
                          <RotateCcw size={14} />{" "}
                          返航
                        </button>
                      </>
                    )}
                  </div>
                )}
                <Tool tip="关闭单位信息" onClick={() => choose("")}>
                  <X />
                </Tool>
              </div>
            </header>
            {post && canOrder && mode !== "deploy" && mineHelp === selected && (
              <div className="mine-rules" id="mine-rules" role="region" aria-label="改建矿场规则">
                <div><b>改建矿场</b><button type="button" aria-label="收起矿场规则" onClick={() => setMineHelp("")}><X size={14} /></button></div>
                <p>仅采矿模式可用。可将自己的工厂或发电站改建为矿场，据点须未被摧毁，且驻军足够支付消耗。</p>
                <p>费用从该据点驻军中立即扣除：第 1 座 50 兵，第 2 座 100 兵，第 3 座 200 兵，之后每座增加 100 兵。按累计建造次数计费，失去矿场不会降低费用，正在改建的矿场也计入下一座费用。</p>
                <p>改建耗时 1 世界日，完成前可取消并返还舰数。另建一座矿场会使已有的改建立即完成。</p>
                <p>完成后停止原来的生产或供电，改为开采海王星矿。拥有的据点越多，每座矿场的开采越快。</p>
              </div>
            )}
            {mode !== "deploy" && (
              <>
                <div className="selection-overview">
                  <span className={"selection-sigil owner-" + unit.owner}>
                    <OriginalIcon
                      name={
                        post
                          ? post.type === "factory"
                            ? "FactoryFill"
                            : post.type === "mine"
                              ? "MineFill"
                              : "GeneratorFill"
                          : "SubIcon"
                      }
                      size={25}
                    />
                  </span>
                  <div className="selection-name">
                    <small>
                      {post ? types[post.type] : "潜艇"} ·{" "}
                      {unit.owner === null ? "中立" : names[unit.owner]}
                    </small>
                    <h2>{name(unit.id)}</h2>
                    {!observer&&commanderRoom&&<button type="button" className="commander-add-reference" disabled={offset!==0} title={offset?'请回到当前局势后引用':'加入 AI 对话'} aria-label="加入 AI 对话" onClick={()=>addToCommander({kind:post?'outpost':'fleet',id:unit.id,label:name(unit.id)})}><Send size={14}/></button>}
                  </div>
                </div>
                <div className="unit-stat-strip">
                  <div>
                    <span>驻守舰数</span>
                    <b>
                      {unit.drillers}
                      <small>舰</small>
                    </b>
                  </div>
                  {post && (
                    <div>
                      <span>护盾强度</span>
                      <b>
                        {post.shield}
                        <small>/ {post.shieldMax}</small>
                      </b>
                    </div>
                  )}

                </div>
                {post && mode !== "deploy" && <OutpostDetails post={post} />}
                {fleet && (
                  <FleetCountdowns
                    fleet={fleet}
                    predictingArrival={selectedArrival.loading}
                    arrivalError={selectedArrival.error}
                    tick={display!.tick}
                    live={!offset && !!view?.realtime}
                    arrivalDisabled={
                      predicting ||
                      arrivalOffset === null ||
                      arrivalOffset > 1440
                    }
                    onArrival={() => {
                      if (
                        arrivalOffset === null ||
                        !view ||
                        !display ||
                        predicting
                      )
                        return;
                      if (arrivalOffset < 0 || arrivalOffset > 1440) return;
                      scrub(arrivalOffset);
                      if (
                        [
                          ...display.outposts,
                          ...(display.perspective?.unseenOutposts ?? []),
                        ].some((o) => o.id === fleet.destination)
                      )
                        select(fleet.destination);
                    }}
                  />
                )}

                {display?.scheduled
                  ?.filter(
                    (p) =>
                      p.player === seat &&
                      p.action.source === selected &&
                      (p.status === "pending" || p.status === "failed"),
                  )
                  .map((p) => (
                    <div className="planned-launch" key={p.id}>
                      <span>
                        {name(p.action.destination)} · {p.action.drillers}
                        <small>
                          {p.status === "failed"
                            ? "执行失败：" + p.reason
                            : "出发 " +
                              countdown(
                                Math.max(
                                  0,
                                  (p.departureTick - display!.tick) * 600 -
                                    (display!.perspective?.seconds ?? display!.secondsSinceLastTick ?? 0),
                                ),
                              )}
                        </small>
                      </span>
                      {p.status === "pending" && (
                        <button
                          title="取消预约"
                          aria-label="取消预约"
                          disabled={pending}
                          onClick={() =>
                            void execute(
                              "cancel-schedule",
                              { id: p.id, player: seat },
                              "预约已取消",
                            )
                          }
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                <div className="selection-actions">


                </div>
              </>
            )}

            {mode === "deploy" &&
              canLaunch && (
                <div className="selection-content dispatch-form">
                  {post && target && (
                    <output className="deployment-result" aria-live="polite">
                      {draftError ? (
                        draftError
                      ) : !draftResult ? (
                        "正在推演…"
                      ) : draftResult.target ? (
                        <>
                          <b>
                            {draftResult.outcome === "reinforced"
                              ? "预计增援"
                              : draftResult.outcome === "won"
                                ? "预计胜利"
                                : "预计战败"}
                          </b>
                          <span>
                            {draftResult.target.drillers} 舰 · 护盾{" "}
                            {draftResult.target.shield}
                          </span>
                        </>
                      ) : (
                        "暂无法确定抵达结果"
                      )}
                    </output>
                  )}

                  {post && (
                    <>
                      <label className="field troop-field">
                        <span>
                          调遣舰数<small>可用 {post.drillers} 舰</small>
                        </span>
                        <input
                          aria-label="调遣舰数"
                          type="number"
                          min={0}
                          max={post.drillers}
                          value={troops}
                          onChange={(e) => setTroops(Number(e.target.value))}
                        />
                      </label>

                    </>
                  )}
                  <button
                    className="primary"
                    disabled={
                      pending ||
                      !target ||
                      (!!post &&
                        (troops > post.drillers ||
                          troops < 1 ||
                          !Number.isInteger(troops)))
                    }
                    onClick={async () => {await order({kind:"launch",source:selected,destination:target,drillers:troops});}}
                  >
                    {pending ? "正在下达…" : "立即出兵"}
                    <ArrowRight />
                  </button>
                </div>
              )}
            {fleet &&
              canOrder &&
              mode !== "deploy" &&
              fleet.canCancelLaunch && (
                <footer className="fleet-cancel-footer">
                  <button
                    disabled={pending}
                    onClick={() =>
                      void order({
                        kind: "cancel-launch",
                        fleetId: fleet.id,
                      })
                    }
                  >
                    <OriginalIcon name="Restart" size={16} />
                    {"撤销出航"}
                  </button>
                </footer>
              )}
            {post && orderActionsVisible && mode !== "deploy" && (
              <footer className="outpost-order-footer" inert={!canOrder} aria-busy={refreshingPerspective}>
                <button onClick={() => void order({ kind: "toggle-mine", outpostId: selected })}>
                  <OriginalIcon name="DrillMineButton" size={14} />
                  {post.minePending ? "取消开矿" : `建矿 · ${display?.perspective?.self?.mineCreationCost ?? "—"} 兵`}
                </button>
                <button onClick={() => void order({ kind: "set-shields", outpostId: selected, enabled: !post.shieldsEnabled })}>
                  <OriginalIcon name="ShieldButton" size={14} />
                  {post.shieldsEnabled ? "关闭护盾" : "开启护盾"}
                </button>
                <button type="button" className="mine-help-toggle" aria-label="改建矿场规则" aria-expanded={mineHelp === selected} aria-controls="mine-rules" onClick={() => setMineHelp(mineHelp === selected ? "" : selected)}><CircleHelp size={14} /></button>
              </footer>
            )}
          </section>
        )}
        {selected &&
          display?.perspective?.unseenOutposts.some((o) => o.id === selected) &&
          !dragging && (
            <section className="selection-card" aria-label="所选单位信息">
              <header className="unit-panel-heading">
                <span>据点概览</span>
                <Tool tip="关闭单位信息" onClick={() => choose("")}>
                  <X />
                </Tool>
              </header>
              <div className="selection-overview">
                <div className="selection-name">
                  <small>
                    {types[
                      display.perspective.unseenOutposts.find(
                        (o) => o.id === selected,
                      )?.type ?? ""
                    ] ?? "类型未知"}{" "}
                    · {(()=>{const owner=display.perspective?.unseenOutposts.find(o=>o.id===selected)?.owner;return owner===undefined?'归属未知':owner===null?'中立':playerNames[owner];})()}
                  </small>
                  <h2>{name(selected)}</h2>
                  {!observer&&commanderRoom&&<button type="button" className="commander-add-reference" disabled={offset!==0} title={offset?'请回到当前局势后引用':'加入 AI 对话'} aria-label="加入 AI 对话" onClick={()=>addToCommander({kind:'outpost',id:selected,label:name(selected)})}><Send size={14}/></button>}
                </div>
              </div>
              <div className="selection-content">
                <p>舰数和护盾未知。</p>
              </div>
            </section>
          )}
        {selected &&
          display &&
          !unit &&
          !display.perspective?.unseenOutposts.some(
            (o) => o.id === selected,
          ) && (
            <div className="prediction-banner">
              该单位在此时刻已不再存在
              <button onClick={() => choose("")}>关闭</button>
            </div>
          )}
      </section>
      {view&&<LiveEvents events={view.activity??[]} scope={`${view.perspective?.roomId??`global-${view.map?.seed??''}`}-${seat}`} tick={view.tick} seconds={view.perspective?.seconds??view.secondsSinceLastTick??0} name={id=>view.perspective?.outpostNames[id]??view.outposts.find(o=>o.id===id)?.name??id}/>}
      <Timebar
        prepareHistory={prepareHistory}
        tick={view?.tick ?? 0}
        offset={offset}
        scrub={scrub}
        minimum={
          view?.perspective
            ? view.perspective.historyStartTick - view.tick
            : Math.min(0, labHistoryStartTick - (view?.tick ?? 0))
        }
        limit={view?.match?.ended ? 0 : 1440}
      />
      {!observer&&commanderRoom&&(!access||access.commander)&&<CommanderChat key={`${commanderRoom}:${seat}`} roomId={commanderRoom} player={seat} request={commanderTransport} referenceRequest={commanderReference?.scope===`${commanderRoom}:${seat}`?commanderReference:null}
        resolveReference={reference=>{
          const post=view?.outposts.find(item=>reference.kind==='outpost'&&item.id===reference.id),known=view?.perspective?.unseenOutposts.find(item=>reference.kind==='outpost'&&item.id===reference.id),fleet=view?.fleets.find(item=>reference.kind==='fleet'&&item.id===reference.id);
          return {label:post?.name??view?.perspective?.outpostNames[reference.id]??reference.label??(reference.kind==='fleet'?'舰队':'据点'),locatable:!!(post||known||fleet)};
        }}
        locate={reference=>{setOffset(0);setMapFocus({id:reference.id});select(reference.id);}}/>}
      {access?.notice}
    </main>
    </ChatMapContext.Provider>
  );
}
function Tool({
  tip,
  onClick,
  children,
  active = false,
  silent = false,
}: {
  tip: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  silent?: boolean;
}) {
  return (
    <button
      className={"quiet-tool " + (active ? "active" : "")}
      aria-label={tip}
      data-audio-silent={silent || active || undefined}
      aria-pressed={active}
      type="button"
      onClick={onClick}
    >
      <span>{children}</span>
      <span className="tool-tip" role="tooltip">
        {tip}
      </span>
    </button>
  );
}

import "./refinement.css";
