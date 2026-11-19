import React from "react";
import {Anchor} from 'lucide-react';
import { PlayerLobby } from "./PlayerLobby.js";
import "./hub-waiting.css";
type Props = React.ComponentProps<typeof PlayerLobby> & {
  onPreview: () => void;
};
export function HubWaitingRoom({
  lobby,
  connection,
  busy,
  error,
  retry,
  command,
  disconnect,
  onPreview,
}: Props) {
  return (
    <main className="hub-waiting">
      <div className="hub-waiting-art" />
      <header>
        <a href="/">← 返回作战大厅</a>
        <span>深 潜</span>
      </header>
      <section className="hub-waiting-layout">
        <aside>
          <div className="waiting-heading">
            <div className="waiting-emblem" aria-hidden="true"><Anchor size={32}/></div>
            <h1>作战准备室</h1>
          </div>
        </aside>
        <section className="hub-waiting-panel" aria-label="作战室席位与开局">
          <PlayerLobby
            lobby={lobby}
            connection={connection}
            busy={busy}
            error={error}
            retry={retry}
            command={command}
            disconnect={disconnect}
            onPreview={onPreview}
          />
        </section>
      </section>
    </main>
  );
}
