import type {PlayerObservation,AttackRoutes} from '@subterfuge/bot-sdk/contracts';
import type {BotDecision,BotPlannerOptions} from '@subterfuge/bot-sdk/analysis/tactical-planner';
import {computeBot} from '@subterfuge/bot-sdk/analysis/tactical-worker';

export const TACTICAL_VALIDATION_MS=2000;
/** Search is reusable advice. Validation is a new conditional computation at
 * the current authority time, with its own budget and no candidate discovery.
 * Only issue time is rebased; troop amounts and targets remain
 * unchanged so a failed proposal cannot silently become a different order. */
export function validateTacticalProposal(proposal:BotDecision,o:PlayerObservation,routes:AttackRoutes,
 options:Pick<BotPlannerOptions,'guidance'|'protectedFleetIds'|'signal'|'forecastCacheRound'>,
 compute:typeof computeBot=computeBot):Promise<BotDecision>{
 const candidate=structuredClone(proposal.selected);
 candidate.drafts=candidate.drafts.map(d=>({...d,issueTick:o.view.tick}));
 return compute(o,routes,{
  ...options,settings:proposal.parameters,horizonTicks:proposal.parameters.horizonTicks,
  validationCandidate:candidate,preludeOnly:true,
  preludeIndependent:proposal.policyDiagnostics?.executionPhase==='independent',
  maxElapsedMs:TACTICAL_VALIDATION_MS,maxSimulations:Math.min(32,proposal.parameters.maxSimulations),
 });
}
