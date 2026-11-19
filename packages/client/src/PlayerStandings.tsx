import React, { useEffect, useState } from "react";
import type { PlayerFinalStandings } from "../../contracts/src/index.js";
import { PlayerConnection } from "./player-connection.js";
import { playerNames, colors } from "./theme.js";
import { tickTime } from "./time.js";
export function PlayerStandings({
  connection,
  roomId,
  player,
}: {
  connection: PlayerConnection;
  roomId: string;
  player: number;
}) {
  const [result, setResult] = useState<PlayerFinalStandings | null>(null),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(null);
    setError("");
    void connection
      .standings()
      .then((next) => {
        if (active) {
          if (next.roomId !== roomId) throw Error("对局已更新，请重新连接。");
          setResult(next);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [connection, roomId, attempt]);
  if (error)
    return (
      <div className="player-error" role="alert">
        {error}
        <button onClick={() => setAttempt((n) => n + 1)}>重新读取排名</button>
      </div>
    );
  if (!result) return <p role="status">正在读取终局排名…</p>;
  if (!result.ended) return <p>本局尚未结束。</p>;
  const winners = result.winners ?? [];
  return (
    <section className="player-final" aria-label="终局排名">
      <h2>终局排名</h2>
      <p className="player-final-winner">
        {winners.length
          ? `胜者：${winners.map((seat) => playerNames[seat]).join("、")}`
          : "本局无胜者"}
      </p>
      <p>结束时间：{tickTime(result.endTick ?? 0)}</p>
      <ol>
        {result.players?.map((p) => (
          <li
            key={p.seat}
            className={winners.includes(p.seat) ? "is-winner" : ""}
          >
            <div>
              <b style={{ color: colors[p.seat] }}>
                {p.teamRank === null
                  ? `第 ${p.rank} 名`
                  : `团队第 ${p.teamRank} 名`}{" "}
                · {playerNames[p.seat]}
                {p.seat === player ? "（你）" : ""}
              </b>
              {winners.includes(p.seat) && <span>胜者</span>}
            </div>
            <dl>
              <div>
                <dt>矿量</dt>
                <dd>{p.neptunium}kg</dd>
              </div>
              <div>
                <dt>矿场</dt>
                <dd>{p.mines}</dd>
              </div>
              <div>
                <dt>其他据点</dt>
                <dd>{p.outposts}</dd>
              </div>
              <div>
                <dt>舰数</dt>
                <dd>{p.drillers}</dd>
              </div>
            </dl>
            {!p.active && (
              <p className="muted">
                {p.deathTick === null
                  ? "已出局"
                  : `出局时间：${tickTime(p.deathTick)}`}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
