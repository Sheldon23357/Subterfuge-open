// @ts-nocheck
// Exact APK 12075 notification handler. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1.
import {SPECIALISTS} from '../../rules/src/reference.js';
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const te={getScreenName:(_info,seat)=>String(seat)},De={Occupied:1},B={Nothing:0,Outpost:1},yn={Normal:0,Urgent:1};
class Listener{handleSpecialistPromoted(e, t) {
        const r = e.world.specialists.get(t);
        let s = "";
        s = `${te.getScreenName(e.info,r.ownerIndex,!0)} promoted a specialist and now has a ${kt[r.type].name}!`;
        for (let i = 0; i < e.info.maxPlayerCount; i++) e.playerStates.get(i).seatState == De.Occupied && r.ownerIndex != i && this.handleEvent(e, i, B.Nothing, 0, s, null, !0, yn.Normal)
    }
handleCreateMine(e, t) {
        let r = "";
        const s = e.world.outposts.get(t);
        for (let i = 0; i < e.info.maxPlayerCount; i++) e.playerStates.get(i).seatState == De.Occupied && i != s.ownerIndex && (r = `Seismic activity detected in ${te.getScreenName(e.info,s.ownerIndex,!0)}'s territory. A new mine has been drilled!`, this.handleEvent(e, i, B.Outpost, t, r, null, !0, yn.Urgent))
    }
handlePlayerJoined(e, t) {
        let r = "";
        for (let s = 0; s < e.info.maxPlayerCount; s++) s == t ? r = `You joined the game (${e.info.maxPlayerCount-e.info.playerCount} seats available)` : r = `${te.getScreenName(e.info,t,!0)} joined the game (${e.info.maxPlayerCount-e.info.playerCount} seats available)`, this.handleEvent(e, s, B.Nothing, -1, r, null, !1, yn.Normal)
    }
handlePlayerLeft(e, t) {
        let r = "";
        for (let s = 0; s < e.info.maxPlayerCount; s++) s != t && (r = `${te.getScreenName(e.info,t,!0)} left the game (${e.info.maxPlayerCount-e.info.playerCount} seats available)`), this.handleEvent(e, s, B.Nothing, -1, r, null, !1, yn.Normal)
    }
handleGameStarting(e) {
        const t = e.secondsUntilGameInProgress / 3600;
        let r = "";
        r = `All players have joined. Game will start in ${t} hours`;
        for (let s = 0; s < e.info.maxPlayerCount; s++) this.handleEvent(e, s, B.Nothing, -1, r, null, !1, yn.Urgent)
    }
handleGameStarted(e) {
        const t = "Game has started!";
        for (let r = 0; r < e.info.maxPlayerCount; r++) this.handleEvent(e, r, B.Nothing, -1, t, null, !0, yn.Normal)
    }}
export function originalPromotionRecipients(players,owner,type){
 const recipients=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player)=>recipients.push(player);
 listener.handleSpecialistPromoted({info:{maxPlayerCount:players.length},playerStates:{get:i=>({seatState:players[i].active?1:4})},world:{specialists:{get:()=>({ownerIndex:owner,type})}}},0);
 return recipients;
}
export function originalMineRecipients(players,owner){
 const recipients=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player)=>recipients.push(player);
 listener.handleCreateMine({info:{maxPlayerCount:players.length},playerStates:{get:i=>({seatState:players[i].active?1:4})},world:{outposts:{get:()=>({ownerIndex:owner})}}},0);
 return recipients;
}
export function originalLifecycleNotices(kind,capacity,occupied,actor,secondsUntilGameInProgress=0){
 const methods={join:'handlePlayerJoined',leave:'handlePlayerLeft',starting:'handleGameStarting',started:'handleGameStarted'};
 const method=methods[kind];if(!method)throw Error('Invalid lifecycle notice');
 const notices=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player,_type,_index,text,_details,notify,priority)=>notices.push({player,text,notify,priority});
 listener[method]({info:{maxPlayerCount:capacity,playerCount:occupied},secondsUntilGameInProgress},actor);
 return notices;
}
