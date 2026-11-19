import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {publicPlayerError} from '../packages/server/src/player-errors.js';
import {PlayerGateway,GameRequestError,GameTransportError} from '../packages/ai/src/index.js';
test('public errors are allowlisted and never leak unexpected exception data',()=>{
 assert.equal(publicPlayerError(new Error('Insufficient drillers')).code,'insufficient-drillers');
 assert.equal(publicPlayerError(new Error('Unsupported fleet action')).code,'request-rejected');
 const error=publicPlayerError(new Error('secret path/key/hidden unit'));
 assert.equal(error.code,'request-rejected');assert.ok(!JSON.stringify(error).includes('secret'));
});
test('gateway preserves actionable errors and only accepts conflict observations from the same room',async()=>{
 let status=400,body:unknown=publicPlayerError(new Error('Insufficient drillers'));
 const server=createServer((req,res)=>{if(req.url==='/player/v2/owner/control'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({roomId:'room',mode:'agent',sessionId:req.headers['x-subterfuge-control-session'],expiresAt:Date.now()+30000}));return;}res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(body));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{
 const address=server.address() as {port:number};const gateway=new PlayerGateway(`http://127.0.0.1:${address.port}`,'token','room',0,2);
 await assert.rejects(gateway.request('/tool/order',{}),(e:unknown)=>e instanceof GameRequestError&&e.code==='insufficient-drillers'&&!!e.detail);
 status=409;body={observation:{roomId:'room',revision:'fresh',view:{player:0}}};
 await assert.rejects(gateway.request('/tool/order',{}),(e:unknown)=>e instanceof GameRequestError&&e.observation?.revision==='fresh');
 body={observation:{roomId:'other',revision:'fresh',view:{player:0}}};
 await assert.rejects(gateway.request('/tool/order',{}),GameTransportError);
 }finally{server.close();await once(server,'close');}
});
