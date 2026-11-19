import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'bot launcher '));mkdirSync(join(dir,'runtime'));
 copyFileSync('examples/bot-release/launch.mjs',join(dir,'launch.mjs'));
 copyFileSync('examples/bot-release/start.cmd',join(dir,'start.cmd'));
 writeFileSync(join(dir,'HOST-MANIFEST.json'),JSON.stringify({platform:process.platform,arch:process.arch,files:{}}));
 writeFileSync(join(dir,'runtime/agent-cli.mjs'),'console.log("ARGS="+JSON.stringify(process.argv.slice(2)));');return dir;
}
test('busy default port chooses a free port without taking over an existing console',async()=>{
 const dir=fixture(),occupied=createServer();
 try{
  await new Promise((done,reject)=>{occupied.once('error',e=>e.code==='EADDRINUSE'?done():reject(e));occupied.listen(4400,'127.0.0.1',done);});
  const r=spawnSync(process.execPath,[join(dir,'launch.mjs')],{encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stdout+r.stderr);const args=JSON.parse(r.stdout.split('ARGS=')[1].trim());
  const port=Number(args[args.indexOf('--console')+1]);assert.ok(port>0&&port!==4400);
  assert.match(r.stdout,/4400 is busy/);
 }finally{if(occupied.listening)await new Promise(done=>occupied.close(done));rmSync(dir,{recursive:true,force:true});}
});
test('Windows cmd entry handles paths with spaces and preserves explicit port', {skip:process.platform!=='win32'},()=>{
 const dir=fixture();
 try{
  const r=spawnSync(process.env.ComSpec??'cmd.exe',['/d','/c','start.cmd --console 4401'],{cwd:dir,encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stdout+r.stderr);const args=JSON.parse(r.stdout.split('ARGS=')[1].trim());
  assert.equal(args[args.indexOf('--console')+1],'4401');
  const source=readFileSync(resolve('examples/bot-release/start.cmd'),'utf8');assert.match(source,/where node/);assert.match(source,/pause/);assert.match(source,/exit \/b %bot_exit%/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
