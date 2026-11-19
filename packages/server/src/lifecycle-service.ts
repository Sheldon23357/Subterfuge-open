import {readJsonBody} from './json-body.js';
import { CommanderStore } from "./commander-store.js";
import { DurablePlayerControl } from "./durable-player-control.js";
import { PlayerProtocolCoordinator } from "./player-protocol-coordinator.js";
import type { PlayerProtocolHost } from "./player-protocol-api.js";
import { realtimeSeconds } from "./realtime.js";
import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import {
  generateOriginalMap,
  hasGameplayMapComposition,
  applyGameplayMapComposition,
} from "../../engine/src/index.js";
import { PlayerAccess, SerialExecutor } from "./player-access.js";
import { submitLobbyMembership } from "./waiting-lobby.js";
import { createHash } from "node:crypto";
import { createLobbyApi } from "./lobby-api.js";
import { createPlayerApi } from "./player-api.js";
import type { LobbyStore } from "./lobby-store.js";
import { ChatStore } from "./chat.js";
import { NotificationRuntime } from "./notification-runtime.js";
import type { NotificationScheduleStore } from "./notification-schedule-store.js";
import type { LobbyAi } from "./ai-lobby.js";

export function createLifecycleService(
  store: LobbyStore,
  options: {
    commander?: CommanderStore;
    ai?: LobbyAi;
    now?: () => number;
    webRoot?: string;
    chat?: () => ChatStore;
    notifications?: NotificationScheduleStore;
    selectSeed?: (players: number) => Promise<number>;
    onClockError?: (error: unknown) => void;
  } = {},
) {
  const serial = new SerialExecutor(),
    now = options.now ?? Date.now;
  const load = () => {
    const snapshot = store.current();
    if (!snapshot) throw Error("Lobby unavailable");
    return snapshot;
  };
  const currentRoom = (snapshot = load()) => {
    const room = snapshot.runtime?.room ?? snapshot.waitingRoom;
    if (!room) throw Error("Waiting world unavailable");
    return room;
  };
  const roomId = () => load().lobby.access.roomId;
  const seconds = () => {
    const snapshot = load();
    return snapshot.runtime
      ? realtimeSeconds(currentRoom(snapshot), snapshot.runtime.syncedAtMs)
      : 0;
  };
  const chatIdentity = (player: number) => {
    const snapshot = load();
    return {
      player:
        snapshot.start?.prepared.seatMapping.find(
          (seat) => seat.gameSeat === player,
        )?.lobbySeat ?? player,
      count: snapshot.lobby.seats.length,
    };
  };
  store.observeTick();
  const repository = store.protocol;
  // One process incarnation, before any request, model tick, or timer starts.
  repository.startAuthority(
    roomId(),
    currentRoom().state.economy.players.length,
  );
  const control = new DurablePlayerControl(repository);
  options.ai?.setControl(control);
  const chat = options.chat?.() ?? new ChatStore(),
    commander = options.commander ?? new CommanderStore();
  const coordinator = new PlayerProtocolCoordinator(repository, {
    roomId,
    load: currentRoom,
    seconds,
    chatIdentity,
  });
  const phaseDocument = () =>
    repository.domainDocument(
      () => repository.currentEpoch(roomId()),
      "lifecycle",
      "phase",
    );
  const phase = (snapshot: ReturnType<typeof load>) =>
    JSON.stringify({
      format: "lifecycle-protocol-phase/1",
      startId: snapshot.start?.id ?? null,
    });
  const committed = (snapshot: ReturnType<typeof load>) => {
    const previous = phaseDocument().read(),
      next = phase(snapshot);
    // This marker is transactional SQL, not an in-memory lastStarted flag.
    // A full-roster start also invalidates the waiting epoch and its grants.
    let changed = false;
    if (previous !== null) {
      const saved: unknown = JSON.parse(previous);
      if (
        !saved ||
        typeof saved !== "object" ||
        Array.isArray(saved) ||
        Object.keys(saved).sort().join(",") !== "format,startId" ||
        !("format" in saved) ||
        saved.format !== "lifecycle-protocol-phase/1" ||
        !("startId" in saved) ||
        (saved.startId !== null &&
          (typeof saved.startId !== "string" ||
            !saved.startId.length ||
            saved.startId.length > 128))
      )
        throw Error("Invalid lifecycle protocol phase");
      changed = saved.startId !== (snapshot.start?.id ?? null);
    }
    coordinator.worldCommitted(currentRoom(snapshot), {
      reset: changed,
      ...(changed && snapshot.start
        ? { seatMapping: snapshot.start.prepared.seatMapping }
        : {}),
    });
    const document = phaseDocument();
    if (document.read() === null) document.initialize(next, null);
    else document.transact(() => ({ payload: next, result: undefined }));
  };
  let initialized = false;
  const removeCommitObserver = store.onCommit((snapshot) => {
    if (!initialized) throw Error("Lifecycle service is still initializing");
    committed(snapshot);
  });
  const ready = (async () => {
    // Never load the old JSON before binding: existing SQL must win even if
    // a leftover file is stale, corrupt, or unreadable.
    await coordinator.bindDomains(chat, commander);
    repository.atomic(() => committed(load()));
    initialized = true;
  })().catch((error) => {
    removeCommitObserver();
    throw error;
  });
  // The public ready promise still rejects; keep startup failure handled even
  // if the caller listens first and relies on the guarded request boundary.
  void ready.catch(() => {});
  const notifications = options.notifications
    ? new NotificationRuntime(options.notifications)
    : undefined;
  const refreshNotifications = () => {
    const current = store.current();
    if (
      notifications &&
      current?.start &&
      current.runtime?.status !== "starting" &&
      current?.runtime
    )
      notifications.refresh(
        current.start.prepared.access.roomId,
        current.runtime.room,
        current.runtime.syncedAtMs,
      );
  };
  const sync = async () => {
    await ready;
    const current = store.current();
    if (current?.start) await store.sync(now(), current.revision);
    store.advanceTurn(now());
    refreshNotifications();
  };
  const lobby = createLobbyApi(store, {
    serial,
    sync,
    start: async (id, player, revision) => {
      const current = store.current();
      if (!current?.waitingRoom || current.revision !== revision)
        throw Error("Waiting world unavailable or stale");
      const count = current.lobby.seats.filter((s) => s === 1).length;
      // Local host selects a valid seed; the original start transition itself
      // consumes precisely that seed. No client-provided world or seed is accepted.
      const seed =
        current.start?.seed ??
        (count === current.lobby.seats.length
          ? (current.waitingRoom.map?.seed ?? 4300)
          : options.selectSeed
            ? await options.selectSeed(count)
            : (
                await generateOriginalMap(
                  count,
                  randomInt(0, 0xffffffff - 499),
                  () => new Promise((resolve) => setImmediate(resolve)),
                  hasGameplayMapComposition,
                  applyGameplayMapComposition,
                )
              ).seed);
      store.commitStart(
        current.waitingRoom,
        { id, player, seed, startedAtMs: now() },
        revision,
      );
    },
  });
  const protocol: PlayerProtocolHost = {
    repository,
    get roomId() {
      return roomId();
    },
    serial,
    sync,
    // Fresh SQLite reads are essential while settleCommand owns an outer tx.
    load: () => {
      const snapshot = load();
      return { room: currentRoom(snapshot), revision: snapshot.revision };
    },
    commit: (room, revision) => store.commitRoom(room, revision),
    seconds,
    ownerIdentity: (authorization) => {
      const snapshot = load(),
        access = new PlayerAccess(
          snapshot.start?.prepared.access ?? snapshot.lobby.access,
        ),
        player = access.identity(authorization);
      return player === null ? null : { roomId: access.roomId, player };
    },
    canObserve: (player) => {
      const snapshot = load();
      return (
        Number.isInteger(player) &&
        player >= 0 &&
        player < currentRoom(snapshot).state.economy.players.length &&
        (!!snapshot.start ||
          (snapshot.lobby.status === "waiting" &&
            snapshot.lobby.seats[player] === 1 &&
            !!snapshot.waitingRoom))
      );
    },
    canControl: () => !!load().start,
    identity: (player) => {
      const snapshot = load(),
        identity = chatIdentity(player);
      return {
        gamePlayer: player,
        lobbySeat: identity.player,
        chatPlayer: identity.player,
        chatCount: identity.count,
        roster:
          snapshot.start?.prepared.seatMapping.map((seat) => ({
            chatPlayer: seat.lobbySeat,
            gamePlayer: seat.gameSeat,
          })) ??
          snapshot.lobby.seats.map((_, seat) => ({
            chatPlayer: seat,
            gamePlayer: seat,
          })),
      };
    },
    tickTimes:(after,limit)=>store.tickTimes(after,limit),
    capabilities: () => coordinator.capabilities(),
    snapshot: (player) => coordinator.snapshot(player),
    instructionsVersion: (player) => coordinator.instructionsVersion(player),
    chat: () => chat,
    commander,
  };
  const players = createPlayerApi({
    protocol,
    ...(options.webRoot ? { webRoot: options.webRoot } : {}),
  });
  const server = createServer((req, res) => {
    void (async () => {
      await ready;
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      ) {
        res
          .writeHead(403, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Browser origin not enabled" }));
        return;
      }
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (path === "/ai/v2" && options.ai) {
        options.ai.api.emit("request", req, res);
        return;
      }
      if(path==='/lobby/v2/turn'){
        const send=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(data));};
        const initial=load(),owner=new PlayerAccess(initial.lobby.access).identity(req.headers.authorization);if(owner===null){send(401,{error:'Unauthorized'});return;}
        if(req.method!=='GET'&&req.method!=='POST'){send(405,{error:'Method not allowed'});return;}
        let body:{tick:number;ready:boolean}|undefined;
        if(req.method==='POST'){try{const raw=await readJsonBody(req,256) as Record<string,unknown>;if(!raw||Object.keys(raw).length!==2||!Number.isSafeInteger(raw.tick)||Number(raw.tick)<0||typeof raw.ready!=='boolean')throw Error();body=raw as typeof body;}catch{send(400,{error:'Invalid readiness'});return;}}
        await serial.run(async()=>{await sync();const current=load(),self=current.start?.prepared.seatMapping.find(s=>s.lobbySeat===owner)?.gameSeat;
          if(self===undefined||current.runtime?.status!=='in-progress'||current.runtime.room.timing?.mode!=='turn-based'){send(409,{error:'回合尚未开始或已结束'});return;}
          try{if(body){store.setTurnReady(self,body.tick,body.ready);await sync();}send(200,{...store.turnPlayers(),self});}catch{send(409,{error:'回合或控制权已变化，请刷新后重试'});}
        });return;
      }
      (path === "/lobby/v2" ||
      path === "/lobby/v2/commands" ||
      path === "/lobby/v2/events"
        ? lobby
        : players
      ).emit("request", req, res);
    })().catch(() => {
      if (!res.headersSent)
        res
          .writeHead(503, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(JSON.stringify({ error: "Lifecycle unavailable" }));
      else res.end();
    });
  });
  // The nested player server owns SSE clients and query workers even though
  // this outer server owns the listening socket. Release them before waiting
  // for the outer server's connections to close.
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    players.close();
    return close(callback);
  }) as typeof server.close;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let timer: ReturnType<typeof setInterval> | undefined,
    busy = false;
  const stopClock = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const synchronize = () => serial.run(sync);
  const startClock = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void synchronize()
        .catch((error) => {
          if (options.onClockError) options.onClockError(error);
          else console.error("Lifecycle clock synchronization failed");
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
    timer.unref();
  };
  server.once("close", () => {
    stopClock();
    removeCommitObserver();
  });
  return {
    server,
    ready,
    synchronize,
    startClock,
    stopClock,
    drain: () =>
      serial.run(async () => {
        await ready;
      }),
    claimSeat: (key: string, host = false, requestedSeat?: number) => serial.run(async () => {
      await ready;
      const current = load();
      const hash = createHash("sha256").update(key).digest("hex");
      return repository.atomic(() => {
        const claims = Object.fromEntries(store.hubClaims().map(c => [c.hash,c.seat]));
        if(requestedSeat!==undefined&&(!Number.isInteger(requestedSeat)||requestedSeat<1||requestedSeat>=current.lobby.seats.length))throw Error("席位无效。");
        let seat = claims[hash];
        if(seat!==undefined&&requestedSeat!==undefined&&seat!==requestedSeat)throw Error("加入凭据与席位不符。");
        if (seat === undefined) {
          if (current.start || current.lobby.status !== "waiting") throw Error("房间已开始或已关闭，无法加入。");
          seat = host ? 0 : requestedSeat ?? current.lobby.seats.findIndex((state, i) => i > 0 && state === 0 && !Object.values(claims).includes(i));
          if (seat < 0 || current.lobby.seats[seat] !== 0 || Object.values(claims).includes(seat)) throw Error("房间已满。");
          claims[hash] = seat;
          const next = submitLobbyMembership(current.lobby, {id: `hub-${hash}`, player: seat, kind: "join"});
          store.commit(next, current.revision);
          store.claimHubSeat(hash, seat);
        } else if (!current.start && current.lobby.status === "waiting" && current.lobby.seats[seat] === 0) {
          store.commit(submitLobbyMembership(current.lobby,{id:`hub-return-${hash}-${current.revision}`,player:seat,kind:'join'}),current.revision);
        }
        return {player: seat, playerToken: current.lobby.access.credentials[seat]!.token, roomId: roomId()};
      });
    }),
  };
}
