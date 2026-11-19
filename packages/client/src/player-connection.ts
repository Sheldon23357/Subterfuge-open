import {DISPATCH_LOCK_MESSAGE} from '../../contracts/src/index.js';
import {cancellationToken,collateralScheduleIds,collateralSchedules,manualCommandError} from './manual-command-feedback.js';
import type {
  QueuedOrderView,
  PlayerObservation,
  PlayerMapView,
  ChatMessage,
  ChatConversation,
  PlayerFinalStandings,
  PlayerIntelStatistics,
  PlayerNotification,
  PlayerLobbyView,
  PlayerLobbyEvent,
  CommanderThread,
  ProtocolOwnerCommanderView,
} from "../../contracts/src/index.js";
import {commanderSnapshotIsCurrent,type CommanderAction} from './commander-chat-model.js';
import { playerLobbyGameSeat } from "../../contracts/src/index.js";
export class PlayerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly observation?: PlayerObservation,
    readonly lobby?: PlayerLobbyView,
    readonly code?: string,
    readonly cancelledScheduleIds?: string[],
    readonly cancellationToken?: string,
    readonly cancelledSchedules?: QueuedOrderView[],
  ) {
    super(message);
  }
}
export class PlayerConnection {
  private lifecycle: boolean | undefined;
  private commanderView:ProtocolOwnerCommanderView|null=null;
  constructor(private token: string,private baseUrl?:string) {}
  async commander(action:CommanderAction,data?:unknown,signal?:AbortSignal):Promise<CommanderThread>{
    let body=data;
    if(action==='confirm'){
      const input=data as {proposalId?:unknown;version?:unknown}|undefined,view=this.commanderView;
      const proposal=view?.proposals.find(p=>p.proposalId===input?.proposalId&&p.baseVersion===String(input?.version));
      if(!view||!proposal)throw Error('Review the current commander proposal before confirming');
      body={roomEpoch:view.scope.roomEpoch,proposalId:proposal.proposalId,baseVersion:proposal.baseVersion,contentDigest:proposal.contentDigest};
    }
    const value=await this.request<ProtocolOwnerCommanderView>(action==='list'?'/player/v2/owner/commander':`/player/v2/owner/commander/${action}`,action==='list'?undefined:body,signal);
    if(!value?.scope||!value.thread||value.scope.roomId!==value.thread.roomId||!Array.isArray(value.thread.messages)||!Array.isArray(value.proposals))throw Error('Invalid commander response');
    const previous=this.commanderView;
    if(previous&&(previous.scope.serverId!==value.scope.serverId||previous.scope.roomId!==value.scope.roomId||previous.scope.playerId!==value.scope.playerId||previous.thread.player!==value.thread.player))throw Error('Commander identity changed');
    if(!previous||commanderSnapshotIsCurrent(previous.thread,value.thread))this.commanderView=value;
    return value.thread;
  }
  async request<T>(
    path: string,
    data?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if(!path.startsWith('/player/v2/')&&!path.startsWith('/lobby/v2')&&!path.startsWith('/ai/v2'))throw new Error('Only v2 player, lobby and AI protocol paths are supported.');
    const target=this.baseUrl?new URL(path,this.baseUrl).toString():path;
    const response = await fetch(target, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      ...(signal ? { signal } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new PlayerRequestError(
        (result.code==='DISPATCH_SOURCE_LOCKED'?DISPATCH_LOCK_MESSAGE:manualCommandError(result.code,response.status)) ?? (typeof result.safeMessage==='string'?result.safeMessage:undefined) ?? (response.status === 401
          ? "加入码已失效，请重新连接。"
          : response.status === 409
            ? "局势已更新，请确认后重试。"
            : "指令未生效，请检查单位状态、资源和执行时间。"),
        response.status,
        result.observation,
        result.lobby,
        typeof result.code === "string" ? result.code : undefined,
        collateralScheduleIds(result.cancelledScheduleIds) ?? undefined,
        cancellationToken(result.cancellationToken) ?? undefined,
        collateralSchedules(result.cancelledSchedules,collateralScheduleIds(result.cancelledScheduleIds)) ?? undefined,
      );
    return result as T;
  }
  observe(signal?: AbortSignal) {
    return this.request<PlayerObservation>(
      "/player/v2/owner/observation",
      undefined,
      signal,
    );
  }
  lobby(signal?: AbortSignal) {
    return this.request<PlayerLobbyView>("/lobby/v2", undefined, signal);
  }
  lobbyCommand(
    kind: "join" | "leave" | "cancel" | "start",
    id: string,
    revision: number,
  ) {
    return this.request<PlayerLobbyView>("/lobby/v2/commands", {
      kind,
      id,
      revision,
    });
  }
  lobbyEvents(after: number, signal?: AbortSignal) {
    return this.request<{
      roomId: string;
      events: PlayerLobbyEvent[];
      nextCursor: number;
      hasMore: boolean;
    }>(`/lobby/v2/events?after=${after}&limit=100`, undefined, signal);
  }
  /** Probe once for older direct game listeners. A lifecycle listener can deny
   * world access while still accepting the original credential in its lobby. */
  async session(
    signal?: AbortSignal,
  ): Promise<{
    lobby: PlayerLobbyView | null;
    observation: PlayerObservation | null;
  }> {
    if (this.lifecycle === false)
      return { lobby: null, observation: await this.observe(signal) };
    let lobby: PlayerLobbyView;
    try {
      lobby = await this.lobby(signal);
      this.lifecycle = true;
    } catch (error) {
      if (error instanceof PlayerRequestError && error.status === 404) {
        this.lifecycle = false;
        return { lobby: null, observation: await this.observe(signal) };
      }
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const seat = playerLobbyGameSeat(lobby);
      if (seat === null) return { lobby, observation: null };
      let observation: PlayerObservation;
      try {
        observation = await this.observe(signal);
      } catch (error) {
        if (
          error instanceof PlayerRequestError &&
          [400, 401].includes(error.status) &&
          attempt === 0
        ) {
          lobby = await this.lobby(signal);
          continue;
        }
        throw error;
      }
      const count =
        lobby.status === "waiting"
          ? lobby.capacity
          : lobby.occupied.filter(Boolean).length;
      if (
        observation.roomId === lobby.roomId &&
        observation.view.player === seat &&
        observation.view.playerCount === count
      )
        return { lobby, observation };
      // Start may compact seats between these reads; never install the old
      // waiting-seat identity beside a newly generated game world.
      lobby = await this.lobby(signal);
    }
    throw Error("房间状态已更新，请稍后重试。");
  }
  notifications(after: number, signal?: AbortSignal) {
    return this.request<{
      roomId: string;
      notifications: PlayerNotification[];
      nextCursor: number;
      hasMore: boolean;
    }>(`/player/v2/owner/notifications?after=${after}&limit=200`, undefined, signal);
  }
  standings() {
    return this.request<PlayerFinalStandings>("/player/v2/owner/standings");
  }
  order(action: unknown, id: string, revision: string, issueTick?: number) {
    return this.request<PlayerObservation>("/player/v2/owner/commands",{kind:issueTick===undefined?'order':'schedule',clientCommandId:id,expectedRevision:revision,payload:{action},...(issueTick===undefined?{}:{issueTick})});
  }
  async cancel(id: string, revision: string, confirmCancelledScheduleIds?: string[], confirmCancellationToken?: string) {
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([id,revision])));
    const clientCommandId='cancel-'+Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
    return this.request<PlayerObservation>("/player/v2/owner/commands",{kind:'cancel-schedule',clientCommandId,expectedRevision:revision,payload:{id,...(confirmCancelledScheduleIds&&confirmCancellationToken?{confirmCancelledScheduleIds,confirmCancellationToken}:{})}});
  }
  async history(tick: number, signal?: AbortSignal) {
    const observation=await this.observe(signal);
    return this.request<{
      roomId: string;
      tick: number;
      secondsSinceLastTick: number;
      view: PlayerMapView;
      intel: PlayerIntelStatistics[];
    }>("/player/v2/owner/queries/history",{expectedRevision:observation.revision,payload:{tick}},signal);
  }
  chat(after: number) {
    return this.request<{
      roomId: string;
      messages: ChatMessage[];
      nextCursor: number;
      hasMore: boolean;
    }>(`/player/v2/owner/chat?after=${after}&limit=200`);
  }
  conversations() {
    return this.request<{ roomId: string; conversations: ChatConversation[] }>(
      "/player/v2/owner/chat/conversations",
    );
  }
  markChatSeen(conversation: string, through: number) {
    return this.request<{ roomId: string; conversations: ChatConversation[] }>(
      "/player/v2/owner/chat/seen",
      { conversation, through },
    );
  }
  sendChat(id: string, to: ChatMessage["to"], text: string) {
    return this.request("/player/v2/owner/chat", { id, to, text });
  }
}
