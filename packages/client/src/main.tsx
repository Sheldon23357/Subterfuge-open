import {ManualCommandConflictError,cancellationToken,collateralScheduleIds,collateralSchedules,manualCancellationQuestion,manualCommandError,manualCommandNotice,manualRequestIdentity} from './manual-command-feedback.js';
import {AudioSettings, useGameAudio} from "./AudioSettings.js";
import {CheckpointPanel} from './CheckpointPanel.js';
import {gameAudio} from "./game-audio.js";
import {actionSound} from "./audio-policy.js";
import { Gear, X, Check } from "./OriginalIcon.js";
import {
  Anchor,
  Radar,
  Map,
  BookOpen,
  SlidersHorizontal,
  ArrowRight,
  Download,
  Info,
  Plus,
  Volume2 as SpeakerHigh,
} from "lucide-react";
import { Game } from "./Game.js";
import { eventDetails, errorMessage } from "./copy.js";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LabView,MatchCreation } from "../../contracts/src/index.js";
import "./style.css";
import "./typography.css";
import "./original-theme.css";
import "./scrollbars.css";
import "./new-voyage.css";
import { NewVoyage } from "./NewVoyage.js";
import { type Settings } from "./theme.js";
function loadSettings(): Settings {
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
async function api(path: string, data?: unknown): Promise<LabView> {
  const r = await fetch(
    "/api/" + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await r.json();
  if (!r.ok) {
    if(result.code==='MANUAL_COMMAND_CONFLICT')throw new ManualCommandConflictError(collateralScheduleIds(result.cancelledScheduleIds),cancellationToken(result.cancellationToken),collateralSchedules(result.cancelledSchedules,collateralScheduleIds(result.cancelledScheduleIds)));
    throw Error(manualCommandError(result.code,r.status)??result.error??"请求失败");
  }
  return result;
}
function App() {
  const [matchRules,setMatchRules]=useState<MatchCreation>({mode:'mining',teamSize:0,neptuniumGoal:200});
  const [startMode,setStartMode]=useState<'fresh'|'endgame'>('fresh');
  const [players, setPlayers] = useState(8),
    [seed, setSeed] = useState(4300);
  const [view, setView] = useState<LabView | null>(null),
    [screen, setScreen] = useState("menu"),
    [modal, setModal] = useState(""),
    [settings, setSettings] = useState(loadSettings),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [log, setLog] = useState(false),
    [resetKey, setResetKey] = useState(0);
  const stateRequest = useRef(0);
  const lock = useRef(false),
    file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const request = ++stateRequest.current;
    api("state")
      .then((data) => {
        if (request === stateRequest.current && !lock.current) setView(data);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    localStorage.setItem("abyss-settings", JSON.stringify(settings));
    document.documentElement.dataset.motion =
      settings.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "on"
        : "off";
  }, [settings]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (view?.autoAdvance?.error) setError('自动推进已停止：' + view.autoAdvance.error);
  }, [view?.autoAdvance?.error]);
  useEffect(() => {
    if (screen !== "game") return;
    let stopped = false;
    let polling = false;
    const timer = setInterval(() => {
      if (!lock.current && !polling) {
        polling = true;
        const request = ++stateRequest.current;
        void api("state")
          .then((data) => {
            if (!stopped && !lock.current && request === stateRequest.current)
              setView((previous) =>
                JSON.stringify(previous) === JSON.stringify(data)
                  ? previous
                  : data,
              );
          })
          .catch(() => {})
          .finally(() => { polling = false; });
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [screen]);
  useGameAudio(settings.sound);
  function openModal(value:string) { gameAudio.play("ui_panel_open");setModal(value); }
  function ping() { gameAudio.play("order_confirm"); }
  async function act(path: string, data: unknown, message = "指令已执行") {
    if (lock.current) return;
    lock.current = true;
    ++stateRequest.current;
    setBusy(true);
    setError("");
    try {
      const identity=manualRequestIdentity(path,data);
      const result=await api(path,data).catch(async error=>{
        if(path!=='cancel-schedule'||!(error instanceof ManualCommandConflictError)||!error.cancelledScheduleIds||!error.cancellationToken||!error.cancelledSchedules||!identity||error.cancelledSchedules.some(row=>row.player!==identity.player)||!view)throw error;
        const names=Object.fromEntries(view.outposts.map(row=>[row.id,row.name]));
        if(!window.confirm(manualCancellationQuestion(error.cancelledScheduleIds,error.cancelledSchedules,names)))throw error;
        return api(path,{...(data as object),confirmCancelledScheduleIds:error.cancelledScheduleIds,confirmCancellationToken:error.cancellationToken});
      });
      setView(result);
      const receiptNotice=identity?manualCommandNotice(result.manualCommandsByPlayer?.[identity.player],identity.id,identity.kind,Object.fromEntries(result.outposts.map(row=>[row.id,row.name]))):null;
      if (receiptNotice||message) setToast(receiptNotice??message);
      const cue = actionSound(path,data);
      if(cue) gameAudio.play(cue);
      return true;
    } catch (e) {
      setError(errorMessage((e as Error).message));
      gameAudio.play("order_reject");
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function close() {
    if (modal === "new" && lock.current) return;
    setModal("");
  }
  useEffect(() => {
    if (!modal) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(modal === "new" && lock.current)) setModal("");
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not(:disabled),.modal input:not(:disabled):not([hidden]),.modal a[href],.modal select:not(:disabled)",
          ),
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
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
  return (
    <div className="app">
      {screen === "menu" ? (
        <main className="menu" inert={!!modal}>
          <div className="menu-art" />
          <div className="menu-shade" />
          <div className="menu-telemetry" aria-hidden="true">
            <svg viewBox="0 0 920 620" role="presentation">
              <g className="telemetry-grid">
                <path d="M155 100h690M155 180h690M155 260h690M155 340h690M155 420h690M155 500h690M235 60v480M355 60v480M475 60v480M595 60v480M715 60v480M835 60v480" />
                <path className="telemetry-contour" d="M100 432c112-130 202-161 302-109s158 57 241-25 132-95 246-117M111 468c122-117 194-131 288-83s160 51 245-23 143-89 254-99M168 389c98-93 166-121 240-81s140 47 213-17 145-91 231-82" />
              </g>
              <path className="telemetry-route" d="M222 478c80-38 119-71 191-64s118 45 187-19 111-117 205-124" />
              <g className="telemetry-reticle" transform="translate(612 393)">
                <circle r="39" />
                <circle r="25" />
                <path d="M-52 0h24m56 0h24M0-52v24m0 56v24M-6 0h12M0-6v12" />
              </g>
              <g className="telemetry-points">
                <circle cx="222" cy="478" r="4" />
                <circle cx="413" cy="414" r="4" />
                <circle cx="600" cy="395" r="4" />
                <circle cx="805" cy="271" r="4" />
              </g>
              <g className="telemetry-labels">
                <text x="170" y="92">N 51° 24′  ·  E 003° 17′</text>
                <text x="648" y="352">TRACK 04 / 218°</text>
                <text x="754" y="244">−1,840 m</text>
                <text x="185" y="520">BATHYMETRIC TRACE</text>
                <text x="786" y="520">GRID 06—A</text>
              </g>
            </svg>
          </div>
          <header className="menu-top">
            <span className="wordmark">
              <Anchor size={22} /> ABYSSAL / 深潜
            </span>
            <span className="tiny">SUBTERFUGE · 本地实验室</span>
          </header>
          <section className="menu-content">
            <div className="eyebrow">
              <span className="dot" /> 深海战略
            </div>
            <h1>
              静水之下，
              <br />
              暗流交锋。
            </h1>
            <p className="intro">
              部署你的舰队，掌控深海的每一次交汇。
              <br />
              在时间、距离与信任之间，找到你的航向。
            </p>
            <nav className="menu-nav">
              <button
                className="primary menu-start"
                disabled={!view}
                onClick={() => {
                  setScreen("game");
                  ping();
                }}
              >
                <span className="command-emblem" aria-hidden="true">
                  <Radar />
                </span>
                <span className="command-label">进入指挥室</span>
                <ArrowRight className="command-arrow" size={22} />
              </button>
              <button data-audio-silent onClick={() => openModal("new")}>
                <span className="menu-glyph" aria-hidden="true">
                  <Map />
                </span>
                <span className="menu-action-label">新建测试局</span>
              </button>
              <button data-audio-silent onClick={() => openModal("help")}>
                <span className="menu-glyph" aria-hidden="true">
                  <BookOpen />
                </span>
                <span className="menu-action-label">操作手册</span>
              </button>
              <button data-audio-silent onClick={() => openModal("settings")}>
                <span className="menu-glyph" aria-hidden="true">
                  <SlidersHorizontal />
                </span>
                <span className="menu-action-label">系统设置</span>
              </button>
            </nav>
          </section>
          <footer className="menu-bottom">
            <span>
              下潜至 2,400 m <span className="depth-line" />
            </span>
          </footer>
          <div className="art-caption">
            NORTH STAR EXPEDITION
            <br />
            <b>北辰 · 深海勘探计划</b>
          </div>
        </main>
      ) : (
        <Game
          view={view}
          settings={settings}
          inert={!!modal}
          openSettings={() => openModal("settings")}
          openHelp={() => openModal("help")}
          exit={() => setScreen("menu")}
          act={act}
        />
      )}{" "}
      {modal && (
        <div className={modal === "new" ? "scrim voyage-scrim" : "scrim"} onClick={close}>
          <section
            className={modal === "new" ? "modal voyage-modal" : modal === "settings" ? "modal settings-modal" : "modal"}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "settings"
                ? "系统设置"
                : modal === "new"
                  ? "新建测试局"
                  : "操作手册"
            }
            onClick={(e) => e.stopPropagation()}
          >
            {modal !== "new" && <header>
              <div>
                <div className="eyebrow">ABYSSAL / CONTROL</div>
                <h2>
                  {modal === "settings"
                    ? "系统设置"
                    : modal === "new"
                      ? "开始新的航行"
                      : "指挥官手册"}
                </h2>
              </div>
              <button
                autoFocus
                className="icon"
                aria-label="关闭弹窗"
                onClick={close}
              >
                <X size={22} />
              </button>
            </header>}
            {modal === "settings" ? (
              <>
                <div className="settings-section-label">界面</div>
                <label className="setting-row">
                  <span>
                    <SpeakerHigh /> 界面提示音
                  </span>
                  <input
                    aria-label="提示音音量"
                    type="range"
                    min="0"
                    max="100"
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
                    ["labels", "海图文字"],
                    ["grid", "测绘网格"],
                    ["motion", "界面动态效果"],
                  ] as const
                ).map(([key, title]) => (
                  <label className="setting-row" key={key}>
                    <span>{title}</span>
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
                <div className="settings-section-label">本地存档</div>
                <CheckpointPanel/>
                <div className="two-buttons">
                  <a
                    className="button"
                    href="/api/export"
                    download="abyssal-snapshot.json"
                  >
                    <Download />
                    导出存档
                  </a>
                  <button onClick={() => file.current?.click()}>
                    导入存档
                  </button>
                  <a
                    className="button"
                    href="/api/replay"
                    download="abyssal-replay.json"
                  >
                    导出回放数据
                  </a>
                </div>
                <input
                  ref={file}
                  hidden
                  type="file"
                  accept=".json"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    try {
                      const data = JSON.parse(await f.text());
                      if (window.confirm("导入将替换当前测试局，是否继续？"))
                        await act("import", data, "存档已恢复");
                    } catch {
                      setError("无法读取 JSON 存档");
                    }
                    e.target.value = "";
                  }}
                />
              </>
            ) : modal === "new" ? (
              <NewVoyage
                players={players} seed={seed} busy={busy} error={error}
                setPlayers={n=>{setPlayers(n);if(matchRules.teamSize>0&&(n%matchRules.teamSize!==0||matchRules.teamSize>n/2))setMatchRules({...matchRules,teamSize:0});}} setSeed={setSeed} close={close}
                rules={matchRules} setRules={setMatchRules}
                startMode={startMode} setStartMode={setStartMode}
                create={async (controllerBindings) => {
                  if (!(await act("new", { players, seed, mapMode: "quantity-priority",startMode,rules:matchRules,controllerBindings }, startMode==='endgame'?'固定残局已载入':'海域已创建'))) return;
                  setScreen("game");
                  setModal("");
                }}
              />
            ) : (
              <>
                <div className="help-grid">
                  <article>
                    <span>01 / 观察</span>
                    <h3>阅读深海</h3>
                    <p>
                      青色属于北辰，珊瑚色属于赤潮，灰色为中立。拖动海图平移，滚轮缩放，点击单位查看详情。
                    </p>
                  </article>
                  <article>
                    <span>02 / 部署</span>
                    <h3>选择你的航向</h3>
                    <p>
                      将己方据点拖向目标，输入正数舰数后确认部署，舰队立即出发。
                    </p>
                  </article>
                  <article>
                    <span>03 / 时间</span>
                    <h3>让计划发生</h3>
                    <p>
                      底部时间条用于回看历史和预览未来；出兵须返回当前时间操作。其他可预约操作按所选整数世界日执行，抵达时间可为小数天。
                    </p>
                  </article>

                </div>

                <button className="primary" data-audio-silent onClick={close}>
                  已了解 <Check />
                </button>
              </>
            )}
          </section>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check />
          {toast}
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <Info />
          <div>
            <b>操作未完成</b>
            <p>{error}</p>
          </div>
          <button
            className="icon"
            onClick={() => setError("")}
            aria-label="关闭错误"
          >
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

