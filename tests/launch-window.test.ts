import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,projectPlayerView,saveFleetSnapshot,restoreFleetSnapshot,type FleetSetup} from '../packages/engine/src/index.js';
import {fleetControls} from '../packages/server/src/inspection.js';
import {observation} from '../packages/server/src/player-api.js';
import {forecastKnownObservation} from '../packages/prediction/src/index.js';
import {enemyWaitingSources} from '../packages/ai/src/controller/analysis/waiting-defense.js';

function launched(seconds=0){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  return submitFleetOrder(createFleetScenario(cfg),{id:'boat',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:27}},seconds).state;
}
test('explicit rule activation preserves accepted history and locks new cancellations at the activation tick',()=>{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.launchCancellationLockTick=102;
  let s=createFleetScenario(cfg);
  s=submitFleetOrder(s,{id:'old',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:27}}).state;
  s=advanceFleetScenario(s,101);
  assert.equal(projectPlayerView(s,0).fleets[0]!.canCancelLaunch,true);
  s=submitFleetOrder(s,{id:'old-cancel',player:0,action:{kind:'cancel-launch',fleetId:'old'}}).state;
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
  s=submitFleetOrder(s,{id:'new',player:0,action:{kind:'launch',delaySeconds:600,source:'蓝方工厂',destination:'红方矿场',drillers:27}}).state;
  s=advanceFleetScenario(s,102);
  assert.equal(projectPlayerView(s,0).fleets[0]!.canCancelLaunch,false);
  assert.throws(()=>submitFleetOrder(s,{id:'new-cancel',player:0,action:{kind:'cancel-launch',fleetId:'new'}}),/no longer be cancelled/);
  assert.deepEqual(restoreFleetSnapshot(saveFleetSnapshot(s)),s);
});
test('exact zero closes authoritative cancellation and both UI controls without changing movement',()=>{
  const before=launched(),s=advanceFleetScenario(before,101),f=s.fleets[0]!,saved=JSON.stringify(s);
  assert.equal(f.state,'waiting');assert.equal(f.secondsUntilLaunch,0);
  assert.equal(projectPlayerView(before,0).fleets[0]!.canCancelLaunch,true);
  assert.equal(projectPlayerView(s,0).fleets[0]!.canCancelLaunch,false);
  assert.equal(fleetControls(s,f).canCancelLaunch,false);
  assert.throws(()=>submitFleetOrder(s,{id:'cancel',player:0,action:{kind:'cancel-launch',fleetId:'boat'}}),/no longer be cancelled/);
  assert.equal(JSON.stringify(s),saved);
  const enemy=projectPlayerView(s,1);
  assert.equal(enemy.fleets[0]!.departureCommitted,true);
  assert.equal(enemy.fleets[0]!.secondsUntilLaunch,undefined);
  assert.equal(enemyWaitingSources(enemy).has('boat'),false);
  assert.equal(advanceFleetScenario(s,102).fleets[0]!.state,'moving');
});
test('fractional phase closes exactly at the deadline, including countdowns crossing a tick',()=>{
  const s=advanceFleetScenario(launched(590),101);
  const cancel=(seconds:number)=>submitFleetOrder(s,{id:'cancel',player:0,action:{kind:'cancel-launch',fleetId:'boat'}},seconds);
  assert.equal(cancel(589).state.fleets[0]!.used,false);
  assert.throws(()=>cancel(590),/no longer be cancelled/);
  for(const phase of [589,590,591]){
    const frame=structuredClone(s);frame.secondsSinceLastTick=phase;
    assert.equal(fleetControls(frame,frame.fleets[0]!).canCancelLaunch,phase<590);
    assert.equal(projectPlayerView(frame,0).fleets[0]!.canCancelLaunch,phase<590);
  }
});
test('prediction cannot recall committed enemy troops or misclassify a committed own fleet as prisoner transport',()=>{
  const s=advanceFleetScenario(launched(),101);
  for(const player of [0,1]){
    const o=observation({state:s,scheduled:[]},player,'window');
    const result=forecastKnownObservation(o,102,[],'defend');
    assert.equal(result.status,'conditional');
    if(result.status!=='conditional')continue;
    assert.equal(result.result.fleets.find(f=>f.id==='boat')!.state,'moving');
    if(player===0){
      const cancelled=forecastKnownObservation(o,102,[{id:'cancel',issueTick:101,action:{kind:'cancel-launch',fleetId:'boat'}}]);
      assert.equal(cancelled.status,'conditional');
      if(cancelled.status==='conditional')assert.notEqual(cancelled.orders[0]!.status,'executed');
    }
  }
});
