import { readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { fleetStandings } from "../../engine/src/index.js";
import { RoomStore } from "./room-store.js";
import {
  PlayerAccess,
  SerialExecutor,
  type PlayerAccessFile,
} from "./player-access.js";
import { DurablePlayerControl } from "./durable-player-control.js";
import { ChatStore } from "./chat.js";
import { CommanderStore } from "./commander-store.js";
import { PlayerProtocolCoordinator } from "./player-protocol-coordinator.js";
import { createPlayerApi } from "./player-api.js";
import type { PlayerProtocolHost } from "./player-protocol-api.js";
import { PlayerProtocolError } from "./player-protocol-auth.js";
import { advanceRoom, type LabRoom } from "./planning.js";
import { catchUpRealtime, realtimeSeconds, startRealtime } from "./realtime.js";
import { parsePlayerPublicOrigin } from "./player-origin.js";
import {
  GameCheckpointCoordinator,
  type GameCheckpointTimeouts,
} from "./game-checkpoint-coordinator.js";
import {
  exportGameOnlyCheckpoint,
  restoreGameOnlyCheckpoint,
  verifyGameOnlyCheckpoint,
  type GameOnlyRestoreMarker,
} from "./game-only-checkpoint.js";

export interface GameOnlyServerOptions {
  store: RoomStore | string;
  /** Required existing credentials. This composition never generates owner credentials. */
  access: PlayerAccessFile | string;
  /** Required only when the supplied database is empty. No demo room is implicit. */
  initialRoom?: LabRoom;
  now?: () => number;
  elapsedNow?: () => number;
  clock?: "saved" | "manual" | "realtime";
  legacyChat?: string | ChatStore;
  commander?: string | CommanderStore;
  publicOrigin?: string;
  checkpointDirectory?: string;
  checkpointTimeouts?: GameCheckpointTimeouts;
  restoreMarker?: string;
  remoteDeadlineMs?: number;
  pulseMs?: number;
  onClockError?: (error: unknown) => void;
}
/** Pure composition: imports no AI runtime, provider, model configuration, SDK or UI. */
export async function createGameOnlyServer(options: GameOnlyServerOptions) {
  if (!options || options.access === undefined)
    throw Error("An explicit existing player access file is required");
  const accessData: PlayerAccessFile =
      typeof options.access === "string"
        ? JSON.parse(await readFile(options.access, "utf8"))
        : structuredClone(options.access),
    access = new PlayerAccess(accessData);
  const now = options.now ?? Date.now,
    wall = () => {
      const n = now();
      if (!Number.isSafeInteger(n) || n < 0)
        throw Error("Invalid game server wall clock");
      return n;
    };
  const publicOrigin = parsePlayerPublicOrigin(options.publicOrigin);
  if (
    options.clock !== undefined &&
    !["saved", "manual", "realtime"].includes(options.clock)
  )
    throw Error("Invalid game clock mode");
  if (
    options.remoteDeadlineMs !== undefined &&
    (!Number.isSafeInteger(options.remoteDeadlineMs) ||
      options.remoteDeadlineMs < 1 ||
      options.remoteDeadlineMs > 86_400_000)
  )
    throw Error("Invalid remote turn deadline");
  const pulseMs = options.pulseMs ?? 250;
  if (!Number.isSafeInteger(pulseMs) || pulseMs < 10 || pulseMs > 60_000)
    throw Error("Invalid clock pulse interval");
  if (typeof options.store === "string") {
    const checkpointManifest = join(
      dirname(resolve(options.store)),
      "manifest.json",
    );
    if (existsSync(checkpointManifest)) {
      const candidate = JSON.parse(await readFile(checkpointManifest, "utf8"));
      if (candidate?.format === "game-only-checkpoint/1")
        throw Error(
          "Restore an immutable checkpoint to a fresh directory before starting a server",
        );
    }
  }
  const ownsStore = typeof options.store === "string",
    store = ownsStore
      ? new RoomStore(options.store as string, {
          wallNow: wall,
          ...(options.elapsedNow ? { monotonicNow: options.elapsedNow } : {}),
        })
      : (options.store as RoomStore);
  let detach: (() => void) | undefined;
  try {
    if (!store.protocol)
      throw Error("Game server requires a writable authoritative RoomStore");
    let saved = store.load();
    if (!saved) {
      if (!options.initialRoom)
        throw Error(
          "Empty authority database requires an explicit initialRoom",
        );
      const room = structuredClone(options.initialRoom);
      if (room.playerRoomId && room.playerRoomId !== access.roomId)
        throw Error("Access file belongs to another room");
      room.playerRoomId = access.roomId;
      if (room.state.economy.players.length !== accessData.credentials.length)
        throw Error("Access file player count differs from room");
      store.commit(room, 0);
      saved = store.load()!;
    }
    const roomId = saved.room.playerRoomId ?? store.predictionSource().roomId;
    if (
      access.roomId !== roomId ||
      accessData.credentials.length !== saved.room.state.economy.players.length
    )
      throw Error("Access file does not match the authoritative room");
    store.verify();
    const repository = store.protocol,
      markerPath =
        options.restoreMarker ??
        (ownsStore
          ? join(
              dirname(resolve(options.store as string)),
              "game-only-restored.json",
            )
          : undefined);
    let marker: GameOnlyRestoreMarker | undefined;
    if (
      markerPath &&
      (options.restoreMarker !== undefined || existsSync(markerPath))
    ) {
      const stat = await lstat(markerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
        throw Error("Invalid restored clone marker");
      const value = JSON.parse(
        await readFile(markerPath, "utf8"),
      ) as GameOnlyRestoreMarker;
      if (
        value.format !== "game-only-restored/1" ||
        value.roomId !== roomId ||
        typeof value.checkpointId !== "string" ||
        typeof value.sourceRoomEpoch !== "string" ||
        typeof value.roomEpoch !== "string" ||
        value.sourceRoomEpoch === value.roomEpoch ||
        !Number.isSafeInteger(value.restoredAtMs) ||
        value.restoredAtMs < 0 ||
        repository.currentEpoch(roomId) !== value.roomEpoch
      )
        throw Error("Restored clone marker does not match authority");
      marker = value;
    }
    const activationPayload = store.readProtocolDocument(
      roomId,
      "restore",
      "activation",
    );
    if (activationPayload) {
      const activation = JSON.parse(activationPayload);
      if (
        activation.format !== "game-only-activation/1" ||
        !Number.isSafeInteger(activation.restoredAtMs) ||
        activation.restoredAtMs < 0 ||
        typeof activation.activated !== "boolean"
      )
        throw Error("Invalid restored clone activation metadata");
      if (!activation.activated && !marker)
        throw Error(
          "A pending restored clone requires its explicit restore marker",
        );
    }
    // Restore already forked offline. A regular process restart preserves epoch
    // while invalidating sessions/fences. Never fork a clone twice on first boot.
    const authority = repository.startAuthority(
      roomId,
      saved.room.state.economy.players.length,
    );
    if (marker) {
      const doc = repository.domainDocument(
        authority.roomEpoch,
        "restore",
        "activation",
      );
      repository.atomic(() => {
        const payload = doc.read();
        if (!payload)
          throw Error("Restored clone activation metadata is missing");
        const activation = JSON.parse(payload);
        if (
          activation.format !== "game-only-activation/1" ||
          activation.restoredAtMs !== marker!.restoredAtMs ||
          typeof activation.activated !== "boolean"
        )
          throw Error("Invalid restored clone activation metadata");
        if (!activation.activated) {
          const activatedAtMs = wall();
          if (activatedAtMs < activation.restoredAtMs)
            throw Error("Restore activation clock moved backwards");
          const current = store.load()!;
          if (current.room.clock)
            store.commit(
              {
                ...current.room,
                clock: {
                  ...current.room.clock,
                  anchorMs:
                    current.room.clock.anchorMs +
                    activatedAtMs -
                    activation.restoredAtMs,
                },
              },
              current.revision,
            );
          doc.transact(() => ({
            payload: JSON.stringify({
              ...activation,
              activated: true,
              activatedAtMs,
            }),
            result: undefined,
          }));
        }
      });
    }
    let synchronizedNow = wall();
    const current = store.load()!;
    if (options.clock === "realtime" && !current.room.clock)
      store.commit(
        startRealtime(current.room, synchronizedNow),
        current.revision,
      );
    if (options.clock === "manual" && current.room.clock) {
      const room = {
        ...current.room,
        state: {
          ...current.room.state,
          secondsSinceLastTick: realtimeSeconds(current.room, synchronizedNow),
        },
      };
      delete room.clock;
      store.commit(room, current.revision);
    }
    const serial = new SerialExecutor(),
      chat =
        options.legacyChat instanceof ChatStore
          ? options.legacyChat
          : new ChatStore(options.legacyChat),
      commander =
        options.commander instanceof CommanderStore
          ? options.commander
          : new CommanderStore(options.commander);
    const room = () => store.load()!.room,
      seconds = () => realtimeSeconds(store.metadata(), synchronizedNow),
      coordinator = new PlayerProtocolCoordinator(repository, {
        roomId: () => roomId,
        load: () => store.current()!.room,
        seconds,
      });
    await coordinator.bindDomains(chat, commander);
    coordinator.refreshWorld();
    detach = store.onCommit((next, _revision, reset) =>
      coordinator.worldCommitted(next, { reset }),
    );
    store.observeTick(store.load()!.revision);
    const checkpoints = new GameCheckpointCoordinator({
      repository,
      roomId: () => roomId,
      serial,
      head: () => {
        const head = store.load()!;
        return { tick: head.room.state.economy.tick, revision: head.revision };
      },
      now: wall,
      beforePause: syncClock,
      ...(options.checkpointTimeouts
        ? { timeouts: options.checkpointTimeouts }
        : {}),
      resumeClock: (pausedAtMs, resumedAtMs) => {
        synchronizedNow = resumedAtMs;
        const head = store.load()!;
        if (head.room.clock)
          store.commit(
            {
              ...head.room,
              clock: {
                ...head.room.clock,
                anchorMs:
                  head.room.clock.anchorMs +
                  Math.max(0, resumedAtMs - pausedAtMs),
              },
            },
            head.revision,
          );
      },
      publish: async (metadata, signal, beforePublish) => {
        if (!options.checkpointDirectory)
          throw Error("Checkpoint directory is not configured");
        return exportGameOnlyCheckpoint(
          store,
          options.checkpointDirectory,
          metadata,
          { signal, beforePublish },
        );
      },
    });
    async function syncClock() {
      if (checkpoints.isPaused()) return;
      synchronizedNow = wall();
      const head = store.current()!,
        current = head.room;
      if (current.clock) {
        const next = await catchUpRealtime(current, synchronizedNow);
        if (next !== current)
          store.commit(next, head.revision, false, "realtime");
      } else if (
        options.remoteDeadlineMs !== undefined &&
        !fleetStandings(current.state).ended
      ) {
        const deadline = repository.turnDeadline(
            roomId,
            current.state.economy.tick,
            options.remoteDeadlineMs,
          ),
          seats = repository
            .readyPlayers(roomId,current.state.economy.tick)
            .filter((s) => current.state.economy.players[s.player]?.active);
        if (
          deadline.remainingMs <= 0 ||
          (seats.length > 0 && seats.every((s) => s.ready))
        )
          store.commit(
            advanceRoom(current, current.state.economy.tick + 1),
            head.revision,
            false,
            "automatic",
          );
      }
    }
    await syncClock();
    const control = new DurablePlayerControl(repository),
      protocol: PlayerProtocolHost = {
        repository,
        roomId,
        serial,
        load: () => store.current()!,
        commit: (next, expected) => store.commit(next, expected),
        sync: syncClock,
        seconds,
        ownerIdentity: (header) => {
          const player = access.identity(header);
          return player === null ? null : { roomId, player };
        },
        chat: () => chat,
        commander,
        capabilities: () => [
          ...coordinator.capabilities(),
          ...(options.checkpointDirectory ? ["checkpoints.coordinated/1"] : []),
        ],
        snapshot: (player) => coordinator.snapshot(player),
        instructionsVersion: (player) =>
          coordinator.instructionsVersion(player),
        assertMutationAllowed: (kind, stage) =>
          checkpoints.assertMutationAllowed(kind, stage),
        checkpoints,
        ...(publicOrigin ? { publicOrigin } : {}),
        ...(options.remoteDeadlineMs === undefined
          ? {}
          : {
              assertCommandWindow: (tick: number) =>
                repository.assertTurnDeadline(roomId, tick),
            }),
      };
    const server = createPlayerApi({protocol,...(publicOrigin?{publicOrigin}:{})});
    let timer: ReturnType<typeof setInterval> | undefined,
      pulsePending = false,
      closed = false;
    server.on("listening", () => {
      if (timer || closed) return;
      timer = setInterval(() => {
        if (
          pulsePending ||
          closed ||
          (!room().clock && options.remoteDeadlineMs === undefined)
        )
          return;
        pulsePending = true;
        void serial
          .run(syncClock)
          .catch((error) => options.onClockError?.(error))
          .finally(() => {
            pulsePending = false;
          });
      }, pulseMs);
      timer.unref();
    });
    async function listen(port = 0, host = "127.0.0.1"): Promise<AddressInfo> {
      if (closed) throw Error("Game server is closed");
      if (server.listening) throw Error("Game server is already listening");
      return new Promise((resolveListen, reject) => {
        const failed = (error: Error) => {
            server.off("listening", ready);
            reject(error);
          },
          ready = () => {
            server.off("error", failed);
            resolveListen(server.address() as AddressInfo);
          };
        server.once("error", failed);
        server.once("listening", ready);
        server.listen(port, host);
      });
    }
    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      closing = (async () => {
        let failure: unknown;
        try {
          await checkpoints.close();
        } catch (error) {
          if (
            !(
              error instanceof PlayerProtocolError &&
              error.code === "SERVER_RESTARTED"
            )
          )
            failure = error;
        }
        try {
          server.closeAllConnections();
          await new Promise<void>((done, reject) =>
            server.close((error) => {
              if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                  "ERR_SERVER_NOT_RUNNING"
              )
                reject(error);
              else done();
            }),
          );
        } catch (error) {
          failure ??= error;
        } finally {
          await serial.run(() => {
            detach?.();
            if (ownsStore) store.close();
          });
        }
        if (failure) throw failure;
      })();
      return closing;
    }
    return {
      server,
      store,
      repository,
      authority,
      access,
      control,
      serial,
      chat,
      commander,
      coordinator,
      checkpoints,
      listen,
      close,
      sync: () => serial.run(syncClock),
    };
  } catch (error) {
    detach?.();
    if (ownsStore) store.close();
    throw error;
  }
}

