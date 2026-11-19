import type {AiState,AiMemory} from '../contracts/types.js';

/** Model tools receive authority as input, never a mutable authorization candidate. */
export type ModelToolState=Readonly<Omit<AiState,'memory'|'commanderDirectives'>> & {
 readonly memory:Readonly<AiMemory>;
 readonly commanderDirectives?:Readonly<NonNullable<AiState['commanderDirectives']>>;
};
export const CAMPAIGN_REMINDER_PREFIX='campaign:';
export function campaignReminderId(campaignId:string):string{return CAMPAIGN_REMINDER_PREFIX+campaignId;}
