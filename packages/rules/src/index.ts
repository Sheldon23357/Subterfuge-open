import profile from '../../../docs/rules/data/profile-diplomacy-core-v1.json' with {type:'json'};
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export const RULES=freeze(profile);
export const PROFILE_ID='diplomacy-core-v1' as const;
export const GAMEPLAY_RULESET_VERSION='4' as const;
export const TICK_SECONDS=600;
export const TICKS_PER_DAY=144;
export const REALTIME_TICK_MILLISECONDS=10_000;
/** Pinned in each new match so historical replay remains deterministic. */
export const ACTIVITY_RULES='realtime-3h' as const;
export type ActivityRules=typeof ACTIVITY_RULES;
export const INACTIVITY_RULE_SECONDS=RULES.GameParams.RealtimeHoursOfInactivityBeforeAutoresign*3_600_000/REALTIME_TICK_MILLISECONDS*TICK_SECONDS;
export * from './diplomacy.js';
export {shieldChargePeriod,shieldRechargeStep,shieldRecoveryBounds} from './shield-recovery.js';
