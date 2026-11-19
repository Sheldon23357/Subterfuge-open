import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFleetScenario,submitFleetOrder,saveFleetSnapshot,restoreFleetSnapshot,exportFleetReplay,replayFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {RoomStore} from '../packages/server/src/room-store.js';

test('a persistent room accepts and restores more than 10000 commands while portable imports remain bounded',async()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.match={mode:'mining',neptuniumGoal:10000};
 let s=createFleetScenario(cfg);
 // Same-time check-ins do not alter an already current check-in time. This
 // analytic fixture avoids constructing the prefix with 10000 redundant clones;
 // the database restore below independently re-executes every command.
 s.commands=Array.from({length:10000},(_,i)=>({id:`check-${i}`,player:0,action:{kind:'check-in' as const},tick:100}));
 const sample=submitFleetOrder(createFleetScenario(cfg),{id:'check-0',player:0,action:{kind:'check-in'}}).state;
 assert.equal(JSON.stringify(s.commands[0]),JSON.stringify(sample.commands[0]));
 const command={id:'check-10000',player:0,action:{kind:'check-in' as const}};
 s=submitFleetOrder(s,command).state;assert.equal(s.commands.length,10001);
 assert.equal(submitFleetOrder(s,command).duplicate,true);
 assert.throws(()=>saveFleetSnapshot(s),/Portable snapshot/);
 assert.throws(()=>replayFleetScenario(exportFleetReplay(s)),/command history/);
 const invalid=exportFleetReplay(s);invalid.commands[0]!.player=99;
 assert.throws(()=>replayFleetScenario(invalid,{trustedLocalStorage:true}),/count/);
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-long-history-'));let store=new RoomStore(join(dir,'room.sqlite'));
 try{
  const room={state:s,scheduled:[]};assert.equal(store.commit(room,0),1);store.close();store=new RoomStore(join(dir,'room.sqlite'));
  const loaded=store.load()!;assert.deepEqual(loaded,{revision:1,room});
  assert.equal(submitFleetOrder(loaded.room.state,command).duplicate,true);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('trusted local size allowance still requires matching snapshot and replay',()=>{
 const cfg=JSON.parse(fs.readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,s=createFleetScenario(cfg);
 const text=saveFleetSnapshot(s)+' '.repeat(20_000_000);
 assert.throws(()=>restoreFleetSnapshot(text),/too large/);
 assert.deepEqual(restoreFleetSnapshot(text,{trustedLocalStorage:true}),s);
 const altered=JSON.parse(saveFleetSnapshot(s));altered.expected.economy.players[0].neptunium=99;
 assert.throws(()=>restoreFleetSnapshot(JSON.stringify(altered),{trustedLocalStorage:true}),/disagree/);
});
