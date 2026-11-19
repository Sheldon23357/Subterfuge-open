import test from "node:test";
import {createHash} from "node:crypto";
import {saveRoom} from "../packages/server/src/planning.js";
import {createServer as createPortProbe} from "node:net";
import {once} from "node:events";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {projectPlayerView,fleetPublicIntel} from '../packages/engine/src/index.js';
import {createEightPlayerScenario} from '../packages/server/src/eight-player.js';

// Imports create a new cache scope and forecasts have no live source metadata.
// Compare game content separately from the explicitly tested source identity.
function assertContent(actual:any,expected:any){
  const content=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='predictionSource'&&key!=='commanderRoomId')):value;
  assert.deepEqual(content(actual),content(expected));
}

// Forecasts describe hypothetical game content, never live commander authority.
// Keep assertContent unchanged for every live/retry/restart/import comparison.
function assertForecastContent(prediction:any,live:any){
  assert.equal('manualCommandsByPlayer' in prediction,false,'forecasts must not advertise live manual authority');
  assert.ok(live.manualCommandsByPlayer,'the live view must retain authoritative manual facts');
  const {manualCommandsByPlayer,...gameContent}=live;
  assertContent(prediction,gameContent);
}

test("browser lab persists orders, rejects foreign origins and restores snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subterfuge-web-"));
  let child: ChildProcess | undefined;
  const probe=createPortProbe();probe.listen(0,"127.0.0.1");await once(probe,"listening");
  const address=probe.address();if(!address||typeof address==='string')throw Error('No test port');const testPort=address.port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const base = `http://127.0.0.1:${testPort}`;
  async function start() {
    child = spawn(
      process.execPath,
      [resolve("dist/packages/server/src/main.js")],
      {
        env: {
          ...process.env,
          LAB_PORT: String(testPort),
          GAME_CLOCK: "manual",
          LAB_LEGACY_FIXTURE: "1",
          LAB_DATA_DIR: dir,
        },
        stdio: "pipe",
      },
    );
    await new Promise<void>((yes, no) => {
      child!.stdout!.once("data", () => yes());
      child!.once("exit", (code) => no(Error(`server exited ${code}`)));
      child!.once("error", no);
    });
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const p = new Promise<void>((done) => child!.once("exit", () => done()));
      child.kill();
      await p;
    }
  }
  async function request(path: string, body: unknown) {
    return fetch(base + "/api/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  try {
    await start();
    const initial = await (await fetch(base + "/api/state")).json();
    assert.ok(Object.values(initial.manualCommandsByPlayer).every((value:any)=>!('releaseSupported' in value)));
    const unavailableRelease=await request('manual-commands/release',{id:'removed-operation',player:0,receiptIds:['manual:0:1'],expectedManualVersion:1,expectedRoomId:initial.commanderRoomId});
    assert.equal(unavailableRelease.status,404);
    assertContent(await(await fetch(base+'/api/state')).json(),initial);
    const timeBaseline=await(await fetch(base+'/api/tick-times')).json();
    assert.equal(timeBaseline.headTick,initial.tick);assert.equal(timeBaseline.records.length,1);assert.equal(timeBaseline.records[0].kind,'observed');
    for(const query of ['after=-1','limit=0','limit=5001','after=1&after=2','unknown=1'])assert.equal((await fetch(base+'/api/tick-times?'+query)).status,400);
    assert.ok(initial.predictionSource);
    const sourceParams=new URLSearchParams(initial.predictionSource);
    const predictionSource=await (await fetch(base+'/api/prediction-source?'+sourceParams)).json();
    assert.equal(predictionSource.room.state.economy.tick,initial.tick);
    assert.equal(createHash("sha256").update(saveRoom(predictionSource.room,{trustedLocalStorage:true})).digest("hex"),predictionSource.revision,"versioned room exactly matches its authoritative snapshot digest");
    assert.equal((await fetch(base+'/api/prediction-source?roomId=invalid&revision=0')).status,409);
    assert.ok(initial.fleets.every((f:{arrivalMinutes:number|null})=>f.arrivalMinutes===null));
    assert.equal(initial.outposts.length, 32);
    assert.equal(initial.players.length, 8);
    assertContent(initial.intel,fleetPublicIntel(createEightPlayerScenario()));
    const fog0=await (await request('perspective',{player:0})).json();
    const fog1=await (await request('perspective',{player:1})).json();
    assert.equal(fog0.arrivals,undefined,'seat observations do not perform a full arrival simulation');
    assert.equal(fog0.observation.view.player,0);assert.equal(fog1.observation.view.player,1);
    assertContent(initial.intel,fog0.observation.intel);
    assert.notDeepEqual(fog0.observation.view.sonar,fog1.observation.view.sonar);
    const hidden=fog0.observation.view.outposts.filter((o:{visibility:number})=>o.visibility!==2);
    assertContent(fog0.observation.view,JSON.parse(JSON.stringify(projectPlayerView(createEightPlayerScenario(),0))));
    assert.ok(hidden.every((o:object)=>'owner'in o&&!('drillers'in o)&&!('shield'in o)&&!('metrics'in o)));
    const future=await (await request('perspective',{player:0,kind:'preview',ticks:1})).json();
    assert.equal(future.frame.player,0);assert.equal(future.frame.targetTick,initial.tick+1);
    assert.equal((await request('perspective',{player:8})).status,400);
    const standings = await (await fetch(base + "/api/standings")).json();
    assert.equal(standings.players.length, 8);
    assert.equal(standings.ended, false);
    assertContent(standings.winners, []);
    assert.equal(standings.rankingTieBreak, "local-seat-id");
    const session = async (seat: number) =>
      (await (await request("chat/session", { seat })).json()).token as string;
    const chatRequest = async (
      path: string,
      token: string,
      body: unknown = {},
    ) =>
      fetch(base + "/api/chat/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lab-seat-token": token,
        },
        body: JSON.stringify(body),
      });
    async function assertCommanderIdentity(view:any, token:string, seat:number) {
      assert.equal(typeof view.commanderRoomId,'string');assert.ok(view.commanderRoomId.length>0);
      const response=await fetch(base+'/api/commander/list',{method:'POST',headers:{'Content-Type':'application/json','x-lab-seat-token':token},body:'{}'});
      assert.equal(response.status,200);const thread=await response.json();
      assert.equal(thread.roomId,view.commanderRoomId);assert.equal(thread.player,seat);
    }
    const t0 = await session(0),
      t1 = await session(1),
      t2 = await session(2);
    await assertCommanderIdentity(initial,t0,0);
    assert.equal((await chatRequest("list", "invalid")).status, 400);
    assert.equal((await request("chat/session", { seat: 8 })).status, 400);
    const dm = { id: "dm-1", to: 1, text: "仅双方可见" };
    assert.equal((await chatRequest("send", t0, dm)).status, 200);
    await chatRequest("send", t0, dm);
    await chatRequest("send", t0, {
      id: "public-1",
      to: null,
      text: "公开消息",
    });
    assert.equal(
      (await (await chatRequest("list", t0)).json()).messages.length,
      2,
    );
    assert.equal(
      (await (await chatRequest("list", t1)).json()).messages.length,
      2,
    );
    const third = (await (await chatRequest("list", t2)).json()).messages;
    assert.equal(third.length, 1);
    assert.equal(third[0].text, "公开消息");
    assert.equal(
      (await chatRequest("send", t0, { id: "bad", to: 8, text: "x" })).status,
      400,
    );
    assert.equal(
      (await chatRequest("send", t0, { id: "empty", to: null, text: " " }))
        .status,
      400,
    );
    const command = {
      id: "browser-test",
      player: 0,
      action: {
        kind: "launch",
        source: "织女星",
        destination: "暮光",
        drillers: 30,
      },
    };
    const accepted = await request("order", command);
    assert.equal(accepted.status, 200);
    const first = await accepted.json();
    assert.equal(first.fleets.length, 1);
    assert.equal(first.tick,initial.tick);
    assert.equal(first.manualCommandsByPlayer['0'].version,1);
    assert.equal(first.manualCommandsByPlayer['0'].receipts[0].orderId,command.id);
    assert.equal(first.manualCommandsByPlayer['0'].receipts[0].outcome,'applied');
    assert.notEqual(first.predictionSource.revision,initial.predictionSource.revision,'same-tick command invalidates prediction');
    const commandSource=await(await fetch(base+'/api/prediction-source?'+new URLSearchParams(first.predictionSource))).json();
    assert.equal(createHash("sha256").update(saveRoom(commandSource.room,{trustedLocalStorage:true})).digest("hex"),commandSource.revision);
    assert.equal(commandSource.room.state.commands.at(-1).id,command.id);
    const repeated=await (await request("order", command)).json();
    assertContent(repeated,first);
    assert.deepEqual(repeated.predictionSource,first.predictionSource,'idempotent commands retain prediction cache versions');
    assert.equal((await fetch(base+'/api/prediction-source?'+sourceParams)).status,409,'older snapshots cannot initialize a new prediction');
    assert.equal(
      (
        await fetch(base + "/api/new", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await request("step", { ticks: -1 })).status, 400);
    const snapshot = await (await fetch(base + "/api/export")).json();
    const prediction = await (await request("preview", { ticks: 6 })).json();
    assertContent((await(await fetch(base+'/api/tick-times')).json()).records,timeBaseline.records);
    assert.equal(prediction.tick, 106);
    assert.equal('commanderRoomId' in prediction,false,'forecast snapshots must not impersonate a live conversation');
    assertContent(await (await fetch(base + "/api/state")).json(), first);
    assertContent(
      await (await fetch(base + "/api/export")).json(),
      snapshot,
    );
    assert.equal((await request("preview", { ticks: 1441 })).status, 400);
    assert.equal((await request("preview", { ticks: -1 })).status, 400);
    const advanced = await (await request("step", { ticks: 6 })).json();
    assertForecastContent(prediction, advanced);
    assert.deepEqual(advanced.manualCommandsByPlayer['0'].receipts,first.manualCommandsByPlayer['0'].receipts,'advancing the game does not invent additional manual actions');
    assert.equal(advanced.tick, 106);
    assert.equal(advanced.commanderRoomId,initial.commanderRoomId);
    await assertCommanderIdentity(advanced,t0,0);

    await stop();
    await start();
    const restoredToken = await session(1);
    const restarted=await(await fetch(base+"/api/state")).json();
    assert.equal(restarted.commanderRoomId,advanced.commanderRoomId);
    await assertCommanderIdentity(restarted,restoredToken,1);
    assert.equal(
      (await (await chatRequest("list", restoredToken)).json()).messages.length,
      2,
    );
    assertContent(await (await fetch(base + "/api/state")).json(), advanced);
    const imported=await (await request("import", snapshot)).json();
    assertContent(imported, first);
    assert.notEqual(imported.commanderRoomId,first.commanderRoomId);
    await assertCommanderIdentity(imported,await session(0),0);
    assert.notEqual(imported.predictionSource.roomId,first.predictionSource.roomId,'same seed/tick import creates a new history and prediction scope');
    const rejected = await request("order", {
      id: "bad",
      player: 1,
      action: {
        kind: "launch",
        source: "织女星",
        destination: "暮光",
        drillers: 1,
      },
    });
    assert.equal(rejected.status, 400);
    assertContent(await (await fetch(base + "/api/state")).json(), first);
    await request("step", { ticks: 6 });
    const scheduledOrder = {
      id: "future-api-test",
      player: 0,
      action: {
        kind: "launch",
        source: "回声",
        destination: "织女星",
        drillers: 5,
      },
    };
    const scheduledView = await (
      await request("schedule", { order: scheduledOrder, departureTick: 114 })
    ).json();
    assert.equal(scheduledView.scheduled[0].status, "pending");
    assert.equal(
      (await request("cancel-schedule", { id: scheduledOrder.id, player: 1 }))
        .status,
      400,
    );
    const plannedSnapshot = await (await fetch(base + "/api/export")).json();
    const predictedPlan = await (await request("preview", { ticks: 8 })).json();
    await stop();
    await start();
    assertContent(
      await (await fetch(base + "/api/state")).json(),
      scheduledView,
    );
    const executedPlan=await (await request("step", { ticks: 8 })).json();
    assertForecastContent(predictedPlan,executedPlan);
    assert.deepEqual(executedPlan.manualCommandsByPlayer['0'].receipts,scheduledView.manualCommandsByPlayer['0'].receipts,'executing a scheduled action retains its original scheduled receipt');
    await request("import", plannedSnapshot);
    assert.equal(
      (
        await (
          await request("cancel-schedule", { id: scheduledOrder.id, player: 0 })
        ).json()
      ).scheduled[0].status,
      "cancelled",
    );
    await request("import", snapshot);
    await request("step", { ticks: 6 });
    let previousRoomId=(await(await fetch(base+"/api/state")).json()).commanderRoomId;
    for (const players of [2, 10]) {
      const created = await (
        await request("new", { players, seed: 4300 })
      ).json();
      assert.equal(created.players.length, players);
      assert.equal(created.outposts.length, players * 10);
      assert.equal(created.map.players, players);
      assert.equal(created.map.algorithm, 'quantity-priority-v1');
      assert.equal(created.map.selection.territoryCounts.length, players);
      assert.equal(created.tick, 0);
      assert.notEqual(created.commanderRoomId,previousRoomId);
      const token = await session(players - 1);
      await assertCommanderIdentity(created,token,players-1);
      assert.equal((await chatRequest("list", token)).status, 200);
      assert.equal(
        (await request("chat/session", { seat: players })).status,
        400,
      );
      const exported = await (await fetch(base + "/api/export")).json();
      await stop();
      await start();
      const restartedCreated=await(await fetch(base+"/api/state")).json();
      assertContent(restartedCreated,created);
      assert.equal(restartedCreated.commanderRoomId,created.commanderRoomId);
      await assertCommanderIdentity(restartedCreated,await session(players-1),players-1);
      const importedCreated=await(await request("import",exported)).json();
      assertContent(importedCreated,created);
      assert.equal(importedCreated.commanderRoomId,created.commanderRoomId,'saved player room identity is restored independently of prediction cache scope');
      assert.notEqual(importedCreated.predictionSource.roomId,created.predictionSource.roomId);
      await assertCommanderIdentity(importedCreated,await session(players-1),players-1);
      previousRoomId=importedCreated.commanderRoomId;
    }
    const current=await (await fetch(base+'/api/state')).json();
    const own=current.outposts.find((o:{owner:number})=>o.owner===0);
    const planned={id:'scheduled-shield',player:0,action:{kind:'set-shields',outpostId:own.id,enabled:false}};
    assert.equal((await request('schedule-order',{order:planned,issueTick:current.tick+1})).status,200);
    assert.equal((await request('order',planned)).status,400);
    await stop();await start();
    assert.equal((await (await fetch(base+'/api/scheduled-orders')).json())[0].status,'pending');
    assert.equal((await request('step',{ticks:1})).status,200);
    assert.equal((await (await fetch(base+'/api/scheduled-orders')).json())[0].status,'executed');
    for (const players of [1, 11, 2.5])
      assert.equal((await request("new", { players })).status, 400);
    const beforeModeError=await (await fetch(base+'/api/state')).json();
    assert.equal((await request('new',{players:8,seed:4300,mapMode:'unknown'})).status,400);
    assertContent(await (await fetch(base+'/api/state')).json(),beforeModeError);
    const originalMap=await (await request('new',{players:8,seed:4300,mapMode:'original'})).json();
    assert.equal(originalMap.map.algorithm,'apk12075-rules4300');
    assert.ok(originalMap.map.seed>=4300);
    const generatorRatio=originalMap.outposts.filter((o:{type:string})=>o.type==='generator').length/originalMap.outposts.length;
    assert.ok(generatorRatio>=.4&&generatorRatio<=.5);
    await stop();await start();
    assertContent(await (await fetch(base+'/api/state')).json(),originalMap);
    assert.equal((await request('auto-step',{runId:'old-browser'})).status,400);
    assert.equal((await request('auto-advance',{enabled:'true'})).status,400);
    const autoStart=await (await request('auto-advance',{enabled:true})).json();
    assert.equal(autoStart.autoAdvance.enabled,true);
    // No state polling, heartbeats or browser step calls during this interval.
    await new Promise(resolve=>setTimeout(resolve,7000));
    const autoStopped=await (await request('auto-advance',{enabled:false})).json();
    assert.ok(autoStopped.tick>autoStart.tick,'the service advances with every browser absent');
    assert.equal(autoStopped.autoAdvance.enabled,false);
    await new Promise(resolve=>setTimeout(resolve,6000));
    assert.equal((await (await fetch(base+'/api/state')).json()).tick,autoStopped.tick);
    await request('auto-advance',{enabled:true});
    await stop();await start();
    assert.equal((await (await fetch(base+'/api/state')).json()).autoAdvance.enabled,false,'restart requires explicitly enabling test advancement');
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
