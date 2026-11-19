import {DispatchSourceLocked} from './dispatch-guard.js';
import {manualCommandView,ManualCommandConflict} from './manual-commands.js';
import {applyCoordinatedOrder,applyCoordinatedCancellation} from './player-commands.js';
import {DurablePlayerControl} from './durable-player-control.js';
import {PlayerProtocolCoordinator} from './player-protocol-coordinator.js';
import {PlayerProtocolError} from './player-protocol-auth.js';
import type {PlayerProtocolHost} from './player-protocol-api.js';
import {CommanderStore} from './commander-store.js';
import {controllerSlots,validateControllerBindings,saveControllerBindings,loadControllerBindings} from './controller-bindings.js';
import {LinkedCheckpoints} from './linked-checkpoints.js';
import {validateImmediateLaunchTime} from './schedule-time.js';
import {PlayerControl} from './player-control.js';
import { readJsonBody } from "./json-body.js";
import {projectGlobalActivity,projectGlobalBattleLosses} from '../../engine/src/index.js';
import {requestDiagnostics,createRequestDiagnosticLog} from './request-diagnostics.js';
import {RoomStore} from './room-store.js';
import type {TickTimeSource} from './tick-times.js';
import {createHash,randomUUID} from 'node:crypto';
import {AiStore,type AiMemory} from '../../ai/src/index.js';
import {LabAi,validateLabAi} from './lab-ai.js';
import {LabAutoAdvance} from './lab-auto-advance.js';
import {catchUpRealtime,startRealtime,realtimeSeconds} from './realtime.js';
import {PlayerAccess,SerialExecutor,loadPlayerAccess,savePlayerAccess} from './player-access.js';
import {createPlayerApi,observation} from './player-api.js';
import {parsePlayerPublicOrigin} from './player-origin.js';
import {createPlayerFrameCache} from './player-forecast.js';
import {createRoomPreviewCache} from './room-preview-cache.js';
import {previewPlayerLaunch} from './player-game-preview.js';
import {labRuleView} from './lab-rule-view.js';
import {scheduleOrder,scheduleIds} from './scheduled-orders.js';
import { outpostMetrics, routeEstimate, fleetControls } from "./inspection.js";
import { createGeneratedRoom,type StartMode,scenarioMessages,scenarioMemory } from "./generated-room.js";
import {
  advanceRoom,
  scheduleLaunch,
  previewLaunch,
  cancelSchedule,
  saveRoom,
  restoreRoom,
  type LabRoom,
} from "./planning.js";
import type { ScheduledLaunch } from "../../contracts/src/index.js";
import { createEightPlayerScenario } from "./eight-player.js";
import { ChatStore } from "./chat.js";
import {observerChatPage} from './observer-chat.js';
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, unlink, access } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import {
  originalOutpostNames,
  fleetStandings,
  fleetPublicIntel,
  createFleetScenario,
  submitFleetOrder,
  advanceFleetScenario,
  saveFleetSnapshot,
  restoreFleetSnapshot,
  exportFleetReplay,
  type FleetOrder,
  type FleetScenario,
} from "../../engine/src/index.js";
import type { LabView } from "../../contracts/src/index.js";

const port = Number(process.env.LAB_PORT ?? 4310);
const devReloadEnabled = process.env.LAB_DEV_RELOAD === "1";
const devReloadClients = new Set<import("node:http").ServerResponse>();
const playerPort=process.env.PLAYER_PORT===undefined?undefined:Number(process.env.PLAYER_PORT);
const publicOrigin=parsePlayerPublicOrigin(process.env.PLAYER_PUBLIC_ORIGIN);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid LAB_PORT');
if(playerPort!==undefined&&(!Number.isInteger(playerPort)||playerPort<1||playerPort>65535||playerPort===port))throw Error('Invalid PLAYER_PORT');
if(process.env.GAME_CLOCK!==undefined&&!['manual','realtime'].includes(process.env.GAME_CLOCK))throw Error('Invalid GAME_CLOCK');
// Fail before touching saves or rotating credentials when another local service
// already owns either listener. Existing running rooms must remain untouched.
for(const [listenerPort,host] of [[port,'127.0.0.1'],...(playerPort===undefined?[]:[[playerPort,process.env.PLAYER_HOST??'127.0.0.1']])] as [number,string][]){
  await new Promise<void>((resolve,reject)=>{const probe=createServer();probe.once('error',reject);probe.listen(listenerPort,host,()=>probe.close(error=>error?reject(error):resolve()));});
}
const root = resolve("packages/client/public"),
  dataDir = resolve(process.env.LAB_DATA_DIR ?? "runtime"),
  save = resolve(dataDir, "browser-eight.json"),
  timelineMarkerFile = resolve(dataDir, "timeline-rewind.json");
