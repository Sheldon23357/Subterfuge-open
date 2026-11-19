import React from "react";
import type {
  PlayerForecastResponse,
  QueuedOrderView,
} from "../../contracts/src/index.js";
import { tickTime } from "./time.js";
import { playerNames } from "./theme.js";
const reasons: Record<string, string> = {
  "match-ended": "对局已结束。",
  "inconsistent-public-totals": "当前单位情报与公开总量尚未一致，请稍后重试。",
  "own-resources-unlocated": "部分己方资源的位置未知，暂无法推演。",
  "funding-economic-runtime-unknown": "当前资助关系的经济影响尚未支持推演。",
  "allied-funding-runtime-unknown": "队友的资助关系尚未支持推演。",
  "allied-resources-unlocated": "部分队友资源的位置未知，暂无法完整推演。",
  "known-schedule-reservation-unresolved": "已有预约的潜艇预留尚无法可靠重建。",
};
export function PlayerForecastStatus({
  response,
  loading,
  error,
  targetTick,
  plans,
  retry,
  leave,
}: {
  response: PlayerForecastResponse | null;
  loading: boolean;
  error: string;
  targetTick: number;
  plans: QueuedOrderView[];
  retry: () => void;
  leave: () => void;
}) {
  return (
    <section className="player-forecast-status" aria-label="未来推演状态">
      <div>
        <b>预演 {tickTime(targetTick)}</b>
        <button onClick={retry} disabled={loading}>
          重新推演
        </button>
        <button onClick={leave}>返回现在</button>
      </div>
      {loading ? (
        <p role="status">正在推演已知局势…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : response?.status === "unsupported" ? (
        <>
          <p>当前无法给出这段未来的可靠海图。</p>
          <ul>
            {response.reasons.map((reason) => (
              <li key={reason}>
                {reasons[reason] ?? "部分必要情报尚未支持推演。"}
              </li>
            ))}
          </ul>
        </>
      ) : response?.status === "conditional" ? (
        <>
          <p>
            条件性推演 · 仅执行已知预约；敌方后续行动与未知抵达结果仍不确定。
          </p>
          <details>
            <summary>
              推演条件与预约结果
              {response.result.unknownArrivals.length
                ? ` · ${response.result.unknownArrivals.length} 次抵达结果未知`
                : ""}
            </summary>
            <p>
              未知位置的舰数与全局能力尚未完整计入；未来总量与胜负不作确定判断。
            </p>
            {response.result.unknownArrivals.map((a, i) => (
              <p key={i}>
                {tickTime(a.tick)} · 抵达 {a.outpostId}
                ：舰数及控制权结果未知。
              </p>
            ))}
            {response.result.uncertainPlayers.length > 0 && (
              <p>
                {response.result.uncertainPlayers
                  .map((p) => playerNames[p])
                  .join("、")}
                的皇室状态不确定。
              </p>
            )}
            {response.orders.length === 0 ? (
              <p>没有己方预约参与本次推演。</p>
            ) : (
              <ul>
                {response.orders.map((order) => {
                  const plan = plans.find((p) => p.id === order.id);
                  return (
                    <li key={order.id}>
                      {tickTime(order.issueTick)} ·{" "}
                      {plan?.action.kind === "launch" ? "派遣舰队" : "对局指令"}{" "}
                      ·{" "}
                      {order.status === "executed"
                        ? "条件成立时可执行"
                        : order.status === "failed"
                          ? "在这些条件下未生效"
                          : "尚未到执行时间"}
                    </li>
                  );
                })}
              </ul>
            )}
            <p>此视图只读。返回现在后可新增或修改预约。</p>
          </details>
        </>
      ) : (
        <p>准备推演…</p>
      )}
    </section>
  );
}
