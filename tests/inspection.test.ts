import test from "node:test";
import assert from "node:assert/strict";
import {
  outpostMetrics,
  fleetControls,
  routeEstimate,
} from "../packages/server/src/inspection.js";
import { createEightPlayerScenario } from "../packages/server/src/eight-player.js";
import {
  advanceFleetScenario,
  submitFleetOrder,
} from "../packages/engine/src/index.js";
test("outpost metrics use shared capacity including fleets and actual production phase", () => {
  const s = createEightPlayerScenario();
  const factory = outpostMetrics(s, "织女星"),
    gen = outpostMetrics(s, "回声");
  assert.equal(factory.output, 6);
  assert.equal(factory.capacity, 200);
  assert.equal(factory.used, 200);
  assert.equal(factory.paused, true);
  assert.equal(factory.nextMinutes, null);
  assert.equal(gen.contribution, 50);
  assert.equal(gen.capacity, 200);
  const sent = submitFleetOrder(s, {
    id: "metrics-fleet",
    player: 0,
    action: {
      kind: "launch",
      source: "织女星",
      destination: "暮光",
      drillers: 20,
    },
  }).state;
  assert.equal(outpostMetrics(sent, "回声").used, 200);
  s.economy.outposts.find((o) => o.id === "织女星")!.drillers = 50;
  const operating = outpostMetrics(s, "织女星");
  assert.equal(operating.nextMinutes, 480);
  const after = advanceFleetScenario(s, 148);
  assert.equal(
    after.economy.outposts.find((o) => o.id === "织女星")!.drillers,
    56,
  );
  const mine = s.economy.outposts.find((o) => o.id === "深井 1")!;
  mine.owner = 0;
  const mining = outpostMetrics(s, mine.id);
  assert.equal(mining.cycleMinutes, 480);
  assert.equal(mining.neptunium, 40);
  assert.equal(mining.mines, 1);
  assert.equal(outpostMetrics(s, "深井 2").capacity, null);
});
test("drag estimate matches basic fleet arrival, wraps and leaves state untouched", () => {
  const s = createEightPlayerScenario(),
    before = JSON.stringify(s);
  const estimate = routeEstimate(s, {
    source: "织女星",
    point: s.initial.positions["回声"]!,
    issueTick: 100,
  });
  assert.ok(estimate.arrivalTick);
  const sent = submitFleetOrder(s, {
    id: "eta-check",
    player: 0,
    action: {
      kind: "launch",
      source: "织女星",
      destination: "回声",
      drillers: 1,
    },
  }).state;
  const arrived = advanceFleetScenario(sent, estimate.arrivalTick!);
  assert.equal(
    arrived.events.find(
      (e) => e.subject === "eta-check" && e.kind === "unloaded",
    )!.tick,
    estimate.arrivalTick,
  );
  const p = s.initial.positions["回声"]!;
  assert.deepEqual(
    routeEstimate(s, {
      source: "织女星",
      point: { x: p.x + s.initial.size.width, y: p.y },
      issueTick: 100,
    }),
    estimate,
  );
  assert.equal(JSON.stringify(s), before);
  assert.throws(() =>
    routeEstimate(s, { source: "织女星", point: p, issueTick: 99 }),
  );
});

test('route estimates remain available beyond 10000 elapsed ticks and for future departures',()=>{
 const initial=createEightPlayerScenario();
 const late=advanceFleetScenario(advanceFleetScenario(initial,10099),10101);
 for(const delay of [0,100]){
  const state=delay?advanceFleetScenario(late,late.economy.tick+delay):late;
  const estimate=routeEstimate(late,{source:'织女星',point:late.initial.positions['回声']!,issueTick:state.economy.tick});
  assert.ok(estimate.arrivalTick!==null);
  const sent=submitFleetOrder(state,{id:`late-eta-${delay}`,player:0,action:{kind:'launch',source:'织女星',destination:'回声',drillers:1}}).state;
  const arrived=advanceFleetScenario(sent,estimate.arrivalTick!);
  const event=arrived.events.find(e=>e.subject===`late-eta-${delay}`&&e.kind==='unloaded');
  assert.equal(event?.tick,estimate.arrivalTick);
  assert.equal(estimate.minutes,(event!.tick-state.economy.tick)*10);
 }
});

test('fleet controls show ordinary cancellation and one-use return availability',()=>{
 const s=createEightPlayerScenario();
 const source=s.economy.outposts.find(o=>o.owner===0&&o.drillers>0)!;
 const target=s.economy.outposts.find(o=>o.id!==source.id)!;
 const next=submitFleetOrder(s,{id:'control-sub',player:0,action:{kind:'launch',delaySeconds:600,source:source.id,destination:target.id,drillers:1}}).state;
 const f=next.fleets.find(f=>f.id==='control-sub')!;
 assert.deepEqual(fleetControls(next,f),{canReturn:true,returned:false,departureCommitted:false,canCancelLaunch:true});
 f.state='moving';assert.deepEqual(fleetControls(next,f),{canReturn:true,returned:false,departureCommitted:true,canCancelLaunch:false});
 f.returned=true;assert.equal(fleetControls(next,f).canReturn,false);
});
