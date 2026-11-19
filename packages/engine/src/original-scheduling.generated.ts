// @ts-nocheck
// Verbatim APK12075 authoritative future queue. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-scheduling.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,fe={instance:()=>null},Re={LaunchSub:2},K={MaxSubsPerPlayer:128};
const De={Resigned:2,AutoResigned:3,Eliminated:4};
class te{static teamOf(e, t) {
        return e.teamSize > 0 ? Math.floor(t / e.teamSize) : t
    } static isAlly(e, t, r) {
        return t < 0 || r < 0 ? !1 : this.teamOf(e, t) == this.teamOf(e, r)
    }}
class Gg{static isSameFutureSubLaunch(e, t) {
        return !(e.type != 2 || t.type != 2 || Math.abs(e.scheduledTick - t.scheduledTick) > 1 || e.scheduledTick < 0 || t.scheduledTick < 0 || e.launchSubData.srcOutpostIndex != t.launchSubData.srcOutpostIndex || e.launchSubData.dstItemType != t.launchSubData.dstItemType || e.launchSubData.dstItemIndex != t.launchSubData.dstItemIndex || e.launchSubData.subIndex != t.launchSubData.subIndex)
    }}
function F2e(n, e, t) {
    const r = e.actions[t],
        s = r.launchSubData.subIndex;
    if (s < 0 || he.RulesVersion < 27 && !n.world.subs.get(s).reserved) return !1;
    n.world.subs.get(s).reserved = !1;
    for (let i = 0; i < e.count; i++) {
        const a = e.actions[i];
        Gg.isSameFutureSubLaunch(a, r) && (a.canceled = !0)
    }
    return !0
}
class ut{static findNextAvailableSubIndex(e, t) {
        const r = e.playerStates.get(t),
            s = t * K.MaxSubsPerPlayer;
        for (let i = 0; i < K.MaxSubsPerPlayer; i++) {
            r.subCounter++;
            let a = s + r.subCounter % K.MaxSubsPerPlayer;
            const o = e.world.subs.get(a);
            if (!o.used && !o.reserved) return a
        }
        return -1
    }}
class kr{static perform(action,state){return state.perform(action);}
static reserveSubIndex(e, t) {
        const r = ut.findNextAvailableSubIndex(e, t);
        if (r == -1) return -1;
        const s = e.world.subs.get(r);
        return s.used || s.reserved ? -1 : (s.reserved = !0, r)
    }
static cancelFutureAction(e, t, r, s) {
        for (let i = 0; i < t.count; i++) {
            const a = t.actions[i];
            if (a.uid == s.uid) {
                if (a.playerIndex != r || a.scheduledTick < e.tickCount) return !1;
                let o;
                return a.type === Re.LaunchSub ? o = F2e(e, t, i) : o = !0, o && (a.canceled = !0), o
            }
        }
        return !1
    }}
export const originalNextFleetSlot=(state,player)=>ut.findNextAvailableSubIndex(state,player);
export const originalReserveFleetSlot=(state,player)=>kr.reserveSubIndex(state,player);
export const originalSameFutureLaunch=Gg.isSameFutureSubLaunch;
export const originalCancelFutureAction=(state,actions,player,uid)=>kr.cancelFutureAction(state,{count:actions.length,actions},player,{uid});
class tr{static applyFutureActionsIfAny(e, t, r = !1) {
        const s = fe.instance() != null && fe.instance().isSimulatedFuture(t);
        let i = !1;
        for (let a = 0; a < e.count; a++) {
            const o = e.actions[a];
            if (o.scheduledTick != t.tickCount || o.canceled || !r && s && !this.isFutureActionKnownToLocalPlayer(t, o)) continue;
            let l = kr.perform(o, t, e, !1);
            if (i ||= l, o.failed = !l, o.type == Re.LaunchSub)
                for (let c = a - 1; c >= 0; c--) {
                    const u = e.actions[c];
                    Gg.isSameFutureSubLaunch(o, u) && (u.failed = o.failed)
                }
        }
        return i
    } static isFutureActionKnownToLocalPlayer(e, t) {
        if (!te.isAlly(e.info, e.youPlayerIndex, t.playerIndex)) return !1;
        const r = e.playerStates.get(t.playerIndex).seatState;
        return r != De.AutoResigned && r != De.Eliminated && r != De.Resigned
    }}
export function originalFutureActionKnown(teamSize,viewer,issuer,seatState){return tr.isFutureActionKnownToLocalPlayer({info:{teamSize},youPlayerIndex:viewer,playerStates:{get:()=>({seatState})}},{playerIndex:issuer});}
export const originalSameTeam=(teamSize,a,b)=>te.isAlly({teamSize},a,b);
/** Authoritative only; player forecasts must supply their own filtered input. */
export function applyOriginalFutureQueue(actions,tick,perform){return tr.applyFutureActionsIfAny({count:actions.length,actions},{tickCount:tick,perform});}
