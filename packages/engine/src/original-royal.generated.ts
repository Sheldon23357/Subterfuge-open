// @ts-nocheck
// Verbatim numerical/lifecycle excerpts, APK 12075. Do not format this generated file.
// Source SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1. Regenerate: node scripts/extract-royal.mjs
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams;
const q={Queen:'Queen',Princess:'Princess',SecurityChief:'SecurityChief',Inspector:'Inspector',King:'King'};
const B={Specialist:3},De={Available:0,Occupied:1,Resigned:2,Eliminated:3},ta=340282347e30,Zn=999999974e-13;
const Z=c=>{if(!c)throw Error('Original royal assertion');};
const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
class Hc{};class G extends Hc{static add(e, t, r) {
        return e.x = t.x + r.x, e.y = t.y + r.y, e
    }
static subtract(e, t, r) {
        return e.x = t.x - r.x, e.y = t.y - r.y, e
    }
static lengthSqr(e) {
        const t = e.x,
            r = e.y;
        return t * t + r * r
    }
constructor(e, t) {
        super(), typeof e == "object" ? (this.x = e.x, this.y = e.y) : (this.x = e || 0, this.y = t || 0)
    }
add(e) {
        return this.x += e.x, this.y += e.y, this
    }
subtract(e) {
        return this.x -= e.x, this.y -= e.y, this
    }
lengthSqr() {
        return this.x * this.x + this.y * this.y
    }}
class we{constructor(type,index){this.type=type;this.index=index;}}
class V{
static getUnwrappedPosWithDimensions(e, t, r, s) {
        const i = So(e.x - t.x),
            a = So(e.y - t.y),
            o = i * (e.x - t.x) <= r / 2 ? new G(0, 0) : new G(-i * r, 0),
            l = a * (e.y - t.y) <= s / 2 ? new G(0, 0) : new G(0, -a * s);
        return G.add(o, e, o.add(l))
    }
static getMinDistSquared(e, t, r, s) {
        return Z(Math.abs(e.x) <= r / 2 + Zn && Math.abs(t.x) <= r / 2 + Zn), Z(Math.abs(e.y) <= s / 2 + Zn && Math.abs(t.y) <= s / 2 + Zn), this.getUnwrappedPosWithDimensions(e, t, r, s).subtract(t).lengthSqr()
    }
static changeSpecialistOwnership(e, t, r) {
        const s = e.specialists.get(t);
        s.type == q.Queen && e.cachedValues.get(r).freeSpecialistCount[q.Queen] > 0 && (s.type = q.Princess), s.ownerIndex = r
    }
static isSpecialistCaptive(w,i){return w.specialists.get(i).captive;}
static getItemPosition(w,location){return w.specialists.get(location.index).position;}
}
class ut{
static eliminatePlayer(e, t) {
        this.setSeatState(e, t, De.Eliminated);
        const r = e.playerStates.get(t);
        r.timeOfDeathInSecs = this.getGameTimeInSeconds(e), r.neptunium = 0;
        for (let s = 0; s < e.info.maxPlayerCount; s++) e.playerStates.get(t).isFundingPlayer[s] = !1, e.playerStates.get(s).isFundingPlayer[t] = !1;
        if (he.RulesVersion < 19) {
            for (let s = 0; s < e.world.subs.count; s++) {
                const i = e.world.subs.get(s);
                i.used && i.ownerIndex == t && (i.ownerIndex = -1)
            }
            for (let s = 0; s < e.world.outposts.count; s++) {
                const i = e.world.outposts.get(s);
                i.ownerIndex == t && (i.ownerIndex = -1)
            }
        }
    }
static setSeatState(n,i,value){n.playerStates.get(i).seatState=value;}
static getGameTimeInSeconds(n){return n.seconds;}
}
const dt={getPuzzleIndex:()=>-1};
const fo=(n,i)=>n.playerStates.get(i).timeOfDeathInSecs<0;
const te={getScreenName:(_n,i)=>String(i)};
class kr{static resign(e, t) {
        if (!fo(e, t)) return !1;
        const r = e.playerStates.get(t);
        return Z(r.seatState != De.Available), r.seatState == De.Available ? !1 : (e.listener.handlePlayerResigned(e, t, te.getScreenName(e.info, t)), ut.eliminatePlayer(e, t), ut.setSeatState(e, t, De.Resigned), he.RulesVersion < 18 && (r.pastHireCount = 1e4), r.timeOfDeathInSecs = ut.getGameTimeInSeconds(e), !0)
    }}
