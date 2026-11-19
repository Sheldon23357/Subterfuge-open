import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createFleetScenario,submitFleetOrder,type FleetSetup,projectPlayerActivity} from '../packages/engine/src/index.js';
import {LobbyStore} from '../packages/server/src/lobby-store.js';
import {PlayerAccess} from '../packages/server/src/player-access.js';
import {createWaitingLobby,submitLobbyMembership} from '../packages/server/src/waiting-lobby.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function waitingFixture(){
 const access=PlayerAccess.generate(2);let lobby=createWaitingLobby(access);
 for(const player of [0,1])lobby=submitLobbyMembership(lobby,{id:'join'+player,player,kind:'join'});
 const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;cfg.economy.initialTick=0;
 const state=submitFleetOrder(createFleetScenario(cfg),{id:'shield',player:0,action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}}).state;
 return {lobby,room:{state,scheduled:[],playerRoomId:access.roomId}};
}
test('durable checkpoint restores verified state and journals, replays its suffix, and retains independent audit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lobby-recovery-')),path=join(dir,'room.sqlite');
 let store=new LobbyStore(path,{}, {buildId:'same-build'});
 try{
  const {lobby,room}=waitingFixture();store.commit(lobby,0,room);store.commitStart(room,{id:'start',player:0,seed:4300,startedAtMs:1000000},1);
  await store.sync(1300000,2);store.checkpoint(true);
  await store.sync(1350000,store.current()!.revision);const expected=store.load()!;
  const activity=projectPlayerActivity(expected.runtime!.room.state,0);store.close(false);
  store=new LobbyStore(path,{}, {buildId:'same-build'});
  assert.deepEqual(store.load(),expected);assert.equal(store.recoveredFromCheckpoint,true);
  assert.deepEqual(projectPlayerActivity(store.current()!.runtime!.room.state,0),activity);
  assert.deepEqual(store.verify(),expected);store.close(false);
  store=new LobbyStore(path,{}, {buildId:'changed-build'});assert.deepEqual(store.load(),expected);assert.equal(store.recoveredFromCheckpoint,false);
 }finally{store.close(false);rmSync(dir,{recursive:true,force:true});}
});
test('damaged checkpoint falls back to replay; checksum-rewritten corrupt authority still fails full audit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lobby-corrupt-')),path=join(dir,'room.sqlite');
 let store=new LobbyStore(path,{}, {buildId:'build'});
 try{
  const {lobby,room}=waitingFixture();store.commit(lobby,0,room);store.close(false);
  let db=new DatabaseSync(path);db.prepare("UPDATE lobby_recovery_checkpoint SET digest='corrupt'").run();db.close();
  store=new LobbyStore(path,{}, {buildId:'build'});assert.ok(store.current());assert.equal(store.recoveredFromCheckpoint,false);store.checkpoint(true);store.close(false);
  db=new DatabaseSync(path);const row=db.prepare('select payload from lobby_waiting_world').get()!;
  const raw=JSON.parse(String(row.payload)),snapshot=JSON.parse(raw.snapshot);snapshot.expected.economy.outposts[0].drillers++;raw.snapshot=JSON.stringify(snapshot);const payload=JSON.stringify(raw);
  db.prepare('UPDATE lobby_waiting_world SET payload=?,digest=?').run(payload,hash(payload));db.close();
  store=new LobbyStore(path,{}, {buildId:'build'});assert.throws(()=>store.current(),/disagree/);assert.throws(()=>store.verify(),/disagree/);
 }finally{store.close(false);rmSync(dir,{recursive:true,force:true});}
});
test('background full audit opens SQLite read-only and leaves the live connection data version unchanged',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lobby-audit-')),path=join(dir,'room.sqlite');const store=new LobbyStore(path);
 try{
  const {lobby,room}=waitingFixture();store.commit(lobby,0,room);
  const observer=new DatabaseSync(path),before=observer.prepare('PRAGMA data_version').get()!.data_version;
  const audit=new LobbyStore(path,{}, {buildId:'build',auditOnly:true});
  try{assert.ok(audit.verify());assert.throws(()=>audit.protocol,/no protocol authority/);}finally{audit.close(false);}
  assert.equal(observer.prepare('PRAGMA data_version').get()!.data_version,before);observer.close();
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
