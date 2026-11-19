// @ts-nocheck
// Verbatim APK 12075 inactivity functions. Do not format. Source SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1.
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,Re={CheckIn:'check-in'};
const K={MinutesPerTick:10,SecondsPerTick:600};
const De={Available:0,Occupied:1,Resigned:2,AutoResigned:3,Eliminated:4};
const fe={instance:()=>({isSimulatedFuture:n=>n.simulatedFuture})};
const V={destroySpecialist:()=>{throw Error('Legacy cleanup is not applicable to rules 4300');}};
class ut{
static getMinutesSinceLastSeen(e, t) {
        const r = e.playerStates.get(t);
        return e.tickCount * K.MinutesPerTick - r.lastCheckinTime / 60
    }
static getGameTimeInSeconds(n){return n.seconds;}
}
class kr{
static checkIn(e, t) {
        const r = e.playerStates.get(t);
        return r.seatState == De.Occupied && (r.lastCheckinTime = ut.getGameTimeInSeconds(e)), !0
    }
static cancelInactivityWarning(e, t) {
        const r = e.playerStates.get(t);
        return r.inactivityWarningCount = 0, r.lastCheckinTime = ut.getGameTimeInSeconds(e), !0
    }
static resign(n,i){return n.resign(i);}
}
function H2e(n) {
    if (n < he.MinutesOfInactivityBeforeFirstWarning) return 0;
    if (n < he.MinutesOfInactivityBeforeFirstWarning + he.MinutesOfInactivityBetweenWarnings) return 1;
    const e = Math.trunc(n - he.MinutesOfInactivityBeforeFirstWarning);
    return Math.trunc(e / he.MinutesOfInactivityBetweenWarnings)
}
function J2e(n, e) {
    for (let t = 0; t < n.specialists.count; ++t) {
        const r = n.specialists.get(t);
        r.used && r.ownerIndex == e && V.destroySpecialist(n, t)
    }
}
function K2e(n) {
    for (let e = 0; e < n.info.maxPlayerCount; e++) {
        const t = n.playerStates.get(e);
        switch (t.seatState) {
            case De.Occupied: {
                const r = ut.getMinutesSinceLastSeen(n, e);
                if (r >= he.HoursOfInactivityBeforeAutoresign * 60 && !fe.instance().isSimulatedFuture(n)) {
                    kr.resign(n, e), t.seatState = De.AutoResigned;
                    continue
                }
                const s = H2e(r);
                s > t.inactivityWarningCount && (t.inactivityWarningCount = s, n.listener.handleInactivityWarning(n, e, r)), t.inactivityWarningCount = s;
                break
            }
            case De.AutoResigned:
            case De.Eliminated:
            case De.Resigned: {
                if (he.RulesVersion < 23 && n.world.cachedValues.get(e).totalCaptiveSpecialistCount > 0) {
                    const r = Math.trunc((t.timeOfDeathInSecs + he.HoursAfterEliminationToDestroySpecialists * 3600) / K.SecondsPerTick);
                    n.tickCount >= r && J2e(n.world, e)
                }
                break
            }
        }
    }
}
export function originalClearActivityWarnings(e,t){if (e.type != Re.CheckIn) {
            const o = t.playerStates.get(e.playerIndex);
            o.inactivityWarningCount = 0
        }}
export const originalInactivity={tick:K2e,warningCount:H2e,checkIn:kr.checkIn,cancelWarning:kr.cancelInactivityWarning};
