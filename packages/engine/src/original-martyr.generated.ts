// @ts-nocheck
// Original r2e Martyr branch and blast helpers. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-martyr.mjs
import {RULES} from '../../rules/src/reference-profile.js';
import {clientDistanceSquared} from './client-geometry.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,B={Outpost:1,Sub:2},pe={Destroyed:3};
const te={getScreenName:(_n,i)=>String(i)};
class V{
static getMinDistSquared(a,b,width,height){return clientDistanceSquared(a,b,{width,height});}
static getItemPosition(w,p){return(p.type===B.Outpost?w.outposts.get(p.index):w.subs.get(p.index)).pos;}
static isSpecialistCaptive(w,index){const p=w.specialists.get(index);return p.ownerIndex!==(p.location.type===B.Outpost?w.outposts.get(p.location.index):w.subs.get(p.location.index)).ownerIndex;}
static destroyOutpost(e, t) {
        const r = e.outposts.get(t);
        r.private_type != pe.Destroyed && (r.originalType = r.private_type, r.private_type = pe.Destroyed), r.drillers = 0, r.shieldCharge = 0, r.shieldMaxCharge = 0, r.electricalOutput = 0, r.secsUntilShieldDisable = 0, r.ticksSinceLastDrillerProduction = 0, r.ticksSinceLastNeptuniumProduction = 0, r.ticksSinceLastShieldPower = 0
    }
}
function hX(n, e, t, r) {
    if (he.RulesVersion >= 28) {
        const s = $e.MartyrRange * $e.MartyrRange;
        return V.getMinDistSquared(n, e, t, r) <= s
    } else return n.clone().subtract(e).length() <= $e.MartyrRange
}
function o2e(n, e) {
    const t = n.world.outposts.get(e);
    for (let r = 0; r < t.specialistCache.count; r++) {
        let s = t.specialistCache.get(r);
        const i = n.world.specialists.get(s);
        if (!i.isDying) {
            i.isDying = !0;
            const a = n.world.cachedValues.get(i.ownerIndex);
            V.isSpecialistCaptive(n.world, s) ? a.captiveSpecialistCount[i.type]-- : a.freeSpecialistCount[i.type]--
        }
    }
}
function l2e(n, e) {
    const t = n.world.subs.get(e);
    for (let r = 0; r < t.specialistCache.count; r++) {
        let s = t.specialistCache.get(r);
        const i = n.world.specialists.get(s);
        i.isDying = !0;
        const a = n.world.cachedValues.get(i.ownerIndex);
        V.isSpecialistCaptive(n.world, s) ? a.captiveSpecialistCount[i.type]-- : a.freeSpecialistCount[i.type]--
    }
}
export function originalMartyrBlast(e,n,r){const i=e.world.specialists.get(r);let l=false;const c = e.world;
let u = [],
                d = 0,
                h = [],
                p = 0,
                A = V.getItemPosition(c, i.location);
n.subDrillersLost = n.subInitialDrillers;
for (let y = 0; y < c.outposts.count; y++) {
                const x = c.outposts.get(y);
                if (hX(x.pos, A, c.width, c.height)) {
                    let w = x.shieldCharge;
                    n.otherLocation.type == B.Outpost && n.otherLocation.index == y && (w = n.otherLocationInitialShieldCharge), w <= $e.MartyrShieldThreshold && (n.subDrillersLost += x.drillers, o2e(e, y), V.destroyOutpost(c, y), h[p] = y, p++)
                }
            }
for (let y = 0; y < c.subs.count; y++) {
                const x = c.subs.get(y);
                if (x.used == !1) continue;
                hX(x.pos, A, c.width, c.height) && (n.subDrillersLost += x.drillers, x.drillers = 0, l2e(e, y), u[d] = y, d++)
            }
let g = te.getScreenName(e.info, i.ownerIndex) + `'s martyr does the deed.
`;
n.combatText += g, n.combatTextMarker += g.length, e.listener.handleMartyrActivated(e, r, h, p, u, d), l = !0;;return l;}
