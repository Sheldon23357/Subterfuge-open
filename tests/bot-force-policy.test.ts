import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {attackRoutes} from '../packages/prediction/src/index.js';
import {forecastKnownPath} from '../packages/prediction/src/index.js';
import {botBufferedForce,botGarrisonPolicy,botCommitmentCost} from '../packages/ai/src/controller/analysis/tactical-force-policy.js';
import {planBot} from '../packages/ai/src/controller/local/bot-planner.js';

function fixture(incoming=0,home=100,defender=5){
  const c=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  c.match={mode:'domination',neptuniumGoal:200};c.size={width:80,height:80};
  c.positions={'蓝方工厂':{x:0,y:0},'红方矿场':{x:1,y:0},'红方后方':{x:30,y:30}};
  c.economy.outposts[0]!.drillers=home;
  c.economy.outposts[0]!.type='generator';
  c.economy.outposts[1]!.drillers=defender;c.economy.outposts[1]!.shield=0;c.economy.outposts[1]!.shieldMax=0;

  if(incoming)c.economy.outposts[1]!.drillers=incoming;
  let state=createFleetScenario(c);
  if(incoming)state=submitFleetOrder(state,{id:'threat',player:1,action:{kind:'launch',source:'红方矿场',destination:'蓝方工厂',drillers:incoming}}).state;
  return observation({state,scheduled:[]},0,'force-policy');
}

test('force buffer is proportional with integer rounding and no minimum extra troop count',()=>{
  assert.equal(botBufferedForce(1),2);
  assert.equal(botBufferedForce(5),7);
  assert.equal(botBufferedForce(20),28);
  assert.equal(botBufferedForce(5,0),5);
  assert.equal(botBufferedForce(5,0.4),7);
});

test('seat force buffer changes a verified buffered alternative without suppressing sound originals',()=>{
  const o=fixture();
  const bufferedForces:number[]=[];
  for(const forceBufferRatio of [0,0.5]){
    const decision=planBot(o,attackRoutes(o),{settings:{schemaVersion:2,forceBufferRatio,maxSimulations:96,maxElapsedMs:60000}});
    const chosen=decision.selected;
    assert.ok(chosen.captureTargets?.includes('红方矿场'),JSON.stringify(chosen));
    const buffered=decision.assessments.find(a=>a.status==='evaluated'&&a.candidate.forceSizing)?.candidate;
    assert.ok(buffered?.forceSizing,JSON.stringify(decision.assessments));
    const sizing=buffered.forceSizing;
    assert.equal(sizing.bufferedForce,sizing.testedMinimum+Math.ceil(sizing.testedMinimum*forceBufferRatio));
    assert.equal(Number(buffered.drafts[0]!.action.drillers),sizing.bufferedForce);
    bufferedForces.push(sizing.bufferedForce);
    const forecast=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:chosen.drafts});
    assert.equal(forecast.forecast.status,'conditional');
    if(forecast.forecast.status==='conditional')assert.equal(forecast.forecast.result.outposts.find(p=>p.id==='红方矿场')!.owner,0);
  }
  assert.ok(bufferedForces[1]!>bufferedForces[0]!,'raising the buffer must raise the verified buffered force');
});

test('garrison preference adapts to visible pressure and reservations without changing observation',()=>{
  const o=fixture(),before=structuredClone(o),source='蓝方工厂';
  const calm=botGarrisonPolicy(o,source);
  assert.ok(calm.spare>0&&calm.spare<100);
  o.view.outposts.find(p=>p.id==='红方矿场')!.drillers=100;
  const pressure=botGarrisonPolicy(o,source);
  assert.ok(pressure.desired>calm.desired);
  o.scheduled.push({id:'committed',player:0,status:'pending',issueTick:o.view.tick+10,
    action:{kind:'launch',source,destination:'红方矿场',drillers:60}});
  assert.equal(botGarrisonPolicy(o,source).available,40);
  assert.equal(botGarrisonPolicy(o,source).spare,0);
  o.scheduled=[];o.view.outposts.find(p=>p.id==='红方矿场')!.drillers=5;
  assert.deepEqual(botGarrisonPolicy(o,source),calm);
  assert.deepEqual(o,before);
});

