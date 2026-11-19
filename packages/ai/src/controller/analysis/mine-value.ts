import {RULES,TICKS_PER_DAY} from '../../../../rules/src/index.js';
import type {PlayerObservation,PlayerMapView} from '../../../../contracts/src/index.js';
import type {AttackScreeningConfig} from './attack-screening-config.js';

/** A bounded investment heuristic, not a forecast. Uses public economy totals
 * and the observer's current replacement cost, never the enemy's sunk cost or
 * hidden clocks. Combat and holding risk remain in their existing components. */
export function mineInvestmentValue(o:PlayerObservation,target:PlayerMapView['outposts'][number],attackTicks:number,c:AttackScreeningConfig){
  const v=o.view;
  if(target.type!=='mine'||target.minePending===true||v.match?.mode==='domination')return null;
  const p=c.mineValue,remainingTicks=Math.max(0,p.incomeHorizonTicks-attackTicks);
  const exposure=remainingTicks/p.incomeHorizonTicks;
  const owner=target.owner==null?undefined:o.intel.find(p=>p.player===target.owner);
  // Public mine income is mines × territories per internal legacy economic day (144 ticks). Count only the new
  // mine here; the existingMineExpansion term already values existing mines'
  // increased output from gaining one territory.
  const ownMineIncomePerDay=v.self.outpostCount+1;
  const ownIncome=ownMineIncomePerDay*remainingTicks/TICKS_PER_DAY;
  const enemyIncomePerDay=owner?.active&&owner.outposts.mine>0?Math.max(0,owner.npPerDay-(owner.outposts.mine-1)*Math.max(0,owner.numOutposts-1)):0;
  // Do not extrapolate future enemy wealth before arrival. Apply the shared
  // rule percentage to the currently public balance; unknown means unknown.
  const enemyBalance=owner?.active?owner.neptunium:null;
  const enemyLoss=enemyBalance===null?null:enemyBalance-Math.round(enemyBalance*(1-RULES.GameParams.NeptuniumPercentLostWithMine));
  const replacementCost=v.self.mineCreationCost;
  const replacement= Math.min(p.replacementCap,replacementCost/RULES.OutpostParams.BaseMineCreationCostInDrillers*p.replacementPerBaseCost)*exposure;
  const income=Math.min(p.incomeCap,ownIncome*p.incomePerNeptunium);
  const denial=Math.min(p.denialCap,((enemyLoss??0)*exposure+enemyIncomePerDay*remainingTicks/TICKS_PER_DAY)*p.denialPerNeptunium);
  return {basis:'conditional-capture-and-hold-with-current-public-economy',replacementCost,horizonTicks:p.incomeHorizonTicks,remainingTicks,
    ownMineIncomePerDay,estimatedOwnIncome:ownIncome,enemyBalance,estimatedEnemyBalanceLoss:enemyLoss,enemyIncomePerDay,
    replacement,income,denial,total:replacement+income+denial};
}
