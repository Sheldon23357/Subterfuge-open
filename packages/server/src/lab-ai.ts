import {memoryConsistency} from '../../ai/src/index.js';
import {reconcileCampaigns,type Campaign, AiStore, SeatRunner, PlayerGateway, createProviderFromEnv, initialState, resumeSeatState, validateSettings, type AgentProvider, type AiMemory } from '../../ai/src/index.js';
import { PlayerAccess } from './player-access.js';
import type {ChatStore} from './chat.js';
import type {PlayerControl} from './player-control.js';
import type {LabRoom} from './planning.js';
import { createPlayerApi,observation } from './player-api.js';
import type {PlayerProtocolHost} from './player-protocol-api.js';
import { AI_CONCURRENCY } from './ai-concurrency.js';

const HYBRID_AUTO_EVENT_COALESCE_MS=1_000;

export function validateLabAi(raw: unknown, players: number) {
  if (!Array.isArray(raw) || raw.length > players) throw Error('AI席位配置无效');
  const seen = new Set<number>();
  return raw.map(value => {
    if (!value || Object.keys(value).sort().join(',') !== 'seat,settings' || !Number.isInteger(value.seat) || value.seat < 0 || value.seat >= players || seen.has(value.seat)) throw Error('AI席位配置无效');
    seen.add(value.seat);
    return { seat: value.seat as number, settings: validateSettings(value.settings) };
  });
}

