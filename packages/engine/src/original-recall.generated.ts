// @ts-nocheck
// Verbatim APK12075 bX recall. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
// Regenerate: node scripts/extract-recall.mjs
const B={Outpost:1};
class we{constructor(type,index){this.type=type;this.index=index;}}
const V={setSpecialistLocation:(world,index,location)=>world.hooks.relocate(index,location),destroySub:(state,index)=>state.hooks.destroy(index)};
function bX(n, e) {
    const t = n.world.subs.get(e),
        r = n.world.outposts.get(t.srcOutpostIndex);
    r.drillers += t.drillers, t.drillers = 0;
    for (let s = t.specialistCache.count - 1; s >= 0; --s) {
        const i = t.specialistCache.get(s);
        V.setSpecialistLocation(n.world, i, new we(B.Outpost, t.srcOutpostIndex))
    }
    V.destroySub(n, e)
}
export const originalRecallSub=bX;
