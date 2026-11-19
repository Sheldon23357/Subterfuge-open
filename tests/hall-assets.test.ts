import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createRoomHub} from '../packages/server/src/room-hub.js';
import {servePlayerStatic} from '../packages/server/src/player-static.js';

test('hall JPG background exists, is compressed, and serves with the image MIME type',async t=>{
 const root=resolve('packages/client/public');
 const server=createServer((req,res)=>{void servePlayerStatic(root,req,res).then(served=>{if(!served)res.writeHead(404).end();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const address=server.address();assert.ok(address&&typeof address==='object');
 const response=await fetch(`http://127.0.0.1:${address.port}/assets/lobby/deep-harbor.jpg`);
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');
 const image=Buffer.from(await response.arrayBuffer());assert.equal(image.readUInt16BE(0),0xffd8);assert.ok(image.length<350000);
 const shell=await readFile(root+'/hall.html','utf8');assert.match(shell,/正在连接大厅/);assert.match(shell,/role="status"/);assert.match(shell,/deep-harbor\.jpg/);assert.doesNotMatch(shell,/style=/);
});

test('hall first paint is self styled, nonblocking, and authorized by its exact CSP style hash',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'hall-loading-'));
 const hub=await createRoomHub({directory,webRoot:resolve('packages/client/public')});
 try{
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');const address=hub.server.address();assert.ok(address&&typeof address==='object');
  const response=await fetch(`http://127.0.0.1:${address.port}/`),html=await response.text();
  const css=/<style id="hall-loading-style">([\s\S]*?)<\/style>/.exec(html)![1]!;
  assert.equal(css,await readFile('packages/client/src/hall-loading.css','utf8'));
  assert.ok(response.headers.get('content-security-policy')!.includes("'sha256-"+createHash('sha256').update(css).digest('base64')+"'"));
  assert.ok(!response.headers.get('content-security-policy')!.includes("'unsafe-inline'"));
  assert.match(html,/<link[^>]+id="hall-stylesheet"[^>]+media="print"/);
  const bootstrap=await fetch(`http://127.0.0.1:${address.port}/assets/lobby/hall-bootstrap.js`);
  assert.equal(bootstrap.status,200);assert.match(bootstrap.headers.get('content-type')!,/javascript/);
 }finally{await hub.close();await rm(directory,{recursive:true,force:true});}
});
