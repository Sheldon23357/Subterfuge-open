import {LOBBY_START_DELAY_SECONDS,type PlayerLobbyView} from "../../contracts/src/index.js";
import { colors, playerNames } from "./theme.js";

/** Ret/ge (APK lines 121170+) requires at least two consecutive occupied
 * seats. The server also supports sparse-seat compaction for API clients. */
export function lobbyControls(lobby: PlayerLobbyView) {
  const count = lobby.occupied.filter(Boolean).length,
    joined = !!lobby.occupied[lobby.player];
  const consecutive = lobby.occupied.every(
    (occupied, index) => occupied === index < count,
  );
  return {
    count,
    joined,
    host: lobby.player === 0,
    consecutive,
    canStart:
      lobby.status === "waiting" &&
      lobby.player === 0 &&
      joined &&
      count >= 2 &&
      consecutive,
    delayHours: LOBBY_START_DELAY_SECONDS / 3600,
  };
}
export function lobbyStage(lobby: PlayerLobbyView | null) {
  return lobby?.status === "waiting" ? "waiting" : "game";
}
export function lobbySeconds(lobby: PlayerLobbyView, elapsedMs: number) {
  return Math.max(
    0,
    Math.ceil((lobby.secondsRemaining ?? 0) - Math.max(0, elapsedMs) / 1000),
  );
}
export function lobbyChatPeople(lobby: PlayerLobbyView) {
  const participants = lobby.occupied.flatMap((occupied, seat) =>
    occupied ? [seat] : [],
  );
  const peers = Object.fromEntries(
    lobby.occupied.map((occupied, seat) => {
      const gameSeat =
        lobby.status === "waiting" ? seat : participants.indexOf(seat);
      return [
        seat,
        {
          name: occupied
            ? playerNames[gameSeat]!
            : `${playerNames[seat]}（已离开）`,
          color: occupied ? colors[gameSeat]! : "#849ba6",
        },
      ];
    }),
  );
  return { player: lobby.player, count: lobby.capacity, participants, peers };
}