function j2e(n, e, t) {
    if (he.RulesVersion >= 18) {
        let r = -1,
            s = ta;
        for (let i = 0; i < n.specialists.count; ++i) {
            const a = n.specialists.get(i);
            if (a.used && !a.isDying && a.ownerIndex == e && a.type == q.Princess && !V.isSpecialistCaptive(n, i)) {
                const o = V.getItemPosition(n, new we(B.Specialist, i)),
                    l = V.getMinDistSquared(o, t, n.width, n.height);
                l < s && (s = l, r = i)
            }
        }
        if (r >= 0) {
            const i = n.specialists.get(r);
            return i.type = q.Queen, i.secsUntilCommitted = 0, !0
        }
    } else
        for (let r = 0; r < n.specialists.count; ++r) {
            const s = n.specialists.get(r);
            if (s.used && !s.isDying && s.ownerIndex == e && s.type == q.Princess && !V.isSpecialistCaptive(n, r)) return s.type = q.Queen, s.secsUntilCommitted = 0, !0
        }
    return !1
}
function q2e(n) {
    let e = 0;
    for (let t = 0; t < n.info.maxPlayerCount; ++t) n.playerStates.get(t).timeOfDeathInSecs < 0 && e++;
    return e
}
function X2e(n, e) {
    let t = dt.getPuzzleIndex(n),
        r = q2e(n);
    for (let s = 0; s < n.info.maxPlayerCount; ++s) t >= 0 && dt.getPuzzle(t).allowNoQueen || n.playerStates.get(s).timeOfDeathInSecs >= 0 || n.world.cachedValues.get(s).freeSpecialistCount[q.Queen] == 0 && (j2e(n.world, s, e.get(s)) || (ut.eliminatePlayer(n, s), n.listener.handlePlayerEliminated(n, s, r), r--))
}
function Q2e(n, e) {
    for (let t = 0; t < e.specialists.count; ++t) {
        const r = e.specialists.get(t);
        if (r.type == q.Queen && r.ownerIndex >= 0 && !V.isSpecialistCaptive(e, t)) {
            const s = V.getItemPosition(e, new we(B.Specialist, t));
            n.set(r.ownerIndex, s)
        }
    }
}
function kH(n, e, t) {
    const r = n.outposts.get(e);
    let s = r.shieldMaxCharge;
    if (r.ownerIndex < 0) return s;
    const i = n.cachedValues.get(r.ownerIndex);
    if (i == null) return s;
    if (s += t.get(q.SecurityChief) * $e.SecurityChiefLocalShieldBonus, s += i.freeSpecialistCount[q.SecurityChief] * $e.SecurityChiefGlobalShieldBonus, s += t.get(q.Inspector) * $e.InspectorShieldBonus, s += t.get(q.Queen) * $e.QueenShieldBonus, he.RulesVersion < 42) {
        const o = t.get(q.King);
        s += o * $e.KingShieldPenalty * 2
    }
    const a = i.freeSpecialistCount[q.King];
    return s -= a * $e.KingShieldPenalty, s = Math.max(s, 0), s
}
export const originalResign=(n,i)=>kr.resign(n,i);
export const originalInherit=j2e;
export const originalQueenPositions=Q2e;
export const originalChangeOwnership=V.changeSpecialistOwnership;
export const originalQueenLoss=X2e;
export const originalShieldMaximum=kH;
