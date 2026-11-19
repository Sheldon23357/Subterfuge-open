import {RULES} from './index.js';

export function shieldChargePeriod(maximum:number):number|null {
  return maximum===0?null:Math.trunc(RULES.OutpostParams.MinutesForFullShieldPower/10/maximum);
}

/** One economic tick, matching p3e: at most one charge, accelerated remainder,
 * and no reset of progress while already full. Ownership/enabling are upstream. */
export function shieldRechargeStep(charge:number,progress:number,maximum:number,speed:number){
  if(charge>=maximum)return {charge,progress};
  progress+=speed;const period=shieldChargePeriod(maximum)!;
  if(progress>=period){progress=speed>1&&period>0?progress%period:0;charge++;}
  return {charge,progress};
}

/** Only public charge/capacity and time. Unknown initial progress; capacity is held fixed. Never read hidden clocks. */
export function shieldRecoveryBounds(charge:number,maximum:number,startTick:number,ticks:number){
  const period=shieldChargePeriod(maximum);
  let lower={charge,progress:0},upper={charge,progress:0};
  for(let i=1;i<=ticks;i++){
    const speed=startTick+i>RULES.GameParams.GameStartSpeedupTicks?1:RULES.GameParams.GameStartSpeedupFactor;
    lower=shieldRechargeStep(lower.charge,lower.progress,maximum,speed);
    // The initial timer can predate a capacity change. At accelerated speed,
    // bound its first-charge remainder by period-1 rather than assuming zero.
    if(i===1&&charge<maximum)upper={charge:charge+1,progress:speed>1&&period!>0?period!-1:0};
    else upper=shieldRechargeStep(upper.charge,upper.progress,maximum,speed);
  }
  return {minimum:lower.charge,maximum:upper.charge};
}