type TimelineMarker = {
  format: "timeline-rewind/1";
  revision: number;
  tick: number;
  kind: "import" | "rewind";
};
async function readTimelineMarker(): Promise<TimelineMarker | null> {
  try {
    const marker = JSON.parse(await readFile(timelineMarkerFile, "utf8"));
    if (!marker || typeof marker !== "object" || Array.isArray(marker) ||
      Object.keys(marker).sort().join(",") !== "format,kind,revision,tick" ||
      marker.format !== "timeline-rewind/1" ||
      !["import", "rewind"].includes(marker.kind) ||
      !Number.isSafeInteger(marker.revision) || marker.revision < 1 ||
      !Number.isSafeInteger(marker.tick) || marker.tick < 0)
      throw Error("Invalid timeline rewind marker");
    return marker as TimelineMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeTimelineMarker(marker: TimelineMarker) {
  await writeFile(timelineMarkerFile + ".tmp", JSON.stringify(marker));
  await rename(timelineMarkerFile + ".tmp", timelineMarkerFile);
}
async function clearTimelineMarker() {
  await unlink(timelineMarkerFile).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}
const fresh = createEightPlayerScenario;
await mkdir(dataDir, { recursive: true });
try{await access(resolve(dataDir,'.checkpoint-restore-incomplete'));throw Error('联动存档恢复未完成，请使用完整恢复目录');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const commander=new CommanderStore(resolve(dataDir,'commander-chat.json'));
const requestLog=createRequestDiagnosticLog(resolve(dataDir,'request-diagnostics.jsonl'));
let chat = new ChatStore(resolve(dataDir, "browser-eight-chat.json"));
async function scopedChat(roomId:string){const store=new ChatStore(resolve(dataDir,'player-chat-'+createHash('sha256').update(roomId).digest('hex')+'.json'));return store;}
const roomStore=new RoomStore(resolve(dataDir,'subterfuge.sqlite'));
let refreshedCut:ReturnType<RoomStore['current']>=null;
const storedRoom=roomStore.load();
let storageRevision=storedRoom?.revision??0;
let loadedRoom:LabRoom;
if(storedRoom)loadedRoom=storedRoom.room;
else{
  try{loadedRoom=restoreRoom(await readFile(save,'utf8'));}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
    loadedRoom=process.env.LAB_LEGACY_FIXTURE==='1'?{state:fresh(),scheduled:[]}:await createGeneratedRoom();
  }
  storageRevision=roomStore.commit(loadedRoom,storageRevision);
}
let restoredProtocolFork=false;
const restoredMarker=resolve(dataDir,'checkpoint-restored.json');
try{
 const restored=JSON.parse(await readFile(restoredMarker,'utf8'));
 if(restored.format!=='checkpoint-restored/1'||!Number.isSafeInteger(restored.revision)||!Number.isSafeInteger(restored.frozenAt)||![restored.revision,restored.revision+1].includes(storageRevision))throw Error('Invalid linked checkpoint restore marker');
 if(storageRevision===restored.revision&&loadedRoom.clock){loadedRoom={...loadedRoom,clock:{...loadedRoom.clock,anchorMs:loadedRoom.clock.anchorMs+Date.now()-restored.frozenAt}};storageRevision=roomStore.commit(loadedRoom,storageRevision);}
 restoredProtocolFork=true;
}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
let state = loadedRoom.state;
let map = loadedRoom.map;
let scheduled: ScheduledLaunch[] = loadedRoom.scheduled;
let scheduledOrders=loadedRoom.scheduledOrders;
let manualCoordination=loadedRoom.manualCoordination;
let dispatchLocks=loadedRoom.dispatchLocks;
let agendaOrder=loadedRoom.agendaOrder;
let scenario=loadedRoom.scenario;
let playerRoomId=loadedRoom.playerRoomId;
let clock=loadedRoom.clock;
roomStore.observeTick(storageRevision);
let playerAccess:PlayerAccess|undefined;
const serial=new SerialExecutor();
const playerControl=new DurablePlayerControl(roomStore.protocol!);
let protocolCoordinator:PlayerProtocolCoordinator|undefined;
let synchronizedNow=Date.now();
const remoteDeadlineMs=process.env.PLAYER_REMOTE_DEADLINE_MS===undefined?undefined:Number(process.env.PLAYER_REMOTE_DEADLINE_MS);
if(remoteDeadlineMs!==undefined&&(!Number.isSafeInteger(remoteDeadlineMs)||remoteDeadlineMs<1||remoteDeadlineMs>86400000))throw Error('PLAYER_REMOTE_DEADLINE_MS must explicitly configure a finite 1..86400000 millisecond deadline');
// A saved realtime anchor remains authoritative. Without one, only a new room
// opts into realtime by default; an existing manual/automatic room stays there
// across restarts even when the player API is enabled.
let realtimeEnabled=clock!==undefined||!storedRoom&&(process.env.GAME_CLOCK==='realtime'||process.env.GAME_CLOCK===undefined&&playerPort!==undefined);
const accessPath=resolve(dataDir,'player-access.json');
const room = (): LabRoom => ({ state, scheduled,...(dispatchLocks?{dispatchLocks}:{}),...(manualCoordination?{manualCoordination}:{}),...(clock?{clock}:{}),...(playerRoomId?{playerRoomId}:{}), ...(scheduledOrders?{scheduledOrders}:{}),...(agendaOrder?{agendaOrder}:{}),...(map ? { map } : {}),...(scenario?{scenario}: {}) });
const previewFrame=createPlayerFrameCache();
const previewRoom=createRoomPreviewCache();
async function persistRoom(next:LabRoom,reset=false,source:TickTimeSource='state-write'){
  if(realtimeEnabled&&reset)next=await catchUpRealtime(startRealtime(next,Date.now()),Date.now());
  const credentials=playerPort!==undefined&&reset?PlayerAccess.generate(next.state.economy.players.length):undefined;
  if(credentials)next={...next,playerRoomId:credentials.roomId};
  const nextChat=credentials?await scopedChat(credentials.roomId):undefined;
  storageRevision=roomStore.commit(next,storageRevision,reset,source);
  if(credentials){await savePlayerAccess(accessPath,credentials);playerAccess=new PlayerAccess(credentials);}
  if(nextChat){if(protocolCoordinator)await protocolCoordinator.bindDomains(nextChat,commander);chat=nextChat;}
  state=next.state;map=next.map;scheduled=next.scheduled;scheduledOrders=next.scheduledOrders;manualCoordination=next.manualCoordination;dispatchLocks=next.dispatchLocks;agendaOrder=next.agendaOrder;playerRoomId=next.playerRoomId;clock=next.clock;
  scenario=next.scenario;
}
if(playerPort!==undefined){
  if(!playerRoomId)await persistRoom(room(),true);
  else playerAccess=await loadPlayerAccess(accessPath,state.economy.players.length,playerRoomId);
}
if(playerPort!==undefined)chat=await scopedChat(playerRoomId!);
const protocolRoomId=()=>roomStore.metadata().roomId;
roomStore.protocol!.startAuthority(protocolRoomId(),state.economy.players.length,{fork:restoredProtocolFork});
protocolCoordinator=new PlayerProtocolCoordinator(roomStore.protocol!,{roomId:protocolRoomId,load:()=>roomStore.current()!.room,seconds:()=>realtimeSeconds(roomStore.metadata(),synchronizedNow)});
await protocolCoordinator.bindDomains(chat,commander);protocolCoordinator.refreshWorld();
roomStore.onCommit((next,_revision,reset)=>protocolCoordinator!.worldCommitted(next,{reset}));
if(restoredProtocolFork)await unlink(restoredMarker);

const timelineMarker=await readTimelineMarker();
const trimConfirmed=timelineMarker!==null&&timelineMarker.revision===storageRevision&&timelineMarker.tick===state.economy.tick;
if(timelineMarker&&!trimConfirmed)await clearTimelineMarker();
if(trimConfirmed)await chat.trimToTick(state.economy.tick);
if(realtimeEnabled&&!clock)await persistRoom(startRealtime(room(),Date.now()));
let checkpointPhase:'idle'|'draining'|'frozen'='idle';
let checkpointFrozenAt=0;
async function syncClock(){
  if(checkpointPhase!=='idle')return;
  synchronizedNow=Date.now();
  if(!clock){if(remoteDeadlineMs!==undefined&&!fleetStandings(state).ended){const deadline=roomStore.protocol!.turnDeadline(protocolRoomId(),state.economy.tick,remoteDeadlineMs);if(deadline.remainingMs<=0)await persistRoom(advanceRoom(room(),state.economy.tick+1),false,'automatic');}return;}
  const current=room(),next=await catchUpRealtime(current,synchronizedNow);
  if(next!==current)await persistRoom(next,false,'realtime');
}
await syncClock();
const aiStore=new AiStore(resolve(dataDir,'lab-ai.sqlite'));
if(trimConfirmed&&playerRoomId)aiStore.trimHistoryToTick(playerRoomId,state.economy.tick);
if(trimConfirmed)await clearTimelineMarker();
const labAi = new LabAi({control:playerControl,chat:()=>chat,room},aiStore);
const tickPerformance=createRequestDiagnosticLog<Record<string,unknown>>(resolve(dataDir,'tick-performance.jsonl'),10*1024*1024,false);
let advanceTiming:{tick:number;readinessMs:number;settlementMs:number;persistMs:number;blockedSeats:number[]}={tick:state.economy.tick,readinessMs:0,settlementMs:0,persistMs:0,blockedSeats:[]};
async function advanceAutomatic(){
 const started=Date.now(),next=advanceRoom(room(),state.economy.tick+1);advanceTiming.settlementMs+=Date.now()-started;
 const persistStarted=Date.now();try{await persistRoom(next,false,'automatic');}finally{advanceTiming.persistMs+=Date.now()-persistStarted;}
}
const autoAdvance = new LabAutoAdvance(serial, async runId => {
  advanceTiming={tick:state.economy.tick,readinessMs:0,settlementMs:0,persistMs:0,blockedSeats:[]};
  if(checkpointPhase!=='idle')return;
  if (clock || fleetStandings(state).ended) { autoAdvance.setEnabled(false); return; }
  if(remoteDeadlineMs!==undefined){const deadline=roomStore.protocol!.turnDeadline(protocolRoomId(),state.economy.tick,remoteDeadlineMs),seats=roomStore.protocol!.readyPlayers(protocolRoomId(),state.economy.tick).filter(s=>state.economy.players[s.player]?.active);if(deadline.remainingMs<=0||seats.length>0&&seats.every(s=>s.ready))await advanceAutomatic();return;}
  const bindings=await loadControllerBindings(dataDir,playerRoomId!,state.economy.players.length);
  const activeBindings=bindings.filter(b=>state.economy.players[b.seat]?.active);
  if (!labAi.hasEnabledSeat()&&!activeBindings.length) return;
  const readinessStarted=Date.now();
  const readySeats=new Set(roomStore.protocol!.readyPlayers(playerRoomId!,state.economy.tick).filter(s=>s.ready).map(s=>s.player));
  advanceTiming.blockedSeats=activeBindings.filter(b=>!readySeats.has(b.seat)).map(b=>b.seat);
  advanceTiming.readinessMs=Date.now()-readinessStarted;
  if(advanceTiming.blockedSeats.length)return;
  if (labAi.readyToStep(runId)) await advanceAutomatic();
},sample=>tickPerformance.write({...sample,...advanceTiming,tickAfter:state.economy.tick}));
if(remoteDeadlineMs!==undefined)autoAdvance.setEnabled(true);
autoAdvance.start();
const checkpoints=new LinkedCheckpoints({directory:dataDir,
 begin:()=>serial.run(async()=>{
  await syncClock();
  const bindings=await loadControllerBindings(dataDir,playerRoomId??'',state.economy.players.length);
  const previous=autoAdvance.status().enabled;autoAdvance.setEnabled(false);
  checkpointFrozenAt=synchronizedNow;checkpointPhase='draining';
  return {roomId:playerRoomId??roomStore.predictionSource().roomId,bindings,autoAdvance:previous,frozenAt:checkpointFrozenAt};
 }),
 drain:expiresAt=>labAi.prepareCheckpoint(expiresAt),
 freeze:task=>serial.run(async()=>{checkpointPhase='frozen';return task({tick:state.economy.tick,revision:storageRevision});}),
 backupGame:async destination=>{await roomStore.backup(destination);},
 thaw:()=>serial.run(async()=>{
  if(clock)await persistRoom({...room(),clock:{...clock,anchorMs:clock.anchorMs+Date.now()-checkpointFrozenAt}});
  checkpointPhase='idle';synchronizedNow=Date.now();
 }),
 finish:(resume,enabled)=>{labAi.releaseCheckpoint(resume);autoAdvance.setEnabled(enabled);},
});
let pulsePending=false,clockError:string|undefined;
if(realtimeEnabled)setInterval(()=>{
  if(pulsePending)return;pulsePending=true;
  void serial.run(syncClock).then(()=>{clockError=undefined;}).catch(e=>{const message=e instanceof Error?e.message:'Clock failure';if(clockError!==message)console.error(message);clockError=message;}).finally(()=>{pulsePending=false;});
},1000).unref();
function view(
  source: FleetScenario = state,
  plans: ScheduledLaunch[] = scheduled,
  genericPlans=scheduledOrders,
): LabView {
  const names = originalOutpostNames(
    map?.seed ?? 0,
    source.economy.outposts.length,
  );
  const phase=source===state?realtimeSeconds(room(),synchronizedNow):0;
  return {
    realtime:source===state&&!!clock,
    ...(source===state?{manualCommandsByPlayer:Object.fromEntries(source.economy.players.map((_,player)=>[player,manualCommandView(room(),player)]))}:{}),
    ...(source===state?{commanderRoomId:playerRoomId??roomStore.predictionSource().roomId}:{}),
    ...(source===state?{predictionSource:roomStore.predictionSource()}:{}),
    autoAdvance:autoAdvance.status(),
    activity:projectGlobalActivity(source),
    battleLosses:projectGlobalBattleLosses(source),
    secondsSinceLastTick:phase,
    ...labRuleView(source,phase),
    orders:[...plans,...(genericPlans??[])].map(p=>({id:p.id,player:p.player,issueTick:p.issueTick,status:p.status,action:{...p.action},...(p.failed?{failed:true}:{}),...(p.reason?{reason:p.reason}:{})})),
    ...(map ? { map } : {}),
    ...(scenario ? { scenario } : {}),
    scheduled: plans,
    tick: source.economy.tick,
    size: source.initial.size,
    players: source.economy.players,
    intel: fleetPublicIntel(source),
    funding: source.economy.funding,
    outposts: source.economy.outposts.map((o, index) => ({
      ...o,
      name: names?.[index] ?? o.id,
      metrics: outpostMetrics(source, o.id),
      position: source.initial.positions[o.id]!,
    })),
    fleets: source.fleets
      .filter((f) => f.used)
      .map((f) => ({
        ...f,
        departureMinutes:f.state==='waiting'?Math.max(0,(f.secondsUntilLaunch-phase)/60):0,
        arrivalMinutes:null,
        ...fleetControls(source, f),
      })),
    events: [
      ...source.events.map((e) => ({
        tick: e.tick,
        kind: e.kind,
        subject: e.subject,
        details: JSON.stringify(e.details),
      })),
    ]
      .sort((a, b) => b.tick - a.tick)
      .slice(0, 150),
  };
}
let queue = Promise.resolve();
// Loopback cookies are shared with the AI console across ports. Allow its
// bounded legacy-cookie cleanup navigation without failing in the HTTP parser.
const server = createServer({maxHeaderSize:64*1024},(req, res) => {
  if (devReloadEnabled) {
    const host = req.headers.host;
    const path = new URL(req.url ?? "/", `http://${host ?? "127.0.0.1"}`).pathname;
    if ((host === `127.0.0.1:${port}` || host === `localhost:${port}`) && path === "/__dev/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("event: connected\ndata: ready\n\n");
      devReloadClients.add(res);
      req.on("close", () => devReloadClients.delete(res));
      return;
    }
    if ((host === `127.0.0.1:${port}` || host === `localhost:${port}`) && path === "/__dev/reload" && req.method === "POST") {
      for (const client of devReloadClients) client.write("event: reload\ndata: updated\n\n");
      res.writeHead(204).end();
      return;
    }
  }
  const diagnostic=requestDiagnostics(req,res,requestLog.write);diagnostic.stage('queue');
  queue = queue
    .then(async () => {
      diagnostic.stage('handler');
      try {
        const host = req.headers.host;
        if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) {
          res.writeHead(403).end();
          return;
        }
        if (
          req.headers.origin &&
          !["http://127.0.0.1:" + port, "http://localhost:" + port].includes(
            req.headers.origin,
          )
        ) {
          res.writeHead(403).end();
          return;
        }
        const path = new URL(req.url ?? "/", `http://${host}`).pathname;
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (path.startsWith("/api/")) {
          await serial.run(syncClock);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          if(req.method==='GET'&&path==='/api/checkpoints'){res.end(JSON.stringify({...checkpoints.status(),entries:await checkpoints.list()}));return;}
          if(req.method==='GET'&&path==='/api/chat/observer'){
            const params=new URL(req.url!,`http://${host}`).searchParams;
            res.end(await serial.run(()=>JSON.stringify(observerChatPage(chat,playerRoomId??roomStore.predictionSource().roomId,params))));return;
          }
          if(req.method==='GET'&&path==='/api/ai-controller'){res.end(JSON.stringify(await controllerSlots(dataDir)));return;}
          if(req.method==='GET'&&path==='/api/ai'){
            const status=labAi.status(),controller=await controllerSlots(dataDir);
            const external=controller.slots.filter(s=>s.bound===true&&s.roomId===playerRoomId&&typeof s.seat==='number');
            const seats=status.seats.filter(s=>!external.some(c=>c.seat===s.seat));
            for(const c of external)seats.push({seat:c.seat!,enabled:c.enabled===true,status:c.busy?'thinking':c.enabled?'waiting':c.status==='error'?'error':c.status==='ended'?'ended':'paused',error:null,recovering:false,settings:{model:c.model,personality:'schemer',provider:c.provider},calls:0,tokens:0});
            res.end(JSON.stringify({...status,seats:seats.sort((a,b)=>a.seat-b.seat)}));return;
          }
          if(req.method==='GET'&&path==='/api/ai/history'){
            const params=new URL(req.url!,`http://${host}`).searchParams;
            if([...params.keys()].some(k=>!['seat','before','screening'].includes(k))||params.getAll('seat').length!==1||params.getAll('before').length>1||params.getAll('screening').length>1||params.has('screening')&&params.get('screening')!=='1'||!/^\d+$/.test(params.get('seat')!)||params.has('before')&&!/^\d+$/.test(params.get('before')!))throw Error('无效日志参数');
            res.end(JSON.stringify(labAi.history(Number(params.get('seat')),params.has('before')?Number(params.get('before')):undefined,params.get('screening')==='1')));return;
          }
          if (req.method === "GET" && path === "/api/state") {
            res.end(await serial.run(() => JSON.stringify(view())));
            return;
          }
          if(req.method==="GET"&&path==="/api/scheduled-orders"){res.end(JSON.stringify(scheduledOrders??[]));return;}
          if (req.method === "GET" && path === "/api/standings") {
            res.end(JSON.stringify(fleetStandings(state)));
            return;
          }
          if(req.method==='GET'&&path==='/api/prediction-source'){
            const params=new URL(req.url!,`http://${host}`).searchParams;
            // Read the identity and world at one serial boundary. A concurrent
            // reset may commit its database before awaiting credential I/O and
            // publishing its in-memory room; never pair those two revisions.
            const result = await serial.run(() => {
              const current=roomStore.predictionSource();
              if(params.size!==2||params.get('roomId')!==current.roomId||params.get('revision')!==current.revision)
                return {status:409,body:JSON.stringify({error:'预测起点已更新'})};
              return {status:200,body:JSON.stringify({...current,room:room()})};
            });
            res.writeHead(result.status).end(result.body);return;
          }
          if (req.method === "GET" && path === "/api/export") {
            res.end(saveRoom(room()));
            return;
          }
          if(req.method==='GET'&&path==='/api/tick-times'){
            const params=new URL(req.url!,`http://${host}`).searchParams;
            if([...params.keys()].some(k=>!['after','limit'].includes(k))||[...params.keys()].some(k=>params.getAll(k).length!==1)||params.has('after')&&!/^\d+$/.test(params.get('after')!)||params.has('limit')&&!/^\d+$/.test(params.get('limit')!))throw Error('无效tick时间参数');
            res.end(JSON.stringify(await serial.run(()=>roomStore.tickTimes(Number(params.get('after')??0),Number(params.get('limit')??1000)))));return;
          }
          if (req.method === "GET" && path === "/api/replay") {
            res.end(
              JSON.stringify({
                format: "lab-replay/1",
                replay: exportFleetReplay(state),
                ...(map ? { map } : {}),
                scheduled,
                ...(scheduledOrders?{scheduledOrders}:{}),...(agendaOrder?{agendaOrder}:{}),
              }),
            );
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405).end("{}");
            return;
          }
          const data = await readJsonBody(req) as any;
          if(path==='/api/checkpoints'){const result=checkpoints.start(data);res.writeHead(202).end(JSON.stringify(result));return;}
          if(checkpoints.status().busy)throw Error('联动存档进行中，请稍后操作');
          if(path==='/api/perspective'){
            if(!Number.isInteger(data.player)||!state.economy.players[data.player])throw Error('Invalid player');
            const current={...room(),state:{...state,secondsSinceLastTick:realtimeSeconds(room(),synchronizedNow)}};
            // Activity journals are keyed by the authoritative state object.
            // Passing the phase-only spread above would replay the full game
            // on every poll to reconstruct the same journal.
            const observed=observation(room(),data.player,roomStore.predictionSource().roomId,current.state.secondsSinceLastTick);
            if(data.kind==='deployment'){
              if(data.departureTick===undefined){res.end(JSON.stringify(previewPlayerLaunch(current,data.player,data.order)));return;}
              const departure=data.departureTick;
              if(!Number.isFinite(departure)||departure<=state.economy.tick+observed.secondsSinceLastTick/600||departure>state.economy.tick+1440)throw Error('Invalid departure');
              const issue=Math.floor(departure+1e-9),issueTick=issue>state.economy.tick?issue:undefined;
              const order={...data.order,action:{...data.order.action,delaySeconds:Math.max(0,Math.round((departure-(issueTick??state.economy.tick))*600-(issueTick===undefined?observed.secondsSinceLastTick:0)))}};
              res.end(JSON.stringify(previewPlayerLaunch(current,data.player,order,issueTick)));return;
            }
            if(data.kind==='preview'){
              const predicted=previewFrame(room(),data.player,state.economy.tick+data.ticks,observed.secondsSinceLastTick);
              if(predicted.status!=='conditional')throw Error('当前预测不可用');
              res.end(JSON.stringify({observation:observed,frame:predicted.result}));return;
            }
            res.end(JSON.stringify({observation:observed}));return;
          }
          if(['/api/commander/list','/api/commander/messages','/api/commander/confirm'].includes(path)){
            const response=await serial.run(async()=>{
              const token=req.headers['x-lab-seat-token'],player=chat.identity(token),identity=chat;
              await syncClock();if(chat!==identity||chat.identity(token)!==player)throw Error('对局会话已变化');
              if(req.headers['x-subterfuge-commander-worker']!==undefined||req.headers['x-subterfuge-controller']==='agent')throw Error('需要玩家确认');
              const roomId=playerRoomId??roomStore.predictionSource().roomId;
              const result=path==='/api/commander/messages'?await commander.send(roomId,player,data,observation(room(),player,roomId,realtimeSeconds(room(),synchronizedNow))):path==='/api/commander/confirm'?await commander.confirm(roomId,player,data,state.economy.tick):commander.read(roomId,player);
              if(path==='/api/commander/list'&&Object.keys(data).length)throw Error('无效对话查询');
              return {...result,workerAvailable:commander.available(roomId,player)};
            });res.end(JSON.stringify(response));return;
          }
          if(['/api/chat/session','/api/chat/list','/api/chat/send'].includes(path)){
            const response=await serial.run(async()=>{
              await syncClock();
              if(path==='/api/chat/session')return {token:chat.claim(data.seat,state.economy.players.length)};
              if(path==='/api/chat/send')await chat.send(req.headers['x-lab-seat-token'],data,state.economy.players.length,state.economy.tick);
              return {messages:chat.list(req.headers['x-lab-seat-token'])};
            });
            res.end(JSON.stringify(response));return;
          }
          if (path === "/api/deployment-preview") {
            res.end(JSON.stringify(previewLaunch(room(), data)));
            return;
          }
          if (path === "/api/route-preview") {
            res.end(JSON.stringify(routeEstimate(state, data)));
            return;
          }
          if (path === "/api/preview") {
            if (
              !Number.isInteger(data.ticks) ||
              data.ticks < 0 ||
              data.ticks > 1440
            )
              throw Error("推演范围为未来 0～1440 世界天");
            const projected = previewRoom(
              room(),
              state.economy.tick + data.ticks,
            );
            res.end(JSON.stringify(view(projected.state, projected.scheduled,projected.scheduledOrders)));
            return;
          }
          const response=await serial.run(async()=>{
          await syncClock();
          let next: LabRoom;
          if(path==='/api/ai')return labAi.command(data);
          if(path==='/api/auto-step')throw Error('自动推进已改为服务端计时，请刷新网页后使用自动推进开关');
          if(path==='/api/clock-mode'){
            if(!data||Object.keys(data).length!==1||data.mode!=='automatic')throw Error('无效时间模式');
            await syncClock();
            if(clock){
              const current=room(),transitionAt=Date.now(),settled=await catchUpRealtime(current,transitionAt);
              const next:LabRoom={...settled,state:{...settled.state,secondsSinceLastTick:realtimeSeconds(settled,transitionAt)}};
              delete next.clock;
              await persistRoom(next,false,'realtime');
            }
            realtimeEnabled=false;
            autoAdvance.setEnabled(true);
            return view();
          }
          if(path==='/api/auto-advance'){
            if(typeof data?.enabled!=='boolean'||Object.keys(data).length!==1)throw Error('无效自动推进参数');
            if(clock&&data.enabled)throw Error('实时对局无需测试自动推进');
            if(data.enabled&&fleetStandings(state).ended)throw Error('对局已结束');
            // Clock control never starts or resumes an AI controller.
            autoAdvance.setEnabled(data.enabled);return view();
          }

          const controllerBindings=path==='/api/new'?validateControllerBindings(data.controllerBindings??[],data.players??8):[];
          if(controllerBindings.length&&(playerPort===undefined||!(await controllerSlots(dataDir)).available))throw Error('请先启动 AI 控制器和玩家接口');
          const aiConfig=path==='/api/new'?validateLabAi(data.aiSeats??[],data.players??8):[];
          if (path === "/api/new") {
            if(data.startMode!==undefined&&data.startMode!=='fresh'&&data.startMode!=='endgame')throw Error('Invalid start mode');
            next = await createGeneratedRoom(
              data.players ?? 8,
              data.seed ?? 4300,
              data.mapMode ?? 'quantity-priority',
              data.rules ?? {},
              (data.startMode??'fresh') as StartMode,
            );
            next.playerRoomId=randomUUID();
          }
          else if (path === "/api/schedule-order")
            next = applyCoordinatedOrder(room(),data.order,'manual',realtimeSeconds(room(),synchronizedNow),data.issueTick);
          else if (path === "/api/schedule")
            next=scheduleLaunch(room(),data,realtimeSeconds(room(),synchronizedNow),{source:'manual'});
          else if (path === "/api/cancel-schedule")
            next = applyCoordinatedCancellation(room(),data.id,data.player,'manual',realtimeSeconds(room(),synchronizedNow),data.confirmCancelledScheduleIds,data.confirmCancellationToken);
          else if (path === "/api/order") {
            validateImmediateLaunchTime(room(),data as FleetOrder,realtimeSeconds(room(),synchronizedNow));
            if(scheduleIds(room()).includes(data.id))throw Error("Command ID belongs to a schedule");
            next = applyCoordinatedOrder(room(),data as FleetOrder,'manual',realtimeSeconds(room(),synchronizedNow));
          } else if (path === "/api/step") {
            if(clock)throw Error('Manual stepping is disabled in realtime rooms');
            if (
              !Number.isInteger(data.ticks) ||
              data.ticks < 1 ||
              data.ticks > 144
            )
              throw Error("推进范围为 1～144 tick");
            next = advanceRoom(room(), state.economy.tick + data.ticks);
          } else if (path === "/api/import")
            next = restoreRoom(JSON.stringify(data), {trustedLocalStorage:true});
          else {
            res.writeHead(404).end("{}");
            return;
          }
          if(path==='/api/import')await writeTimelineMarker({format:'timeline-rewind/1',revision:storageRevision+1,tick:next.state.economy.tick,kind:next.state.economy.tick<state.economy.tick?'rewind':'import'});
          await persistRoom(next,path==='/api/new'||path==='/api/import',path==='/api/step'?'manual':'state-write');
          if(path==='/api/new'||path==='/api/import'){
            await saveControllerBindings(dataDir,playerRoomId!,path==='/api/new'?controllerBindings:[]);
            autoAdvance.setEnabled(false);
            if(playerPort===undefined)await chat.reset();
            if(next.scenario)await chat.seed(scenarioMessages(next.scenario.id,next.state.economy.players.length));
            const memorySeeds:Record<number,Partial<AiMemory>>={};
            for(const item of aiConfig){const memory=next.scenario?scenarioMemory(next.scenario.id,item.seat,next.state.economy.players.length):undefined;if(memory)memorySeeds[item.seat]=memory;}
            labAi.reset(aiConfig,memorySeeds);
            if(path==='/api/import')await clearTimelineMarker();
          }
          return view();
          });
          res.end(JSON.stringify(response));
          return;
        }
        if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        const file = resolve(
          root,
          "." + decodeURIComponent(path === "/" ? "/index.html" : path),
        );
        if (!file.startsWith(root + sep)) {
          res.writeHead(403).end();
          return;
        }
        const content = await readFile(file);
        res.setHeader(
          "Content-Type",
          (
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript",
              ".css": "text/css",
              ".png": "image/png",
              ".ogg": "audio/ogg",
              ".mp3": "audio/mpeg",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
        );
        if (devReloadEnabled && extname(file) === ".html") {
          const html = content.toString("utf8").replace("</body>", '<script>new EventSource("/__dev/events").addEventListener("reload",()=>location.reload())</script></body>');
          res.end(html);
        } else res.end(content);
      } catch (e) {
        diagnostic.fail(e,(e instanceof ManualCommandConflict||e instanceof DispatchSourceLocked)?409:400);
        res
          .writeHead((e instanceof ManualCommandConflict||e instanceof DispatchSourceLocked)?409:400, { "Content-Type": "application/json; charset=utf-8" })
          .end(
            JSON.stringify({
              error: e instanceof Error ? e.message : "操作失败",
              ...(e instanceof DispatchSourceLocked?{code:e.code}:{}),
              ...(e instanceof ManualCommandConflict?{code:e.code,...(e.cancelledScheduleIds?{cancelledScheduleIds:e.cancelledScheduleIds,cancellationToken:e.cancellationToken,cancelledSchedules:e.cancelledSchedules}:{})}:{}),
            }),
          );
      }
    })
    .catch((e) => {
      diagnostic.fail(e,500);
      res.end();
    });
});
server.listen(port, "127.0.0.1", () =>
  console.log(`深潜 · 本地测试界面 http://127.0.0.1:${port}`),
);

const protocol:PlayerProtocolHost={onDiagnostic:requestLog.write,repository:roomStore.protocol!,get roomId(){return protocolRoomId();},serial,sync:syncClock,programmaticAutoAdvance:()=>remoteDeadlineMs===undefined&&!clock&&autoAdvance.status().enabled,onExternalControl:(roomId,player)=>labAi.externalControl(roomId,player),assertMutationAllowed:(kind,stage)=>{if(checkpointPhase!=='idle'&&!(checkpointPhase==='draining'&&(stage==='settle'||['commander-worker','readiness','status','control-renew','control-release'].includes(kind))))throw new PlayerProtocolError('CONTROL_BUSY',409,'Checkpoint write barrier is active','transient');},...(remoteDeadlineMs===undefined?{}:{assertCommandWindow:(tick:number)=>roomStore.protocol!.assertTurnDeadline(protocolRoomId(),tick)}),load:()=>roomStore.current()!,commit:(next,expected)=>roomStore.commit(next,expected),refresh:()=>{const cut=roomStore.current()!;if(cut===refreshedCut)return;const saved=roomStore.load()!,next=saved.room;refreshedCut=cut;storageRevision=saved.revision;state=next.state;map=next.map;scheduled=next.scheduled;scheduledOrders=next.scheduledOrders;manualCoordination=next.manualCoordination;dispatchLocks=next.dispatchLocks;agendaOrder=next.agendaOrder;playerRoomId=next.playerRoomId;clock=next.clock;scenario=next.scenario;},seconds:()=>realtimeSeconds(roomStore.metadata(),synchronizedNow),ownerIdentity:authorization=>{const player=playerAccess?.identity(authorization);return player===undefined||player===null?null:{roomId:playerAccess!.roomId,player};},tickTimes:(after,limit)=>roomStore.tickTimes(after,limit),capabilities:()=>protocolCoordinator!.capabilities(),snapshot:player=>protocolCoordinator!.snapshot(player),instructionsVersion:player=>protocolCoordinator!.instructionsVersion(player),chat:()=>chat,commander,...(publicOrigin?{publicOrigin}:{})};
await labAi.start(protocol);
if(playerPort!==undefined){
  const playerServer=createPlayerApi({protocol,webRoot:root,...(publicOrigin?{publicOrigin}:{})});
  playerServer.listen(playerPort,process.env.PLAYER_HOST??'127.0.0.1',()=>console.log(`Player API listening on port ${playerPort}; credentials are in the local data directory.`));
}
