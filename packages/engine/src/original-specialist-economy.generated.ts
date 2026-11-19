// @ts-nocheck
// Verbatim APK12075 specialist economy/sonar excerpts. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-specialist-economy.mjs
import {originalCommandTime} from './original-command-time.generated.js';
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
import {clientDistance,clientDistanceSquared,wrapClientPoint} from './client-geometry.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,Vn=RULES.OutpostParams,K={MinutesPerTick:10,TicksPerDay:144,MaxSpecialistsPerLocation:128,MaxSubsPerPlayer:128,MaxSpecialistsPerSub:3};
const q={COUNT:31,...Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]))};
const B={Nothing:0,Outpost:1,Sub:2,Specialist:3},pe={Factory:1,Destroyed:3},UG=.5;
const g0={BaseSpeed:0.004999999888};
const He={Moving:'moving'},ta=340282347e30;
const kt=Array.from({length:31},()=>({speed:1}));for(const s of SPECIALISTS)kt[s.client_type_id].speed=s.base_speed_multiplier;
const Z=c=>{if(!c)throw Error('Original specialist economy assertion');};
class mr{constructor(n){this.count=n;this.values=Array(n).fill(0);}get(i){return this.values[i];}set(i,v){this.values[i]=v;}}
class we{constructor(type,index){this.type=type;this.index=index;}set(type,index){this.type=type;this.index=index;return this;}}
const rt={Unknown:0,Known:1,Visible:2},kD=4,xMe=0,wMe=0,B3=new we();
const E={gameState:null};
const fe={instance:()=>({isSimulatedFuture:n=>n.simulatedFuture===true})};
class Circle{set(center,radius){this.center={...center};this.radius=radius;return this;}}
const CX=new Circle(),wX=new Circle();
class Ev {
    item;
    center;
    visRadius;
    constructor(e = new we, t = new G(0, 0), r = 0) {
        this.item = e, this.center = t, this.visRadius = r
    }
}
class te{static teamOf(e, t) {
        return e.teamSize > 0 ? Math.floor(t / e.teamSize) : t
    }
static teamFirstSeat(e, t) {
        return t < 0 ? 0 : e.teamSize > 0 ? t * e.teamSize : t
    }
static teamEndSeat(e, t) {
        return t < 0 ? 0 : e.teamSize <= 0 ? t + 1 : Math.min(t * e.teamSize + e.teamSize, e.maxPlayerCount)
    }}
function CMe(n, e, t, r) {
    const s = V.getMinDistSquared(n.center, e.center, t, r),
        i = (n.radius + e.radius) * (n.radius + e.radius);
    return s <= i
}
function tp(n, e) {
    return n >= e.first && n < e.end
}
function IX(n, e, t = !1) {
    if (e < 0) return {
        first: 0,
        end: 0
    };
    const r = t ? void 0 : n ?? E.gameState?.info;
    if (!r) return {
        first: e,
        end: e + 1
    };
    const s = te.teamOf(r, e);
    return {
        first: te.teamFirstSeat(r, s),
        end: te.teamEndSeat(r, s)
    }
}
function IMe(n, e, t, r, s) {
    const i = n.outposts.get(e);
    if (tp(i.ownerIndex, r)) return rt.Visible;
    for (let a = 0; a < i.specialistCache.count; ++a) {
        const o = i.specialistCache.get(a),
            l = n.specialists.get(o);
        if (l.type != q.Sentry || l.sentryLastTargetSubIndex == -1) continue;
        const c = n.subs.get(l.sentryLastTargetSubIndex);
        if (c.used && tp(c.ownerIndex, r)) return rt.Visible
    }
    return wn.isVisible(t, i.pos, xMe, n.width, n.height) ? rt.Visible : s ? rt.Known : rt.Unknown
}
function TMe(n, e, t, r) {
    return e.used ? tp(e.ownerIndex, r) || wn.isVisible(t, e.pos, wMe, n.width, n.height) ? rt.Visible : e.destination.type < 0 || e.destination.type >= kD ? (console.warn(`Sub has invalid destination type ${e.destination.type}. Valid range is 0-${kD-1}.`), rt.Unknown) : e.state == He.Moving && !tp(e.ownerIndex, r) && tp(V.getItemOwnerIndex(n, e.destination), r) ? rt.Visible : rt.Unknown : rt.Unknown
}
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
class ct{static add(e, t) {
        Z(e.count < e.capacity), e.count < e.capacity && (e.elements[e.count++] = t)
    }
static remove(e, t) {
        Z(t >= 0 && t < e.count), t >= 0 && t < e.count && (e.elements[t] = e.elements[e.count - 1], e.count--)
    }
static getIndexFor(e, t) {
        for (let r = 0; r < e.count; ++r)
            if (e.elements[r] === t) return r;
        return -1
    }}
const G={copy:(out,p)=>{out.x=p.x;out.y=p.y;return out;}};
class Slots{static getFirstUnusedSubIndexForPlayer(e, t) {
        Z(t >= 0);
        const r = t * K.MaxSubsPerPlayer;
        for (let s = 0; s < K.MaxSubsPerPlayer; ++s) {
            const i = s + r;
            if (!e.subs.get(i).used && !e.subs.get(i).reserved) return i
        }
        return -1
    }}
