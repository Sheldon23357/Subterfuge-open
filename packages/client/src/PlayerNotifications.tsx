import {gameAudio} from "./game-audio.js";
import {AudioEventCursor} from "./audio-policy.js";
import React, { useEffect, useRef, useState } from "react";
import {
  ruleNotificationWorldTime,
  type PlayerNotification,
} from "../../contracts/src/index.js";

import { PlayerConnection } from "./player-connection.js";
import { playerNames } from "./theme.js";
import { worldMinutes as minutes, tickTime } from "./time.js";
const titles: Record<string, string> = {
  departed: "舰队出发预警",
  battle: "战斗报告",
  "mine-captured": "矿场易主",
  "dormant-arrival": "抵达休眠据点",
  "mine-created": "新矿场建成",
  "funding-toggled": "资助变更",
  "funding-expired": "资助失效",
  "inactivity-warning": "活跃警告",
  "player-resigned": "玩家退出",
  "player-eliminated": "玩家淘汰",
  "game-ended": "对局结束",
};

const name = (seat: number | null) =>
  seat === null ? "休眠方" : (playerNames[seat] ?? `玩家 ${seat + 1}`);
const shortFleetReferences = (value: string) =>
  value.replace(/\bp(\d+)-([a-f0-9]{64})\b/gi, (_m, owner: string, hash: string) =>
    `F${Number(owner) + 1}-${hash.slice(0, 8).toUpperCase()}`,
  );
