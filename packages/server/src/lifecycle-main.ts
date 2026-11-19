import { CommanderStore } from "./commander-store.js";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { createGeneratedRoom } from "./generated-room.js";
import { createWaitingLobby } from "./waiting-lobby.js";
import { PlayerAccess, savePlayerAccess } from "./player-access.js";
import { LobbyStore } from "./lobby-store.js";
import { ChatStore } from "./chat.js";
import { createLifecycleService } from "./lifecycle-service.js";
import { NotificationScheduleStore } from "./notification-schedule-store.js";
import { AiStore, createProviderFromEnv } from "../../ai/src/index.js";
import { LobbyAi } from "./ai-lobby.js";

const port = Number(process.env.LOBBY_PORT ?? 4312),
  host = process.env.LOBBY_HOST ?? "127.0.0.1",
  players = Number(process.env.LOBBY_PLAYERS ?? 8);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(players) ||
  players < 2 ||
  players > 10
)
  throw Error("Invalid lobby listener or player count");
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(port, host, () =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
});
const directory = resolve(process.env.LOBBY_DATA_DIR ?? "runtime-lobby");
await mkdir(directory, { recursive: true });
const store = new LobbyStore(resolve(directory, "lifecycle.sqlite"));
let notifications: NotificationScheduleStore | undefined;
let aiStore: AiStore | undefined, ai: LobbyAi | undefined;
try {
  if (!store.load()) {
    const access = PlayerAccess.generate(players),
      room = await createGeneratedRoom(
        players,
        randomInt(0, 0xffffffff - 499),
        "original",
      );
    room.playerRoomId = access.roomId;
    store.commit(createWaitingLobby(access), 0, room);
  }
  const saved = store.load()!;
  if (!saved.waitingRoom)
    throw Error("Lifecycle database has no waiting world");
  // Local host distributes these credentials. Never print tokens or serve this file.
  await savePlayerAccess(
    resolve(directory, "lobby-access.json"),
    saved.lobby.access,
  );
  const commander = new CommanderStore(
    resolve(directory, "commander-chat.json"),
  );
  const chat = new ChatStore(resolve(directory, "game-chat.json"));
  notifications = new NotificationScheduleStore(
    resolve(directory, "notifications.sqlite"),
  );
  aiStore = new AiStore(resolve(directory, "ai.sqlite"));
  ai = new LobbyAi(store, aiStore, createProviderFromEnv());
  const service = createLifecycleService(store, {
    commander,
    webRoot: resolve("packages/client/public"),
    chat: () => chat,
    notifications,
    ai,
  });
  await service.ready;
  await service.synchronize();
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(port, host, resolve);
  });
  service.startClock();
  ai.start(
    `http://${host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host}:${port}`,
  );
  console.log(
    `Lifecycle service listening on http://${host}:${port}; local credentials: ${resolve(directory, "lobby-access.json")}`,
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    service.stopClock();
    await ai?.stop();
    await new Promise<void>((resolve) => service.server.close(() => resolve()));
    await service.drain();
    notifications?.close();
    aiStore?.close();
    store.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
} catch (error) {
  await ai?.stop();
  notifications?.close();
  aiStore?.close();
  store.close();
  throw error;
}
