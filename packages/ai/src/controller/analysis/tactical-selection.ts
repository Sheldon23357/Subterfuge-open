import {compareBotEvaluations,type BotEvaluation} from './tactical-evaluation.js';

/** Risk preferences, not probabilities of the simulated opponent responses. */
export const BOT_ACTION_WEIGHTS=Object.freeze({ordinary:0.6,pressure:0.4});

/** No generated pressure scenarios means the ordinary line supplies both terms.
 * Callers must reject missing mandatory pressure results before calling this. */
export function botWeightedEvaluation(ordinary:BotEvaluation,pressure?:BotEvaluation|null):BotEvaluation {
 pressure??=ordinary;
 const worst=compareBotEvaluations(ordinary,pressure)<=0?ordinary:pressure;
 const components:Record<string,number>={};
 for(const key of new Set([...Object.keys(ordinary.components),...Object.keys(pressure.components)]))
  components[key]=(ordinary.components[key]??0)*BOT_ACTION_WEIGHTS.ordinary+(pressure.components[key]??0)*BOT_ACTION_WEIGHTS.pressure;
 return {...worst,utility:ordinary.utility*BOT_ACTION_WEIGHTS.ordinary+pressure.utility*BOT_ACTION_WEIGHTS.pressure,
  components,unknowns:[...new Set([...ordinary.unknowns,...pressure.unknowns])]};
}

function terminalNotWorse(candidate:BotEvaluation,baseline:BotEvaluation){
 return compareBotEvaluations({...candidate,utility:0},{...baseline,utility:0})>=0;
}

/** One admission rule for attacks, defense, recalls and autonomous transfers. */
export function botWeightedActionAllowed(ordinary:BotEvaluation,baseline:BotEvaluation,
 pressure:BotEvaluation|null=ordinary,baselinePressure:BotEvaluation|null=baseline,minimumGain=1):boolean {
 pressure??=ordinary;baselinePressure??=baseline;
 if(!terminalNotWorse(ordinary,baseline)||!terminalNotWorse(pressure,baselinePressure))return false;
 const candidate=botWeightedEvaluation(ordinary,pressure),hold=botWeightedEvaluation(baseline,baselinePressure);
 return compareBotEvaluations(candidate,hold)>0
  &&(candidate.outcome!==hold.outcome||candidate.crossingTick!==hold.crossingTick||candidate.utility>hold.utility+minimumGain);
}
