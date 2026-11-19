import type {PlayerObservation} from '../../../../contracts/src/index.js';
import {shieldRecoveryBounds} from '../../../../rules/src/index.js';
type Post=PlayerObservation['view']['outposts'][number];
/** Bound only routine visible growth using shared rule timing. Any change of
 * owner/type/production parameters is handled separately as important intel. */
export function routineDefenseGrowth(old:Post,next:Post,before:PlayerObservation,after:PlayerObservation,exactProduction=false){
 const ticks=after.view.tick-before.view.tick;
 if(ticks<=0||old.owner!==next.owner||old.type!==next.type||old.visibility!==next.visibility)return false;
 const m=old.metrics,n=next.metrics;
 let production=0;
 if(m&&n&&m.active&&!m.paused&&m.cycleMinutes!==null&&m.cycleMinutes>0&&m.nextMinutes!==null&&m.output===n.output&&m.cycleMinutes===n.cycleMinutes&&n.active&&!n.paused){
   const minutes=ticks*10+(after.secondsSinceLastTick-before.secondsSinceLastTick)/60;
   production=minutes<m.nextMinutes?0:m.output*(1+Math.floor((minutes-m.nextMinutes)/m.cycleMinutes));
 }
 const troopIncrease=old.drillers!==undefined&&next.drillers!==undefined?Math.max(0,next.drillers-old.drillers):Infinity;
 const shieldUpper=old.shield!==undefined&&old.shieldMax!==undefined&&old.shieldsEnabled!==false&&old.owner!==null
   ?shieldRecoveryBounds(old.shield,old.shieldMax,before.view.tick,ticks).maximum:old.shield;
 const shieldNormal=next.shield!==undefined&&shieldUpper!==undefined&&next.shield<=shieldUpper;
 return (exactProduction?troopIncrease===production:troopIncrease<=production)&&shieldNormal;
}
