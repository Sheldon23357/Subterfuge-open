/** Versioned seat preferences, not combat or safety guarantees. Resource,
 * permission, survival and victory checks remain mandatory. */
export const BOT_SETTINGS_SCHEMA_VERSION=2 as const;

/** The utility scale is anchored, not renormalized when preferences change.
 * Other assets and costs are heuristics measured against one remaining
 * driller. A weighted equivalent is not an exchange rate or a probability. */
export const BOT_UTILITY_SCALE=Object.freeze({
  id:'driller-anchor-v1',unit:'weighted-driller-equivalent',drillerValue:1,
} as const);

export interface BotNumericSettings {
  maxSimulations:number;
  maxElapsedMs:number;
  horizonTicks:number;
  reviewIntervalTicks:number;
  minActionGain:number;
  /** Retained serialized preference; selection uses the unified minActionGain. */
  minCaptureGain:number;
  objectiveSwitchTolerance:number;
  forceBufferRatio:number;
  remoteUncertaintyForceFraction:number;
  economyWeight:number;
  defenseWeight:number;
  territoryWeight:number;
}
export type BotSettingKey=keyof BotNumericSettings;
export interface BotSettings extends BotNumericSettings {schemaVersion:typeof BOT_SETTINGS_SCHEMA_VERSION}

const ECONOMY_WEIGHT_BASELINE=2;
/** Displayed preferences are multipliers around the current baseline, not
 * shares of a total. All scoring consumers use this single conversion. */
export function botEffectiveWeights(settings:Readonly<BotSettings>) {
  return {economyWeight:settings.economyWeight*ECONOMY_WEIGHT_BASELINE,
    defenseWeight:settings.defenseWeight,territoryWeight:settings.territoryWeight};
}

/** Only the currently valid, unversioned configuration is upgradeable. This
 * is not a fallback for obsolete game saves or malformed settings. */
export interface LegacyBotSettings {
  maxSimulations:number;
  maxElapsedMs:number;
  horizonTicks:number;
  reviewIntervalTicks:number;
  aggression:number;
  actionMargin:number;
  objectiveSwitchMargin:number;
  riskForceFraction:number;
  attackForceMargin:number;
  economyWeight:number;
  defenseWeight:number;
  territoryWeight:number;
}
export type BotSettingsInput=Partial<LegacyBotSettings>|({schemaVersion:typeof BOT_SETTINGS_SCHEMA_VERSION}&Partial<BotNumericSettings>);

/** Frozen migration defaults must not track later changes to v2 defaults. */
export const LEGACY_BOT_SETTINGS_DEFAULTS:Readonly<LegacyBotSettings>=Object.freeze({
  maxSimulations:50,maxElapsedMs:10000,horizonTicks:144,reviewIntervalTicks:6,
  aggression:1,actionMargin:2,objectiveSwitchMargin:6,riskForceFraction:0.35,attackForceMargin:0.2,
  economyWeight:1,defenseWeight:1,territoryWeight:1,
});
export const DEFAULT_BOT_SETTINGS:Readonly<BotSettings>=Object.freeze({
  schemaVersion:BOT_SETTINGS_SCHEMA_VERSION,
  maxSimulations:80,maxElapsedMs:4000,horizonTicks:196,reviewIntervalTicks:6,
  minActionGain:1,minCaptureGain:1,objectiveSwitchTolerance:6,
  forceBufferRatio:0.4,remoteUncertaintyForceFraction:0.35,
  economyWeight:1,defenseWeight:1,territoryWeight:1,
});
type Limit={min:number;max:number;integer?:boolean};
export const BOT_SETTING_LIMITS:Readonly<Record<BotSettingKey,Limit>>=Object.freeze({
  maxSimulations:{min:2,max:512,integer:true},maxElapsedMs:{min:1000,max:60000,integer:true},
  horizonTicks:{min:1,max:196,integer:true},reviewIntervalTicks:{min:1,max:144,integer:true},
  minActionGain:{min:0,max:20},minCaptureGain:{min:0,max:40},objectiveSwitchTolerance:{min:0,max:50},
  forceBufferRatio:{min:0,max:1},remoteUncertaintyForceFraction:{min:0,max:1},
  economyWeight:{min:0.25,max:4},defenseWeight:{min:0.25,max:4},territoryWeight:{min:0.25,max:4},
});
const LEGACY_LIMITS:Readonly<Record<keyof LegacyBotSettings,Limit>>=Object.freeze({
  maxSimulations:{min:2,max:512,integer:true},maxElapsedMs:{min:1000,max:60000,integer:true},
  horizonTicks:{min:1,max:144,integer:true},reviewIntervalTicks:{min:1,max:144,integer:true},
  aggression:{min:0.5,max:2},actionMargin:{min:0,max:20},objectiveSwitchMargin:{min:0,max:50},
  riskForceFraction:{min:0,max:1},attackForceMargin:{min:0,max:1},
  economyWeight:{min:0.25,max:4},defenseWeight:{min:0.25,max:4},territoryWeight:{min:0.25,max:4},
});
function numberSetting(value:unknown,key:string,limit:Limit):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<limit.min||value>limit.max||limit.integer&&!Number.isSafeInteger(value))throw Error(`Invalid programmatic bot setting: ${key}`);
  return value;
}

/** Resolve once to the sole canonical model. V2 needs an explicit version;
 * mixed old/new names and unknown versions fail atomically, never clamp.
 * Valid v1 preferences retain exactly their former admission thresholds. */
export function resolveBotSettings(raw:unknown=undefined):BotSettings {
  if(raw===undefined)return {...DEFAULT_BOT_SETTINGS};
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid programmatic bot settings');
  const input=raw as Record<string,unknown>;
  if(Object.hasOwn(input,'schemaVersion')){
    if(input.schemaVersion!==BOT_SETTINGS_SCHEMA_VERSION)throw Error('Unsupported programmatic bot settings version');
    const result={...DEFAULT_BOT_SETTINGS};
    for(const key of Object.keys(input)){
      if(key==='schemaVersion')continue;
      if(!Object.hasOwn(BOT_SETTING_LIMITS,key))throw Error(`Unknown programmatic bot setting: ${key}`);
      const name=key as BotSettingKey;
      result[name]=numberSetting(input[key],key,BOT_SETTING_LIMITS[name]);
    }
    return result;
  }
  const legacy={...LEGACY_BOT_SETTINGS_DEFAULTS};
  for(const key of Object.keys(input)){
    if(!Object.hasOwn(LEGACY_LIMITS,key))throw Error(`Unknown programmatic bot setting: ${key}`);
    const name=key as keyof LegacyBotSettings;
    legacy[name]=numberSetting(input[key],key,LEGACY_LIMITS[name]);
  }
  return {
    schemaVersion:BOT_SETTINGS_SCHEMA_VERSION,
    maxSimulations:legacy.maxSimulations,maxElapsedMs:legacy.maxElapsedMs,
    horizonTicks:legacy.horizonTicks,reviewIntervalTicks:legacy.reviewIntervalTicks,
    minActionGain:legacy.actionMargin,minCaptureGain:legacy.actionMargin/legacy.aggression,
    objectiveSwitchTolerance:legacy.objectiveSwitchMargin,
    forceBufferRatio:legacy.attackForceMargin,remoteUncertaintyForceFraction:legacy.riskForceFraction,
    economyWeight:legacy.economyWeight,defenseWeight:legacy.defenseWeight,territoryWeight:legacy.territoryWeight,
  };
}
