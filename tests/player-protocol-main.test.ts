import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
async function freePort(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function main(t:TestContext,deadline?:number){const dir=await mkdtemp(join(tmpdir(),'protocol-main-fixture-')),port=await freePort(),playerPort=await freePort(),env:NodeJS.ProcessEnv={...process.env,LAB_DATA_DIR:dir,LAB_PORT:String(port),PLAYER_PORT:String(playerPort),LAB_LEGACY_FIXTURE:'1',GAME_CLOCK:'manual',NO_PROXY:'127.0.0.1,localhost'};delete env.PLAYER_REMOTE_DEADLINE_MS;if(deadline!==undefined)env.PLAYER_REMOTE_DEADLINE_MS=String(deadline);const child=fork(fileURLToPath(new URL('../packages/server/src/main.js',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc'],env});let output='';child.stdout!.on('data',chunk=>output+=chunk);child.stderr!.on('data',chunk=>output+=chunk);t.after(async()=>{await stop(child);await rm(dir,{recursive:true,force:true});});const get=()=>fetch(`http://127.0.0.1:${port}/api/state`).then(r=>r.json());const end=Date.now()+15000;while(true){if(child.exitCode!==null)throw Error(output);try{const state=await get();return{child,get,initial:state,output:()=>output};}catch(error){if(Date.now()>end)throw Error(String(error)+' '+output);await sleep(30);}}}
async function stop(child:ChildProcess){if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill();await end;}}
test('R03 real main opt-in finite deadline advances with every executor offline',{timeout:20000},async t=>{const game=await main(t,100),first=game.initial.tick,end=Date.now()+5000;while((await game.get()).tick<=first){assert.ok(Date.now()<end,game.output());await sleep(50);}assert.equal(game.initial.autoAdvance.enabled,true);});
test('real main default manual progression remains unchanged without explicit remote deadline',{timeout:20000},async t=>{const game=await main(t);assert.equal(game.initial.autoAdvance.enabled,false);await sleep(1200);assert.equal((await game.get()).tick,game.initial.tick);});
