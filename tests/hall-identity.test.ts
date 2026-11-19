import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hallClaim, hasHallClaim, rememberHallAdmission, rememberHallIdentity, restoreHallIdentity, forgetActiveHallIdentity} from '../packages/client/src/hall-identity.js';
import {savedHallToken} from '../packages/client/src/hall-link-protocol.js';
class Storage {
  values = new Map<string,string>();
  getItem(key:string) { return this.values.get(key) ?? null; }
  setItem(key:string,value:string) { this.values.set(key,value); }
  removeItem(key:string) { this.values.delete(key); }
}

test('a saved owner identity can reopen its room without creating another admission claim',()=>{
 const session=new Storage(),persistent=new Storage();
 const identity={playerToken:'c'.repeat(64),code:'ABC123',roomId:'running-room'};
 rememberHallIdentity(session,persistent,identity);
 assert.equal(hasHallClaim(session,persistent,identity.code),false);
 assert.equal(savedHallToken(identity.code,persistent,new Storage()),identity.playerToken);
 assert.equal(savedHallToken('DEF456',persistent,new Storage()),null);
 const reopened=new Storage();restoreHallIdentity(reopened,persistent);
 assert.equal(reopened.getItem('subterfuge-player-code'),identity.playerToken);
 assert.equal(reopened.getItem('subterfuge-hub-room-id'),identity.roomId);
 assert.equal(hasHallClaim(reopened,persistent,identity.code),false);
});
test('closing all tabs preserves admission key and restores the same player without claiming a new seat',()=>{
 const persistent=new Storage(), first=new Storage();
 const claim=hallClaim(first,persistent,'create',()=> 'a'.repeat(64));
 rememberHallAdmission(first,persistent,{playerToken:'host-token',code:'ABC123',roomId:'room-one'},claim,true);
 assert.equal(persistent.getItem('subterfuge-hall-claim-create'),null);
 const reopened=new Storage();
 restoreHallIdentity(reopened,persistent);
 assert.equal(reopened.getItem('subterfuge-player-code'),'host-token');
 assert.equal(reopened.getItem('subterfuge-hub-room-id'),'room-one');
 assert.equal(hallClaim(reopened,persistent,'ABC123',()=>{throw Error('Must not create a new identity');}),claim);
 assert.equal(hasHallClaim(reopened,persistent,'ABC123'),true);
});
test('room identities stay separate and existing tabs retain their room',()=>{
 const persistent=new Storage(), first=new Storage(), second=new Storage();
 rememberHallAdmission(first,persistent,{playerToken:'first',code:'ABC123',roomId:'one'},'a'.repeat(64),false);
 rememberHallAdmission(second,persistent,{playerToken:'second',code:'DEF456',roomId:'two'},'b'.repeat(64),false);
 assert.equal(hallClaim(new Storage(),persistent,'ABC123',()=>''),'a'.repeat(64));
 restoreHallIdentity(first,persistent);
 assert.equal(first.getItem('subterfuge-player-code'),'first');
 assert.equal(hallClaim(first,persistent,'DEF456',()=>''),'b'.repeat(64));
});
test('existing session credentials are preserved on upgrade; explicit disconnect stops auto restore',()=>{
 const session=new Storage(),persistent=new Storage();
 session.setItem('subterfuge-player-code','old-token');
 session.setItem('subterfuge-room-code','ABC123');
 session.setItem('subterfuge-hub-room-id','one');
 session.setItem('subterfuge-hall-claim-ABC123','a'.repeat(64));
 restoreHallIdentity(session,persistent);
 assert.equal(hasHallClaim(new Storage(),persistent,'ABC123'),true);
 forgetActiveHallIdentity(session,persistent);
 const reopened=new Storage();restoreHallIdentity(reopened,persistent);
 assert.equal(reopened.getItem('subterfuge-player-code'),null);
 assert.equal(hasHallClaim(reopened,persistent,'ABC123'),true);
});
test('storage write failure prevents silently creating another identity',()=>{
 const persistent=new Storage();persistent.setItem=()=>{throw Error('Storage unavailable');};
 assert.throws(()=>hallClaim(new Storage(),persistent,'ABC123',()=> 'a'.repeat(64)),/Storage unavailable/);
});
