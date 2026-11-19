// @ts-nocheck
// Verbatim Hne gameplay notification dispatch, APK 12075. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1.
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
import {originalFleetTravelMinutes,originalPointVisible,originalCountSpecialists} from './original-specialist-economy.generated.js';
const he=RULES.GameParams;
const B={Nothing:0,Outpost:1,Sub:2,Specialist:3},pe={Mine:0},He={Moving:'moving'},Ns={SubWon:1};
const De={Occupied:1,Resigned:2,AutoResigned:3,Eliminated:4},yn={Urgent:0,Normal:1},K={MaxWinnerCount:10},ke={Ended:4};
const q=Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]));
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const Z=()=>{};
const Bi=(o,i)=>o.label??String(i);
const te={getScreenName:(_info,seat)=>'P'+seat,isAlly:(info,a,b)=>a===b||a>=0&&b>=0&&info.teamSize>0&&Math.floor(a/info.teamSize)===Math.floor(b/info.teamSize)};
const V={getSubTravelTimeInMinutes:originalFleetTravelMinutes,countSpecialistOfType:originalCountSpecialists,getItemOwnerIndex:(w,l)=>l.type===1?w.outposts.get(l.index).ownerIndex:l.type===2?w.subs.get(l.index).ownerIndex:-1};
const wn={isVisibleForPlayer:originalPointVisible};
const qn={getType:(o)=>o.private_type};
const ut={getWinningPlayers:(state,out)=>{state.winners.forEach((seat,i)=>out[i]=seat);return state.winners.length;}};
function YG(n) {
    return n.length == 0 ? "" : n.length == 1 ? n[0] : n.length == 2 ? `${n[0]} and ${n[1]}` : `${n.slice(0,-1).join(", ")}, and ${n[n.length-1]}`
}
function MI(n, e, t, r) {
    let s = "";
    if (n.ownerIndex == t) s += "Your sub ";
    else {
        Z(n.ownerIndex >= 0);
        const i = te.getScreenName(r.info, n.ownerIndex, !0);
        s += `${i}'s sub `
    }
    if (n.srcOutpostIndex >= 0) {
        const i = r.world.outposts.get(n.srcOutpostIndex);
        s += `heading from ${Bi(i,n.srcOutpostIndex)} `
    }
    if (n.destination.type == B.Outpost) {
        const i = r.world.outposts.get(n.destination.index);
        s += `to ${Bi(i,n.destination.index)} `
    }
    if (e > 0) {
        const i = te.getScreenName(r.info, e, !0);
        s += `crossed paths with ${i}'s sub...`
    } else s += "crossed paths with a dormant sub...";
    return s
}
class Listener{handleSubDeparture(e, t) {
        let r;
        const s = e.world.subs.get(t),
            i = e.world.outposts.get(s.srcOutpostIndex);
        switch (Z(s.used), Z(s.state == He.Moving), s.destination.type) {
            case B.Outpost: {
                const a = e.world.outposts.get(s.destination.index);
                let o = V.getSubTravelTimeInMinutes(e.world, t);
                const l = Math.trunc((o + 30) / 60),
                    c = V.countSpecialistOfType(e.world, s.specialistCache, q.Navigator, !0, !1);
                r = c == 0 ? `${te.getScreenName(e.info,s.ownerIndex,!0)} just launched a sub from ${Bi(i,s.srcOutpostIndex)}. It is estimated to arrive at ${Bi(a,s.destination.index)} in about ${l} hours.` : `${te.getScreenName(e.info,s.ownerIndex,!0)} just launched a sub with a Navigator from ${Bi(i,s.srcOutpostIndex)}. It is estimated to arrive at ${Bi(a,s.destination.index)} in about ${l} hours.`;
                for (let u = 0; u < e.info.playerCount; ++u) u != s.ownerIndex && (u == a.ownerIndex && a.ownerIndex != s.ownerIndex || c > 0 && !te.isAlly(e.info, u, s.ownerIndex) && wn.isVisibleForPlayer(s.pos, u, e.world, e.info)) && this.handleEvent(e, u, B.Sub, t, r, null, !0, yn.Urgent, !0, {
                    attackerIndex: s.ownerIndex,
                    targetOutpostIndex: s.destination.index,
                    targetOwnerIndex: a.ownerIndex,
                    launchId: s.launchId
                });
                break
            }
            case B.Sub: {
                const a = e.world.subs.get(s.destination.index);
                if (a.ownerIndex != s.ownerIndex) {
                    r = `${te.getScreenName(e.info,s.ownerIndex,!0)} just launched a sub from ${Bi(i,s.srcOutpostIndex)}. It is headed to intercept another sub.`;
                    for (let o = 0; o < e.info.playerCount; ++o) o != s.ownerIndex && o == a.ownerIndex && this.handleEvent(e, o, B.Sub, t, r, null, !0, yn.Urgent)
                }
                break
            }
            default:
                Ta("Unknown dest type")
        }
    }
handleSubChangedCourse(e, t) {
        const r = e.world.subs.get(t);
        Z(r.used);
        const s = V.getItemOwnerIndex(e.world, r.destination);
        Z(r.state == He.Moving);
        const i = V.getSubTravelTimeInMinutes(e.world, t),
            a = Math.trunc((i + 30) / 60),
            o = V.countSpecialistOfType(e.world, r.specialistCache, q.Navigator, !0, !1);
        let l = "";
        for (let c = 0; c < e.info.playerCount; ++c)
            if (c != r.ownerIndex)
                if (r.destination.type == B.Outpost) {
                    const u = r.destination.index,
                        d = o > 0 && !te.isAlly(e.info, c, r.ownerIndex) && wn.isVisibleForPlayer(r.pos, c, e.world, e.info);
                    (c == s || d) && (l = `${te.getScreenName(e.info,r.ownerIndex,!0)}'s sub just changed course. It is now estimated to arrive at ${Bi(e.world.outposts.get(u),u)} in about ${a} hours.`, this.handleEvent(e, c, B.Sub, t, l, null, !0, yn.Urgent))
                } else r.destination.type == B.Sub && c == s && (l = `${te.getScreenName(e.info,r.ownerIndex,!0)}'s sub just changed course and is now set to intercept a sub of yours.`, this.handleEvent(e, c, B.Sub, t, l, null, !0, yn.Urgent))
    }
handleSubArrivalToDormantOutpost(e, t, r) {
        const s = e.world.subs.get(t);
        Z(s.destination.type == B.Outpost);
        const i = e.world.outposts.get(r);
        let a = "";
        for (let o = 0; o < e.info.playerCount; ++o) {
            const l = s.ownerIndex == o;
            l && (o == s.ownerIndex ? a = `Your sub has arrived at dormant outpost ${Bi(i,r)}` : a = `A sub has arrived at dormant outpost ${Bi(i,r)}`, this.handleEvent(e, o, B.Outpost, r, a, null, l, yn.Normal))
        }
    }
handleSubArrivalWithCombat(e, t) {
        let r = "";
        const s = e.world.subs.get(t.subIndex);
        Z(s.destination.type == B.Outpost);
        const i = s.destination.index,
            a = e.world.outposts.get(i),
            o = Bi(a, i),
            l = te.getScreenName(e.info, s.ownerIndex, !0),
            c = te.getScreenName(e.info, a.ownerIndex, !0);
        for (let d = 0; d < e.info.playerCount; ++d) {
            if (d != s.ownerIndex && d != a.ownerIndex) continue;
            let h = !1;
            const p = t.outcome == Ns.SubWon;
            d == s.ownerIndex ? p ? (r = `Your sub has arrived at ${o} and taken over the outpost.`, h = !0) : r = `Your sub has arrived at ${o} and combat ensued.` : r = `${l}'s sub arrived at ${o} and combat ensued.`, this.handleEvent(e, d, B.Outpost, i, r, t.combatText, h, yn.Normal)
        }
        if (qn.getType(a, e.world.secondsSinceLastTick) == pe.Mine && t.outcome == Ns.SubWon)
            for (let d = 0; d < e.info.playerCount; ++d) d == s.ownerIndex ? (r = `You have taken over a mine at ${o}`, this.handleEvent(e, d, B.Outpost, i, r, null, !0, yn.Normal)) : d == a.ownerIndex ? (r = `${l} has taken over your mine at ${o}`, this.handleEvent(e, d, B.Outpost, i, r, null, !0, yn.Normal)) : (r = `${l} has taken over ${c}'s mine at ${o}`, this.handleEvent(e, d, B.Outpost, i, r, null, !0, yn.Normal))
    }
handlePlayerEliminated(e, t, r) {
        const s = e.playerStates.get(t).seatState;
        let i = "";
        for (let a = 0; a < e.info.maxPlayerCount; a++) e.playerStates.get(a).seatState == De.Occupied && (s == De.Eliminated ? a == t ? (i = "You've been eliminated.", this.handleEvent(e, t, B.Nothing, -1, i, null, !0, yn.Normal)) : (i = `${te.getScreenName(e.info,t,!0)} was eliminated.`, this.handleEvent(e, a, B.Nothing, -1, i, null, !0, yn.Normal)) : s == De.AutoResigned && (a == t ? (i = "You've autoresigned due to inactivity.", this.handleEvent(e, t, B.Nothing, -1, i, null, !0, yn.Normal)) : (i = `${te.getScreenName(e.info,t,!0)} was autoresigned due to inactivity.`, this.handleEvent(e, a, B.Nothing, -1, i, null, !0, yn.Normal))))
    }
handleInTransitCombat(e, t) {
        Z(t.otherLocation.type == B.Sub);
        const r = e.world.subs.get(t.subIndex),
            s = e.world.subs.get(t.otherLocation.index);
        let i = -1;
        r.drillers > 0 ? i = t.subIndex : s.drillers > 0 && (i = t.otherLocation.index);
        const a = he.RulesVersion >= 42 && r.drillers > 0 && s.drillers > 0;
        let o = "";
        for (let l = 0; l < e.info.playerCount; ++l)
            if (!(l != r.ownerIndex && l != s.ownerIndex) && (l == r.ownerIndex ? o = MI(r, s.ownerIndex, l, e) : o = MI(s, r.ownerIndex, l, e), o != "")) {
                const c = a ? l == r.ownerIndex ? t.subIndex : t.otherLocation.index : i;
                this.handleEvent(e, l, c >= 0 ? B.Sub : B.Nothing, c >= 0 ? c : -1, o, t.combatText, !1, yn.Normal)
            }
    }
handleGameOver(e) {
        const t = new Array(K.MaxWinnerCount).fill(-1),
            r = ut.getWinningPlayers(e, t),
            s = [];
        for (let a = 0; a < r; a++) s.push(te.getScreenName(e.info, t[a], !0));
        const i = r == 0 ? "Game over." : `Game over. ${YG(s)} ${r==1?"wins":"win"}.`;
        for (let a = 0; a < e.info.maxPlayerCount; a++) this.handleEvent(e, a, B.Nothing, -1, i, null, !0, yn.Normal)
    }
notifyOfSentryFire(e, t, r) {
        let s = "";
        const i = e.world.specialists.get(t);
        Z(i.ownerIndex >= 0), Z(i.type == q.Sentry);
        const a = e.world.subs.get(r);
        Z(a.used), e.playerStates.get(i.ownerIndex).seatState == De.Occupied && (a.ownerIndex < 0 ? s = "Your Sentry is now firing on a dormant sub" : s = `Your Sentry is now firing on ${te.getScreenName(e.info,a.ownerIndex,!0)}'s sub`, this.handleEvent(e, i.ownerIndex, i.location.type, i.location.index, s, null, !0, yn.Normal)), a.ownerIndex >= 0 && e.playerStates.get(a.ownerIndex).seatState == De.Occupied && (s = `${te.getScreenName(e.info,i.ownerIndex,!0)}'s Sentry is firing on your sub`, this.handleEvent(e, a.ownerIndex, B.Sub, r, s, null, !0, yn.Urgent))
    }
handleSentryFired(e, t, r, s, i) {
        if (r >= 0 && s < 0) this.notifyOfSentryFire(e, t, r);
        else {
            Z(r >= 0 && s >= 0);
            const a = e.world.subs.get(r),
                o = e.world.subs.get(s);
            a.ownerIndex != o.ownerIndex && this.notifyOfSentryFire(e, t, r)
        }
    }
handleDoubleAgentActivated(e, t, r) {
        const s = e.world.specialists.get(t);
        let i = "";
        i = `Your double agent was activated and defected to ${te.getScreenName(e.info,s.ownerIndex,!0)}'s side.`, this.handleEvent(e, r, s.location.type, s.location.index, i, null, !0, yn.Normal), i = `${te.getScreenName(e.info,r,!0)}'s double agent was activated and defected to your side.`, this.handleEvent(e, s.ownerIndex, s.location.type, s.location.index, i, null, !0, yn.Normal)
    }
handleSpecialistHired(e, t, r, s) {
        let i = "";
        const a = kt[r].name,
            o = a[0];
        let l = o == "A" || o == "E" || o == "I" || o == "O" || o == "U";
        i = `${te.getScreenName(e.info,t,!0)} just hired ${l?"an":"a"} ${a}.`;
        const c = e.world.outposts.get(s);
        for (let u = 0; u < e.info.maxPlayerCount; u++) u != t && wn.isVisibleForPlayer(c.pos, u, e.world, e.info) && this.handleEvent(e, u, B.Outpost, s, i, null, !0, yn.Normal)
    }
handleFundingSet(e, t, r, s) {
        let i = "",
            a = !0;
        for (let o = 0; o < e.info.maxPlayerCount; o++) {
            let l = yn.Normal;
            if (s)
                if (o == t) i = `You stopped funding ${te.getScreenName(e.info,r,!0)}.`, a = !1;
                else if (o == r) i = `${te.getScreenName(e.info,t,!0)} stopped funding you.`, l = yn.Urgent;
            else continue;
            else if (o == t) i = `You started funding ${te.getScreenName(e.info,r,!0)}.`, a = !1;
            else if (o == r) i = `${te.getScreenName(e.info,t,!0)} is now funding you.`, l = yn.Normal;
            else continue;
            this.handleEvent(e, o, B.Nothing, 0, i, null, a, l)
        }
    }
handleFundingNoLongerValid(e, t, r) {
        let s = "";
        for (let i = 0; i < e.info.maxPlayerCount; i++) i == t ? (s = `Funding for ${te.getScreenName(e.info,r,!0)} has been cancelled because they have too much Neptunium.`, this.handleEvent(e, i, B.Nothing, 0, s, null, !0, yn.Normal)) : i == r && (s = `Funding from ${te.getScreenName(e.info,t,!0)} has been cancelled because you have too much Neptunium.`, this.handleEvent(e, i, B.Nothing, 0, s, null, !0, yn.Normal))
    }
handleInactivityWarning(e, t, r) {
        let s = "";
        const i = e.playerStates.get(t);
        s = `You have been away from the game for ${Math.trunc(r/60)} hours.`;
        let a = "",
            o = yn.Normal;
        if (i.inactivityWarningCount == 1) a = "Your absence impacts other players negatively. If you don't want to continue the game, please log in and resign.";
        else {
            const l = he.HoursOfInactivityBeforeAutoresign * 60 - r;
            a = `Your absence from the game impacts other players negatively. You will autoresign in ${Math.trunc(l/60)} hours unless you log in.`, o = yn.Urgent
        }
        this.handleEvent(e, t, B.Nothing, -1, s, a, !0, o)
    }
handlePlayerResigned(e, t, r) {
        let s = "";
        for (let i = 0; i < e.info.maxPlayerCount; i++) e.playerStates.get(i).seatState == De.Occupied && (i != t && (s = `${r} has resigned.`), this.handleEvent(e, i, B.Nothing, 0, s, null, !1, yn.Normal))
    }
handleSpecialistReleased(e, t, r) {
        const s = e.world.specialists.get(t);
        let i = "";
        i = `${te.getScreenName(e.info,r,!0)} released your ${kt[s.type].name} from captivity.`, this.handleEvent(e, s.ownerIndex, B.Specialist, t, i, null, !0, yn.Normal), i = `You released ${te.getScreenName(e.info,s.ownerIndex,!0)}'s ${kt[s.type].name} from captivity.`, this.handleEvent(e, r, B.Specialist, t, i, null, !1, yn.Normal)
    }
handleSpecialistPromoted(e, t) {
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
handleNewHireAvailable(e) {
        let t = "";
        for (let r = 0; r < e.info.maxPlayerCount; r++) e.playerStates.get(r).seatState == De.Occupied && (t = "A new specialist hire is available!", this.handleEvent(e, r, B.Nothing, 0, t, null, !0, yn.Normal))
    }}
export function originalGameplayNotifications(state,method,args){
 const result=[],listener=Object.create(Listener.prototype);
 listener.handleEvent=(e,t,locationType,locationIndex,text,details,sendNotification,priority,_record,attack)=>{if (e.status != ke.Ended && e.playerStates.get(t).timeOfDeathInSecs >= 0) return;
 result.push({player:t,locationType,locationIndex,text,details,sendNotification,generateAlert:_record??true,urgent:priority===yn.Urgent,...(attack?{attack}:{})});};
 if(!["handleSubDeparture","handleSubChangedCourse","handleSubArrivalToDormantOutpost","handleSubArrivalWithCombat","handlePlayerEliminated","handleInTransitCombat","handleGameOver","notifyOfSentryFire","handleSentryFired","handleDoubleAgentActivated","handleSpecialistHired","handleFundingSet","handleFundingNoLongerValid","handleInactivityWarning","handlePlayerResigned","handleSpecialistReleased","handleSpecialistPromoted","handleCreateMine","handleNewHireAvailable"].includes(method))throw Error('Unsupported original notification');
 listener[method](state,...args);return result;
}
