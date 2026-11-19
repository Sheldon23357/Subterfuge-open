import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,submitFleetOrder,advanceFleetScenario,advanceOwnedFleetScenario,prepareForecastKnowledge,buildForecastWorld,enableForecastNotifications,readForecastNotifications,type FleetSetup} from '../packages/engine/src/index.js';
import {createKnownPrediction} from '../packages/prediction/src/index.js';
import {observation} from '../packages/server/src/player-api.js';

function fixture(){
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;

 return createFleetScenario(setup);
}
test('owned fleet advancement preserves public input isolation and identical settlement',()=>{
 const source=fixture(),before=structuredClone(source),owned=structuredClone(source);
 const expected=advanceFleetScenario(source,source.economy.tick+60);
 assert.equal(advanceOwnedFleetScenario(owned,owned.economy.tick+60),owned);assert.deepEqual(owned,expected);assert.deepEqual(source,before);
});
test('forecast checkpoints remain isolated across continuation and backward sibling predictions',()=>{
 const o=observation({state:fixture(),scheduled:[]},0,'forecast-cache'),before=structuredClone(o),start=o.view.tick;
 const session=createKnownPrediction(o,{collectResourceFrames:true});
 const first=session.predict(start+12),preserved=structuredClone(first);
 const later=session.predict(start+60);assert.deepEqual(later,createKnownPrediction(o,{collectResourceFrames:true}).predict(start+60));
 assert.deepEqual(first,preserved);assert.deepEqual(session.predict(start+6),createKnownPrediction(o,{collectResourceFrames:true}).predict(start+6));
 assert.deepEqual(session.predict(start+12),preserved);assert.deepEqual(o,before);
});

test('owned forecast advancement retains opt-in notification journals without leaking into a sibling',()=>{
 const source=fixture(),built=buildForecastWorld(prepareForecastKnowledge(source,0));
 assert.equal(built.status,'conditional');if(built.status!=='conditional')return;
 enableForecastNotifications(built.state);
 const immutable=advanceFleetScenario(built.state,built.state.economy.tick+36,true);
 advanceOwnedFleetScenario(built.state,built.state.economy.tick+36,true);
 assert.deepEqual(readForecastNotifications(built.state,0),readForecastNotifications(immutable,0));
 const preserved=readForecastNotifications(immutable,0);advanceOwnedFleetScenario(built.state,built.state.economy.tick+24,true);
 assert.deepEqual(readForecastNotifications(immutable,0),preserved);
});