function cliOptions(args: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !/^--[a-z-]+$/.test(key) ||
      value === undefined ||
      value.startsWith("--") ||
      result.has(key)
    )
      throw Error("Arguments must be unique --name value pairs");
    result.set(key.slice(2), value);
  }
  return result;
}
/** Explicit CLI; importing this file never opens a listener or reads configuration. */
export async function runGameOnlyServerCli(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help",
    args = cliOptions(argv.slice(1)),
    get = (key: string) => {
      const value = args.get(key);
      if (!value) throw Error("Missing --" + key);
      return value;
    };
  if (command === "help") {
    console.log(
      "Game-only server: serve --database PATH --access EXISTING_FILE [--port 4300] [--host 127.0.0.1] [--checkpoint-directory DIR] [--clock saved|manual|realtime]\nOffline: export --database PATH --directory DIR --checkpoint-id ID | verify --source DIR | restore --source DIR --destination NEW_DIR",
    );
    return;
  }
  const allowed: Record<string, string[]> = {
    serve: [
      "database",
      "access",
      "port",
      "host",
      "checkpoint-directory",
      "clock",
      "remote-deadline-ms",
      "restore-marker",
    ],
    export: ["database", "directory", "checkpoint-id"],
    verify: ["source"],
    restore: ["source", "destination"],
  };
  if (
    !allowed[command] ||
    [...args.keys()].some((k) => !allowed[command]!.includes(k))
  )
    throw Error("Unknown game-only command or option");
  if (command === "verify") {
    console.log(JSON.stringify(await verifyGameOnlyCheckpoint(get("source"))));
    return;
  }
  if (command === "restore") {
    console.log(
      JSON.stringify(
        await restoreGameOnlyCheckpoint(get("source"), get("destination")),
      ),
    );
    return;
  }
  const database = get("database");
  const stat = await lstat(database);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("An existing regular authority database is required");
  if (command === "export") {
    const store = new RoomStore(database);
    try {
      const head = store.load();
      if (!head) throw Error("No authoritative room");
      const roomId = head.room.playerRoomId ?? store.predictionSource().roomId;
      console.log(
        JSON.stringify(
          await exportGameOnlyCheckpoint(store, get("directory"), {
            checkpointId: get("checkpoint-id"),
            mode: "game-only",
            roomId,
            roomEpoch: store.protocol!.currentEpoch(roomId),
            tick: head.room.state.economy.tick,
            revision: head.revision,
            frozenAtMs: Date.now(),
            unsettledCommands: store
              .protocol!.inspect()
              .operations.filter(
                (row) =>
                  row.room_epoch === store.protocol!.currentEpoch(roomId) &&
                  row.state === "accepted",
              ).length,
            participants: [],
          }),
        ),
      );
    } finally {
      store.close();
    }
    return;
  }
  const port = Number(args.get("port") ?? 4300);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("Invalid listen port");
  const service = await createGameOnlyServer({
    store: database,
    access: get("access"),
    ...(args.has("clock")
      ? { clock: args.get("clock") as GameOnlyServerOptions["clock"] & string }
      : {}),
    ...(args.has("checkpoint-directory")
      ? { checkpointDirectory: args.get("checkpoint-directory")! }
      : {}),
    ...(args.has("remote-deadline-ms")
      ? { remoteDeadlineMs: Number(args.get("remote-deadline-ms")) }
      : {}),
    ...(args.has("restore-marker")
      ? { restoreMarker: args.get("restore-marker")! }
      : {}),
    onClockError: (error) =>
      console.error(
        error instanceof Error ? error.message : "Game clock failed",
      ),
  });
  try {
    const address = await service.listen(port, args.get("host") ?? "127.0.0.1");
    console.log(
      JSON.stringify({
        service: "game-only",
        host: address.address,
        port: address.port,
        roomId: service.authority.roomId,
        roomEpoch: service.authority.roomEpoch,
      }),
    );
  } catch (error) {
    await service.close();
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void service.close().catch((error) => {
        console.error(
          error instanceof Error ? error.message : "Shutdown failed",
        );
        process.exitCode = 1;
      });
    });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void runGameOnlyServerCli().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Game-only server failed",
    );
    process.exitCode = 1;
  });
}
