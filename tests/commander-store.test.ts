import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  createFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import { CommanderStore } from "../packages/server/src/commander-store.js";
import {
  createPlayerApi,
  observation,
} from "../packages/server/src/player-api.js";
import {
  PlayerAccess,
  SerialExecutor,
} from "../packages/server/src/player-access.js";
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import { PlayerControl } from "../packages/server/src/player-control.js";
import type { LabRoom } from "../packages/server/src/planning.js";
function room(): LabRoom {
  const cfg = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  cfg.size = { width: 80, height: 80 };
  cfg.positions = {
    蓝方工厂: { x: 0, y: 0 },
    红方矿场: { x: 20, y: 0 },
    红方后方: { x: 25, y: 0 },
  };
  return { state: createFleetScenario(cfg), scheduled: [] };
}
const send = (id = "m1") => ({
  id,
  text: "先守住工厂，暂时不要进攻。",
  references: [{ kind: "outpost", id: "蓝方工厂", label: "伪造名称" }],
});
const response = (
  messageId = "m1",
  baseVersion = 0,
  text = "守住工厂，暂时不要进攻。",
) => ({
  op: "reply",
  messageId,
  reply: "可以，我建议先稳住防线。",
  proposal: { baseVersion, text, summary: "优先防守，暂停进攻。" },
});
test("commander discussion is private, durable, duplicate-safe and does not silently adopt proposals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "commander-"));
  try {
    const file = join(dir, "chat.json"),
      store = new CommanderStore(file),
      r = room(),
      o = observation(r, 0, "room-one");
    await store.load();
    let thread = await store.send("room-one", 0, send(), o);
    assert.equal(
      thread.messages[0]!.references[0]!.label,
      o.outpostNames!["蓝方工厂"],
    );
    assert.equal(thread.directives.version, 0);
    thread = await store.worker("room-one", 0, response(), o.view.tick);
    assert.equal(thread.directives.text, "");
    assert.equal(thread.messages[1]!.proposal!.status, "pending");
    assert.equal(store.read("room-one", 1).messages.length, 0);
    assert.equal(store.read("room-two", 0).messages.length, 0);
    const p = thread.messages[1]!.proposal!;
    thread = await store.confirm(
      "room-one",
      0,
      { proposalId: p.id, version: 0 },
      o.view.tick,
    );
    assert.equal(thread.directives.version, 1);
    assert.equal(thread.directives.appliedVersion, 0);
    const count = thread.messages.length;
    assert.equal(
      (
        await store.confirm(
          "room-one",
          0,
          { proposalId: p.id, version: 0 },
          o.view.tick,
        )
      ).messages.length,
      count,
    );
    assert.equal(
      (await store.send("room-one", 0, send(), o)).messages.length,
      count,
    );
    assert.equal(
      (await store.worker("room-one", 0, response(), o.view.tick)).messages
        .length,
      count,
    );
    await assert.rejects(
      store.send("room-one", 0, { ...send(), text: "不同请求" }, o),
      /冲突/,
    );
    thread = await store.worker(
      "room-one",
      0,
      { op: "ack", version: 1, reply: "已调整防守策略，尚未调动舰队。" },
      o.view.tick,
    );
    assert.equal(thread.directives.appliedVersion, 1);
    assert.equal(thread.messages.length, count);
    assert.equal(thread.messages.at(-1)!.text, "指挥官指令已保存，AI 将调整原有策略。");
    assert.deepEqual(await store.worker("room-one", 0, {op:"ack",version:1,reply:"已调整防守策略，尚未调动舰队。"}, o.view.tick), thread);
    const loaded = new CommanderStore(file);
    await loaded.load();
    assert.deepEqual(loaded.read("room-one", 0), thread);
    assert.equal((await readFile(file, "utf8")).includes("伪造名称"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("confirmation is atomic against competing proposals and delayed replies cannot override newer instructions", async () => {
  const store = new CommanderStore(),
    o = observation(room(), 0, "one");
  await store.send("one", 0, send("m1"), o);
  await store.send("one", 0, send("m2"), o);
  await store.worker("one", 0, response("m1"), o.view.tick);
  let thread = await store.worker(
    "one",
    0,
    response("m2", 0, "暂停扩张。"),
    o.view.tick,
  );
  const ps = thread.messages.filter((m) => m.proposal).map((m) => m.proposal!);
  const outcomes = await Promise.allSettled(
    ps.map((p) =>
      store.confirm("one", 0, { proposalId: p.id, version: 0 }, o.view.tick),
    ),
  );
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.read("one", 0).directives.version, 1);
  await store.send("one", 0, send("m3"), o);
  thread = await store.worker("one", 0, response("m3", 0), o.view.tick);
  const last = thread.messages.at(-1)!;
  assert.equal(last.proposal!.status, "superseded");
  await assert.rejects(
    store.confirm(
      "one",
      0,
      { proposalId: last.proposal!.id, version: 0 },
      o.view.tick,
    ),
    /已经更新/,
  );
  await assert.rejects(
    store.worker(
      "one",
      0,
      { op: "ack", version: 0, reply: "旧策略" },
      o.view.tick,
    ),
    /已更新/,
  );
});
test("references and structured requests cannot inject inaccessible objects or unexpected instructions", async () => {
  const store = new CommanderStore(),
    o = observation(room(), 0, "one");
  await assert.rejects(
    store.send(
      "one",
      0,
      { ...send(), references: [{ kind: "fleet", id: "hidden-enemy" }] },
      o,
    ),
    /不可见/,
  );
  await assert.rejects(store.send("other", 0, send(), o), /身份/);
  await assert.rejects(
    store.send("one", 0, { ...send(), player: 1 }, o),
    /字段/,
  );
  await assert.rejects(
    store.send(
      "one",
      0,
      {
        ...send(),
        references: [
          { kind: "outpost", id: "蓝方工厂", position: { x: 1, y: 2 } },
        ],
      },
      o,
    ),
    /字段/,
  );
  await store.send("one", 0, send(), o);
  await assert.rejects(
    store.worker(
      "one",
      0,
      { ...response(), directives: { version: 99, text: "attack" } },
      o.view.tick,
    ),
    /字段/,
  );
  assert.equal(store.read("one", 0).directives.version, 0);
});
test("v2 discussion stays private while paused and confirmed instructions preserve tick completion but reject stale writes",async t=>{
 const h=protocolHarness(t,{room:room()}),store=new CommanderStore(),server=await createOwnerPlayerApi(h,{commander:store}),g=h.grant(0,['observe','events.read','commands.write','control.lease','commander.worker']);
 const session=h.repository.createSession(g.principal,'commander-test-executor',['core/2','commander.worker/1']);
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const request=(path:string,data?:unknown,token=h.ownerCredentials.credentials[0]!.token)=>fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},...(data===undefined?{}:{body:JSON.stringify(data)})});
 try{
  assert.equal((await fetch(url+'/player/v2/owner/commander')).status,401);assert.equal((await request('/player/v2/owner/commander?player=1')).status,400);
  assert.equal((await request('/player/v2/owner/commander/messages',send())).status,200);
  const reply={roomEpoch:h.authority.roomEpoch,sessionId:session,authorizationVersion:'1',instructionsVersion:'0',idempotencyKey:'discussion-reply',clientCommandId:'discussion-reply',kind:'commander-worker',payload:response()};
  const answered=await request('/player/v2/commander/worker',reply,g.token);assert.equal(answered.status,200);assert.equal((await answered.json()).state,'applied');
  assert.equal(h.repository.ownerStatus(h.roomId,0).mode,'manual');assert.equal(h.store.load()!.revision,1);
  const view=await(await request('/player/v2/owner/commander')).json(),proposal=view.proposals[0],confirmation={roomEpoch:view.scope.roomEpoch,proposalId:proposal.proposalId,baseVersion:proposal.baseVersion,contentDigest:proposal.contentDigest};
  assert.equal((await request('/player/v2/owner/commander/confirm',confirmation,g.token)).status,401);
  const other=await(await request('/player/v2/owner/commander',undefined,h.ownerCredentials.credentials[1]!.token)).json();assert.equal(other.thread.messages.length,0);
  const snapshot=await(await request('/player/v2/snapshot',undefined,g.token)).json();assert.equal(JSON.parse(snapshot.page.text).commander.messages.length,2);
  const lease=h.repository.controlOperation(g.principal,'acquire',{roomEpoch:h.authority.roomEpoch,sessionId:session,idempotencyKey:'discussion-game-acquire'}),revision=observation(h.store.load()!.room,0,h.roomId).revision;
  const command=(id:string,instructionsVersion='0')=>h.command(id,{sessionId:session,fence:lease.generation,expectedRevision:revision,instructionsVersion});
  const ready=command('discussion-ready');ready.kind='readiness';ready.payload={ready:true,tick:100};
  assert.equal((await(await request('/player/v2/commands',ready,g.token)).json()).state,'applied');assert.equal(h.repository.readyPlayers(h.roomId,100)[0]!.ready,true);
  await request('/player/v2/owner/commander/messages',send('m2'));assert.equal(h.repository.readyPlayers(h.roomId,100)[0]!.ready,true);
  assert.equal((await request('/player/v2/owner/commander/confirm',confirmation)).status,200);assert.equal(h.repository.readyPlayers(h.roomId,100)[0]!.ready,true);
  const stale=await(await request('/player/v2/commands',command('old-instructions'),g.token)).json();assert.equal(stale.state,'rejected');assert.equal(stale.code,'INSTRUCTIONS_CHANGED');assert.equal(h.store.load()!.revision,1);
  const fresh=await(await request('/player/v2/commands',command('current-instructions','1'),g.token)).json();assert.equal(fresh.state,'applied');assert.equal(h.store.load()!.revision,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("failed reconciliation notice is durable and idempotent without claiming application", async () => {
  const store = new CommanderStore(),
    o = observation(room(), 0, "notice-room");
  await store.send("notice-room", 0, send(), o);
  const proposed = await store.worker(
    "notice-room",
    0,
    response(),
    o.view.tick,
  );
  const p = proposed.messages[1]!.proposal!;
  await store.confirm(
    "notice-room",
    0,
    { proposalId: p.id, version: 0 },
    o.view.tick,
  );
  const notice = {
    op: "notice",
    id: "reconcile-version-1",
    reply: "指示已保存，但策略调整暂未完成。",
  };
  const first = await store.worker("notice-room", 0, notice, o.view.tick);
  const second = await store.worker("notice-room", 0, notice, o.view.tick);
  assert.equal(first.directives.appliedVersion, 0);
  assert.deepEqual(second, first);
  assert.equal(second.messages.at(-1)!.status, "failed");
});

test("player explicitly confirms clearing all instructions and empty proposal survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "commander-clear-"));
  try {
    const file = join(dir, "chat.json"),
      store = new CommanderStore(file),
      o = observation(room(), 0, "clear-room");
    await store.send("clear-room", 0, send(), o);
    let thread = await store.worker("clear-room", 0, response(), o.view.tick);
    await store.confirm(
      "clear-room",
      0,
      { proposalId: thread.messages[1]!.proposal!.id, version: 0 },
      o.view.tick,
    );
    await store.send(
      "clear-room",
      0,
      { id: "clear-message", text: "撤销全部指挥官指令。", references: [] },
      o,
    );
    thread = await store.worker(
      "clear-room",
      0,
      {
        op: "reply",
        messageId: "clear-message",
        reply: "可以，确认后我会撤销全部现有指示。",
        proposal: { baseVersion: 1, text: "", summary: "撤销全部指挥官指令。" },
      },
      o.view.tick,
    );
    assert.notEqual(thread.directives.text, "");
    const proposal = thread.messages.at(-1)!.proposal!;
    assert.equal(proposal.text, "");
    const reloaded = new CommanderStore(file);
    await reloaded.load();
    thread = await reloaded.confirm(
      "clear-room",
      0,
      { proposalId: proposal.id, version: 1 },
      o.view.tick,
    );
    assert.equal(thread.directives.text, "");
    assert.equal(thread.directives.version, 2);
    const final = new CommanderStore(file);
    await final.load();
    assert.equal(final.read("clear-room", 0).directives.version, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v2 owner commands remain available with confirmed instructions and after explicitly clearing them",async t=>{
 const current=room();current.state=createFleetScenario({...current.state.initial,match:{mode:'mining',neptuniumGoal:99999},});
 const h=protocolHarness(t,{room:current}),store=new CommanderStore(),server=await createOwnerPlayerApi(h,{commander:store});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const request=(path:string,data?:unknown,player=0)=>fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+h.ownerCredentials.credentials[player]!.token},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const order=async(id:string,player=0)=>{const observed=await(await request('/player/v2/owner/observation',undefined,player)).json();return request('/player/v2/owner/commands',{kind:'order',clientCommandId:id,expectedRevision:observed.revision,payload:{action:{kind:'check-in'}}},player);};
 const confirm=async()=>{const view=await(await request('/player/v2/owner/commander')).json(),proposal=view.proposals.at(-1);return request('/player/v2/owner/commander/confirm',{roomEpoch:view.scope.roomEpoch,proposalId:proposal.proposalId,baseVersion:proposal.baseVersion,contentDigest:proposal.contentDigest});};
 try{
  assert.equal((await order('before-instructions')).status,200);
  await store.send(h.roomId,0,send(),observation(h.store.load()!.room,0,h.roomId));await store.worker(h.roomId,0,response(),current.state.economy.tick);assert.equal((await confirm()).status,200);
  assert.equal((await order('manual-with-instructions')).status,200);assert.equal((await order('other-seat',1)).status,200);assert.equal(h.repository.ownerStatus(h.roomId,0).mode,'manual');assert.equal(store.read(h.roomId,0).directives.version,1);
  await store.send(h.roomId,0,{id:'clear',text:'清空指示',references:[]},observation(h.store.load()!.room,0,h.roomId));await store.worker(h.roomId,0,{op:'reply',messageId:'clear',reply:'请确认清空。',proposal:{baseVersion:1,text:'',summary:'清空全部指示。'}},current.state.economy.tick);
  assert.equal((await confirm()).status,200);assert.equal((await order('manual-after-clear')).status,200);assert.equal(store.read(h.roomId,0).directives.text,'');assert.equal(store.read(h.roomId,0).directives.version,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