const $n={getSecondsUntilCommitted:(p,t)=>Math.max(p.secsUntilCommitted-Math.trunc(t),0)};
class Jt{static getSecondsUntilLaunch(p,t){return Math.max(p.secsUntilLaunch-Math.trunc(t),0);}static isGift=originalCommandTime.gift;
static getTravelTimeInMinutes(e, t) {
        return e / t
    }}
const qn={getType:originalCommandTime.outpostType};
const ut={countFundersForPlayer:(n,i)=>n.funders[i]};
class V{
static isSpecialistCaptive(w,i){const p=w.specialists.get(i);return p.ownerIndex!==(p.location.type===B.Outpost?w.outposts.get(p.location.index):w.subs.get(p.location.index)).ownerIndex;}
static getItemPosition(w,l){return (l.type===B.Outpost?w.outposts.get(l.index):w.subs.get(l.index)).pos;}
static getMinDist(w,a,b){return clientDistance(a,b,w);}
static getMinDistSquared(a,b,width,height){return clientDistanceSquared(a,b,{width,height});}
static getWrappedPos(width,height,p){return wrapClientPoint(p,{width,height});}
static isElectricalCapKnown(e, t) {
        return !fe.instance().isSimulatedFuture(e) || t == e.youPlayerIndex
    }
static canOutpostProduceDrillers(e, t, r, s = !1) {
        const i = e.world,
            a = i.outposts.get(t);
        if (qn.getType(a, e.world.secondsSinceLastTick) !== pe.Factory) return !1;
        const l = a.ownerIndex;
        if (l < 0) return !1;
        const c = i.cachedValues.get(l);
        return !(!s && c.drillers >= i.cachedValues.get(l).electricalOutput)
    }
static calculateDrillerProductionRateByPlayer(e, t) {
        let r = 0;
        const s = e.world;
        for (let i = 0; i < s.outposts.count; ++i) {
            const a = s.outposts.get(i);
            if (a.ownerIndex != t || !V.canOutpostProduceDrillers(e, i, e.youPlayerIndex, !0)) continue;
            const o = V.calculateTicksBetweenDrillerProductions(s, i),
                c = V.calculateDrillersForNextProductionAtOutpost(e, i, s.cachedValues.get(a.ownerIndex), !0) * K.TicksPerDay * V.getStartSpeedupFactor(s) / o;
            r += c
        }
        return Math.trunc(r + .5)
    }
static getFirstUnusedSubIndexForPlayer(w,owner){const slot=Slots.getFirstUnusedSubIndexForPlayer(w.slotView,owner);return slot<0?-1:w.allocateSub(slot);}
static setSubPath(w,i,source,destination){w.setReleasePath(i,source,destination);}
static applyDiplomatAbilityForPlayerInLocation(e, t, r, s) {
        if (!l3e(e, t, s)) return 0;
        let i = new an(K.MaxSpecialistsPerLocation);
        for (let c = 0; c < r.count; ++c) {
            const u = r.get(c),
                d = e.specialists.get(u);
            Z(d.used), d.ownerIndex == s && !d.inLimbo && ct.add(i, u)
        }
        if (i.count == 0) return 0;
        const a = c3e(e, i.get(0));
        if (a == -1) return 0;
        const o = Math.trunc((i.count - 1) / 3) + 1;
        let l = 0;
        for (let c = 0; c < o; ++c) {
            let u = he.RulesVersion <= 24 ? s : V.getItemOwnerIndex(e, t),
                d = V.getFirstUnusedSubIndexForPlayer(e, u);
            if (he.RulesVersion >= 42 && d == -1) break;
            Z(d >= 0);
            let h = e.subs.get(d);
            const p = h.lastSunkAt;
            h.reset(), G.copy(h.lastSunkAt, p), h.used = !0, h.state = He.Moving, h.secsUntilLaunch = 0, h.drillers = 0, h.ownerIndex = u, h.isPrisonerReleaseSub = !0, e.subs.set(d, h), V.setSubPath(e, d, t, new we(B.Outpost, a));
            for (let A = 0; A < K.MaxSpecialistsPerSub && l != i.count; ++A) {
                const g = i.get(l);
                V.setSpecialistLocation(e, g, new we(B.Sub, d)), l++
            }
        }
        return l
    }
static setSpecialistLocation(e, t, r) {
        const s = e.specialists.get(t);
        switch (s.isReturningPirate = !1, s.location.type) {
            case B.Outpost: {
                const i = e.outposts.get(s.location.index),
                    a = ct.getIndexFor(i.specialistCache, t);
                Z(a != -1), ct.remove(i.specialistCache, a);
                break
            }
            case B.Sub: {
                const i = s.location.index,
                    a = e.subs.get(i),
                    o = ct.getIndexFor(a.specialistCache, t);
                Z(o != -1), ct.remove(a.specialistCache, o);
                break
            }
            case B.Nothing:
                break;
            default:
                Z(!1);
                break
        }
        switch (s.location.copyFrom(r), s.location.type) {
            case B.Outpost: {
                const i = e.outposts.get(s.location.index);
                ct.add(i.specialistCache, t), s.lastVisitedOutpostIndex = s.location.index;
                break
            }
            case B.Sub: {
                const i = e.subs.get(s.location.index);
                ct.add(i.specialistCache, t);
                break
            }
            case B.Nothing:
                break;
            default:
                Z(!1);
                break
        }
    }
static getItemOwnerIndex(e, t) {
        switch (t.type) {
            case B.Sub: {
                const r = e.subs.get(t.index);
                return r.used ? r.ownerIndex : -1
            }
            case B.Outpost:
                return e.outposts.get(t.index).ownerIndex;
            case B.Specialist: {
                const r = e.specialists.get(t.index);
                return r.used ? r.ownerIndex : -1
            }
            default:
                Ta("Invalid item type");
                break
        }
        return -1
    }
static getSpecialistCountByTypeAtLocation(e, t, r, s, i) {
        for (let o = 0; o < q.COUNT; ++o) e.set(o, 0);
        const a = r.type == B.Outpost ? t.outposts.get(r.index).specialistCache : t.subs.get(r.index).specialistCache;
        if (this.addSpecialistCountByTypeFromCache(e, a, t, s, i), r.type == B.Outpost) {
            const o = t.subLookup.index.get(r.index);
            for (let l = 0; l < o.count; ++l) {
                const c = t.subLookup.items.get(o.start + l),
                    u = t.subs.get(c);
                Jt.getSecondsUntilLaunch(u, t.secondsSinceLastTick) > 0 && this.addSpecialistCountByTypeFromCache(e, u.specialistCache, t, s, i)
            }
        }
    }
static addSpecialistCountByTypeFromCache(e, t, r, s, i) {
        for (let a = 0; a < t.count; a++) {
            const o = t.get(a),
                l = r.specialists.get(o);
            if (Z(l.used), $n.getSecondsUntilCommitted(l, r.secondsSinceLastTick) > 0) continue;
            const c = V.isSpecialistCaptive(r, o);
            (c && i || !c && s) && e.set(l.type, e.get(l.type) + 1)
        }
    }
static getOutpostIndexForSpecialistAbility(e, t) {
        const r = e.specialists.get(t);
        if (r.location.type == B.Outpost) return r.location.index;
        if (r.location.type == B.Sub) {
            const s = e.subs.get(r.location.index);
            if (Jt.getSecondsUntilLaunch(s, e.secondsSinceLastTick) > 0) return s.srcOutpostIndex
        }
        return -1
    }
static calculateDrillersForNextProductionAtOutpost(e, t, r, s = !1) {
        const i = e.world,
            a = new mr(q.COUNT);
        V.getSpecialistCountByTypeAtLocation(a, i, new we(B.Outpost, t), !0, !1);
        const o = he.RulesVersion >= 42 ? n3e(i, t) : a.get(q.Foreman),
            l = a.get(q.Tycoon),
            c = r.freeSpecialistCount[q.MinisterOfEnergy],
            u = he.RulesVersion >= 23 ? 1 : o3e(c),
            d = he.RulesVersion >= 23 ? Math.trunc(c) : 0,
            h = r.drillers >= r.electricalOutput,
            p = i.outposts.get(t).ownerIndex,
            A = ut.countFundersForPlayer(e, p),
            g = Vn.DrillersPerProduction * u + $e.ForemanExtraDrillers * o + $e.TycoonExtraDrillers * l + he.FundingDrillerProductionBonus * A - d,
            y = Math.max(g, 0),
            v = h ? 0 : Math.min(y, r.electricalOutput - r.drillers);
        return !s && V.isElectricalCapKnown(e, p) ? v : y
    }
static calculateTicksBetweenDrillerProductions(e, t) {
        const r = e.outposts.get(t);
        if (Z(qn.getType(r, e.secondsSinceLastTick) == pe.Factory), r.ownerIndex < 0) return 0;
        const i = 1 + e.cachedValues.get(r.ownerIndex).freeSpecialistCount[q.Tycoon] * $e.TycoonProductionRateBonusFactor,
            a = Math.trunc(Vn.MinutesBetweenDrillerProductions / i);
        return Math.trunc(a / K.MinutesPerTick)
    }
static getAdjustedOutpostElectricalOutput(e, t) {
        return e.outposts.get(t).electricalOutput
    }
static getTheoreticalMaxShieldCharge(e, t) {
        const r = e.outposts.get(t);
        if (qn.getType(r, e.secondsSinceLastTick) == pe.Destroyed) return 0;
        const i = new mr(q.COUNT);
        return V.getSpecialistCountByTypeAtLocation(i, e, new we(B.Outpost, t), !0, !1), kH(e, t, i)
    }
static getCurrentMaxShieldCharge(e, t) {
        const r = e.outposts.get(t);
        if (r.shieldsEnabled == !1 || qn.getType(r, e.secondsSinceLastTick) == pe.Destroyed) return 0;
        let i = new mr(q.COUNT);
        return V.getSpecialistCountByTypeAtLocation(i, e, new we(B.Outpost, t), !0, !1), kH(e, t, i)
    }
static changeSpecialistOwnership(e, t, r) {
        const s = e.specialists.get(t);
        s.type == q.Queen && e.cachedValues.get(r).freeSpecialistCount[q.Queen] > 0 && (s.type = q.Princess), s.ownerIndex = r
    }
static getStartSpeedupFactor(e) {
        const t = he.GameStartSpeedupTicks;
        return !(t > 0) || e.tickCount > t ? 1 : V.getStartSpeedupFactorValue()
    }
static getStartSpeedupFactorValue() {
        const e = he.GameStartSpeedupFactor;
        return e > 1 ? e : 1
    }
static getBaseSpeed(e) {
        return g0.BaseSpeed * V.getStartSpeedupFactor(e)
    }
static getBestSpeedForLocation(e, t, r) {
        const s = V.getItemOwnerIndex(e, t);
        if (s < 0) return V.getBaseSpeed(e);
        Z(t.type == B.Outpost || t.type == B.Sub);
        const i = t.type === B.Outpost ? e.outposts.get(t.index).specialistCache : e.subs.get(t.index).specialistCache;
        return this.getBestSpeedWithSpecialists(i, s, t.type, e, r)
    }
static getBestSpeedWithSpecialists(e, t, r, s, i) {
        let a = 1,
            o = 1;
        for (let l = 0; l < e.count; l++) {
            const c = e.get(l),
                u = s.specialists.get(c);
            if (Z(u.used), V.isSpecialistCaptive(s, c)) continue;
            let d = 1;
            if (he.RulesVersion >= 29) {
                if (u.type == q.Smuggler) {
                    const p = (i.type != B.Nothing ? V.getItemOwnerIndex(s, i) : -1) == u.ownerIndex || i.type == B.Nothing ? kt[q.Smuggler].speed : 1;
                    d = Math.max(d, p)
                }
                if (u.type == q.Pirate) {
                    let h = 1;
                    i.type == B.Sub || i.type == B.Nothing ? h = kt[q.Pirate].speed : u.isReturningPirate && (h = 2 * kt[q.Pirate].speed), d = Math.max(d, h)
                }
                if (u.type != q.Smuggler && u.type != q.Pirate) {
                    const h = kt[u.type].speed;
                    d = Math.max(d, h)
                }
            } else u.type == q.Smuggler ? d = (i.type != B.Nothing ? V.getItemOwnerIndex(s, i) : -1) == u.ownerIndex || i.type == B.Nothing ? kt[q.Smuggler].speed : 1 : u.type == q.Pirate ? i.type == B.Sub || i.type == B.Nothing ? d = kt[q.Pirate].speed : u.isReturningPirate ? d = 2 * kt[q.Pirate].speed : d = 1 : d = kt[u.type].speed;
            u.type == q.Navigator && (o *= 1 - $e.NavigatorSpeedPenalty), a = Math.max(a, d), Z(kt[u.type].speed >= 1)
        }
        if (a = a * o, he.RulesVersion >= 24) {
            const l = e1(s, t),
                c = V.getBaseSpeed(s) * a,
                u = V.getBaseSpeed(s) * l;
            return r == B.Sub ? e.count == 0 ? u : c : Math.max(c, u)
        } else {
            const l = e1(s, t);
            return V.getBaseSpeed(s) * a * l
        }
    }
static countSpecialistOfType(e, t, r, s, i) {
        let a = 0;
        for (let o = 0; o < t.count; o++) {
            const l = t.get(o),
                c = e.specialists.get(l);
            if (c.type == r) {
                if ($n.getSecondsUntilCommitted(c, e.secondsSinceLastTick) > 0) continue;
                let u = this.isSpecialistCaptive(e, l);
                (u && i || !u && s) && a++
            }
        }
        return a
    }
static getSubTravelTimeInMinutes(e, t) {
        const r = e.subs.get(t),
            s = r.specialistCache.clone(),
            i = this.getBestSpeedWithSpecialists(s, r.ownerIndex, B.Sub, e, r.destination),
            a = V.getItemPosition(e, r.destination),
            o = V.getMinDist(e, r.pos, a);
        return V.getTravelMinutesWithSpeedup(e, o, i)
    }
static getTravelMinutesWithSpeedup(e, t, r) {
        const s = V.getStartSpeedupFactor(e);
        if (s <= 1) return Jt.getTravelTimeInMinutes(t, r);
        const i = (he.GameStartSpeedupTicks - e.tickCount) * K.MinutesPerTick,
            a = r * i;
        return t <= a ? Jt.getTravelTimeInMinutes(t, r) : i + Jt.getTravelTimeInMinutes(t - a, r / s)
    }
static countSpecialistOfTypeAtLocation(w,l,type,free,captive){const counts=new mr(q.COUNT);V.getSpecialistCountByTypeAtLocation(counts,w,l,free,captive);return counts.get(type);}
}
class Ms{static calculate(e, t, r) {
        for (let i = 0; i < e.count; ++i) e.get(i).reset();
        for (let i = 0; i < t.info.maxPlayerCount; ++i) {
            const a = e.get(i);
            he.RulesVersion >= 25 || t.playerStates.get(i).seatState == De.Available || t.playerStates.get(i).seatState == De.Occupied ? a.electricalOutput = he.BaseElectricalOutput : a.electricalOutput = 0, a.neptunium = t.playerStates.get(i).neptunium
        }
        const s = t.world;
        for (let i = 0; i < s.outposts.count; i++) {
            const a = s.outposts.get(i);
            if (a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex),
                l = qn.getType(a, s.secondsSinceLastTick);
            o.outpostCountByType[l]++, o.electricalOutput += V.getAdjustedOutpostElectricalOutput(t.world, i), o.drillers += a.drillers
        }
        for (let i = 0; i < s.subs.count; i++) {
            const a = s.subs.get(i);
            !a.used || a.ownerIndex < 0 || (e.get(a.ownerIndex).drillers += a.drillers)
        }
        for (let i = 0; i < s.specialists.count; ++i) {
            const a = s.specialists.get(i);
            if (!a.used || a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex);
            if (!($n.getSecondsUntilCommitted(a, t.world.secondsSinceLastTick) <= 0)) continue;
            !V.isSpecialistCaptive(s, i) || a.inLimbo ? (o.freeSpecialistCount[a.type]++, o.totalFreeSpecialistCount++) : (o.captiveSpecialistCount[a.type]++, o.totalCaptiveSpecialistCount++)
        }
        for (let i = 0; i < s.specialists.count; ++i) {
            const a = s.specialists.get(i);
            if (!a.used || a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex);
            if ($n.getSecondsUntilCommitted(a, t.world.secondsSinceLastTick) <= 0 && !V.isSpecialistCaptive(s, i)) {
                if (a.type == q.MinisterOfEnergy) o.electricalOutput += $e.MinisterOfEnergyOutput;
                else if (a.type == q.Tinkerer) {
                    const u = V.getOutpostIndexForSpecialistAbility(s, i);
                    if (u >= 0) {
                        const d = V.getTheoreticalMaxShieldCharge(s, u);
                        o.electricalOutput += $e.TinkererBoostFactor * d
                    }
                }
            }
        }
        for (let i = 0; i < t.info.maxPlayerCount; i++)
            for (let a = 0; a < t.info.maxPlayerCount; a++) t.playerStates.get(i).isFundingPlayer[a] && (e.get(a).electricalOutput += he.FundingElectricalOutputBonus);
        for (let i = 0; i < t.info.maxPlayerCount; i++) e.get(i).electricalOutput = Math.max(e.get(i).electricalOutput, 0);
        if ((r || fe.instance()).isSimulatedFuture(t))
            for (let i = 0; i < t.info.maxPlayerCount; i++)
                for (let a = 0; a < q.COUNT; a++) {
                    const o = fe.instance().getRemovedFreeSpecialistCount(i, a);
                    e.get(i).freeSpecialistCount[a] += o
                }
    }}
