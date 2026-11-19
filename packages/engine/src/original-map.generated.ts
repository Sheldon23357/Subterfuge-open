// @ts-nocheck
// Reviewed, verbatim APK 12075 excerpts. Regenerate with scripts/extract-map.mjs.
// SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1. No bundle initialization, UI, network or dynamic code execution.
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,Vn=RULES.OutpostParams;
const K={MaxPlayerCount:10,MaxOutpostCount:100,OutpostsPerPlayer:10,MinutesPerTick:10,MaxSpecialistsPerLocation:128};
const pe={Mine:0,Factory:1,Generator:2,Destroyed:3},q={Queen:'Queen'},B={Outpost:1};
const P2e=200,gX=3,M2e=.33,MPe=32767,Zn=999999974e-13,ta=340282347e30;
const Z=(v)=>{if(!v)throw Error('Original map assertion');},Xte=Z;
const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
class G{constructor(x=0,y=0){this.x=x;this.y=y;}set(x,y){if(typeof x==='object'){this.x=x.x;this.y=x.y;}else{this.x=x;this.y=y;}return this;}clone(){return new G(this.x,this.y)}add(p){this.x+=p.x;this.y+=p.y;return this;}length(){return Math.sqrt(this.x*this.x+this.y*this.y);}static add(e,t,r){e.x=t.x+r.x;e.y=t.y+r.y;return e;}static subtract(e,t,r){e.x=t.x-r.x;e.y=t.y-r.y;return e;}}
class an{constructor(n){this.count=0;this.elements=new Array(n);}get(i){return this.elements[i];}}
class mr{constructor(n){this.elements=new Array(n);}}
const ct={add(a,p){a.elements[a.count++]=p;}};
class we{constructor(type,index){this.type=type;this.index=index;}}
const na=new G();
class V{static getUnwrappedPosWithDimensions(e, t, r, s) {
        const i = So(e.x - t.x),
            a = So(e.y - t.y),
            o = i * (e.x - t.x) <= r / 2 ? new G(0, 0) : new G(-i * r, 0),
            l = a * (e.y - t.y) <= s / 2 ? new G(0, 0) : new G(0, -a * s);
        return G.add(o, e, o.add(l))
    }
static getUnwrappedPos(e, t, r) {
        return this.getUnwrappedPosWithDimensions(t, r, e.width, e.height)
    }
static getWrappedPos2(e, t) {
        return this.getWrappedPos(e.width, e.height, t)
    }
static getWrappedPos(e, t, r) {
        const i = r.clone();
        let a = 0;
        for (a = 0; a < 10 && !(i.x <= e / 2); ++a) i.x -= e;
        for (Z(a < 10), a = 0; a < 10 && !(i.x >= -e / 2); ++a) i.x += e;
        for (Z(a < 10), a = 0; a < 10 && !(i.y <= t / 2); ++a) i.y -= t;
        for (Z(a < 10), a = 0; a < 10 && !(i.y >= -t / 2); ++a) i.y += t;
        return Z(a < 10), i
    }
static getMinDist(e, t, r) {
        Z(Math.abs(t.x) <= e.width / 2 && Math.abs(r.x) <= e.width / 2), Z(Math.abs(t.y) <= e.height / 2 && Math.abs(r.y) <= e.height / 2);
        const s = V.getUnwrappedPos(e, t, r),
            i = Math.fround(G.subtract(na, s, r).length()),
            a = i * i;
        return a < Zn ? 0 : Math.sqrt(a)
    }
static addSpecialistCommitted(w,type,owner,location){w.queens.push({type,owner,outpost:location.index});}
}
function I3(n, e, t) {
    return n + t * (e - n)
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

class b2 {
    private_type;
    originalType;
    pos = new G(0, 0);
    ownerIndex;
    drillers;
    futureUnknown;
    shieldsEnabled;
    electricalOutput;
    ticksSinceLastDrillerProduction;
    ticksSinceLastNeptuniumProduction;
    ticksSinceLastShieldPower;
    nameIndex;
    private_secsUntilMineCreation;
    secsUntilShieldDisable;
    mostRecentShieldActionUid;
    shieldMaxCharge;
    shieldCharge;
    specialistCache;
    meantForPlayer;
    closestAssignedOutpost;
    distToClosestAssignedOutpost;
    constructor() {
        this.reset()
    }
    reset() {
        this.private_type = pe.Destroyed, this.originalType = pe.Destroyed, this.pos.set(0, 0), this.ownerIndex = -1, this.drillers = 0, this.futureUnknown = !1, this.shieldsEnabled = !0, this.electricalOutput = 0, this.ticksSinceLastDrillerProduction = 0, this.ticksSinceLastNeptuniumProduction = 0, this.ticksSinceLastShieldPower = 0, this.nameIndex = -1, this.private_secsUntilMineCreation = 0, this.secsUntilShieldDisable = 0, this.mostRecentShieldActionUid = -1, this.shieldMaxCharge = 0, this.shieldCharge = 0, this.specialistCache = new an(K.MaxSpecialistsPerLocation), this.meantForPlayer = -1, this.closestAssignedOutpost = -1, this.distToClosestAssignedOutpost = 1e8
    }
    clone() {
        const e = new b2;
        return e.copyFrom(this), e
    }
    copyFrom(e) {
        this.private_type = e.private_type, this.originalType = e.originalType, this.pos = e.pos.clone(), this.ownerIndex = e.ownerIndex, this.drillers = e.drillers, this.futureUnknown = e.futureUnknown, this.shieldsEnabled = e.shieldsEnabled, this.electricalOutput = e.electricalOutput, this.ticksSinceLastDrillerProduction = e.ticksSinceLastDrillerProduction, this.ticksSinceLastNeptuniumProduction = e.ticksSinceLastNeptuniumProduction, this.ticksSinceLastShieldPower = e.ticksSinceLastShieldPower, this.nameIndex = e.nameIndex, this.private_secsUntilMineCreation = e.private_secsUntilMineCreation, this.secsUntilShieldDisable = e.secsUntilShieldDisable, this.mostRecentShieldActionUid = e.mostRecentShieldActionUid, this.shieldMaxCharge = e.shieldMaxCharge, this.shieldCharge = e.shieldCharge, this.specialistCache = e.specialistCache.clone(), this.meantForPlayer = e.meantForPlayer, this.closestAssignedOutpost = e.closestAssignedOutpost, this.distToClosestAssignedOutpost = e.distToClosestAssignedOutpost
    }
}

function AX(n) {
    return n.getFloat(0, 1) < M2e ? Vn.StrongShieldMaxCharge : Vn.WeakShieldMaxCharge
}

function R2e(n, e) {
    for (let t = 0; t < e.outposts.count; t++)
        if (V.getMinDist(e, n, e.outposts.get(t).pos) < Vn.MinDistBetweenOutposts) return !1;
    return !0
}

function O2e(n, e) {
    let t = n.outposts.get(n.outposts.count);
    t.reset(), t.pos = V.getWrappedPos2(n, e), t.pos.x = Math.fround(t.pos.x), t.pos.y = Math.fround(t.pos.y), t.nameIndex = n.outposts.count, ct.add(n.outposts, t)
}

function B2e(n, e, t) {
    let r = -n.width / 2,
        s = -r,
        i = -n.height / 2,
        a = -i,
        o = new G;
    for (let l = 0; l < e; l++) {
        let c = !1;
        for (let u = 0; u < 200; u++)
            if (o.x = Math.fround(t.getFloat(r, s)), o.y = Math.fround(t.getFloat(i, a)), o = V.getWrappedPos2(n, o), o.x = Math.fround(o.x), o.y = Math.fround(o.y), R2e(o, n)) {
                O2e(n, o), c = !0;
                break
            } if (!c) return !1
    }
    return !0
}

function xne(n, e, t) {
    const r = new Array(K.MaxPlayerCount);
    for (let i = 0; i < K.MaxPlayerCount; i++) r[i] = new G(0, 0);
    const s = new G;
    for (let i = 0; i < t; i++)
        for (let a = i + 1; a < t; a++) {
            const o = V.getUnwrappedPos(n, e[a], e[i]);
            o.x = Math.fround(o.x), o.y = Math.fround(o.y), s.set(0, 0), s.x = Math.fround(Math.fround(o.x) - Math.fround(e[i].x)), s.y = Math.fround(Math.fround(o.y) - Math.fround(e[i].y));
            const l = Math.fround(Math.fround(Math.fround(s.x) * Math.fround(s.x)) + Math.fround(Math.fround(s.y) * Math.fround(s.y)));
            let c = Math.fround(Math.fround(50) / Math.fround(l));
            if (c = Math.fround(Math.min(c, 50)), l > Zn) {
                let u = yX(s);
                u.x = Math.fround(Math.fround(u.x) * Math.fround(c)), u.y = Math.fround(Math.fround(u.y) * Math.fround(c)), r[a].x = Math.fround(Math.fround(r[a].x) + Math.fround(u.x)), r[a].y = Math.fround(Math.fround(r[a].y) + Math.fround(u.y)), r[i].x = Math.fround(Math.fround(r[i].x) - Math.fround(u.x)), r[i].y = Math.fround(Math.fround(r[i].y) - Math.fround(u.y))
            }
        }
    for (let i = 0; i < t; i++) {
        let a = Math.fround(Math.fround(Math.fround(r[i].x) * Math.fround(r[i].x)) + Math.fround(Math.fround(r[i].y) * Math.fround(r[i].y))),
            o = Math.sqrt(Math.fround(a));
        const l = Math.fround(o),
            c = Math.fround(Math.fround(l) * Math.fround(.5));
        l > Zn && (r[i] = yX(r[i]), r[i].x = Math.fround(r[i].x), r[i].y = Math.fround(r[i].y), r[i].x = Math.fround(Math.fround(r[i].x) * Math.fround(c)), r[i].y = Math.fround(Math.fround(r[i].y) * Math.fround(c))), e[i].x = Math.fround(Math.fround(e[i].x) + Math.fround(r[i].x)), e[i].y = Math.fround(Math.fround(e[i].y) + Math.fround(r[i].y)), e[i] = V.getWrappedPos2(n, e[i]), e[i].x = Math.fround(e[i].x), e[i].y = Math.fround(e[i].y)
    }
}

function L2e(n, e, t, r) {
    for (let i = 0; i < t; i++) e[i].x = Math.fround(r.getFloat(0, n.width)), e[i].y = Math.fround(r.getFloat(0, n.height)), e[i] = V.getWrappedPos2(n, e[i]), e[i].x = Math.fround(e[i].x), e[i].y = Math.fround(e[i].y);
    let s = 300;
    for (let i = 0; i < s; i++) xne(n, e, t)
}

function D2e(n) {
    for (let e = 0; e < n.outposts.count; e++) n.outposts.get(e).meantForPlayer = -1, n.outposts.get(e).closestAssignedOutpost = -1, n.outposts.get(e).distToClosestAssignedOutpost = 999999999;
    for (let e = 0; e < n.outposts.count; e++) {
        const t = n.outposts.get(e);
        if (t.ownerIndex >= 0) {
            t.meantForPlayer = t.ownerIndex;
            continue
        }
        for (let r = 0; r < n.outposts.count; r++) {
            const s = n.outposts.get(r);
            if (e == r || s.ownerIndex < 0 || he.RulesVersion < 21 && n.outposts.get(r).drillers == 0) continue;
            let i = V.getMinDist(n, t.pos, s.pos);
            i < t.distToClosestAssignedOutpost && (t.distToClosestAssignedOutpost = i, t.closestAssignedOutpost = r, t.meantForPlayer = s.ownerIndex)
        }
    }
}

function N2e(n, e, t, r, s) {
    const i = new Array(K.OutpostsPerPlayer);
    let a = new Array(K.OutpostsPerPlayer),
        o = new Array(K.OutpostsPerPlayer),
        l = t.getFloat(r, s),
        c = Math.trunc(l / 100 * K.OutpostsPerPlayer);
    for (let d = 0; d < K.OutpostsPerPlayer; d++) i[d] = d < c ? pe.Generator : pe.Factory, a[d] = AX(t), o[d] = t.getInt(0, Vn.MinutesBetweenDrillerProductions / K.MinutesPerTick);
    he.RulesVersion == 12 ? i[0] = pe.Mine : Z(i[0] == pe.Generator);
    for (let d = 0; d < 100; d++) {
        let h = t.getInt(1, K.OutpostsPerPlayer - 1),
            p = t.getInt(1, K.OutpostsPerPlayer - 1),
            A = i[h];
        i[h] = i[p], i[p] = A
    }
    let u = Array.from({
        length: K.MaxPlayerCount
    }, () => Array(K.MaxOutpostCount).fill(0));
    for (let d = 0; d < e; d++)
        for (let h = 0; h < n.outposts.count; h++) u[d][h] = V.getMinDist(n, n.outposts.get(h).pos, n.playerOrigins[d]);
    for (let d = 0; d < K.OutpostsPerPlayer; d++)
        for (let h = 0; h < e; h++) {
            let p = -1,
                A = ta;
            for (let y = 0; y < n.outposts.count; y++) {
                const x = n.outposts.get(y);
                if (x.private_type != pe.Destroyed) continue;
                const v = Math.fround(V.getMinDist(n, x.pos, n.playerOrigins[h]));
                v < A && (A = v, p = y)
            }
            const g = n.outposts.get(p);
            switch (g.private_type = i[d], g.originalType = g.private_type, g.private_type) {
                case pe.Factory:
                    g.electricalOutput = 0, g.ticksSinceLastDrillerProduction = o[d];
                    break;
                case pe.Generator:
                    g.electricalOutput = Vn.GeneratorElectricalOutput, g.ticksSinceLastDrillerProduction = 0;
                    break;
                case pe.Mine:
                    g.electricalOutput = 0, g.ticksSinceLastDrillerProduction = 0;
                    break
            }
            g.ticksSinceLastNeptuniumProduction = 0, g.shieldMaxCharge = a[d]
        }
    for (let d = 0; d < n.outposts.count; d++) {
        const h = n.outposts.get(d);
        h.private_type == pe.Destroyed && (h.private_type = t.getInt(0, 1) == 0 ? pe.Factory : pe.Generator, h.originalType = h.private_type, h.electricalOutput = h.private_type == pe.Factory ? 0 : Vn.GeneratorElectricalOutput, h.shieldMaxCharge = AX(t), h.ticksSinceLastDrillerProduction = h.private_type == pe.Factory ? t.getInt(0, Vn.MinutesBetweenDrillerProductions / K.MinutesPerTick) : 0)
    }
}

function yX(n) {
    let e = Math.fround(Math.fround(Math.fround(n.x) * Math.fround(n.x)) + Math.fround(Math.fround(n.y) * Math.fround(n.y)));
    const t = Math.fround(Math.sqrt(e));
    return Xte(t > Zn, "Attempt to normalize zero-length Vec2"), n.x = Math.fround(n.x / t), n.y = Math.fround(n.y / t), n
}

function wne(n, e) {
    let t = new Array(e);
    for (let i = 0; i < e; t[i++] = 0);
    for (let i = 0; i < n.outposts.count; i++) {
        let a = n.outposts.get(i).meantForPlayer;
        Z(a >= 0), t[a]++
    }
    let r = -1,
        s = 999999;
    for (let i = 0; i < e; i++) r = Math.max(r, t[i]), s = Math.min(s, t[i]);
    return r - s
}

function V2e(n, e, t, r, s) {
    let i;
    he.RulesVersion >= 18 ? e <= 4 ? i = 3 / 4 : i = 1 : e < 4 ? i = 3 / 4 : i = 1;
    const a = e * P2e;
    n.height = Math.fround(Math.sqrt(a / i)), n.width = Math.fround(a / n.height);
    let o = e * K.OutpostsPerPlayer;
    if (!B2e(n, o, t)) return 9999;
    L2e(n, n.playerOrigins, e, t);
    let c = new Array(K.MaxPlayerCount).fill(null).map(d => new Array(K.MaxPlayerCount).fill(0));
    for (let d = 0; d < e; d++)
        for (let h = 0; h < n.outposts.count; h++) c[d][h] = V.getMinDist(n, n.outposts.get(h).pos, n.playerOrigins[d]);
    for (let d = 0; d < e; d++)
        for (let h = 0; h < he.InitialOutpostsPerPlayer + 1; h++) {
            let p = -1,
                A = ta;
            for (let g = 0; g < n.outposts.count; g++) {
                if (n.outposts.get(g).ownerIndex >= 0) continue;
                let y = c[d][g];
                y < A && (A = y, p = g)
            }
            Z(p >= 0), n.outposts.get(p).ownerIndex = d, h == 0 ? (V.addSpecialistCommitted(n, q.Queen, d, new we(B.Outpost, p)), n.outposts.get(p).drillers = Vn.QueenInitialDrillers) : n.outposts.get(p).drillers = Vn.SecondaryOutpostInitialDrillers
        }
    D2e(n);
    let u = wne(n, e);
    return N2e(n, e, t, r, s), u
}

function G2e(n, e) {
    if (he.RulesVersion >= 18) {
        const t = new mr(K.MaxPlayerCount),
            r = new mr(K.MaxPlayerCount);
        for (let s = 0; s < K.MaxPlayerCount; s++) t[s] = 0, r[s] = 0;
        for (let s = 0; s < n.outposts.count; s++) {
            const i = n.outposts.get(s);
            i.ownerIndex < 0 || (i.private_type == pe.Generator ? t[i.ownerIndex]++ : r[i.ownerIndex]++)
        }
        for (let s = 0; s < e; s++)
            if (t[s] != t[0] || r[s] != r[0]) return !1;
        return !0
    } else return !0
}
export function originalCandidate(players,seed,min=30,max=60){
 const w={width:0,height:0,outposts:new an(100),playerOrigins:Array.from({length:10},()=>new G()),queens:[]};
 w.outposts.elements=Array.from({length:100},()=>new b2());
 const rng=new p0();rng.setSeed(seed);
 const score=V2e(w,players,rng,min,max);
 return {valid:score<=3&&G2e(w,players),score,width:w.width,height:w.height,origins:w.playerOrigins.slice(0,players).map(p=>({x:p.x,y:p.y})),queens:w.queens,outposts:w.outposts.elements.slice(0,w.outposts.count).map(p=>({position:{x:p.pos.x,y:p.pos.y},owner:p.ownerIndex,type:p.private_type,drillers:p.drillers,shield:p.shieldCharge,shieldMax:p.shieldMaxCharge,productionProgress:p.ticksSinceLastDrillerProduction,meantForPlayer:p.meantForPlayer,nameIndex:p.nameIndex}))};
}
