// @ts-nocheck
// Verbatim APK12075 recruitment excerpts. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-recruitment.mjs
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
const he=RULES.GameParams,K={MinutesPerTick:10,MaxSpecialistsPerPlayer:48},kc={NumHireOptions:3};
const q={Invalid:0,COUNT:31,...Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]))};
const mh={Attack:1,Defense:2,Other:3,Promoted:4},categories={attack:1,defense:2,other:3,promoted:4};
const kt=Array.from({length:31},()=>({category:0,promotesTo:0,amount:0}));
for(const s of SPECIALISTS)kt[s.client_type_id]={category:categories[s.category]??0,promotesTo:q[s.promotes_to]??0,amount:s.hire_bundle_size};
const DD=3,fne=2147483647,MPe=32767,B={Nothing:0,Outpost:1,Sub:2},ke={InProgress:0,WaitingToStart:1};
const Z=c=>{if(!c)throw Error('Original recruitment assertion');};
class an {
    capacity;
    count;
    elements;
    constructor(e) {
        this.capacity = e, this.count = 0, this.elements = new Array(e)
    }
    get(e) {
        return this.elements[e]
    }
    set(e, t) {
        this.elements[e] = t
    }
    clone() {
        const e = new an(this.capacity);
        return e.count = this.count, e.elements = this.elements.slice(0, this.count), e
    }
}
class p0 {
    m_next;
    m_stubsRemaining;
    m_stubs = new Array(16);
    constructor() {
        this.reset()
    }
    reset() {
        this.m_next = BigInt(1), this.m_stubsRemaining = 0
    }
    setSeed(e) {
        this.m_next = BigInt(e)
    }
    getFloat(e, t) {
        if (Z(e <= t), this.m_stubsRemaining > 0) return --this.m_stubsRemaining, I3(e, t, this.m_stubs[this.m_stubsRemaining]);
        {
            const r = this.customRand(),
                s = Math.fround(r / MPe);
            return I3(e, t, s)
        }
    }
    getFloatFromRange(e) {
        return this.getFloat(e.min, e.max)
    }
    getInt(e, t) {
        if (Z(e <= t), this.m_stubsRemaining > 0) {
            --this.m_stubsRemaining;
            const r = Math.fround(this.m_stubs[this.m_stubsRemaining]),
                s = I3(e, t + 1, r);
            return Math.min(s, t)
        } else return this.customRand() % (t - e + 1) + e
    }
    stubPercentages(e, t) {
        Z(t > 0);
        for (let r = 0; r < t; ++r) this.m_stubs[t - r - 1] = e[r];
        this.m_stubsRemaining = t
    }
    customRand() {
        return this.m_next = (this.m_next * BigInt(1103515245) & BigInt(4294967295)) + BigInt(12345) & BigInt(4294967295), Number(this.m_next >> BigInt(16) & BigInt(32767))
    }
}
function I3(n, e, t) {
    return n + t * (e - n)
}
function I2e(n, e) {
    const t = n,
        r = e;
    return t.random != r.random ? t.random - r.random : he.RulesVersion >= 29 || E.gameState.info.gameId == 20987 ? t.num - r.num : 0
}
function T2e(n, e) {
    if (n.get(0) != e && n.get(1) != e) return 0;
    for (let t = 1; t < n.count - 1; ++t)
        if (n.get(t - 1) != e && n.get(t) != e && n.get(t + 1) != e) return t;
    return -1
}
function pX(n, e, t) {
    const r = new an(DD * q.COUNT);
    for (let s = 0; s < q.COUNT; ++s)
        if (kt[s].category == e)
            for (let a = 0; a < DD; ++a) {
                let o = {
                    num: 0,
                    random: 0
                };
                o.num = s, o.random = t.getInt(0, fne), ct.add(r, o)
            }
    r.elements.sort(I2e), he.RulesVersion >= 23 && (n.count = 0);
    for (let s = 0; s < r.count; ++s) ct.add(n, r.get(s).num);
    for (let s = 0; s < n.count - 1; ++s)
        if (n.get(s) == n.get(s + 1)) {
            const i = T2e(n, n.get(s));
            if (i === -1) continue;
            n.set(s + 1, n.get(i)), n.set(i, n.get(s))
        }
}
function k3(n, e, t, r) {
    Z(e >= 0), oI.reset();
    const s = new an(DD * q.COUNT);
    if (oI.setSeed(ut.generateDeterministicDrawSeed(r, t, n) >>> 0), pX(s, r, oI), s.count === 0) return q.Invalid;
    const i = Math.trunc(e / s.count);
    for (let o = 0; o < i; ++o) pX(s, r, oI);
    const a = e % s.count;
    if (t < 0) {
        let o = dt.getSpecialistForHire(n, e, t, r);
        if (o != q.Invalid) return o
    }
    return s.get(a)
}
class ct{static add(e, t) {
        Z(e.count < e.capacity), e.count < e.capacity && (e.elements[e.count++] = t)
    }}
