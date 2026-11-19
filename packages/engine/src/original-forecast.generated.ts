// @ts-nocheck
// Exact APK 12075 forecast excerpts. Do not format. Source SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1.
import {SPECIALISTS} from '../../rules/src/reference.js';
const B={Nothing:0,Outpost:1,Sub:2},rt={Unknown:0,Known:1,Visible:2};
const mh={Promoted:'promoted'},q={IntelligenceOfficer:23};
q.IntelligenceOfficer=SPECIALISTS.find(p=>p.id==='IntelligenceOfficer').client_type_id;
const kt=Object.fromEntries(SPECIALISTS.map(p=>[p.client_type_id,{category:p.category}]));
const Z=c=>{if(!c)throw Error('Original forecast assertion');};
class we{constructor(type=0,index=-1){this.type=type;this.index=index;}}
const wn={getVisibility:(e,l,w)=>e(l,w)};
const V={
 isSpecialistCaptive:(w,i)=>w.isSpecialistCaptive(i),
 destroySpecialist:(w,i)=>w.destroySpecialist(i),
 destroySub:(n,i)=>n.world.destroySub(i),
};
const wm=(w,i,l,gift)=>w.transferSpecialists(i,l,gift);
class Forecast{removeAllNonVisibleItems(e) {
        for (let t = 0; t < this.workingState.world.specialists.count; t++) {
            const r = this.workingState.world.specialists.get(t);
            if (r.used == !1) continue;
            if (wn.getVisibility(e, r.location, this.workingState.world) < rt.Visible) {
                const i = kt[r.type];
                (r.type == q.IntelligenceOfficer || i.category == mh.Promoted) && !V.isSpecialistCaptive(this.workingState.world, t) && this.removedFreeSpecialistCount[r.ownerIndex][r.type]++, V.destroySpecialist(this.workingState.world, t)
            }
        }
        for (let t = 0; t < this.workingState.world.subs.count; t++)
            if (this.workingState.world.subs.get(t).used != !1) switch (wn.getVisibility(e, new we(B.Sub, t), this.workingState.world)) {
                case rt.Unknown:
                    V.destroySub(this.workingState, t);
                    break;
                case rt.Visible:
                    break;
                default:
                    Z(!1);
                    break
            }
        for (let t = 0; t < this.workingState.world.outposts.count; t++) {
            const r = this.workingState.world.outposts.get(t);
            wn.getVisibility(e, new we(B.Outpost, t), this.workingState.world) <= rt.Known && (r.futureUnknown = !0)
        }
    }}
export function originalPruneForecast(state,visibility){
 const f=Object.create(Forecast.prototype);f.workingState=state;
 f.removedFreeSpecialistCount=Array.from({length:state.info.maxPlayerCount},()=>Array(31).fill(0));
 f.removeAllNonVisibleItems(visibility);return f.removedFreeSpecialistCount;
}
export function originalUnknownArrival(e,t){
 const s=e.world,i=s.subs.get(t),a=i.destination.index,o=s.outposts.get(a);
 if (o.ownerIndex == -1 && (i.private_isGift = !1), o.futureUnknown) {
            e.listener.handleFutureUnknownCombatOrArrival(e, t), i.drillers = 0, o.drillers = 0;
            const l = s.subs.get(t);
            if (l.specialistCache.count == 0) return;
            for (let u = 0; u < l.specialistCache.count; ++u) {
                const d = l.specialistCache.get(u);
                s.specialists.get(d).inLimbo = !0
            }
            wm(s, t, new we(B.Outpost, a), !1), o.ownerIndex = -1, V.destroySub(e, t);
            return
        }
}
