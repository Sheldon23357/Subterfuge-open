import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,rmSync,symlinkSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {listLocalGames} from './list-local-games.mjs';

const modulePath=fileURLToPath(new URL('./project-cleanup.psm1',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(t){
  const prefix=join(realpathSync(tmpdir()),'subterfuge-cleanup-');
  const root=mkdtempSync(prefix);
  t.after(()=>{assert.ok(root.startsWith(prefix));rmSync(root,{recursive:true,force:true});});
  const put=(p,text='fixture')=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),text);};
  put('AGENTS.md');put('package.json','{}');put('packages/server/src/main.ts');put('runtime/latest/player-access.json');
  assert.equal(spawnSync('git',['init','--quiet',root]).status,0);
  return {root,put,keep:join(root,'runtime/latest')};
}
function ps(root,code){
  const script=`$ErrorActionPreference='Stop'; Import-Module ${quote(modulePath)} -Force; $root=${quote(root)}; ${code}`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.error?.message ?? (result.stdout+'\n'+result.stderr));
  return result.stdout;
}
function game(root,name,room,wallMs){
  const directory=join(root,'runtime',name);mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(join(directory,'subterfuge.sqlite'));
  db.exec('CREATE TABLE active_room(slot INTEGER,room_id TEXT); CREATE TABLE snapshots(room_id TEXT,payload TEXT); CREATE TABLE tick_time_anchors(room_id TEXT,wall_ms INTEGER);');
  db.prepare('INSERT INTO active_room VALUES(1,?)').run(room);
  db.prepare('INSERT INTO snapshots VALUES(?,?)').run(room,JSON.stringify({playerRoomId:room,snapshot:JSON.stringify({expected:{economy:{tick:7}}})}));
  db.prepare('INSERT INTO tick_time_anchors VALUES(?,?)').run(room,wallMs);db.close();
  return directory;
}

test('inventory uses authority time, excludes checkpoint copies, retains split agent layout',t=>{
  const {root}=fixture(t);
  const older=game(root,'older','room-old',1000),latest=game(root,'split/game','room-new',2000);
  mkdirSync(join(root,'runtime/split/agent'));game(root,'older/checkpoints/copy','room-copy',999999);
  utimesSync(join(older,'subterfuge.sqlite'),new Date(),new Date());
  const result=listLocalGames(root);
  assert.equal(result.errors.length,0);assert.equal(result.games.length,2);
  assert.equal(result.games[0].directory,latest);assert.equal(result.games[0].keepDirectory,join(root,'runtime/split'));
  assert.deepEqual(result.games[0].protectedDirectories,[latest,join(root,'runtime/split/agent')]);
});
test('unreadable game is reported instead of silently classified as rubbish',t=>{
  const {root,put}=fixture(t);put('runtime/broken/subterfuge.sqlite','broken database');
  assert.equal(listLocalGames(root).errors.length,1);
});
test('an arbitrary stage suffix does not hide a newer authoritative game',t=>{
  const {root}=fixture(t);game(root,'old','older',1000);game(root,'latest-stage','newer',3000);
  assert.equal(listLocalGames(root).games[0].roomId,'newer');
});
test('a game at the shared runtime root protects its state without keeping old game directories',t=>{
  const {root,put}=fixture(t);game(root,'','current-room',4000);game(root,'old','old-room',1000);
  put('runtime/player-access.json');put('runtime/independent-agent/seat.sqlite');
  const selected=listLocalGames(root).games[0];
  assert.ok(selected.protectedDirectories.includes(join(root,'runtime/subterfuge.sqlite')));
  assert.ok(selected.protectedDirectories.includes(join(root,'runtime/independent-agent')));
  assert.ok(!selected.protectedDirectories.includes(join(root,'runtime')));
  const keep=selected.protectedDirectories.map(quote).join(',');
  const plan=JSON.parse(ps(root,`@(Get-ProjectCleanupPlan $root @(${keep})) | ConvertTo-Json -Depth 4 -Compress`));
  assert.ok(plan.some(p=>realpathSync(p.Path)===realpathSync(join(root,'runtime/old'))),JSON.stringify(plan));
});
test('plan covers history outside runtime while preserving latest state and source',t=>{
  const {root,put,keep}=fixture(t);
  put('runtime/old/subterfuge.sqlite');put('runtime/.cleanup/previous.json');put('outputs/report.json');put('artifacts/preview.png');put('dist/output.js');put('research/packages/original.apk');put('research/analysis/generated.js');put('packages/client/public/assets/texture.png');
  const plan=JSON.parse(ps(root,`@(Get-ProjectCleanupPlan $root @(${quote(keep)})) | ConvertTo-Json -Depth 4 -Compress`));
  const paths=plan.map(p=>realpathSync(p.Path));
  for(const p of ['runtime/old','outputs','artifacts','dist','research/analysis'])assert.ok(paths.includes(realpathSync(join(root,p))),`${p}: ${JSON.stringify(paths)}`);
  for(const p of [keep,join(root,'runtime/.cleanup'),join(root,'research/packages'),join(root,'packages')])assert.ok(!paths.includes(realpathSync(p)),p);
});
test('deletion rejects root, outside paths, retained directory and its ancestor',t=>{
  const {root,put,keep}=fixture(t);put('runtime/old/file.txt');
  ps(root,`$kept=@(${quote(keep)}); foreach($path in @($root, (Join-Path $root '../outside'), ${quote(keep)}, (Join-Path $root 'runtime'))) { $blocked=$false; try { Remove-CleanupTarget $root $path $kept } catch { $blocked=$true }; if(!$blocked){throw ('Not blocked: '+$path)} }; Remove-CleanupTarget $root (Join-Path $root 'runtime/old') $kept`);
  assert.ok(existsSync(join(keep,'player-access.json')));assert.ok(!existsSync(join(root,'runtime/old')));
});
test('junction deletion removes only the link and leaves linked source untouched',t=>{
  const {root,put,keep}=fixture(t);put('outside-data/retain.txt','retained');mkdirSync(join(root,'runtime/old'));
  symlinkSync(join(root,'outside-data'),join(root,'runtime/old/link'),'junction');
  const stats=JSON.parse(ps(root,`Get-CleanupTarget $root (Join-Path $root 'runtime/old') 'test' | ConvertTo-Json -Compress`));
  assert.equal(stats.Files,0);assert.equal(stats.Links,1);
  ps(root,`Remove-CleanupTarget $root (Join-Path $root 'runtime/old') @(${quote(keep)})`);
  assert.equal(readFileSync(join(root,'outside-data/retain.txt'),'utf8'),'retained');assert.ok(!existsSync(join(root,'runtime/old')));
});
test('execution refuses a newly tracked file and records per-target failure',t=>{
  const {root,put,keep}=fixture(t);put('outputs/中文报告.txt');put('outputs/disposable.tmp');
  assert.equal(spawnSync('git',['-C',root,'add','outputs/中文报告.txt']).status,0);
  const result=JSON.parse(ps(root,`$targets=@([pscustomobject]@{Path=(Join-Path $root 'outputs');Bytes=1}); @(Invoke-CleanupSelection $root $targets @(${quote(keep)}) '') | ConvertTo-Json -Depth 4 -Compress`).split(/\r?\n/).findLast(s=>s.startsWith('{')||s.startsWith('[')));
  assert.match(result.Status,/未完整删除/);assert.ok(existsSync(join(root,'outputs/中文报告.txt')));
});