class mr{constructor(n){this.count=n;this.elements=Array(n).fill(0);}get(i){return this.elements[i];}set(i,v){this.elements[i]=v;}}
const oI=new p0;
class ut{static generateDeterministicDrawSeed(e, t, r) {
        return -1609100829 ^ t ^ e << 4 ^ r
    }}
class Ag{static getSpecialistsForHire(e, t, r, s) {
        Z(e.count == kc.NumHireOptions), e.set(0, k3(t, r - 1, s, mh.Other)), e.set(1, k3(t, r - 1, s, mh.Attack)), e.set(2, k3(t, r - 1, s, mh.Defense))
    }}
class $n{static getUnpromotedType(e) {
        for (let t = 0; t < 31; t++)
            if (kt[t].promotesTo == e) return q[Object.keys(q).find(r => q[r] === t)];
        return 0
    }
static getSecondsUntilCommitted(e, t) {
        return Math.max(e.secsUntilCommitted - Math.trunc(t), 0)
    }
static isBeingHired(e, t) {
        return $n.getSecondsUntilCommitted(e, t) <= 0 ? !1 : kt[e.type].category == 1 || kt[e.type].category == 2 || kt[e.type].category == 3
    }
static isBeingPromoted(e, t) {
        return $n.getSecondsUntilCommitted(e, t) <= 0 ? !1 : kt[e.type].category == 4
    }}
const fo=(n,i)=>n.playerStates.get(i).active;
// Host bridges are mandatory: no silently omitted world effects or cache updates.
const Ms={calculate:(_c,n)=>n.world.hooks.recalculate(n)};
class V{
static isSpecialistCaptive(w,i){return w.hooks.isCaptive(w,i);}
static getQueenIndex(e, t) {
        for (let r = 0; r < e.specialists.count; ++r) {
            const s = e.specialists.get(r);
            if (!(!s.used || s.ownerIndex != t || s.type != q.Queen) && !this.isSpecialistCaptive(e, r)) return r
        }
        return -1
    }
static playerHasPendingPromotionOrHire(e, t) {
        for (let r = 0; r < e.specialists.count; ++r) {
            const s = e.specialists.get(r);
            if (s.used && s.ownerIndex == t && $n.getSecondsUntilCommitted(s, e.secondsSinceLastTick) > 0) return !0
        }
        return !1
    }
static addSpecialist(w,t,o,l){return w.hooks.addSpecialist(w,t,o,l);}
static destroySpecialist(w,i){return w.hooks.destroySpecialist(w,i);}
static getOutpostIndexForSpecialistAbility(w,i){return w.hooks.getAbilityOutpost(w,i);}
static commitPendingSpecialistsForPlayer(e, t) {
        const r = e.world;
        for (let s = 0; s < r.specialists.count; ++s) {
            const i = r.specialists.get(s);
            if (i.used && i.ownerIndex == t && $n.getSecondsUntilCommitted(i, r.secondsSinceLastTick) > 0) {
                if (kt[i.type].category == mh.Promoted) e.listener.handleSpecialistPromoted(e, s);
                else {
                    const o = V.getOutpostIndexForSpecialistAbility(r, s);
                    o != -1 && e.listener.handleSpecialistHired(e, i.ownerIndex, i.type, o)
                }
                i.secsUntilCommitted = 0, _1(r, s)
            }
        }
        he.RulesVersion >= 26 && Ms.calculate(e.world.cachedValues, e), e.visibilityChanged = !0
    }
}
const _1=(w,i)=>w.hooks.activate(w,i);
class kr{static hireSpecialist(e, t, r, s) {
        if (!fo(e, t) || r.specialistHireIndex < 0 || r.specialistHireIndex >= kc.NumHireOptions) return !1;
        const i = e.playerStates.get(t);
        if (e.hiresAvailable + i.DEPRECATED_V18_extraHiresPurchased <= i.pastHireCount || he.RulesVersion >= 19 && r.hireNumber != i.pastHireCount || he.RulesVersion >= 28 && (r.specialistHireIndex < 0 || r.specialistHireIndex >= kc.NumHireOptions)) return !1;
        const a = new mr(kc.NumHireOptions);
        Ag.getSpecialistsForHire(a, t, i.pastHireCount + 1, e.info.seed);
        const o = a.get(r.specialistHireIndex);
        if (o == q.Invalid) return !1;
        const l = kt[o],
            c = V.getQueenIndex(e.world, t);
        if (c == -1) return !1;
        const d = e.world.specialists.get(c).location;
        if (d.type != B.Outpost) return !1;
        V.commitPendingSpecialistsForPlayer(e, t);
        for (let h = 0; h < l.amount; ++h) {
            const p = V.addSpecialist(e.world, o, t, d),
                A = e.world.specialists.get(p);
            A.hireActionUid = s
        }
        return i.pastHireCount++, e.visibilityChanged = !0, !0
    }
static togglePromoteSpecialist(e, t, r) {
        if (e.status != ke.InProgress || !fo(e, t)) return !1;
        const s = r.itemIndex,
            i = e.world.specialists.get(s);
        if (!i.used || i.ownerIndex != t) return !1;
        const a = e.playerStates.get(t),
            o = $n.getSecondsUntilCommitted(i, e.world.secondsSinceLastTick) > 0,
            l = $n.getUnpromotedType(i.type);
        if (o && l != q.Invalid) {
            a.pastHireCount--;
            const u = $n.getUnpromotedType(i.type);
            Z(u != q.Invalid), i.type = u, i.secsUntilCommitted = 0
        } else {
            const u = parseInt(kt[i.type].promotesTo);
            if (u == q.Invalid || e.hiresAvailable + a.DEPRECATED_V18_extraHiresPurchased <= a.pastHireCount || i.location.type != B.Outpost) return !1;
            V.commitPendingSpecialistsForPlayer(e, t), a.pastHireCount++, i.type = u, i.secsUntilCommitted = Math.trunc(he.MinutesToCancelAction * 60 + e.world.secondsSinceLastTick)
        }
        return !0
    }
static cancelHireSpecialist(e, t, r) {
        if (!fo(e, t)) return !1;
        const s = e.world.specialists.get(r.itemIndex);
        if (!s.used || !$n.isBeingHired(s, e.world.secondsSinceLastTick)) return !1;
        for (let a = 0; a < e.world.specialists.count; ++a) {
            const o = e.world.specialists.get(a);
            o.used && o.ownerIndex == t && $n.getSecondsUntilCommitted(o, e.world.secondsSinceLastTick) > 0 && V.destroySpecialist(e.world, a)
        }
        const i = e.playerStates.get(t);
        return i.pastHireCount--, !0
    }
static finalizeHireOrPromotion(e, t) {
        return fo(e, t) ? (V.commitPendingSpecialistsForPlayer(e, t), e.visibilityChanged = !0, !0) : !1
    }}
