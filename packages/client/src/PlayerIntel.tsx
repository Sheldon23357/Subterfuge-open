import {worldDailyRate,worldFleetProductionEstimate} from './time.js';
import React from "react";
import type { PlayerIntelStatistics } from "../../contracts/src/index.js";
import { colors, playerNames } from "./theme.js";
export function PlayerIntel({
  rows,
  player,
  historical,
}: {
  rows: PlayerIntelStatistics[] | null;
  player: number;
  historical: boolean;
}) {
  return (
    <section className="player-intel" aria-label="公开情报">
      <h2>{historical ? "历史情报" : "当前情报"}</h2>
      <p className="muted">
        各舰队的公开总量；具体据点舰数仍按声呐显示。
      </p>
      {rows === null ? (
        <p role="status">正在读取当时情报…</p>
      ) : (
        rows.map((row) => (
          <article
            key={row.player}
            aria-label={`${playerNames[row.player]}情报`}
          >
            <h3 style={{ color: colors[row.player] }}>
              {playerNames[row.player]}
              {row.player === player ? "（你）" : ""}
              <small>{row.active ? "在局" : "已出局"}</small>
            </h3>
            <dl>
              <div>
                <dt>矿量</dt>
                <dd>{row.neptunium}kg</dd>
              </div>
              <div>
                <dt>矿世界天产量</dt>
                <dd>{worldDailyRate(row.npPerDay)}kg / 天</dd>
              </div>
              <div>
                <dt>总舰数 / 供电</dt>
                <dd>
                  {row.drillers} / {row.output}
                </dd>
              </div>
              <div>
                <dt title="非连续产出；实际按据点周期结算，电能不足时暂停">144天理论舰产能估计</dt>
                <dd>{worldFleetProductionEstimate(row.drillerRate)}</dd>
              </div>
            </dl>
            <p>
              据点 {row.numOutposts} · 矿场 {row.outposts.mine} · 工厂{" "}
              {row.outposts.factory} · 发电站 {row.outposts.generator}
            </p>
          </article>
        ))
      )}
    </section>
  );
}