class wn{static computeVisibilityRange(e, t) {
        if (e.type != B.Outpost) return 0;
        const r = t.outposts.get(e.index);
        if (r.ownerIndex < 0) return Vn.VisibilityRange;
        let s = Vn.VisibilityRange;
        const i = new mr(q.COUNT);
        V.getSpecialistCountByTypeAtLocation(i, t, e, !0, !1), s *= Math.pow($e.IntelligenceOfficerLocalVisibilityMultiplier, i.get(q.IntelligenceOfficer)), s *= Math.pow($e.PrincessLocalVisibilityMultiplier, i.get(q.Princess));
        const a = t.cachedValues.get(r.ownerIndex);
        if (a == null) return s;
        const o = a.freeSpecialistCount[q.IntelligenceOfficer];
        return s = s + s * o * $e.IntelligenceOfficerGlobalVisibilityBonus, s
    }
static compute(e, t, r, s, i, a = !1) {
        if (Z(r >= 0), r < 0) return;
        e.everythingVisible = !1, e.areas.count = 0;
        const o = IX(i, r, a);
        for (let u = 0; u < t.outposts.count; ++u) {
            const d = t.outposts.get(u);
            if (tp(d.ownerIndex, o)) {
                const h = this.computeVisibilityRange(B3.set(B.Outpost, u), t),
                    p = new Ev(B3.set(B.Outpost, u), d.pos, h);
                ct.add(e.areas, p)
            }
        }
        const l = E.gameState?.world?.cachedValues;
        let c = !1;
        for (let u = o.first; u < o.end; u++) {
            const d = l?.get(u);
            if (d != null && d.freeSpecialistCount[q.IntelligenceOfficer] > 0) {
                c = !0;
                break
            }
        }
        for (let u = 0; u < t.outposts.count; ++u) e.outposts.set(u, IMe(t, u, e, o, c));
        for (let u = 0; u < s.subs.count; ++u) s.subs.get(u).used && e.subs.set(u, TMe(t, s.subs.get(u), e, o));
        for (let u = 0; u < t.subs.count; ++u) {
            const d = t.subs.get(u);
            if (d.used && tp(d.ownerIndex, o) && d.destination.type == B.Sub) {
                const h = d.destination.index;
                e.subs.set(h, rt.Visible)
            }
        }
        e.textureUpToDate = !1
    }
static isVisible(e, t, r, s, i) {
        CX.set(t, r);
        for (let a = 0; a < e.areas.count; ++a) {
            const o = e.areas.get(a),
                l = V.getWrappedPos(s, i, o.center);
            if (wX.set(l, o.visRadius), CMe(CX, wX, s, i)) return !0
        }
        return !1
    }
static isVisibleForPlayer(e, t, r, s) {
        const i = IX(s, t);
        for (let a = 0; a < r.outposts.count; ++a) {
            const o = r.outposts.get(a);
            if (!tp(o.ownerIndex, i)) continue;
            const l = this.computeVisibilityRange(B3.set(B.Outpost, a), r);
            if (V.getMinDistSquared(o.pos, e, r.width, r.height) <= l * l) return !0
        }
        return !1
    }
static getVisibility(e, t, r) {
        switch (t.type) {
            case B.Outpost:
                return e.outposts.get(t.index);
            case B.Sub:
                return e.subs.get(t.index);
            case B.Specialist:
                return this.getVisibility(e, r.specialists.get(t.index).location, r) == rt.Visible ? rt.Visible : rt.Unknown
        }
        return rt.Unknown
    }}
