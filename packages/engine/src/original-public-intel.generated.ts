// @ts-nocheck
// Verbatim lye public-intel statistics and expressions, APK12075. Do not format. SHA256 41a81d2529b71de38016cff949fb9731b858869d274ecb4aa179231231c02bd1
const De={Occupied:1},pe={Mine:0,Generator:2,Factory:1};
export function originalPublicIntelStatistics(n,v,productionRate){
 const V={calculateDrillerProductionRateByPlayer:productionRate};
 const w = n.world.cachedValues.get(v),
            I = n.playerStates.get(v),
            C = w.outpostCountByType[pe.Mine],
            k = w.outpostCountByType[pe.Generator],
            P = w.outpostCountByType[pe.Factory],
            L = C + k + P;
 const R = I.seatState === De.Occupied;
 return {active:R,neptunium: I.neptunium,
npPerDay: R ? C * L : 0,
outposts: {
                mine: C,
                generator: k,
                factory: P
            },
numOutposts: L,
drillers: w.drillers,
output: w.electricalOutput,
drillerRate: V.calculateDrillerProductionRateByPlayer(n, v)};
}
