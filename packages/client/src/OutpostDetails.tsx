import { Factory, Zap, Gem } from "./OriginalIcon.js";
import React from "react";
import type { GameView } from "./game-view.js";
import {productionCycleDisplay} from "./production-cycle-display.js";
export function OutpostDetails({
  post,
}: {
  post: GameView["outposts"][number];
}) {
  const m = post.metrics;
  if (!m) return null;
  const power = m.capacity === null ? "—" : `${m.used} / ${m.capacity}`;
  const production = productionCycleDisplay(m.cycleMinutes,m.nextMinutes);
  const status = post.owner === null ? "未运营" : m.paused && post.type !== "generator" ? "已暂停" : "运行中";
  const statusMetric = (
    <span className="metric-status">
      状态
      <b>{status}</b>
      {post.owner !== null && post.type !== "generator" && !m.paused && <small>{production.next}</small>}
    </span>
  );
  return (
    <div className="outpost-metrics">
      <div className="metric-heading">
        {post.type === "factory" ? (
          <Factory />
        ) : post.type === "generator" ? (
          <Zap />
        ) : (
          <Gem />
        )}
        <span>
          {post.type === "factory"
            ? "生产"
            : post.type === "generator"
              ? "供电"
              : "采矿"}
        </span>
      </div>
      {post.type === "factory" ? (
        <>
          <div className="metric-pair metric-columns">
            {statusMetric}
            <span>
              生产效率
              <b title={production.detail}>
                {production.cycle}
                <small>{production.batchPrefix}{m.output}舰</small>
              </b>
            </span>
            <span title="舰数共用电能容量，含据点与航行舰队">
              上限<b>{m.capacity ?? "—"}</b>
              <small>占用 {m.used ?? "—"}</small>
            </span>
          </div>
          {m.used !== null && m.capacity !== null && m.used >= m.capacity && (
            <small className="metric-note">
              电能容量已满；释放容量后恢复生产
            </small>
          )}
        </>
      ) : post.type === "generator" ? (
        <>
          <div className="metric-pair metric-columns">
            {statusMetric}
            <span>
              提供舰船容量
              <b>
                +{m.contribution}
              </b>
            </span>
            <span title="电能共享，含据点与航行舰队">
              占用 / 上限<b>{power}</b>
            </span>
          </div>

        </>
      ) : (
        <>
          <div className="metric-pair metric-columns">
            {statusMetric}
            <span>
              采矿效率
              <b title={production.detail}>
                {production.cycle}<small>{production.batchPrefix}1矿</small>
              </b>
            </span>
            <span>
              矿量<b>{m.neptunium ?? "—"}</b>
              <small>{m.mines} 座矿场</small>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
