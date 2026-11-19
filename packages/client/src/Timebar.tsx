import React, { useEffect, useRef, useState } from "react";
import { ChevronsRight, LocateFixed, History } from "lucide-react";
import { worldMinutes as minutes, tickTime as clock } from "./time.js";
import "./timebar.css";
import { HistoryLoading } from './HistoryLoading.js';
export function Timebar({
  tick,
  offset,
  scrub,
  minimum = 0,
  limit = 1440,
  prepareHistory,
}: {
  tick: number;
  offset: number;
  scrub: (value: number) => void;
  minimum?: number;
  limit?: number;
  prepareHistory?: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<void>;
}) {
  const [historyMode, setHistoryMode] = useState(false);
  const [loading, setLoading] = useState(false), [progress, setProgress] = useState(0), [historyError, setHistoryError] = useState('');
  const preparation = useRef<AbortController | null>(null);
  const history = historyMode || offset < 0 || limit === 0;
  const lower = history ? Math.min(0, minimum) : 0;
  const maximum = history ? 0 : Math.min(limit, Math.max(144, Math.ceil(offset / 144) * 144));
  const current = useRef(offset),
    hold = useRef<ReturnType<typeof setInterval> | null>(null),
    start = useRef(0);
  current.current = offset;
  function stop() {
    if (hold.current) clearInterval(hold.current);
    hold.current = null;
  }
  function advance() {
    const step = performance.now() - start.current > 1200 ? 6 : 1;
    current.current = Math.min(history ? 0 : limit, current.current + step);
    scrub(current.current);
    if (current.current === (history ? 0 : limit)) stop();
  }
  function begin() {
    if (hold.current) return;
    start.current = performance.now();
    advance();
    hold.current = setInterval(advance, 120);
  }
  function cancelPreparation() {
    const controller = preparation.current;
    preparation.current = null;
    controller?.abort();
    setLoading(false); setHistoryMode(false); scrub(0);
  }
  async function toggleHistory() {
    stop(); setHistoryError('');
    if (history) { setHistoryMode(false); scrub(0); return; }
    if (preparation.current) return;
    scrub(0);
    const controller = new AbortController();
    preparation.current = controller;
    setProgress(0); setLoading(true);
    try {
      await prepareHistory?.(controller.signal, fraction => {
        if (!controller.signal.aborted && preparation.current === controller) setProgress(fraction);
      });
      if (!controller.signal.aborted && preparation.current === controller) setHistoryMode(true);
    } catch (error) {
      if (!controller.signal.aborted && preparation.current === controller && !(error instanceof DOMException && error.name === 'AbortError'))
        setHistoryError(error instanceof Error ? error.message : '历史加载失败，请重试。');
    } finally {
      if (preparation.current === controller) { preparation.current = null; setLoading(false); }
    }
  }
  useEffect(() => {
    const blur = () => stop();
    window.addEventListener("blur", blur);
    return () => {
      stop();
      preparation.current?.abort();
      window.removeEventListener("blur", blur);
    };
  }, []);
  return (
    <><footer className={"precision-timebar " + (history ? "history-mode " : "") + (offset ? "forecast" : "")}>
      <button
        className="time-history-button"
        aria-label="历史"
        aria-pressed={history}
        disabled={minimum >= 0}
        title={history ? "退出历史回看" : "查看本局历史"}
        onClick={() => void toggleHistory()}
      >
        <History size={18} />
      </button>
      <div className="time-readout">
        <span>
          <b>{clock(tick + offset)}</b>
          <small>
            {offset < 0
              ? `−${minutes(-offset * 10)} · 历史`
              : offset
                ? `+${minutes(offset * 10)} · 预测`
                : "当前时间"}
          </small>
        </span>
      </div>
      <button
        className="time-button"
        aria-label="返回当前时间"
        title="返回当前时间"
        onClick={() => {
          stop();
          setHistoryMode(false);
          scrub(0);
        }}
      >
        <LocateFixed />
      </button>
      <div className="precision-track">
        <div className="time-ticks" />
        <input
          aria-label={history ? "历史时间" : "未来推演时间"}
          type="range"
          min={lower}
          max={maximum}
          value={offset}
          step={1}
          onChange={(e) => scrub(Number(e.target.value))}
          style={
            {
              "--progress": `${maximum === lower ? 100 : ((offset - lower) / (maximum - lower)) * 100}%`,
            } as React.CSSProperties
          }
        />
        <div className="tick-labels">
          {[0, 1, 2, 3, 4].map((n) => {
            const at = lower + ((maximum - lower) * n) / 4;
            return (
              <span key={n}>
                {at === 0
                  ? "现在"
                  : history ? clock(Math.round(tick + at)) : `+${minutes(at * 10)}`}
              </span>
            );
          })}
        </div>
      </div>
      <button
        className="time-button"
        aria-label={history ? "向现在快进" : "长按快速预览未来"}
        title={history ? "单击向现在前进1世界日；长按加速回看" : "单击 +1世界日；长按加速预览（不改变真实时间）"}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          begin();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onLostPointerCapture={stop}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !e.repeat) {
            e.preventDefault();
            begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            stop();
          }
        }}
        onBlur={stop}
      >
        <ChevronsRight />
      </button>
      {historyError && <span className="time-history-error" role="alert">{historyError}</span>}
    </footer>
    {loading && <HistoryLoading progress={progress} cancel={cancelPreparation} />}</>
  );
}
