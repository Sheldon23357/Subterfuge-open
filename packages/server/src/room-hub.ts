import { createServer } from "node:http";
import { randomInt, createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PlayerAccess, SerialExecutor } from "./player-access.js";
import { LobbyStore } from "./lobby-store.js";
import { createLifecycleService } from "./lifecycle-service.js";
import { createWaitingLobby } from "./waiting-lobby.js";
import {createFleetScenario} from '../../engine/src/index.js';
import { createGeneratedRoom } from "./generated-room.js";
import { servePlayerStatic } from "./player-static.js";
import { readJsonBody } from "./json-body.js";
import {parseRoomTiming} from '../../contracts/src/index.js';
import {tickMilliseconds} from './realtime.js';
import {Worker} from 'node:worker_threads';
import {roomRecoveryBuildId} from './room-recovery-build.js';
import type {HubRoomSummary} from '../../contracts/src/index.js';
import {ENDED_ROOM_LIMIT} from '../../contracts/src/index.js';
import {PlayerProtocolError} from './player-protocol-auth.js';

export function generateRoomCode() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code: string;
  do {
    code = Array.from(
      { length: 6 },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
  } while (!/[A-Z]/.test(code) || !/[0-9]/.test(code));
  return code;
}
interface Metadata {
  code: string;
  name: string;
  createdAt: number;
  createHash: string;
}
/** One public origin; bearer credentials route to exactly one isolated authority. */
export async function createRoomHub(options: {
  directory: string;
  webRoot: string;
}) {
  const rooms = new Map<
    string,
    {
      meta: Metadata;
      store: LobbyStore;
      service: ReturnType<typeof createLifecycleService>;
      access: PlayerAccess;
    }
  >();
  const serial = new SerialExecutor();
  const buildId=roomRecoveryBuildId();
  const pending=new Map<string,{code:string;name:string;createdAt:number;status:'recovering'|'unavailable'}>();
  const workers=new Set<Worker>();
  const auditedRooms=new Set<string>();
  let closing=false,recoveryStarted=false,recoveryComplete=false;
  const work=(path:string,audit=false)=>new Promise<{usedCheckpoint:boolean}>((resolve,reject)=>{
    const worker=new Worker(new URL('./room-recovery-worker.js',import.meta.url),{workerData:{path,buildId,audit},resourceLimits:{maxOldGenerationSizeMb:768}});workers.add(worker);
    const timeout=setTimeout(()=>{void worker.terminate();reject(Error('Room recovery timed out'));},120000);timeout.unref();
    worker.once('message',(reply)=>{clearTimeout(timeout);reply.ok?resolve(reply):reject(Error('Room recovery verification failed'));});
    worker.once('error',()=>reject(Error('Room recovery worker failed')));
    worker.once('exit',()=>{clearTimeout(timeout);workers.delete(worker);reject(Error('Room recovery worker exited before a result'));});
  });
  let finishRecovery!:()=>void;
  const ready=new Promise<void>(resolve=>{finishRecovery=resolve;});
  let finishAudit!:()=>void;
  const audited=new Promise<void>(resolve=>{finishAudit=resolve;});
  await mkdir(options.directory, { recursive: true });
  const roomRoot = await realpath(options.directory);
  async function open(meta: Metadata) {
    const directory = join(roomRoot, meta.code),
      store = new LobbyStore(join(directory, "lifecycle.sqlite"),{}, {buildId});
    try {
      const saved = store.current();
      if (!saved) throw Error("Room has no committed lobby");
      const service = createLifecycleService(store, {
        webRoot: options.webRoot,
        onClockError:()=>{void serial.run(()=>quarantine(meta)).catch(()=>console.error('Room clock isolation failed:',meta.code));},
      });
      await service.ready;
      rooms.set(meta.code, {
        meta,
        store,
        service,
        access: new PlayerAccess(saved.lobby.access),
      });
      pending.delete(meta.code);
      store.onCommit(snapshot=>{if(snapshot.runtime?.status==='ended'){service.stopClock();scheduleRetention();}});
      if(saved.runtime?.status!=='ended')service.startClock();
    } catch (error) {
      store.close(false);
      throw error;
    }
  }
  const discovered:Metadata[]=[];
  const retired=new Set<string>();
  for(const entry of await readdir(roomRoot,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    if(/^\.ended-[A-Z0-9]{6}-[a-f0-9-]{36}$/.test(entry.name)){retired.add(join(roomRoot,entry.name));continue;}
    if(!/^[A-Z0-9]{6}$/.test(entry.name))continue;
    try{
      const meta=JSON.parse(await readFile(join(roomRoot,entry.name,'room.json'),'utf8')) as Metadata;
      if(meta.code!==entry.name||typeof meta.name!=='string'||meta.name.length>40||!Number.isSafeInteger(meta.createdAt)||!/^[a-f0-9]{64}$/.test(meta.createHash))throw Error('Invalid room metadata');
      discovered.push(meta);pending.set(meta.code,{code:meta.code,name:meta.name,createdAt:meta.createdAt,status:'recovering'});
    }catch{pending.set(entry.name,{code:entry.name,name:'房间恢复失败',createdAt:0,status:'unavailable'});console.error('Room metadata unavailable:',entry.name);}
  }
  const summary = (
    room: typeof rooms extends Map<string, infer V> ? V : never,
  ):HubRoomSummary => {
    const saved = room.store.current()!;
    return {
      code: room.meta.code,
      name: room.meta.name,
      createdAt: room.meta.createdAt,
      capacity: saved.lobby.seats.length,
      players: saved.lobby.seats.filter((s) => s === 1).length,
      status: saved.runtime?.status ?? saved.lobby.status,
      timing:parseRoomTiming((saved.runtime?.room??saved.waitingRoom)?.timing),
      ...(saved.runtime?.status==='ended'?{endedAt:endedAt(room)}:{}),
    };
  };
  function endedAt(room:NonNullable<ReturnType<typeof rooms.get>>){
    const runtime=room.store.current()!.runtime!,clock=runtime.room.clock;
    const event=runtime.room.state.events.find(e=>e.kind==='game-ended');
    if(!event)throw Error('Ended room has no authoritative ending');
    if(!clock&&runtime.room.timing?.mode==='turn-based')return runtime.syncedAtMs;
    if(!clock)throw Error('Ended room has no clock');
    return clock.anchorMs+(event.tick-clock.anchorTick+event.fraction)*tickMilliseconds(runtime.room);
  }
  async function dispose(room:NonNullable<ReturnType<typeof rooms.get>>){
    room.service.stopClock();room.service.server.close();await room.service.drain();room.store.close(false);
  }
  async function removeRetired(){for(const path of retired){
    if(await realpath(path)!==path)throw Error('Refuse cleanup outside room directory');
    await rm(path,{recursive:true,force:true});retired.delete(path);
  }}
  async function retainEnded(){
    if(closing||!recoveryComplete)return;
    await removeRetired();
    const ended=[...rooms.values()].filter(r=>r.store.current()?.runtime?.status==='ended').sort((a,b)=>endedAt(b)-endedAt(a)||b.meta.createdAt-a.meta.createdAt||b.meta.code.localeCompare(a.meta.code));
    for(const room of ended.slice(ENDED_ROOM_LIMIT)){
      if(!auditedRooms.has(room.meta.code))continue;
      if(room.store.current()?.runtime?.status!=='ended')continue;
      const path=join(roomRoot,room.meta.code);
      if(await realpath(path)!==path)throw Error('Refuse cleanup outside room directory');
      rooms.delete(room.meta.code);await dispose(room);
      const target=join(roomRoot,`.ended-${room.meta.code}-${randomUUID()}`);
      await rename(path,target);retired.add(target);await removeRetired();
    }
  }
  let retentionScheduled=false;
  function scheduleRetention(){if(retentionScheduled||closing)return;retentionScheduled=true;
    setImmediate(()=>{void serial.run(retainEnded).catch(()=>console.error('Ended room cleanup failed')).finally(()=>{retentionScheduled=false;});});
  }
  async function quarantine(meta:Metadata){
    const room=rooms.get(meta.code);rooms.delete(meta.code);
    pending.set(meta.code,{code:meta.code,name:meta.name,createdAt:meta.createdAt,status:'unavailable'});
    if(room)await dispose(room);
  }
  async function recover(){
    const audits:Metadata[]=[];
    try{for(const meta of discovered){
      if(closing)break;
      try{
        const result=await work(join(roomRoot,meta.code,'lifecycle.sqlite'));
        if(closing)break;
        await serial.run(()=>open(meta));if(result.usedCheckpoint)audits.push(meta);else auditedRooms.add(meta.code);
      }catch{if(!closing){await serial.run(()=>quarantine(meta));console.error('Room recovery failed:',meta.code);}}
    }
    recoveryComplete=true;
    if(!closing)await serial.run(retainEnded);
    }catch(error){console.error('Room recovery maintenance failed:',error);}
    finally{finishRecovery();}
    // Full replay stays off the request thread; checkpoint restore does not suppress audit.
    for(const meta of audits){if(closing)break;if(!rooms.has(meta.code))continue;
      try{await work(join(roomRoot,meta.code,'lifecycle.sqlite'),true);auditedRooms.add(meta.code);if(!closing)await serial.run(retainEnded);}
      catch{if(!closing){await serial.run(()=>quarantine(meta));console.error('Room background audit failed:',meta.code);}}
    }
    finishAudit();
  }
  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(value));
      };
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        req.headers.origin &&
        req.headers.origin !== `http://${req.headers.host}` &&
        req.headers.origin !== `https://${req.headers.host}`
      ) {
        send(403, { error: "来源不允许。" });
        return;
      }
      if (url.pathname.startsWith("/api/rooms")) {
        if (url.search) {
          send(400, { error: "不支持查询参数。" });
          return;
        }
        if (url.pathname === "/api/rooms" && req.method === "GET") {
          send(200, { rooms: [...rooms.values()].map(summary).concat([...pending.values()].map(meta=>({...meta,capacity:0,players:0}))) });
          return;
        }
        const requested=/^\/api\/rooms\/([A-Za-z0-9]{6})\//.exec(url.pathname)?.[1]?.toUpperCase();
        if(requested&&pending.has(requested)){send(503,{error:pending.get(requested)!.status==='recovering'?'房间正在恢复，请稍后重试。':'房间恢复失败，暂时无法进入。'});return;}
        const identityPath=/^\/api\/rooms\/([A-Z0-9]{6})\/identity$/.exec(url.pathname);
        if(identityPath){
          const room=rooms.get(identityPath[1]!);
          if(!room){send(404,{error:'房间不存在。'});return;}
          if(req.method!=='GET'){send(405,{error:'Method not allowed'});return;}
          const seat=room.access.identity(req.headers.authorization);
          if(seat===null||room.store.current()?.lobby.seats[seat]!==1){send(401,{error:'Unauthorized'});return;}
          send(200,{roomId:room.access.roomId,seat});return;
        }
        const botPath=/^\/api\/rooms\/([A-Z0-9]{6})\/bots$/.exec(url.pathname);
        if(botPath){
          const room=rooms.get(botPath[1]!);
          if(!room){send(404,{error:'房间不存在。'});return;}
          if(req.method==='GET'){send(200,{connections:room.store.hubBotLinks().filter(link=>room.store.current()?.lobby.seats[link.seat]===1)});return;}
          if(req.method!=='POST'&&req.method!=='DELETE'){send(405,{error:'Method not allowed'});return;}
          const seat=room.access.identity(req.headers.authorization);
          if(seat===null||room.store.current()?.lobby.seats[seat]!==1){send(401,{error:'Unauthorized'});return;}
          let body:Record<string,unknown>;
          try{
            body=await readJsonBody(req,512) as Record<string,unknown>;
            if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.id!=='string'||!/^[a-f0-9]{48}$/.test(body.id)||Object.keys(body).some(key=>!['id',...(req.method==='POST'?['name','model']:[])].includes(key)))throw Error();
            if(req.method==='POST'&&(typeof body.name!=='string'||!body.name.trim()||body.name.length>60||/[\u0000-\u001f]/.test(body.name)))throw Error();
          }catch{send(400,{error:'Invalid bot connection'});return;}
          if(room.access.identity(req.headers.authorization)!==seat||room.store.current()?.lobby.seats[seat]!==1){send(401,{error:'Unauthorized'});return;}
          try{
            if(body.model!==undefined&&(typeof body.model!=='string'||body.model.length>200||/[\u0000-\u001f]/.test(body.model))){send(400,{error:'Invalid model name'});return;}
            if(req.method==='POST')room.store.linkHubBot(seat,body.id as string,(body.name as string).trim(),Date.now(),typeof body.model==='string'?body.model:'未提供模型');
            else room.store.unlinkHubBot(seat,body.id as string);
          }catch(error){send(409,{error:error instanceof Error?error.message:'Connection conflict'});return;}
          send(200,{connections:room.store.hubBotLinks()});return;
        }
        const joining = /^\/api\/rooms\/([A-Za-z0-9]{6})\/join$/.exec(
          url.pathname,
        );
        if (
          req.method !== "POST" ||
          (!joining && url.pathname !== "/api/rooms")
        ) {
          send(404, { error: "接口不存在。" });
          return;
        }
        if (req.headers["sec-fetch-site"] === "cross-site") {
          send(403, { error: "来源不允许。" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          const value = await readJsonBody(req, 2048);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw Error();
          body = value as Record<string, unknown>;
        } catch {
          send(400, { error: "请求格式错误。" });
          return;
        }
        if (
          body.seat !== undefined && (!Number.isInteger(body.seat) || Number(body.seat)<1 || Number(body.seat)>9) ||
          typeof body.key !== "string" ||
          !/^[a-f0-9]{64}$/.test(body.key) ||
          Object.keys(body).some(
            (k) =>
              !(joining ? ["key", "seat"] : ["key", "name", "capacity", "timing"]).includes(k),
          )
        ) {
          send(400, { error: "加入凭据无效。" });
          return;
        }
        await serial.run(async () => {
          let room = joining ? rooms.get(joining[1]!.toUpperCase()) : undefined;
          if (!joining) {
            const name = typeof body.name === "string" ? body.name.trim() : "";
            const capacity = body.capacity;
            let timing;try{timing=parseRoomTiming(body.timing);}catch{send(400,{error:'无效对局模式或 tick 时间（1–3600 秒）'});return;}
            if (
              !name ||
              name.length > 40 ||
              !Number.isInteger(capacity) ||
              Number(capacity) < 2 ||
              Number(capacity) > 10
            ) {
              send(400, { error: "请填写房间名称和 2–10 人容量。" });
              return;
            }
            const hash = createHash("sha256")
              .update(body.key as string)
              .digest("hex");
            if(discovered.some(meta=>meta.createHash===hash&&pending.has(meta.code))){send(503,{error:'原房间暂时不可用，请稍后重试。'});return;}
            room = [...rooms.values()].find((r) => r.meta.createHash === hash);
            if(room&&JSON.stringify(parseRoomTiming((room.store.current()!.runtime?.room??room.store.current()!.waitingRoom)?.timing))!==JSON.stringify(timing)){send(409,{error:'该创建请求已绑定不同的对局模式'});return;}
            if (!room) {
              if (rooms.size+pending.size >= 100) {
                send(409, { error: "服务器房间数量已达上限。" });
                return;
              }
              let code: string, directory: string;
              for (;;) {
                code = generateRoomCode();
                directory = join(roomRoot, code);
                try {
                  await mkdir(directory);
                  break;
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
                }
              }
              const access = PlayerAccess.generate(Number(capacity));
              const world = await createGeneratedRoom(
                Number(capacity),
                randomInt(0, 0xffffffff - 499),
                "original",
              );
              world.timing=timing;
              if(timing.mode==='realtime'){
                const setup=structuredClone(world.state.initial);if(setup.match)setup.match.realtimeTickMilliseconds=timing.tickSeconds*1000;
                world.state=createFleetScenario(setup);
              }
              world.playerRoomId = access.roomId;
              const store = new LobbyStore(join(directory, "lifecycle.sqlite"),{}, {buildId});
              try {
                store.commit(createWaitingLobby(access), 0, world);
              } finally {
                store.close();
              }
              const meta = {
                code,
                name,
                createdAt: Date.now(),
                createHash: hash,
              };
              await writeFile(
                join(directory, "room.json"),
                JSON.stringify(meta),
                { flag: "wx", mode: 0o600 },
              );
              await open(meta);auditedRooms.add(meta.code);
              room = rooms.get(code)!;
            }
          }
          if (!room) {
            send(404, { error: "房间不存在，请核对房间码。" });
            return;
          }
          try {
            const identity = await room.service.claimSeat(
              body.key as string,
              !joining,
              body.seat as number | undefined,
            );
            send(200, { ...summary(room), ...identity });
          } catch (error) {
            send(409, {
              error: error instanceof Error ? error.message : "无法加入房间。",
            });
          }
        });
        return;
      }
      if (
        url.pathname.startsWith("/lobby/v2") ||
        url.pathname.startsWith("/ai/v2") ||
        url.pathname.startsWith("/player/v2/")
      ) {
        const room = [...rooms.values()].find(
          (r) => {
            if(r.access.identity(req.headers.authorization)!==null)return true;
            if(!url.pathname.startsWith('/player/v2/')||url.pathname.startsWith('/player/v2/owner/'))return false;
            try{return r.store.protocol.authenticate(req.headers.authorization).roomId===r.access.roomId;}
            catch(error){if(error instanceof PlayerProtocolError&&error.code==='UNAUTHORIZED')return false;throw error;}
          },
        );
        if (!room&&[...pending.values()].some(r=>r.status==='recovering')){send(503,{error:'房间正在恢复，请稍后重试。'});return;}
        if (!room) {
          send(401, { error: "加入凭据无效。" });
          return;
        }
        room.service.server.emit("request", req, res);
        return;
      }
      if (
        url.pathname === "/" ||
        url.pathname === "/hall.js" ||
        url.pathname === "/hall.css"
      ) {
        if (req.method !== "GET") {
          send(405, { error: "Method not allowed" });
          return;
        }
        const file = url.pathname === "/" ? "hall.html" : url.pathname.slice(1);
        try {
          const data = await readFile(join(options.webRoot, file));
          const styleHashes=file.endsWith('.html')?[...data.toString('utf8').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match=>`'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`):[];
          res.writeHead(200, {
            "Content-Type": file.endsWith(".html")
              ? "text/html; charset=utf-8"
              : file.endsWith(".js")
                ? "text/javascript"
                : "text/css",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
              `default-src 'self'; style-src 'self' ${styleHashes.join(' ')}; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`,
          });
          res.end(data);
        } catch {
          send(404, { error: "请先构建网页。" });
        }
        return;
      }
      if (!(await servePlayerStatic(options.webRoot, req, res)))
        send(404, { error: "Not found" });
    })().catch(() => {
      if (!res.headersSent)
        res
          .writeHead(503, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "大厅暂时不可用，请重试。" }));
      else res.end();
    });
  });
  server.once('listening',()=>{recoveryStarted=true;void recover().catch(()=>{finishRecovery();finishAudit();console.error('Room recovery task failed');});});
  const maintenance=setInterval(scheduleRetention,60000);maintenance.unref();
  return {
    server,ready,audited,
    async close() {
      closing=true;clearInterval(maintenance);
      await Promise.allSettled([...workers].map(worker=>worker.terminate()));
      if(recoveryStarted){await ready;await audited;}else{finishRecovery();finishAudit();}
      for (const r of rooms.values()) {
        r.service.stopClock();
        r.service.server.close();
      }
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await serial.run(async () => {
        for (const r of rooms.values()) {
          await r.service.drain();
          r.store.close();
        }
      });
    },
  };
}
