import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

/** Strategy tuning, NOT game rules. All time values are game ticks (1 world day; internally 10 rule minutes).
 * Edit defaults, or set AI_ATTACK_SCREENING_CONFIG to a JSON override file.
 * File overrides are read per scan, so tuning does not require a service restart. */
export const DEFAULT_ATTACK_SCREENING = {
  version:'attack-screening/1',
  limits:{candidates:5,diversitySlots:3,maxSources:3,attackTicks:108,nearTicks:72,assemblySpreadTicks:30,holdTicks:24,localTicks:48,previewCandidates:2},
  force:{minimumReserve:0,enemyMobilization:0.65,thirdPartyMobilization:0.5,unknownDrillers:30,unknownShield:10},
  confidence:{unknownTarget:0.35,unknownSupportPenalty:0.08,minimum:0.1},
  value:{territory:12,factory:28,generator:14,mine:24,unknown:6,capacityBottleneck:12,existingMineExpansion:4,leader:12,scale:80},
  mineValue:{replacementPerBaseCost:8,replacementCap:24,incomePerNeptunium:1.5,incomeCap:18,denialPerNeptunium:1,denialCap:18,incomeHorizonTicks:144},
  weights:{value:30,attackBalance:25,holdBalance:15,speed:10,confidence:10,lowExposure:10},
  capacityPressure:{maximumBonus:6},
};
export type AttackScreeningConfig=typeof DEFAULT_ATTACK_SCREENING;

export function attackScreeningConfig(raw:unknown={}):AttackScreeningConfig {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid attack screening config');
  const patch=raw as Record<string,unknown>,result=structuredClone(DEFAULT_ATTACK_SCREENING);
  for(const [key,value] of Object.entries(patch)){
    if(!Object.hasOwn(result,key))throw Error(`Unknown screening config section: ${key}`);
    if(key==='version'){if(value!==result.version)throw Error('Unsupported screening config version');continue;}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`Invalid screening section: ${key}`);
    const section=result[key as Exclude<keyof AttackScreeningConfig,'version'>] as Record<string,number>;
    for(const [name,n] of Object.entries(value)){
      if(!Object.hasOwn(section,name)||typeof n!=='number'||!Number.isFinite(n)||n<0||n>10000)throw Error(`Invalid screening parameter: ${key}.${name}`);
      section[name]=n;
    }
  }
  const l=result.limits;
  if(result.capacityPressure.maximumBonus>10)throw Error('Capacity pressure bonus exceeds supported bound');
  for(const [key,n] of Object.entries(l))if(!Number.isInteger(n)||n<1)throw Error(`Invalid screening limit: ${key}`);
  if(l.nearTicks>l.attackTicks||l.candidates>20||l.diversitySlots>3||l.maxSources>6||l.attackTicks>144||l.assemblySpreadTicks>144||l.holdTicks>144||l.localTicks>144||l.previewCandidates>3)throw Error('Screening limits exceed supported bounds');
  if(!Number.isInteger(result.mineValue.incomeHorizonTicks)||result.mineValue.incomeHorizonTicks<1||result.mineValue.incomeHorizonTicks>1440)throw Error('Invalid mine value horizon');
  for(const n of [result.force.enemyMobilization,result.force.thirdPartyMobilization,...Object.values(result.confidence)])if(n>1)throw Error('Screening fraction must be within 0..1');
  if(result.value.scale<=0||Object.values(result.weights).reduce((a,b)=>a+b,0)<=0||result.force.unknownDrillers<=0||result.force.unknownShield<=0)throw Error('Screening scales and unknown estimates must be positive');
  return result;
}

export class AttackScreeningConfigError extends Error {}
export function loadAttackScreeningConfig(path=process.env.AI_ATTACK_SCREENING_CONFIG):AttackScreeningConfig {
  try{return attackScreeningConfig(path?JSON.parse(readFileSync(path,'utf8')):{});}
  catch(error){throw new AttackScreeningConfigError(`进攻初筛配置无效：${error instanceof SyntaxError?'JSON语法错误':error instanceof Error?error.message:'无法读取配置'}`);}
}
export function screeningConfigId(config:AttackScreeningConfig){return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0,12);}
