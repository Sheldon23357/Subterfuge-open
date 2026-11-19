import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {PlayerConnection} from '../packages/client/src/player-connection.js';
import {playerGameCommand} from '../packages/client/src/player-game.js';
import {manualRequestIdentity} from '../packages/client/src/manual-command-feedback.js';
import type {PlayerObservation} from '../packages/contracts/src/index.js';
test('normal gameplay has no takeover or handback controls, dead adapters or callable owner release method',()=>{
 for(const file of ['ManualCommandArrangements.tsx','manual-release.ts'])assert.equal(existsSync('packages/client/src/'+file),false);
 for(const file of ['Game.tsx','player-main.tsx','main.tsx','player-game.ts','player-connection.ts','use-player-control.ts','PlayerControlStatus.tsx','ManualCommandProtectionNote.tsx','manual-command-feedback.ts']){
  const source=readFileSync('packages/client/src/'+file,'utf8');
  assert.ok(!/manual-commands\/release|releaseManual|manualReleaseRequest|openArrangements|takeover|完全接管|交还 AI|管理手动安排|暂停 AI/.test(source),file);
 }
 assert.equal('releaseManual' in PlayerConnection.prototype,false);
 const observation={} as PlayerObservation;
 for(const path of ['manual-commands/release','takeover','pause','resume']){
  assert.throws(()=>playerGameCommand(observation,path,{id:'not-an-operation'}),/不支持/);
  assert.equal(manualRequestIdentity(path,{id:'not-an-operation',player:0}),null);
 }
});
test('control hook is read-only while ordinary manual order and collateral-safety transports remain',()=>{
 const hook=readFileSync('packages/client/src/use-player-control.ts','utf8');assert.ok(hook.includes("'/player/v2/owner/control',undefined,controller.signal"));assert.ok(!hook.includes("action:"));
 const connection=readFileSync('packages/client/src/player-connection.ts','utf8');for(const path of ['/player/v2/owner/commands'])assert.ok(connection.includes(path));
 const player=readFileSync('packages/client/src/player-main.tsx','utf8');assert.ok(player.includes('control.blocked'));assert.ok(player.includes('playerManualCommandNotice(next,command)'));assert.ok(player.includes('window.confirm(manualCancellationQuestion'));
});