/** Test bots use the same authenticated player API as lobby bots, never the lab API. */
export class LabAi {
  private checkpointLocked=false;
  async prepareCheckpoint(expiresAt:number){
    this.checkpointLocked=true;
    while([...this.runners.values()].some(r=>r.settling)){
      if(Date.now()>=expiresAt)throw Error('等待托管 AI 收尾超时');
      await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    const resume=[...this.runners.values()].filter(r=>r.state.enabled&&r.state.status!=='error'&&r.state.status!=='ended').map(r=>r.state.lobbySeat);
    return resume;
  }
  releaseCheckpoint(_resume:number[]){this.checkpointLocked=false;}
  private advanceInputs:unknown[]=[];
  private advanceEpoch=0;
  /** Room updates replace these references. Chat read marks do not invalidate a check.
   * This opaque token is local scheduler metadata, never model-visible information. */
  private advanceVersion(seat:number) {
    const room=this.host.room();
    const inputs=[this.access,room.state,room.state.economy.tick,room.scheduled,room.scheduledOrders,room.agendaOrder,room.map,room.scenario];
    if(inputs.some((value,i)=>value!==this.advanceInputs[i])){this.advanceInputs=inputs;this.advanceEpoch++;}
    return `${this.advanceEpoch}:${this.host.chat?.().cursorForSeat(seat)??0}`;
  }
  readyToStep(_runId:string,wallMs=Date.now()) {
    if(this.checkpointLocked)return false;
    const tick=this.host.room().state.economy.tick;
    // A paused runner may still be awaiting the receipt of an already submitted write.
    const active=[...this.runners.values()].filter(r=>r.running||r.state.enabled&&r.state.status!=='ended');
    for(const runner of active){
      if(runner.state.status==='error'&&!runner.recovering)throw Error(`第${runner.state.lobbySeat+1}席AI未完成：${runner.state.error??'请检查日志后恢复或暂停该席位'}`);
    }
    const settled=active.every(r=>r.readyToAdvance(tick,this.advanceVersion(r.state.lobbySeat)));
    if(settled)return true;
    // Never await the authenticated player API while holding the room SerialExecutor.
    // A version mismatch refreshes observations without forcing a model decision.
    for(const runner of active)if(!runner.readyToAdvance(tick,this.advanceVersion(runner.state.lobbySeat))){
      const options=!this.host.room().clock?{eventCoalesceMs:HYBRID_AUTO_EVENT_COALESCE_MS}:{};
      void runner.poll(wallMs,false,!runner.running,options);
    }
    return false;
  }
  private runners = new Map<number, SeatRunner>();
  private credentials = PlayerAccess.generate(2);
  private access = new PlayerAccess(this.credentials);
  private baseUrl = '';
  private timer?: ReturnType<typeof setInterval>;
  private api?:ReturnType<typeof createPlayerApi>;
  constructor(private host:{room:()=>LabRoom;protocol?:PlayerProtocolHost;chat?:()=>ChatStore;control?:PlayerControl}, private store: AiStore, private provider: AgentProvider = createProviderFromEnv(),private readonly Runner:typeof SeatRunner=SeatRunner) {
  }
  async start(protocol?:PlayerProtocolHost) {
    protocol??=this.host.protocol;
    if(!protocol)throw Error('托管 AI 需要 v2 玩家协议主机');
    const playerProtocol={...protocol,ownerIdentity:(authorization:unknown)=>{const player=this.access.identity(authorization);return player===null?null:{roomId:this.access.roomId,player};},onExternalControl:(roomId:string,player:number)=>{this.externalControl(roomId,player);protocol.onExternalControl?.(roomId,player);}};
    this.api=createPlayerApi({protocol:playerProtocol});
    await new Promise<void>((resolve, reject) => { this.api!.once('error', reject); this.api!.listen(0, '127.0.0.1', resolve); });
    const address = this.api.address();
    if (!address || typeof address === 'string') throw Error('AI API unavailable');
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    this.reset();
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }
  reset(config: ReturnType<typeof validateLabAi> = [],memorySeeds:Record<number,Partial<AiMemory>>={}) {
    for (const runner of this.runners.values()) runner.pause();
    this.runners.clear();
    const room = this.host.room();
    this.credentials = PlayerAccess.generate(room.state.economy.players.length);
    this.credentials.roomId = room.playerRoomId ?? this.credentials.roomId;
    this.access = new PlayerAccess(this.credentials);
    for (const item of config) {
      const state=initialState(this.access.roomId, item.seat, item.settings),seed=memorySeeds[item.seat];
      if(seed)state.memory={...state.memory,...seed};
      this.store.save(state, 'configured');
    }
    for (const state of this.store.list(this.access.roomId)) {
      // Restart/import never silently resumes interrupted model work.
      const observed=observation(room,state.lobbySeat,this.access.roomId);
      if(!observed.view.self.active||observed.view.match?.ended)this.store.endSeat(state,observed);
      else if (!config.some(c => c.seat === state.lobbySeat)) { state.enabled = false; state.status = 'paused'; this.store.save(state, 'paused'); }
      const token = this.credentials.credentials[state.lobbySeat]?.token;
      if (!token) continue;
      this.runners.set(state.lobbySeat, new this.Runner(state, this.store, Object.assign(new PlayerGateway(this.baseUrl, token, this.access.roomId, state.lobbySeat, this.credentials.credentials.length), {advanceVersion:()=>this.advanceVersion(state.lobbySeat)}), this.provider));
    }
  }
  hostedActive(roomId:string,player:number){
    if(this.access.roomId!==roomId)return false;
    const state=this.runners.get(player)?.state;
    return !!state?.enabled&&state.status!=="ended";
  }
  externalControl(roomId:string,player:number){
    if(this.access.roomId!==roomId)return;
    const runner=this.runners.get(player),stored=this.store.load(roomId,player);
    if(runner&&(runner.state.enabled||runner.running||!["paused","ended"].includes(runner.state.status)||stored?.enabled))runner.pause();
  }
  status() {
    return { concurrency: AI_CONCURRENCY, seats: [...this.runners.values()].map(r => {const s=r.state;return {seat:s.lobbySeat, settings:s.settings, enabled:s.enabled, status:s.status, recovering:r.recovering, error:s.error, calls:s.calls, tokens:s.tokens};}) };
  }
  hasEnabledSeat() {
    if (this.runners.size === 0) return true;
    return [...this.runners.values()].some(r => r.state.enabled && r.state.status !== 'ended');
  }
  command(raw: {seat:number;action:string;settings?:unknown}) {
    if(this.checkpointLocked)throw Error('联动存档进行中');
    const runner = this.runners.get(raw.seat);
    if (!runner) throw Error('AI席位不存在');
    if (raw.action !== 'pause'&&this.host.control?.isExternal(this.access.roomId,raw.seat))throw Error('External controller owns seat');
    if (raw.action === 'pause') runner.pause();
    else if ((raw.action === 'resume'||raw.action==='review') && !runner.running && runner.state.status !== 'ended') {
      if(raw.settings!==undefined)runner.state.settings=validateSettings(raw.settings);
      if(runner.state.status==='error'||runner.state.error!==null)runner.state.nextReview=0;
      else if(raw.action==='review')runner.state.nextReview=0;
      else runner.state.nextReview=null;
      resumeSeatState(runner.state,runner.state.nextReview);
      this.store.save(runner.state, 'resumed');
      if(raw.action==='review')runner.requestMemoryReview();
    } else throw Error('AI当前无法执行该操作');
    this.advanceEpoch++;
    return this.status();
  }
  resumeAll() {
    if(this.checkpointLocked)throw Error('联动存档进行中');
    for (const runner of this.runners.values()) {
      if (runner.state.status === 'ended'||this.host.control?.isExternal(this.access.roomId,runner.state.lobbySeat)) continue;
      resumeSeatState(runner.state,runner.state.status==='error'||runner.state.error!==null?0:runner.state.nextReview);
      this.store.save(runner.state, 'resumed');
    }
    this.advanceEpoch++;
  }
  history(seat:number,before?:number,includeScreening=false) {
    if(!Number.isSafeInteger(seat)||seat<0||seat>=this.credentials.credentials.length)throw Error('无效席位');
    const state=this.runners.get(seat)?.state;
    const savedCampaigns=includeScreening?this.store.latest<{plans:Campaign[]}>(this.access.roomId,seat,'campaign-state'):null;
    const room=this.host.room(),o=observation(room,seat,this.access.roomId);
    const campaigns=savedCampaigns?{plans:reconcileCampaigns(savedCampaigns.plans,o)}:null;
    const consistency=state?memoryConsistency(state.memory,{observation:o,notebook:this.store.notebook(this.access.roomId,seat,o.view.tick*600),campaigns:this.store.latest<{plans:Campaign[]}>(this.access.roomId,seat,'campaign-state')?.plans??[],chat:[],notifications:[],chatCursor:0,notificationCursor:0,chatPlayer:seat,chatCount:this.credentials.credentials.length},this.store.memoryReviews(this.access.roomId,seat)):null;
    return {memoryConsistency:consistency,roomId:this.access.roomId,seat,...(includeScreening?{screening:this.store.latest(this.access.roomId,seat,'attack-screening'),campaigns} : {}),agent:state?{status:state.status,settings:state.settings,calls:state.calls,tokens:state.tokens,memory:state.memory,lastThought:state.lastThought,sequence:state.sequence,error:state.error,notebook:this.store.notebook(this.access.roomId,seat,room.state.economy.tick*600)}:null,failure:state?.status==='error'?this.store.latest(this.access.roomId,seat,'error'):null,deferred:this.store.latest<{deferred:unknown[]}>(this.access.roomId,seat,'wake-state')?.deferred??[],...this.store.decisionPage(this.access.roomId,seat,before)};
  }
  tick() {
    if(this.checkpointLocked)return;
    const runners = [...this.runners.values()].sort((a,b)=>(a.state.lastThought??-1)-(b.state.lastThought??-1));
    for (const runner of runners) {
      if (runners.filter(r => r.running).length >= AI_CONCURRENCY) break;
      if(this.host.control?.isExternal(this.access.roomId,runner.state.lobbySeat)){if(runner.state.enabled)runner.pause();continue;}
      void runner.poll();
    }
  }
  async stop() {
    clearInterval(this.timer);
    for (const runner of this.runners.values()) runner.pause();
    if(this.api)await new Promise<void>(resolve => this.api!.close(() => resolve()));
  }
}