export function message(text: string) {
  const translated = text.replace(/\bP(\d+)\b/g, (_m, i: string) =>
    name(Number(i)),
  );

  const patterns: [RegExp, (...args: string[]) => string][] = [
    [
      /^(.+) just launched a sub from (.+)\. It is estimated to arrive at (.+) in about (\d+) hours\.$/,
      (_m, p, src, dst, h) =>
        `${p}从 ${src} 派出潜艇，预计约 ${minutes(Number(h) * 60)}抵达 ${dst}。`,
    ],
    [
      /^Your sub has arrived at (.+) and taken over the outpost\.$/,
      (_m, p) => `你的潜艇抵达 ${p} 并占领据点。`,
    ],
    [
      /^Your sub has arrived at (.+) and combat ensued\.$/,
      (_m, p) => `你的潜艇抵达 ${p}，发生战斗。`,
    ],
    [
      /^(.+)'s sub arrived at (.+) and combat ensued\.$/,
      (_m, p, dst) => `${p}的潜艇抵达 ${dst}，发生战斗。`,
    ],
    [
      /^You have taken over a mine at (.+)$/,
      (_m, dst) => `你占领了 ${dst} 的矿场。`,
    ],
    [
      /^(.+) has taken over your mine at (.+)$/,
      (_m, p, dst) => `${p}占领了你在 ${dst} 的矿场。`,
    ],
    [
      /^(.+) has taken over (.+)'s mine at (.+)$/,
      (_m, p, other, dst) => `${p}占领了${other}在 ${dst} 的矿场。`,
    ],
    [
      /^Seismic activity detected in (.+)'s territory\. A new mine has been drilled!$/,
      (_m, p) => `检测到${p}领地内的地震活动：一座新矿场已建成。`,
    ],
    [/^(.+) was eliminated\.$/, (_m, p) => `${p}已被淘汰。`],
    [/^(.+) has resigned\.$/, (_m, p) => `${p}已退出对局。`],
    [
      /^Your sub has arrived at dormant outpost (.+)$/,
      (_m, p) => `你的潜艇已抵达休眠据点 ${p}。`,
    ],
    [/^You started funding (.+)\.$/, (_m, p) => `你开始资助${p}。`],
    [/^You stopped funding (.+)\.$/, (_m, p) => `你停止资助${p}。`],
    [/^(.+) is now funding you\.$/, (_m, p) => `${p}开始资助你。`],
    [/^(.+) stopped funding you\.$/, (_m, p) => `${p}停止资助你。`],
    [
      /^Funding for (.+) has been cancelled because they have too much Neptunium\.$/,
      (_m, p) => `对${p}的资助已因矿量差额不足而失效。`,
    ],
    [
      /^Funding from (.+) has been cancelled because you have too much Neptunium\.$/,
      (_m, p) => `${p}对你的资助已因矿量差额不足而失效。`,
    ],
    [
      /^Your absence from the game impacts other players negatively\. You will autoresign in (\d+) hours unless you log in\.$/,
      (_m, h) => `请回到对局保持活跃。继续离线 ${minutes(Number(h) * 60)}将自动退出。`,
    ],
    [
      /^Your sub (.+)crossed paths with (.+)'s sub\.\.\.$/,
      (_m, route, p) => `你的潜艇与${p}的潜艇发生遭遇。`,
    ],
    [
      /^(.+)'s sub (.+)crossed paths with (.+)'s sub\.\.\.$/,
      (_m, p, route, other) => `${p}的潜艇与${other}的潜艇发生遭遇。`,
    ],
    [
      /^You have been away from the game for (\d+) hours\.$/,
      (_m, h) => `你已离开对局 ${minutes(Number(h) * 60)}。`,
    ],
    [
      /^Game over\. (.+) wins?\.$/,
      (_m, p) => `对局结束，${p.replaceAll(" and ", "、")}获胜。`,
    ],
  ];
  for (const [pattern, render] of patterns)
    if (pattern.test(translated))
      return shortFleetReferences(translated.replace(pattern, (...parts: unknown[]) =>
          render(...(parts.slice(0, -2) as string[])),
        ));
  return shortFleetReferences((
      {
        "Game over.": "对局结束。",
        "You've been eliminated.": "你已被淘汰。",
        "Your absence impacts other players negatively. If you don't want to continue the game, please log in and resign.":
          "长时间离线会影响其他玩家，请回到对局保持活跃。",
      } as Record<string, string>
    )[translated] ?? translated);
}
function BattleReport({
  battle,
}: {
  battle: NonNullable<PlayerNotification["battle"]>;
}) {

  return (
    <details className="player-battle">
      <summary>查看战斗详情</summary>
      <table>
        <caption>参战舰数与结算</caption>
        <thead>
          <tr>
            <th>阵营</th>
            <th>参战</th>
            <th>剩余</th>
          </tr>
        </thead>
        <tbody>
          {(["attacker", "defender"] as const).map((side, i) => (
            <tr key={side}>
              <th>
                {i ? "守方" : "攻方"} · {name(battle[side].player)}
              </th>
              <td>{battle[side].before}</td>
              <td>{battle[side].after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        护盾 {battle.shield.before} → {battle.shield.after} ·{" "}
        {(
          {
            attacker: "攻方获胜",
            defender: "守方获胜",
            draw: "双方平局",
            ended: "战斗提前结束",
          } as Record<string, string>
        )[battle.outcome] ?? battle.outcome}
      </p>

    </details>
  );
}
export function PlayerNotifications({
  connection,
  roomId,
  player,
  visible,
  onUnread,
  scope = "",
}: {
  connection: PlayerConnection;
  roomId: string;
  player: number;
  visible: boolean;
  onUnread: (count: number) => void;
  scope?: string;
}) {
  const [entries, setEntries] = useState<PlayerNotification[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const cursor = useRef(0),
    seen = useRef(0),
    key = `subterfuge-events-seen:${roomId}:${scope ? scope + ":" : ""}${player}`;
  useEffect(() => {
    let active = true,
      running = false;
    const controller = new AbortController();
    const audioCursor = new AudioEventCursor();
    cursor.current = 0;
    setEntries([]);
    setError("");
    setLoaded(false);
    try {
      const stored = Number(sessionStorage.getItem(key) ?? 0);
      seen.current = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
    } catch {
      seen.current = 0;
    }
    const load = async () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      try {
        for (let page = 0; page < 5 && active; page++) {
          const result = await connection.notifications(
            cursor.current,
            controller.signal,
          );
          if (!active) return;
          if (result.roomId !== roomId) throw Error("对局已更新，请重新连接。");
          if (result.notifications.length)
            setEntries((prior) => [...prior, ...result.notifications]);
          const cue=audioCursor.accept(result.notifications,result.hasMore);
          if(cue)gameAudio.play(cue);
          cursor.current = result.nextCursor;
          setLoaded(true);
          setError("");
          if (!result.hasMore) break;
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    const wake = () => {
      setVisibilityEpoch((n) => n + 1);
      void load();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [connection, roomId, key]);
  useEffect(() => {
    if (loaded && visible && document.visibilityState === "visible") {
      seen.current = cursor.current;
      try {
        sessionStorage.setItem(key, String(seen.current));
      } catch {}
    }
    onUnread(loaded ? Math.max(0, cursor.current - seen.current) : 0);
  }, [entries, loaded, visible, key, onUnread, visibilityEpoch]);
  return (
    <section className="player-notifications" aria-label="玩家事件记录">
      <h2>战报与通知</h2>
      <p className="muted">截至现在的事件记录；仅显示本舰队有权接收的消息。</p>
      {error && (
        <p className="player-error" role="alert">
          {error}
        </p>
      )}
      {!loaded ? (
        <p role="status">正在读取事件…</p>
      ) : entries.length === 0 ? (
        <p>目前没有新的事件。</p>
      ) : (
        <ol>
          {[...entries].reverse().map((entry) => {
            const eventTime = ruleNotificationWorldTime(entry);
            return (
              <li key={entry.id}>
                <header>
                  <b>{titles[entry.kind] ?? "对局事件"}</b>
                  {entry.urgent && <span>重要</span>}
                  <time>
                    {eventTime.eventWorldDay === null
                      ? "时间未知"
                      : tickTime(eventTime.eventWorldDay)}
                  </time>
                </header>
                <p>{message(entry.text)}</p>
                {entry.location?.kind === "outpost" && (
                  <p className="muted">事件据点：{entry.location.id}</p>
                )}
                {entry.details && (
                  <details>
                    <summary>附加信息</summary>
                    <p>{message(entry.details)}</p>
                  </details>
                )}
                {entry.battle && <BattleReport battle={entry.battle} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
