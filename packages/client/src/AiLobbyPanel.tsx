import React, { useEffect, useState } from "react";
import { type PlayerLobbyView } from "../../contracts/src/index.js";
import type { PlayerConnection } from "./player-connection.js";
import "./ai-lobby.css";

interface Settings {
  model: string;
  personality: string;
  provider?: string;
}
interface Seat {
  seat: number;
  gameSeat: number | null;
  enabled: boolean;
  status: string;
  recovering?:boolean;
  error: string | null;
  settings: Settings;
  calls: number;
  tokens: number;
}
interface Status {
  roomId: string;
  provider: string;
  seats: Seat[];
}
const labels: Record<string, string> = {
  waiting: "待命",
  thinking: "思考中",
  paused: "已暂停",
  error: "异常",
  ended: "已结束",
};
export function AiLobbyPanel({
  connection,
  lobby,
}: {
  connection: PlayerConnection;
  lobby: PlayerLobbyView;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const poll = () =>
      connection
        .request<Status>("/ai/v2")
        .then((v) => {
          if (active && v.roomId === lobby.roomId) setStatus(v);
        })
        .catch(() => {
          if (active) setError("无法读取 AI 状态。");
        });
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection, lobby.roomId]);
  return <section className="ai-lobby-panel" aria-label="服务器托管状态">
    <header><h3>服务器托管状态</h3></header>
    {status?.seats.map(s=><div className="ai-seat-compact" key={s.seat}><div className="ai-seat-title"><strong>席位 {s.seat+1}</strong><span>{s.recovering?'等待自动恢复':labels[s.status]??s.status}</span></div><div className="ai-seat-detail">{s.calls} 次 · {s.tokens.toLocaleString()} tokens</div>{s.error&&<p role="status" className="ai-row-error">{s.error}</p>}</div>)}
    <p className="ai-panel-note">AI 连接、模型与策略由独立运行器管理；开局后使用本人玩家身份人工接管。</p>
    {error&&<p role="alert" className="player-error">{error}</p>}
  </section>;
}
