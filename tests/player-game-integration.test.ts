import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import {
  createFleetScenario,
  projectPlayerView,
  fleetPublicIntel,
  submitFleetOrder,
  advanceFleetScenario,
  type FleetSetup,
} from "../packages/engine/src/index.js";
import type { PlayerObservation } from "../packages/contracts/src/index.js";
import { createKnownPrediction } from '../packages/prediction/src/index.js';
import {
  playerGameView,
  fleetArrivalOffset,
} from "../packages/client/src/game-view.js";
import {
  playerGameCommand,
  playerGameQuery,
} from "../packages/client/src/player-game.js";
import { PlayerConnection } from "../packages/client/src/player-connection.js";
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';
import {
  PlayerAccess,
  SerialExecutor,
} from "../packages/server/src/player-access.js";
import type { LabRoom } from "../packages/server/src/planning.js";

function fixture(hiddenDelta=0) {
  const setup = JSON.parse(fs.readFileSync("examples/fleet-lab.json", "utf8"))
    .initial as FleetSetup;
  setup.size = { width: 80, height: 80 };
  setup.positions["红方矿场"] = { x: 12, y: 0 };
  setup.positions["红方后方"] = { x: 25, y: 0 };
  setup.economy.outposts[2]!.drillers = 30-hiddenDelta;
  setup.economy.outposts[1]!.drillers += hiddenDelta;
  return { state: createFleetScenario(setup), scheduled: [] } as LabRoom;
}
function observed(room: LabRoom): PlayerObservation {
  return {
    roomId: "test",
    revision: "revision",
    view: projectPlayerView(room.state, 0),
    intel: fleetPublicIntel(room.state),
    scheduled: [],
    historyStartTick: 100,
    secondsSinceLastTick: room.state.secondsSinceLastTick ?? 0,
    realtime: true,
  };
}

test('stable names survive current, historical and future frame conversion without restoring hidden or stale economics',()=>{
  const room=fixture(),now=observed(room);
  now.outpostNames={'蓝方工厂':'LYRA','红方矿场':'POSEIDON','红方后方':'DEEP'};
  const before=JSON.stringify(now),past=structuredClone(now.view);
  past.tick-=1;past.outposts[0]!.drillers=17;
  const {match,...geometry}=structuredClone(now.view);
  const future={...geometry,format:'player-forecast/2' as const,
    targetTick:now.view.tick+10,observedAt:{tick:now.view.tick,seconds:0},certainty:'conditional' as const,
    assumptions:[],unknownArrivals:[],uncertainPlayers:[]};
  future.outposts.reverse();future.outposts.find(o=>o.id==='蓝方工厂')!.drillers=42;
  const current=playerGameView(now),history=playerGameView(now,past),predicted=playerGameView(now,future,[],0);
  for(const frame of [current,history,predicted]){
    assert.equal(frame.outposts.find(o=>o.id==='蓝方工厂')!.name,'LYRA');
    assert.equal(frame.perspective!.outpostNames['红方矿场'],'POSEIDON');
    assert.ok(frame.perspective!.unseenOutposts.every(o=>('owner'in o)&&!('drillers'in o)));

  }
  assert.equal(history.outposts[0]!.drillers,17);
  assert.equal(predicted.outposts[0]!.drillers,42);
  predicted.perspective!.outpostNames['蓝方工厂']='changed';
  assert.equal(JSON.stringify(now),before);
});



test("player deployment is immediate-only while other future commands remain available", () => {
  const room=fixture();room.state.secondsSinceLastTick=299;const now=observed(room);
  const order={id:'draft',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:20}};
  for(const departureTick of [101.5,103])assert.throws(()=>playerGameCommand(now,'schedule',{order,departureTick}),/仅支持立即出发/);
  for(const issueTick of [100,102,102.25])assert.throws(()=>playerGameCommand(now,'schedule-order',{order,issueTick}),/仅支持立即出发/);
  for(const delaySeconds of [1,600,900])assert.throws(()=>playerGameCommand(now,'order',{...order,action:{...order.action,delaySeconds}}),/仅支持立即出发/);
  assert.throws(()=>playerGameCommand(now,'order',{...order,issueTick:102}),/仅支持立即出发/);
  assert.throws(()=>playerGameCommand(now,'order',{...order,departureTick:103}),/仅支持立即出发/);
  const immediate=playerGameCommand(now,'order',order);
  assert.equal(immediate.kind,'order');if(immediate.kind==='order'){assert.equal(immediate.issueTick,undefined);assert.equal(immediate.action.delaySeconds,undefined);assert.equal('player' in immediate,false);}
  const recruit=playerGameCommand(now,'schedule-order',{order:{id:'hire',player:0,action:{kind:'hire',candidateId:'candidate'}},issueTick:103});
  assert.equal(recruit.kind,'order');if(recruit.kind==='order')assert.equal(recruit.issueTick,103);
  assert.throws(()=>playerGameCommand(now,'schedule',{order:{...order,player:1},departureTick:103}),/当前舰队/);
  for(const path of ['new','step','import','export'])assert.throws(()=>playerGameCommand(now,path,{}),/不支持/);
});

test("arrival shortcut uses the event tick rather than rounding a phase-reduced countdown one tick too early", () => {
  const fleet = {
    id: "f",
    owner: 0,
    position: { x: 0, y: 0 },
    drillers: 10,
    destination: "target",
    state: "waiting",
    gift: false,
    canCancelLaunch: true,
    departureMinutes: 10,
    arrivalMinutes: 1707,
    arrivalTick: 672,
  };
  assert.equal(fleetArrivalOffset(fleet, 500, 250), 172);
  assert.equal(
    fleetArrivalOffset({ ...fleet, arrivalTick: null }, 500, 250),
    172,
  );
  assert.equal(
    fleetArrivalOffset(
      { ...fleet, arrivalTick: null, arrivalMinutes: null },
      500,
      250,
    ),
    null,
  );
});