test('a newly observed hostile fleet raises the garrison demand, and shields offset that demand',()=>{
  const o=fixture(90),source=o.view.outposts.find(p=>p.id==='蓝方工厂')!;
  const threatened=botGarrisonPolicy(o,source.id);
  assert.ok(threatened.desired>=90);
  assert.equal(threatened.spare,9,'observed ordinary attack reserves its force plus the defender tie-break, rather than a fixed 15% margin');
  source.shield=200;
  const shielded=botGarrisonPolicy(o,source.id);
  assert.ok(shielded.spare>threatened.spare);
  assert.equal(shielded.desired,0,'sufficient shields can remove the observed garrison demand');
  o.view.fleets=[];source.shield=0;
  assert.ok(botGarrisonPolicy(o,source.id).desired<threatened.desired);
});

test('joint launches share the garrison budget rather than each claiming the same reserve',()=>{
  const o=fixture(),source='蓝方工厂';
  o.view.outposts.find(p=>p.id==='红方矿场')!.drillers=80;
  const drafts=[30,60].map((drillers,i)=>({id:`d${i}`,issueTick:o.view.tick,
    action:{kind:'launch',source,destination:'红方矿场',drillers}}));
  const joint=botCommitmentCost(o,drafts),isolated=drafts.map(d=>botCommitmentCost(o,[d]));
  assert.ok(joint.shortfall>isolated.reduce((sum,c)=>sum+c.shortfall,0));
  assert.ok(botCommitmentCost(o,[{...drafts[0]!,action:{...drafts[0]!.action,drillers:100}}]).shortfall>joint.shortfall);
});

test('bot tests a funded margin and can select a sound smaller original while keeping a mobile garrison',()=>{
  const o=fixture(),decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  const selected=decision.selected;
  assert.ok(selected.captureTargets?.includes('红方矿场'),JSON.stringify(selected));
  const buffered=decision.assessments.find(a=>a.status==='evaluated'&&a.candidate.forceSizing)?.candidate;
  assert.ok(buffered?.forceSizing,JSON.stringify(decision.assessments));
  const force=Number(selected.drafts[0]!.action.drillers);
  assert.equal(Number(buffered.drafts[0]!.action.drillers),botBufferedForce(buffered.forceSizing.testedMinimum));
  assert.ok(force<50,'a five-troop target must not take the entire 100-troop garrison');
  assert.ok(100-force>=botGarrisonPolicy(o,'蓝方工厂').desired);
  const forecast=forecastKnownPath(o,{targetTick:o.view.tick+144,drafts:selected.drafts});
  assert.equal(forecast.forecast.status,'conditional');
  if(forecast.forecast.status==='conditional'){
    assert.equal(forecast.forecast.orders.some(d=>d.status==='failed'),false);
    assert.equal(forecast.forecast.result.outposts.find(p=>p.id==='红方矿场')!.owner,0);
  }
  assert.ok(decision.coverage.simulations<=96);
});

test('full-force expansion remains a legal evaluated alternative instead of failing a minimum-garrison gate',()=>{
  const o=fixture(0,10,8),decision=planBot(o,attackRoutes(o),{maxSimulations:96,maxElapsedMs:30000});
  assert.ok(decision.assessments.some(a=>a.status==='evaluated'&&a.candidate.drafts.some(d=>d.action.source==='蓝方工厂'&&d.action.drillers===10)));
  assert.ok(decision.selected.captureTargets?.includes('红方矿场'),JSON.stringify(decision.selected));
});

test('quiet sources have no fixed minimum reserve and commitment cost grows continuously',()=>{
  const o=fixture(),source='蓝方工厂';
  o.view.outposts.find(p=>p.id==='红方矿场')!.drillers=0;
  o.view.outposts.find(p=>p.id==='红方后方')!.drillers=0;
  assert.equal(botGarrisonPolicy(o,source).desired,0);
  assert.equal(botGarrisonPolicy(o,source).spare,100);
  const cost=(drillers:number)=>botCommitmentCost(o,[{id:'d',issueTick:o.view.tick,action:{kind:'launch',source,destination:'红方矿场',drillers}}]).transit;
  assert.ok(cost(100)>cost(99)&&cost(99)>cost(98));
  assert.ok(cost(100)-cost(99)<1,'emptying a source adds a smooth price, not an arbitrary cliff');
});
