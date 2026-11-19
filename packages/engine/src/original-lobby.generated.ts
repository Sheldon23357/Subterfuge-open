// @ts-nocheck
// Verbatim APK12075 lobby methods/countdown branch. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-lobby.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,ke={WaitingToStart:1,Starting:2,InProgress:3,Cancelled:5},De={Available:0,Occupied:1};
const _a={createRandomWorld:(s,...args)=>s.hooks.recreate(...args),createBestWorldStartingAtSeed:()=>{throw Error('Unsupported historical world recreation');}};
const Ms={calculate:(_cache,s)=>s.hooks.recalculate()};
const bX=(s,i)=>s.hooks.cancelSub(i);
class ut{static setSeatState(e, t, r) {
        const s = e.playerStates.get(t);
        s.seatState = r
    }
static getGameTimeInSeconds(s){return s.hooks.gameSeconds();}}
class kr{static joinGame(e, t) {
        return e.info.playerCount >= e.info.maxPlayerCount || e.playerStates.get(t).seatState != De.Available || e.status != ke.WaitingToStart ? !1 : (e.info.playerCount++, ut.setSeatState(e, t, De.Occupied), e.listener.handlePlayerJoined(e, t), !0)
    }
static leaveGame(e, t) {
        if (e.info.playerCount < 1 || e.status != ke.WaitingToStart || e.playerStates.get(t).seatState != De.Occupied) return !1;
        for (let r = 0; r < e.world.subs.count; r++) {
            const s = e.world.subs.get(r);
            s.used == !1 || s.ownerIndex != t || bX(e, r)
        }
        return e.info.playerCount--, ut.setSeatState(e, t, De.Available), e.listener.handlePlayerLeft(e, t), !0
    }
static cancelGame(e, t) {
        return e.status != ke.WaitingToStart || t != 0 || e.playerStates.get(t).seatState != De.Occupied ? !1 : (e.status = ke.Cancelled, !0)
    }
static startGame(e, t, r, s) {
        if (e.status != ke.WaitingToStart) return !1;
        e.info.initialMaxPlayerCount > e.info.playerCount ? (e.info.maxPlayerCount = e.info.playerCount, s.count = 0, he.RulesVersion >= 23 ? (_a.createRandomWorld(e, e.info.maxPlayerCount, r, e.info.percentGeneratorsMin, e.info.percentGeneratorsMax), e.secondsUntilGameInProgress = he.GameStartingDelayInHoursAfterWorldRecreation * 3600) : (_a.createBestWorldStartingAtSeed(e, e.info.maxPlayerCount, e.info.seed, e.info.percentGeneratorsMin, e.info.percentGeneratorsMax), e.secondsUntilGameInProgress = he.GameStartingDelayInHours * 3600), Ms.calculate(e.world.cachedValues, e)) : e.secondsUntilGameInProgress = he.GameStartingDelayInHours * 3600, e.status = ke.Starting, e.listener.handleGameStarting(e);
        const i = ut.getGameTimeInSeconds(e);
        for (let a = 0; a < e.info.playerCount; ++a) e.playerStates.get(a).lastCheckinTime = i;
        return !0
    }}
export const originalLobby={join:kr.joinGame,leave:kr.leaveGame,cancel:kr.cancelGame,start:kr.startGame};
/** Only the Starting branch; running-game time is handled by the game clock. */
export function originalLobbyCountdown(t,e){
 if(t.status!==ke.Starting)throw Error('Expected starting lobby');
 t.secondsSinceCreation+=e;
 {
            const i = Math.fround(e * t.timeFactor);
            t.secondsSinceStarting += i, t.secondsUntilGameInProgress -= i, t.secondsUntilGameInProgress <= 0 && (t.status = ke.InProgress, t.listener.handleGameStarted(t), t.secondsUntilGameInProgress = 0)
        }
}
