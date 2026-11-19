import { Clock3, ArrowRight } from "lucide-react";
import React, { useEffect, useState } from "react";
import type { GameView } from "./game-view.js";
import { worldCountdown as countdown, arrivalWorldDays } from "./time.js";
import {preparingFleet,launchLocked} from './fleet-preparation.js';
export function FleetCountdowns({
  fleet,
  tick,
  live,
  onArrival,
  arrivalDisabled,
  predictingArrival=false,
  arrivalError,
}: {
  fleet: GameView["fleets"][number];
  tick: number;
  live: boolean;
  onArrival: () => void;
  arrivalDisabled: boolean;
  predictingArrival?:boolean;
  arrivalError?:string|undefined;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!live) return;
    const start = performance.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((performance.now() - start) / 1000)),
      200,
    );
    return () => clearInterval(timer);
  }, [
    fleet.id,
    fleet.state,
    fleet.departureMinutes,
    fleet.arrivalMinutes,
    tick,
    live,
  ]);
  const preparing = preparingFleet(fleet),locked=launchLocked(fleet);
  const remaining =
    fleet.departureMinutes === null
      ? null
      : Math.max(0, fleet.departureMinutes * 60 - elapsed);
  return (
    <div className="fleet-countdowns">
      <span>
        {preparing ? "出发准备" : "状态"}
        <b>
          {preparing
            ? remaining === null
              ? "未知"
              : countdown(remaining)
            : locked ? "出航已锁定" : "航行中"}
        </b>
      </span>
      <span>
        预计抵达
        <b title={arrivalError}>
          {predictingArrival?"计算中":fleet.arrivalMinutes === null
            ? "暂无法确定"
            : arrivalWorldDays(
                Math.max(0, fleet.arrivalMinutes * 60 - elapsed) / 60,
              )}
        </b>
      </span>
      <button
        className="arrival-shortcut"
        onClick={onArrival}
        disabled={arrivalDisabled}
        aria-label="跳转到抵达时刻"
      >
        <Clock3 className="arrival-clock" size={17} aria-hidden="true" />
        <span className="arrival-label">抵达时刻</span>
        <ArrowRight className="arrival-arrow" size={16} aria-hidden="true" />
      </button>
      {preparing && remaining === 0 && live && (
        <small className="fleet-clock-note">等待出发</small>
      )}
    </div>
  );
}
