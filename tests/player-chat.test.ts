import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ChatStore} from '../packages/server/src/chat.js';
import {createEightPlayerScenario} from '../packages/server/src/eight-player.js';
import {protocolHarness,createOwnerPlayerApi} from './player-protocol-test-helpers.js';

test('authenticated v2 owner chat filters before pagination, rejects spoofing and persists idempotently',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-player-chat-')),path=join(dir,'chat.json');
 const chat=new ChatStore(path);await chat.load();
 const room={state:createEightPlayerScenario(),scheduled:[]};
 const h=protocolHarness(t,{room}),server=await createOwnerPlayerApi(h,{chat:()=>chat});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const request=(seat:number,path='/player/v2/owner/chat',data?:unknown)=>fetch(url+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${h.ownerCredentials.credentials[seat]!.token}`,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
 try{
   assert.equal((await fetch(url+'/player/v2/owner/chat')).status,401);
   const world=JSON.stringify(h.store.load()!.room),initial=await (await request(2,'/player/v2/owner/observation')).json();
   const dm={id:'same-id',to:1,text:'Private offer'};
   assert.equal((await request(0,'/player/v2/owner/chat',{...dm,from:2})).status,400);
   const sent=await (await request(0,'/player/v2/owner/chat',dm)).json();assert.ok(sent.message,JSON.stringify(sent));assert.equal(sent.message.from,0);
   const retry=await (await request(0,'/player/v2/owner/chat',dm)).json();assert.deepEqual(retry,sent);
   assert.equal((await request(0,'/player/v2/owner/chat',{...dm,text:'changed'})).status,400);
   const third=await (await request(2)).json();assert.deepEqual(third.messages,[]);assert.equal(third.nextCursor,0);assert.equal(third.hasMore,false);
   const search=await (await request(0,'/player/v2/owner/chat/search?with=1&text=offer&id=same-id')).json();assert.equal(search.messages.length,1);assert.equal(search.messages[0].text,'Private offer');
   assert.deepEqual((await (await request(2,'/player/v2/owner/chat/search?id=same-id')).json()).messages,[]);
   for(const query of ['with=8','player=0','limit=51','before=999','text='+('x'.repeat(121)),'limit=1&limit=2'])assert.equal((await request(0,'/player/v2/owner/chat/search?'+query)).status,400);

   assert.deepEqual(await (await request(2,'/player/v2/owner/observation')).json(),initial);
   assert.equal((await request(1,'/player/v2/owner/chat',{id:'same-id',to:null,text:'Public reply'})).status,200);
   const page=await (await request(0,'/player/v2/owner/chat?after=0&limit=1')).json();assert.equal(page.messages[0].text,'Private offer');assert.equal(page.nextCursor,1);assert.equal(page.hasMore,true);
   const rest=await (await request(0,'/player/v2/owner/chat?after=1&limit=1')).json();assert.equal(rest.messages[0].text,'Public reply');assert.equal(rest.hasMore,false);
   const other=await (await request(2)).json();assert.deepEqual(other.messages.map((m:{text:string})=>m.text),['Public reply']);assert.equal(other.nextCursor,1);
   for(const data of [{id:'x',to:0,text:'self'},{id:'x',to:8,text:'invalid'},{id:'x',to:null,text:''},{id:'x',to:null,text:'x'.repeat(2001)}])assert.equal((await request(0,'/player/v2/owner/chat',data)).status,400);
   for(const query of ['after=-1','after=999','limit=201','player=0','after=NaN'])assert.equal((await request(0,'/player/v2/owner/chat?'+query)).status,400);
   const concurrent=await Promise.all(Array.from({length:10},(_,i)=>request(0,'/player/v2/owner/chat',{id:'parallel-'+i,to:null,text:'m'+i})));assert.ok(concurrent.every(r=>r.status===200));
   let before:number|null=null;const searched:string[]=[];
   do {const page=await (await request(0,'/player/v2/owner/chat/search?limit=2'+(before===null?'':'&before='+before))).json();searched.push(...page.messages.map((m:{id:string;from:number})=>`${m.from}:${m.id}`));before=page.nextBefore;}while(before!==null);
   assert.equal(searched.length,12);assert.equal(new Set(searched).size,12);

   const restored=new ChatStore(path);await restored.bindDurable(h.repository.domainDocument(()=>h.repository.currentEpoch(h.roomId),'chat','journal'));assert.equal(restored.listForSeat(0).length,12);assert.equal(restored.listForSeat(2).length,11);
   const copy=restored.listForSeat(0);copy[0]!.text='mutated';assert.equal(restored.listForSeat(0)[0]!.text,'Private offer');assert.equal(JSON.stringify(h.store.load()!.room),world);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
test('chat store serializes direct callers and publishes only after disk success; corrupt input fails closed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subterfuge-chat-store-')),path=join(dir,'chat.json');
 try{
   const chat=new ChatStore(path);await chat.load();const token=chat.claim(0,3);
   await Promise.all(Array.from({length:20},(_,i)=>chat.send(token,{id:String(i),to:1,text:'test'},3,100)));
   const restored=new ChatStore(path);await restored.load();assert.equal(restored.listForSeat(1).length,20);
   await chat.reset();assert.throws(()=>chat.list(token));assert.deepEqual(chat.listForSeat(0),[]);
   const failing=new ChatStore(join(dir,'missing','chat.json'));await assert.rejects(()=>failing.sendFromSeat(0,{id:'x',to:null,text:'test'},3,100));assert.deepEqual(failing.listForSeat(0),[]);
   for(const value of [{},[{id:'bad'}],[{id:'a',from:0,to:1,text:'secret',tick:100,sentAt:1,extra:'hidden'}]]){await writeFile(path,JSON.stringify(value));await assert.rejects(()=>new ChatStore(path).load(),/Invalid chat/);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
