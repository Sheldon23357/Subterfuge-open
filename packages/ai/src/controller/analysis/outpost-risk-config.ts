import {readFileSync} from 'node:fs';

/** Search preferences, never combat rules or attack probabilities. */
export const DEFAULT_OUTPOST_RISK=Object.freeze({
 firstSupportWeight:0.5,secondSupportWeight:0.2,outerEnemyWeight:0.5,
 mineMultiplier:1.5,horizonTicks:144,targetLimit:10,
});
export type OutpostRiskConfig={-readonly [K in keyof typeof DEFAULT_OUTPOST_RISK]:number};
export function outpostRiskConfig(raw:unknown={}):OutpostRiskConfig {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid outpost risk config');
 const result:OutpostRiskConfig={...DEFAULT_OUTPOST_RISK};
 for(const [key,value] of Object.entries(raw)){
  if(!Object.hasOwn(result,key)||typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error(`Invalid outpost risk parameter: ${key}`);
  result[key as keyof OutpostRiskConfig]=value;
 }
 for(const key of ['firstSupportWeight','secondSupportWeight','outerEnemyWeight'] as const)if(result[key]>1)throw Error(`Invalid outpost risk fraction: ${key}`);
 if(result.firstSupportWeight<result.secondSupportWeight)throw Error('Second support weight exceeds first support weight');
 if(result.mineMultiplier<1||result.mineMultiplier>10)throw Error('Invalid outpost risk importance');
 if(!Number.isSafeInteger(result.horizonTicks)||result.horizonTicks<1||result.horizonTicks>144||!Number.isSafeInteger(result.targetLimit)||result.targetLimit<1||result.targetLimit>100)throw Error('Invalid outpost risk limits');
 return result;
}
export function loadOutpostRiskConfig(path=process.env.AI_OUTPOST_RISK_CONFIG):OutpostRiskConfig {
 return outpostRiskConfig(path?JSON.parse(readFileSync(path,'utf8')):{});
}