function n3e(n, e) {
    const t = n.outposts.get(e);
    if (t.ownerIndex < 0 || n.cachedValues.get(t.ownerIndex).freeSpecialistCount[q.Foreman] == 0) return 0;
    let r = 0;
    for (let s = 0; s < n.specialists.count; s++) {
        const i = n.specialists.get(s);
        if (!i.used || i.isDying || i.type != q.Foreman || i.ownerIndex != t.ownerIndex || V.isSpecialistCaptive(n, s) || $n.getSecondsUntilCommitted(i, n.secondsSinceLastTick) > 0) continue;
        const a = V.getOutpostIndexForSpecialistAbility(n, s);
        if (a < 0) continue;
        const o = new we(B.Outpost, a),
            l = $e.ForemanRangeFactor ?? UG,
            c = wn.computeVisibilityRange(o, n) * l;
        V.getMinDist(n, t.pos, V.getItemPosition(n, o)) <= c && r++
    }
    return r
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
function e1(n, e) {
    return e == -1 ? 1 : 1 + (he.RulesVersion >= 35 ? Math.min(1, n.cachedValues.get(e).freeSpecialistCount[q.Admiral]) : n.cachedValues.get(e).freeSpecialistCount[q.Admiral]) * $e.AdmiralGlobalSpeedBonus
}
function x3e(n, e) {
    const t = n.specialists.get(e),
        r = V.getOutpostIndexForSpecialistAbility(n, e);
    if (r == -1) return;
    t.timerInMinutes += K.MinutesPerTick;
    const s = Math.trunc(60 / $e.TinkererDischargePerHour);
    if (t.timerInMinutes < s) return;
    const i = n.outposts.get(r);
    i.shieldCharge = Math.max(i.shieldCharge - 1, 0), t.timerInMinutes = 0
}
function x2(n, e) {
    const t = n.specialists.get(e),
        r = V.getOutpostIndexForSpecialistAbility(n, e);
    if (r === -1) return -1;
    const s = new we(B.Outpost, r),
        i = wn.computeVisibilityRange(s, n) / 2;
    let a = ta,
        o = -1,
        l = -1;
    for (let c = 0; c < n.subs.count; c++) {
        const u = n.subs.get(c);
        if (!u.used || u.ownerIndex === t.ownerIndex || u.state !== He.Moving || u.drillers === 0 || Jt.isGift(u, n.secondsSinceLastTick) && V.getItemOwnerIndex(n, u.destination) === t.ownerIndex) continue;
        const d = V.getMinDist(n, u.pos, V.getItemPosition(n, s));
        if (d <= i) {
            const h = Lne(u.drillers);
            (h > o || h === o && d < a) && (a = d, o = h, l = c)
        }
    }
    return l
}
function Lne(n) {
    return Math.ceil(n * $e.SentryDrillerRemovedPercentage)
}
function EMe(n, e) {
    Z(V.isSpecialistCaptive(n.world, e) == !1);
    const t = n.world,
        r = t.specialists.get(e);
    if (r.timerInMinutes += K.MinutesPerTick, r.timerInMinutes < $e.SentryFirePeriodInMinutes || V.getOutpostIndexForSpecialistAbility(t, e) < 0) return;
    const i = r.sentryLastTargetSubIndex;
    if (r.sentryLastTargetSubIndex = x2(n.world, e), r.sentryLastTargetSubIndex < 0) return;
    const a = r.sentryLastTargetSubIndex,
        o = t.subs.get(a);
    Z(o.used);
    let l = 0;
    o.drillers > 0 && (l = Lne(o.drillers), o.drillers -= l), r.timerInMinutes = 0, n.listener.handleSentryFired(n, e, a, i, l)
}
function _1(n, e) {
    const t = n.specialists.get(e);
    if (he.RulesVersion >= 28 && !t.used) return;
    Z(t.used);
    const r = V.getOutpostIndexForSpecialistAbility(n, e);
    if (r == -1) return;
    const s = n.outposts.get(r);
    if (s.ownerIndex == t.ownerIndex && !s.futureUnknown) switch (t.type) {
        case q.Hypnotist:
            C2(n, r);
            break;
        case q.Inspector:
            a3e(n, r);
            break;
        case q.Diplomat:
            fre(n, e);
            break
    }
}
function C2(n, e) {
    const t = new an(K.MaxSpecialistsPerLocation),
        r = n.outposts.get(e);
    for (let s = 0; s < r.specialistCache.count; s++) {
        let i = r.specialistCache.get(s);
        V.isSpecialistCaptive(n, i) && (V.changeSpecialistOwnership(n, i, r.ownerIndex), ct.add(t, i))
    }
    for (let s = 0; s < t.count; ++s) {
        const i = t.get(s);
        _1(n, i)
    }
}
function a3e(n, e) {
    const t = n.outposts.get(e);
    t.shieldCharge = V.getCurrentMaxShieldCharge(n, e)
}
function v3e(n, e) {
    const t = V.getOutpostIndexForSpecialistAbility(n, e);
    t < 0 || C2(n, t)
}
function fre(n, e) {
    const t = n.specialists.get(e);
    Z(t.used), Z(t.ownerIndex >= 0), Z(t.type == q.Diplomat);
    const r = V.getOutpostIndexForSpecialistAbility(n, e);
    Z(r >= 0);
    const s = n.outposts.get(r).pos,
        i = wn.computeVisibilityRange(new we(B.Outpost, r), n),
        a = i * i;
    for (let o = 0; o < n.outposts.count; ++o) {
        const l = n.outposts.get(o);
        if (l.specialistCache.count == 0 || l.ownerIndex == t.ownerIndex) continue;
        V.getMinDistSquared(s, l.pos, n.width, n.height) <= a && V.applyDiplomatAbilityForPlayerInLocation(n, new we(B.Outpost, o), l.specialistCache, t.ownerIndex)
    }
    if (he.RulesVersion <= 24)
        for (let o = 0; o < n.subs.count; ++o) {
            const l = n.subs.get(o);
            if (!l.used || l.specialistCache.count == 0 || l.ownerIndex == t.ownerIndex) continue;
            V.getMinDistSquared(s, l.pos, n.width, n.height) <= a && V.applyDiplomatAbilityForPlayerInLocation(n, new we(B.Sub, o), l.specialistCache, t.ownerIndex)
        }
    return 0
}
function l3e(n, e, t) {
    const r = V.getItemPosition(n, e);
    for (let s = 0; s < n.specialists.count; ++s) {
        const i = n.specialists.get(s);
        if (!i.used || i.ownerIndex != t || i.type != q.Diplomat || V.isSpecialistCaptive(n, s)) continue;
        const a = V.getOutpostIndexForSpecialistAbility(n, s);
        if (a == -1) continue;
        const o = n.outposts.get(a),
            l = wn.computeVisibilityRange(new we(B.Outpost, a), n);
        if (V.getMinDistSquared(r, o.pos, n.width, n.height) <= l * l) return !0
    }
    return !1
}
function c3e(n, e) {
    const t = n.specialists.get(e),
        r = t.location.type == B.Outpost ? t.location.index : -1,
        s = he.RulesVersion >= 19 ? V.getItemPosition(n, t.location) : V.getItemPosition(n, new we(B.Specialist, e));
    let i = ta,
        a = -1;
    for (let o = 0; o < n.outposts.count; o++) {
        if (o == r) continue;
        const l = n.outposts.get(o);
        if (l.ownerIndex == t.ownerIndex) {
            Z(l.ownerIndex >= 0);
            const c = V.getMinDistSquared(l.pos, s, n.width, n.height);
            c < i && (i = c, a = o)
        }
    }
    return a
}
export function originalFactoryPeriod(w,i){return V.calculateTicksBetweenDrillerProductions(w,i);}
export function originalCanFactoryProduce(n,i){return V.canOutpostProduceDrillers(n,i,n.youPlayerIndex);}
export function originalFactoryAmount(n,i,c){return V.calculateDrillersForNextProductionAtOutpost(n,i,c);}
export function originalPlayerProductionRate(n,player){return V.calculateDrillerProductionRateByPlayer(n,player);}
export function originalSonarRange(w,i){return wn.computeVisibilityRange(new we(B.Outpost,i),w);}
export const originalForemenInRange=n3e;
export function originalOutpostShieldMaximum(w,i){if(w.outposts.get(i).private_type===pe.Destroyed)return 0;const counts=new mr(q.COUNT);V.getSpecialistCountByTypeAtLocation(counts,w,new we(B.Outpost,i),true,false);return kH(w,i,counts);}
// This entry is authoritative-state only. Filtered projections must not pass removed hidden specialists.
export const originalElectricalCapKnown=(n,player)=>V.isElectricalCapKnown(n,player);
export function originalGlobalCaches(n){Ms.calculate(n.world.cachedValues,n,{isSimulatedFuture:()=>false});}
/** Same original body, with a per-call forecast context; no mutable singleton. */
export function originalForecastGlobalCaches(n,removed){
 const fe={instance:()=>({isSimulatedFuture:()=>true,getRemovedFreeSpecialistCount:(player,type)=>removed[player][type]})};
 class ForecastMs{static calculate(e, t, r) {
        for (let i = 0; i < e.count; ++i) e.get(i).reset();
        for (let i = 0; i < t.info.maxPlayerCount; ++i) {
            const a = e.get(i);
            he.RulesVersion >= 25 || t.playerStates.get(i).seatState == De.Available || t.playerStates.get(i).seatState == De.Occupied ? a.electricalOutput = he.BaseElectricalOutput : a.electricalOutput = 0, a.neptunium = t.playerStates.get(i).neptunium
        }
        const s = t.world;
        for (let i = 0; i < s.outposts.count; i++) {
            const a = s.outposts.get(i);
            if (a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex),
                l = qn.getType(a, s.secondsSinceLastTick);
            o.outpostCountByType[l]++, o.electricalOutput += V.getAdjustedOutpostElectricalOutput(t.world, i), o.drillers += a.drillers
        }
        for (let i = 0; i < s.subs.count; i++) {
            const a = s.subs.get(i);
            !a.used || a.ownerIndex < 0 || (e.get(a.ownerIndex).drillers += a.drillers)
        }
        for (let i = 0; i < s.specialists.count; ++i) {
            const a = s.specialists.get(i);
            if (!a.used || a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex);
            if (!($n.getSecondsUntilCommitted(a, t.world.secondsSinceLastTick) <= 0)) continue;
            !V.isSpecialistCaptive(s, i) || a.inLimbo ? (o.freeSpecialistCount[a.type]++, o.totalFreeSpecialistCount++) : (o.captiveSpecialistCount[a.type]++, o.totalCaptiveSpecialistCount++)
        }
        for (let i = 0; i < s.specialists.count; ++i) {
            const a = s.specialists.get(i);
            if (!a.used || a.ownerIndex < 0) continue;
            const o = e.get(a.ownerIndex);
            if ($n.getSecondsUntilCommitted(a, t.world.secondsSinceLastTick) <= 0 && !V.isSpecialistCaptive(s, i)) {
                if (a.type == q.MinisterOfEnergy) o.electricalOutput += $e.MinisterOfEnergyOutput;
                else if (a.type == q.Tinkerer) {
                    const u = V.getOutpostIndexForSpecialistAbility(s, i);
                    if (u >= 0) {
                        const d = V.getTheoreticalMaxShieldCharge(s, u);
                        o.electricalOutput += $e.TinkererBoostFactor * d
                    }
                }
            }
        }
        for (let i = 0; i < t.info.maxPlayerCount; i++)
            for (let a = 0; a < t.info.maxPlayerCount; a++) t.playerStates.get(i).isFundingPlayer[a] && (e.get(a).electricalOutput += he.FundingElectricalOutputBonus);
        for (let i = 0; i < t.info.maxPlayerCount; i++) e.get(i).electricalOutput = Math.max(e.get(i).electricalOutput, 0);
        if ((r || fe.instance()).isSimulatedFuture(t))
            for (let i = 0; i < t.info.maxPlayerCount; i++)
                for (let a = 0; a < q.COUNT; a++) {
                    const o = fe.instance().getRemovedFreeSpecialistCount(i, a);
                    e.get(i).freeSpecialistCount[a] += o
                }
    }}
 ForecastMs.calculate(n.world.cachedValues,n);
}
// Preserve i2e's descending global slot cleanup, independently of local order.
export function originalCleanupDyingSpecialists(count,isDying,destroy){
 const V={destroySpecialist:(_world,slot)=>destroy(slot)};
 function i2e(n) {
    for (let e = n.world.specialists.count - 1; e >= 0; e--) n.world.specialists.get(e).isDying && V.destroySpecialist(n.world, e)
}
 i2e({world:{specialists:{count,get:slot=>({isDying:isDying(slot)})}}});
}
// V.setSpecialistLocation removes with ct.remove, not removePreservingOrder.
export function originalRemoveLocalSpecialist(elements,id){
 const cache={count:elements.length,elements:elements.slice()};
 ct.remove(cache,ct.getIndexFor(cache,id));return cache.elements.slice(0,cache.count);
}
export function originalFleetSpeed(w,i,destination){return V.getBestSpeedForLocation(w,new we(B.Sub,i),destination);}
export const originalFleetTravelMinutes=(w,i)=>V.getSubTravelTimeInMinutes(w,i);
export const originalPointVisible=(p,player,w,info)=>wn.isVisibleForPlayer(p,player,w,info);
export const originalCountSpecialists=(w,cache,type,free,captive)=>V.countSpecialistOfType(w,cache,type,free,captive);
export const originalAbilityOutpost=(w,i)=>V.getOutpostIndexForSpecialistAbility(w,i);
export const originalTinkererTick=x3e;
export const originalSpecialistActivation=_1;
export const originalHypnotistTick=v3e;
export const originalSentryTick=EMe;
export const originalDiplomatTick=fre;
export const originalDiplomatRelease=V.applyDiplomatAbilityForPlayerInLocation;
export function originalVisibility(world,player,info){
 const result={areas:new an(world.outposts.count),outposts:new mr(world.outposts.count),subs:new mr(world.subs.count)};
 E.gameState={world,info};
 try{wn.compute(result,world,player,world,info);return{outposts:result.outposts.values,fleets:result.subs.values,areas:result.areas.elements.slice(0,result.areas.count).map(a=>({center:{...a.center},radius:a.visRadius}))};}
 finally{E.gameState=null;}
}
// Post-combat effects in V.handleSubArrival, after transfer and before Queen demotion.
export function originalAfterHostileArrival(s,a){
 V.countSpecialistOfTypeAtLocation(s, new we(B.Outpost, a), q.Inspector, !0, !1) > 0 && (s.outposts.get(a).shieldCharge = V.getCurrentMaxShieldCharge(s, a));
 V.countSpecialistOfTypeAtLocation(s, new we(B.Outpost, a), q.Hypnotist, !0, !1) > 0 && C2(s, a);
}
// Exact post-transfer branch of wm; movement itself is performed by the world adapter.
export function originalAfterSpecialistTransfer(n,t,i){if (t.type == B.Outpost && n.outposts.get(t.index).futureUnknown == !1) {
        V.countSpecialistOfTypeAtLocation(n, t, q.Hypnotist, !0, !1) > 0 && C2(n, t.index);
        for (let l = 0; l < i.count; ++l) {
            const c = i.get(l);
            _1(n, c)
        }
    }}