function y3e(n) {
    const e = n.world;
    for (let t = 0; t < e.specialists.count; ++t) {
        const r = e.specialists.get(t);
        if (r.used && r.secsUntilCommitted > 0) {
            if (r.secsUntilCommitted = r.secsUntilCommitted - K.MinutesPerTick * 60, r.secsUntilCommitted > 0) continue;
            if (r.secsUntilCommitted = 0, kt[r.type].category == mh.Promoted) n.listener.handleSpecialistPromoted(n, t);
            else {
                const i = V.getOutpostIndexForSpecialistAbility(e, t);
                i >= 0 && n.listener.handleSpecialistHired(n, r.ownerIndex, r.type, i)
            }
            _1(e, t)
        }
    }
}
function i3e(n, e) {
    if (e < 0) return -1;
    const t = e * K.MaxSpecialistsPerPlayer;
    for (let r = 0; r < K.MaxSpecialistsPerPlayer; r++) {
        n.specialistCounter[e]++;
        let s = t + n.specialistCounter[e] % K.MaxSpecialistsPerPlayer;
        if (!n.specialists.get(s).used) return s
    }
    return -1
}
export const originalAllocateSpecialistSlot=i3e;
export const originalRecruitment={hire:kr.hireSpecialist,promote:kr.togglePromoteSpecialist,cancel:kr.cancelHireSpecialist,commit:kr.finalizeHireOrPromotion,tick:y3e};
// Same original hire body; only draw lookup is supplied by restricted knowledge.
// Never call the deterministic seed generator for a forecast's unknown draw.
export function originalHireWithKnownDraw(state,player,data,uid,lookup){
 const Ag={getSpecialistsForHire:(out,seat,number)=>{const choices=lookup(seat,number);if(choices.length!==3)throw Error('Invalid known recruitment draw');choices.forEach((type,i)=>out.set(i,type));}};
 const hire=function(e,t,r,s){
        if (!fo(e, t) || r.specialistHireIndex < 0 || r.specialistHireIndex >= kc.NumHireOptions) return !1;
        const i = e.playerStates.get(t);
        if (e.hiresAvailable + i.DEPRECATED_V18_extraHiresPurchased <= i.pastHireCount || he.RulesVersion >= 19 && r.hireNumber != i.pastHireCount || he.RulesVersion >= 28 && (r.specialistHireIndex < 0 || r.specialistHireIndex >= kc.NumHireOptions)) return !1;
        const a = new mr(kc.NumHireOptions);
        Ag.getSpecialistsForHire(a, t, i.pastHireCount + 1, e.info.seed);
        const o = a.get(r.specialistHireIndex);
        if (o == q.Invalid) return !1;
        const l = kt[o],
            c = V.getQueenIndex(e.world, t);
        if (c == -1) return !1;
        const d = e.world.specialists.get(c).location;
        if (d.type != B.Outpost) return !1;
        V.commitPendingSpecialistsForPlayer(e, t);
        for (let h = 0; h < l.amount; ++h) {
            const p = V.addSpecialist(e.world, o, t, d),
                A = e.world.specialists.get(p);
            A.hireActionUid = s
        }
        return i.pastHireCount++, e.visibilityChanged = !0, !0
    };
 return hire(state,player,data,uid);
}
export function originalHireOptions(seed,player,number){if(seed<0)throw Error('Puzzle seeds require tutorial data');const result=new mr(3);Ag.getSpecialistsForHire(result,player,number,seed);return result.elements;}
export const originalPendingRecruitment=V.playerHasPendingPromotionOrHire;
// Exact time-machine preview gates. The caller supplies the present/offset
// bridges and a draw lookup; null means that draw is absent from known input.
// A per-call lexical fe avoids shared mutable time-machine context.
export function originalRecruitmentPreviews(present,offset,player,lookup){
 const fe={instance:()=>({getGameStateAtOffset:()=>offset,getGameStateAtPresent:()=>present})};
 const requested={current:null,next:null};let stage='current';
 class Ag{
 static getSpecialistsForHire(out,seat,number,seed){
  requested[stage]=number;const values=lookup(seat,number);
  if(values!==null&&values.length!==3)throw Error('Invalid preview recruitment draw');
  for(let i=0;i<3;i++)out.set(i,values===null?q.Invalid:values[i]);
 }
 static getCurrentHireOptionsForPlayer(e, t) {
        Z(t.count == kc.NumHireOptions);
        const r = fe.instance().getGameStateAtOffset(),
            s = fe.instance().getGameStateAtPresent(),
            i = r.playerStates.get(e),
            a = s.playerStates.get(e);
        let o = r.hiresAvailable + i.DEPRECATED_V18_extraHiresPurchased > i.pastHireCount,
            l = s.hiresAvailable + a.DEPRECATED_V18_extraHiresPurchased > a.pastHireCount,
            c = i.pastHireCount + 1,
            u = s.status == ke.WaitingToStart,
            d = a.pastHireCount + 1,
            h = V.playerHasPendingPromotionOrHire(s.world, e);
        if (l && !h && d++, !o || u || c > d) {
            for (let p = 0; p < kc.NumHireOptions; p++) t.set(p, q.Invalid);
            return
        }
        this.getSpecialistsForHire(t, e, c, r.info.seed)
    }
static getNextHireOptionsForPlayer(e, t) {
        Z(t.count == kc.NumHireOptions);
        const r = fe.instance().getGameStateAtOffset(),
            s = fe.instance().getGameStateAtPresent(),
            i = r.playerStates.get(e),
            a = s.playerStates.get(e),
            o = r.hiresAvailable + i.DEPRECATED_V18_extraHiresPurchased > i.pastHireCount,
            l = s.hiresAvailable + a.DEPRECATED_V18_extraHiresPurchased > a.pastHireCount;
        let c = i.pastHireCount + 1;
        o && c++;
        let u = a.pastHireCount + 1;
        if (l && u++, V.playerHasPendingPromotionOrHire(s.world, e) && l || s.status == ke.WaitingToStart || c > u) {
            for (let h = 0; h < kc.NumHireOptions; h++) t.set(h, q.Invalid);
            return
        }
        Ag.getSpecialistsForHire(t, e, c, r.info.seed)
    }
 }
 const current=new mr(3),next=new mr(3);
 Ag.getCurrentHireOptionsForPlayer(player,current);stage='next';Ag.getNextHireOptionsForPlayer(player,next);
 return{current:current.elements,next:next.elements,requested};
}
export function originalHireSeed(category,seed,player){return ut.generateDeterministicDrawSeed(category,seed,player)>>>0;}
export {p0 as OriginalRecruitmentRandom};
