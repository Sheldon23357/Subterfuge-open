import {test} from 'node:test';
import assert from 'node:assert/strict';
import {playerHref,playerRoute,resolvePlayerRoute} from '../packages/client/src/player-route.js';
import {rememberHallIdentity} from '../packages/client/src/hall-identity.js';
class Memory{values=new Map<string,string>();getItem(k:string){return this.values.get(k)??null;}setItem(k:string,v:string){this.values.set(k,v);}removeItem(k:string){this.values.delete(k);}get length(){return this.values.size;}key(i:number){return [...this.values.keys()][i]??null;}}
test('route uses stable one-based lobby seats, rejects malformed or ambiguous parameters, and contains no credential',()=>{
 assert.equal(playerHref('ABC123',9),'/player.html?room=ABC123&seat=10');assert.deepEqual(playerRoute('?room=ABC123&seat=2'),{code:'ABC123',seat:1});assert.equal(playerRoute(''),null);
 for(const query of ['?room=ABC123','?seat=1','?room=ABC123&seat=0','?room=ABC123&seat=11','?room=ABC123&seat=01','?room=ABC123&seat=1&seat=2','?room=ABC123&room=DEF456&seat=1'])assert.throws(()=>playerRoute(query));
});
test('multiple rooms, multiple seats and existing tabs retain independent verified credentials',async()=>{
 const storage=new Memory(),first=new Memory(),second=new Memory();
 const a={code:'ABC123',seat:0,roomId:'one',playerToken:'a'.repeat(64)},b={...a,seat:1,playerToken:'b'.repeat(64)},c={code:'DEF456',seat:0,roomId:'two',playerToken:'c'.repeat(64)};
 rememberHallIdentity(first,storage,a);rememberHallIdentity(second,storage,b);rememberHallIdentity(second,storage,c);
 const verify=async(code:string,token:string)=>{const row=[a,b,c].find(row=>row.code===code&&row.playerToken===token);if(!row)throw Object.assign(Error(),{status:401});return {roomId:row.roomId,seat:row.seat};};
 for(const value of [a,b,c])assert.deepEqual(await resolvePlayerRoute(value,second,storage,verify),value);
 assert.equal(first.getItem('subterfuge-player-code'),a.playerToken);
 await assert.rejects(resolvePlayerRoute({code:'ABC123',seat:2},second,storage,verify),/没有该席位/);
});
test('pre-existing AI slots resolve only after authoritative identity confirmation',async()=>{
 const storage=new Memory(),session=new Memory();storage.setItem('subterfuge-ai-identity-ABC123-ai-04','d'.repeat(64));
 const target={code:'ABC123',seat:3};assert.equal((await resolvePlayerRoute(target,session,storage,async()=>({roomId:'one',seat:3}))).playerToken,'d'.repeat(64));
 await assert.rejects(resolvePlayerRoute({...target,seat:2},session,storage,async()=>({roomId:'one',seat:3})),/没有该席位/);
 await assert.rejects(resolvePlayerRoute(target,session,storage,async()=>{throw Object.assign(Error('recovering'),{status:503});}),/recovering/);
});
