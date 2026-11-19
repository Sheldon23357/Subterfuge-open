// @ts-nocheck
// Original oX General/King phase. Do not format. APK SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-global-combat.mjs
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,q={General:'General',King:'King'},B={Sub:2,Outpost:1};
class we{constructor(type,index){this.type=type;this.index=index;}}
const te={getScreenName:(_info,i)=>String(i)};
const V={getSpecialistsAtLocation:(w,l)=>(l.type===B.Sub?w.subs.get(l.index):w.outposts.get(l.index)).specialistCache,
isSpecialistCaptive:(w,i)=>{const p=w.specialists.get(i);return p.ownerIndex!==(p.location.type===B.Sub?w.subs.get(p.location.index):w.outposts.get(p.location.index)).ownerIndex;}};
const br = (n, e) => n.world.subs.get(e.subIndex);
const Rr = (n, e) => n.world.subs.get(e.otherLocation.index);
const _s = (n, e) => n.world.outposts.get(e.otherLocation.index);
const Zo = (n, e) => e.otherLocation.type == B.Sub ? Rr(n, e).drillers : _s(n, e).drillers;
const Wa = (n, e) => e.otherLocation.type == B.Sub ? Rr(n, e).ownerIndex : _s(n, e).ownerIndex;
function uX(n, e) {
    const t = V.getSpecialistsAtLocation(n, e);
    let r = 0;
    for (let s = 0; s < t.count; s++) {
        const i = t.get(s);
        !V.isSpecialistCaptive(n, i) && !n.specialists.get(i).isDying && r++
    }
    return r
}
export function originalGlobalCombat(n,e,t){
 const r={subIndex:e,otherLocation:t,outcome:0,combatText:'',combatTextMarker:0},s=n.world.subs.get(e);let l=false;
 let p = s.drillers,
        A = Zo(n, r);
const g = he.RulesVersion < 42 || r.outcome != 4;
if (g && s.ownerIndex >= 0) {
        const C = n.world.cachedValues.get(s.ownerIndex),
            k = C.freeSpecialistCount[q.General],
            L = uX(n.world, new we(B.Sub, e)) > 0 ? k * $e.GeneralPowerBonusForSpecialists : 0,
            R = Math.min(Zo(n, r), L);
        if (r.otherLocation.type == B.Outpost ? _s(n, r).drillers -= R : r.otherLocation.type == B.Sub && (Rr(n, r).drillers -= R), R > 0) {
            let D = te.getScreenName(n.info, s.ownerIndex) + "'s " + (k > 1 ? "Generals destroy " : "General destroys ") + R + ` drillers
`;
            r.combatText += D, r.combatTextMarker += D.length, l = !0
        }
        if (he.RulesVersion >= 25) {
            let D = C.freeSpecialistCount[q.King];
            if (D > 0) {
                he.RulesVersion >= 32 && (D = 1);
                const N = he.RulesVersion >= 26 ? p : s.drillers,
                    U = Math.trunc(Math.min(Zo(n, r), N / $e.KingDestroyRatio * D));
                if (r.otherLocation.type == B.Outpost ? _s(n, r).drillers -= U : r.otherLocation.type == B.Sub && (Rr(n, r).drillers -= U), U > 0) {
                    let z = te.getScreenName(n.info, s.ownerIndex) + "'s " + (D > 1 ? "Kings destroy " : "King destroys ") + U + ` drillers
`;
                    r.combatText += z, r.combatTextMarker += z.length, l = !0
                }
            }
        }
    }
if (g && Wa(n, r) >= 0) {
        const C = n.world.cachedValues.get(Wa(n, r)),
            k = C.freeSpecialistCount[q.General],
            L = uX(n.world, r.otherLocation) > 0 ? k * $e.GeneralPowerBonusForSpecialists : 0,
            R = Math.min(s.drillers, L);
        if (s.drillers -= R, R > 0) {
            let D = te.getScreenName(n.info, Wa(n, r)) + "'s " + (k > 1 ? "Generals destroy " : "General destroys ") + R + ` drillers
`;
            r.combatText += D, r.combatTextMarker += D.length, l = !0
        }
        if (he.RulesVersion >= 25) {
            let D = C.freeSpecialistCount[q.King];
            if (D > 0) {
                he.RulesVersion >= 32 && (D = 1);
                const N = he.RulesVersion >= 26 ? A : Zo(n, r),
                    U = Math.trunc(Math.min(s.drillers, N / $e.KingDestroyRatio * D));
                if (s.drillers -= U, U > 0) {
                    let z = te.getScreenName(n.info, Wa(n, r)) + "'s " + (D > 1 ? "Kings destroy " : "King destroys ") + U + ` drillers
`;
                    r.combatText += z, r.combatTextMarker += z.length, l = !0
                }
            }
        }
    }
 return r.combatText;
}
