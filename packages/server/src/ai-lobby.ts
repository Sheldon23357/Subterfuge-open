import type {PlayerControl} from './player-control.js';
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  AiStore,
  SeatRunner,
  PlayerGateway,
  CodexProvider,
  initialState,
  resumeSeatState,
  validateSettings,
  type AgentProvider,
  type AiState,
} from "../../ai/src/index.js";
import { PlayerAccess } from "./player-access.js";
import { submitLobbyMembership } from "./waiting-lobby.js";
import type { LobbyStore } from "./lobby-store.js";
import { AI_CONCURRENCY } from './ai-concurrency.js';

/** Host controls bot seats; Codex receives only the seat-scoped HTTP projection. */
export class LobbyAi {
  private control?:PlayerControl;
  setControl(control:PlayerControl){this.control=control;}
  /** Control projection uses authenticated game-seat mapping, never client input. */
  hostedActive(roomId:string,player:number){
    const current=this.lobby.load();
    if(!current)return false;
    const access=current.start?.prepared.access??current.lobby.access;
    if(access.roomId!==roomId)return false;
    const seat=current.start?current.start.prepared.seatMapping.find(m=>m.gameSeat===player)?.lobbySeat:player;
    if(seat===undefined)return false;
    const entry=this.runners.get(seat);
    const state=(entry?.gameRoom===roomId?entry.runner.state:undefined)??this.storage.load(current.lobby.access.roomId,seat);
    return !!state?.enabled&&state.status!=="ended";
  }
  externalControl(roomId:string,player:number){
    const current=this.lobby.load();
    if(!current||current.start?.prepared.access.roomId!==roomId)return;
    const seat=current.start.prepared.seatMapping.find(m=>m.gameSeat===player)?.lobbySeat;
    if(seat===undefined)return;
    const live=this.runners.get(seat)?.runner,stored=this.storage.load(current.lobby.access.roomId,seat);
    if(live){if(live.state.enabled||live.running||!["paused","ended"].includes(live.state.status)||stored?.enabled)live.pause();}
    else if(stored&&(stored.enabled||!["paused","ended"].includes(stored.status))){stored.enabled=false;if(stored.status!=="ended")stored.status="paused";this.storage.save(stored,"paused");}
  }
  private runners = new Map<number, { runner: SeatRunner; gameRoom: string }>();
  private active = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private baseUrl = "";
  readonly api;
  constructor(
    private lobby: LobbyStore,
    private storage: AiStore,
    private provider: AgentProvider = new CodexProvider(),
  ) {
    this.api = createServer((req, res) => {
      void (async () => {
        const send = (status: number, value: unknown) => {
          res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(value));
        };
        try {
          const url = new URL(req.url ?? "/", "http://local");
          if (url.pathname !== "/ai/v2" || url.search) {
            send(404, { error: "Not found" });
            return;
          }
          if (
            req.headers.origin &&
            req.headers.origin !== `http://${req.headers.host}`
          ) {
            send(403, { error: "Origin rejected" });
            return;
          }
          let current = this.lobby.load();
          if (!current) {
            send(503, { error: "Lobby unavailable" });
            return;
          }
          const identity = new PlayerAccess(current.lobby.access).identity(
            req.headers.authorization,
          );
          if (identity !== 0) {
            send(identity === null ? 401 : 403, {
              error: "Only the host can manage AI",
            });
            return;
          }
          if (req.method === "GET") {
            send(200, this.status());
            return;
          }
          if (req.method !== "POST") {
            send(405, { error: "Method not allowed" });
            return;
          }
          let body = "";
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 4096) throw Error("Request too large");
          }
          const value = JSON.parse(body);
          current = this.lobby.load();
          if (
            !current ||
            new PlayerAccess(current.lobby.access).identity(
              req.headers.authorization,
            ) !== 0
          )
            throw Error("Session changed");
          if (
            !value ||
            typeof value !== "object" ||
            !Number.isSafeInteger(value.seat) ||
            value.seat < 1 ||
            value.seat >= current.lobby.seats.length
          )
            throw Error("请选择有效的非房主席位。");
          if (
            Object.keys(value).some(
              (k) => !["action", "seat", "settings"].includes(k),
            )
          )
            throw Error("Invalid AI command");
          const room = current.lobby.access.roomId,
            seat = value.seat;
          const stored = this.storage.load(room, seat),
            live = this.runners.get(seat)?.runner;
          if (value.action === "add") {
            if (
              current.start ||
              current.lobby.status !== "waiting" ||
              current.lobby.seats[0] !== 1 ||
              current.lobby.seats[seat] === 1 ||
              stored
            )
              throw Error("只能在等待大厅中向空席位添加AI。");
            const state = initialState(
              room,
              seat,
              validateSettings(value.settings),
            );
            const next = submitLobbyMembership(current.lobby, {
              id: `ai-join-${randomUUID()}`,
              player: seat,
              kind: "join",
            });
            this.lobby.commit(next, current.revision);
            this.storage.save(state, "configured");
          } else if (value.action === "pause") {
            if (!stored) throw Error("AI席位不存在。");
            if (live) live.pause();
            else {
              stored.enabled = false;
              stored.status = "paused";
              this.storage.save(stored, "paused");
            }
          } else if (value.action === "resume") {
            if (
              !stored ||
              live?.running ||
              current.lobby.seats[seat] !== 1 ||
              current.runtime?.status === "ended" ||
              current.lobby.status === "cancelled"
            )
              throw Error("AI暂时不能恢复，请稍后重试。");
            const gameSeat=current.start?.prepared.seatMapping.find(m=>m.lobbySeat===seat)?.gameSeat;
            if(gameSeat!==undefined&&this.control?.isExternal(current.start!.prepared.access.roomId,gameSeat))throw Error("External controller owns seat");
            const state = live?.state ?? stored;
            if (value.settings !== undefined)
              state.settings = validateSettings(value.settings);
            resumeSeatState(state,state.status==='error'||state.error!==null?0:state.nextReview);
            this.storage.save(state, "resumed");
            // Recreate the runner so changed settings and trigger state take effect.
            this.runners.delete(seat);
          } else throw Error("Unknown AI command");
          send(200, this.status());
        } catch (e) {
          send(400, {
            error:
              e instanceof Error && /^[\u4e00-\u9fff]/.test(e.message)
                ? e.message
                : "AI配置未生效，请检查席位和参数。",
          });
        }
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }
  status() {
    const current = this.lobby.load()!;
    return {
      roomId: current.lobby.access.roomId,
      provider: this.provider.constructor.name.replace(/Provider$/, '').toLowerCase(),
      concurrency: AI_CONCURRENCY,
      seats: this.storage.list(current.lobby.access.roomId).map((s) => ({
        seat: s.lobbySeat,
        gameSeat:
          current.start?.prepared.seatMapping.find(
            (m) => m.lobbySeat === s.lobbySeat,
          )?.gameSeat ?? null,
        enabled: s.enabled,
        status: s.status,
        recovering:this.runners.get(s.lobbySeat)?.runner.recovering??false,
        error: s.error,
        settings: s.settings,
        calls: s.calls,
        tokens: s.tokens,
        lastThought: s.lastThought,
        nextReview: s.nextReview,
      })),
    };
  }
  start(baseUrl: string) {
    if (this.timer) return;
    this.baseUrl = baseUrl;
    // Interrupted decisions are never silently replayed after process restart.
    const current = this.lobby.load();
    if (current)
      for (const state of this.storage.list(current.lobby.access.roomId))
        if (state.status === "thinking") {
          state.status = "error";
          state.enabled = false;
          state.error = "上次决策被中断，请检查局势后手动恢复。";
          this.storage.save(state, "interrupted");
        }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* A corrupt store never enables an agent. */
      }
    }, 5000);
    this.timer.unref();
  }
  tick() {
    const current = this.lobby.load();
    if (
      current &&
      (current.runtime?.status === "ended" ||
        current.lobby.status === "cancelled")
    ) {
      for (const saved of this.storage.list(current.lobby.access.roomId)) {
        const runner = this.runners.get(saved.lobbySeat)?.runner;
        if (runner?.running) runner.pause();
        const state = runner?.state ?? saved;
        this.storage.closeSeat(state,state.lastThought??0,current.lobby.status==='cancelled'?'lobby-cancelled':'match-ended');
      }
      return;
    }
    if (!current?.start || current.runtime?.status !== "in-progress") return;
    const seats = this.storage
      .list(current.lobby.access.roomId)
      .sort((a, b) => (a.lastThought ?? -1) - (b.lastThought ?? -1));
    for (const saved of seats) {
      if (
        [...this.runners.values()].filter((e) => e.runner.running).length >= AI_CONCURRENCY
      )
        break;
      if (!saved.enabled || saved.status==='ended'||saved.status==='error'&&!this.runners.get(saved.lobbySeat)?.runner.recovering) continue;
      const gameSeat = current.start.prepared.seatMapping.find(
        (m) => m.lobbySeat === saved.lobbySeat,
      )?.gameSeat;
      if (gameSeat === undefined) continue;
      if(this.control?.isExternal(current.start.prepared.access.roomId,gameSeat)){this.externalControl(current.start.prepared.access.roomId,gameSeat);continue;}
      const room = current.start.prepared.access.roomId;
      let entry = this.runners.get(saved.lobbySeat);
      if (entry && entry.gameRoom !== room) {
        entry.runner.pause();
        this.runners.delete(saved.lobbySeat);
        entry = undefined;
      }
      if (!entry) {
        const token = current.start.prepared.access.credentials.find(
          (c) => c.player === gameSeat,
        )!.token;
        const gateway = new PlayerGateway(
          this.baseUrl,
          token,
          room,
          saved.lobbySeat,
          current.lobby.seats.length,
          current.start.prepared.seatMapping.map((m) => ({
            chatPlayer: m.lobbySeat,
            gamePlayer: m.gameSeat,
          })),
        );
        entry = {
          runner: new SeatRunner(saved, this.storage, gateway, this.provider),
          gameRoom: room,
        };
        this.runners.set(saved.lobbySeat, entry);
      }
      const task = entry.runner.poll();
      this.active.add(task);
      void task.finally(() => this.active.delete(task));
    }
  }
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const { runner } of this.runners.values())
      if (runner.running) runner.pause();
    await Promise.allSettled([...this.active]);
  }
}
