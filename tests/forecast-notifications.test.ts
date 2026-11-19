import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createFleetScenario,submitFleetOrder,type FleetSetup,type Fleet} from '../packages/engine/src/fleet-scenario.js';
import {prepareForecastKnowledge} from '../packages/engine/src/forecast-knowledge.js';
import {buildForecastWorld} from '../packages/engine/src/forecast-world.js';
import {createForecastSonarCollector,forecastEventMinutes} from '../packages/engine/src/forecast-notifications.js';
function contactFixture(drillers=[10]){
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};const built=buildForecastWorld(prepareForecastKnowledge(createFleetScenario(cfg),0));
 if(built.status!=='conditional')throw Error(built.reasons.join(','));
 const initial=built.state;
 initial.fleets=drillers.map((n,i):Fleet=>({id:'contact-'+i,slot:128+i,used:true,owner:1,source:cfg.economy.outposts[1]!.id,destination:cfg.economy.outposts[2]!.id,drillers:n,position:{x:35,y:35},previous:{x:35,y:35},state:'moving',secondsUntilLaunch:0,fractionMoved:0,gift:false,giftSeconds:0}));
 const next=()=>{const s=structuredClone(initial);s.economy.tick++;for(const f of s.fleets)f.position={x:2,y:3};return s;};
 return {initial,next};
}
test('forecast sonar notices retain minute rounding and recipient lifecycle boundaries',()=>{
 for(const [phase,minutes]of [[0,11],[1,10],[59,10],[60,10],[599,1]]){
  const f=contactFixture(),collector=createForecastSonarCollector(f.initial,0,phase!);collector.sample(f.next());
  const [notice]=collector.result();assert.ok(notice);assert.equal(notice.minutesBeforeSending,minutes);
  assert.equal(notice.generateAlert,false);assert.equal(notice.sendNotification,true);assert.deepEqual(notice.position,{x:2,y:3});
 }
 assert.equal(forecastEventMinutes(100,1,100),null);assert.equal(forecastEventMinutes(100,0,100),1);
 for(const ended of [false,true]){
  const f=contactFixture(),collector=createForecastSonarCollector(f.initial,0,0),next=f.next();next.economy.players[0]!.active=false;
  if(ended)next.events.push({sequence:0,tick:101,fraction:0,kind:'game-ended',subject:'match',details:{player:1,team:null}});
  collector.sample(next);assert.equal(collector.result().length,Number(ended));
 }
});
test('single ordinary contact requires ten moving drillers and excludes own, unused and already visible fleets',()=>{
 for(const count of [1,9,10]){
  const f=contactFixture([count]),collector=createForecastSonarCollector(f.initial,0,0);collector.sample(f.next());assert.equal(collector.result().length,count>=10?1:0);
 }
 for(const change of [(f:Fleet)=>{f.owner=0;},(f:Fleet)=>{f.used=false;},(f:Fleet)=>{f.state='waiting';},(f:Fleet)=>{f.position={x:2,y:3};}]){
  const f=contactFixture();change(f.initial.fleets[0]!);const collector=createForecastSonarCollector(f.initial,0,0);collector.sample(f.next());assert.deepEqual(collector.result(),[]);
 }
});
test('multiple positive contacts bypass the single-contact force threshold and choose first slot',()=>{
 const f=contactFixture([1,2]),before=JSON.stringify(f.initial),collector=createForecastSonarCollector(f.initial,0,0);collector.sample(f.next());
 assert.equal(collector.result().length,1);assert.equal(collector.result()[0]!.fleetId,'contact-0');assert.equal(collector.result()[0]!.multiple,true);assert.equal(JSON.stringify(f.initial),before);
});

test('isolated collector tracks known fleet sonar reentry without accepting authoritative states',()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
 cfg.size={width:80,height:80};
 const live=submitFleetOrder(createFleetScenario(cfg),{id:'known-contact',player:1,action:{kind:'launch',source:cfg.economy.outposts[1]!.id,destination:cfg.economy.outposts[2]!.id,drillers:10}}).state;
 assert.throws(()=>createForecastSonarCollector(live,0,250),/Restricted/);
 const built=buildForecastWorld(prepareForecastKnowledge(live,0));assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 const state=built.state;state.fleets[0]!.state='moving';
 const collector=createForecastSonarCollector(state,0,250),before=JSON.stringify(state);
 const outside=structuredClone(state);outside.economy.tick=101;outside.fleets[0]!.position={x:35,y:35};
 collector.sample(outside);assert.deepEqual(collector.result(),[]);
 const returned=structuredClone(outside);returned.economy.tick=102;returned.fleets[0]!.position={x:1,y:0};
 collector.sample(returned);
 // Pc.handleEvent suppresses dead recipients only while the match is running.
 // Exercise the collector adapter too, not just the extracted function above.
 const deadCollector=createForecastSonarCollector(state,0,250);
 deadCollector.sample(outside);
 const eliminated=structuredClone(returned);eliminated.economy.players[0]!.active=false;
 deadCollector.sample(eliminated);assert.deepEqual(deadCollector.result(),[]);
 const endedCollector=createForecastSonarCollector(state,0,250);
 endedCollector.sample(outside);
 eliminated.events.push({sequence:eliminated.events.length,tick:102,fraction:0,kind:'game-ended',subject:'match',details:{player:1,team:null}});
 endedCollector.sample(eliminated);
 assert.equal(endedCollector.result().length,1,'ended matches retain original dead-recipient notification behavior');
 assert.deepEqual(collector.result(),[{kind:'sonar-contact',tick:102,minutesBeforeSending:16,fleetId:'known-contact',position:{x:1,y:0},multiple:false,sendNotification:true,generateAlert:false}]);
 const copy=collector.result();copy[0]!.position.x=999;assert.equal(collector.result()[0]!.position.x,1);
 assert.equal(JSON.stringify(state),before);assert.equal(collector.horizonTick,172);
 assert.throws(()=>collector.sample(returned),/consecutive/);
 const empty=structuredClone(returned);empty.economy.tick=103;empty.fleets=[];collector.sample(empty);
 const reused=structuredClone(returned);reused.economy.tick=104;reused.fleets[0]!.id='reused-slot';collector.sample(reused);
 assert.equal(collector.result().length,1,'unused slots retain visibility as in original wn.compute');
});
