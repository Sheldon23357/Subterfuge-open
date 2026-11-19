import {restoreDecisionTask} from '../contracts/decision-task-validation.js';
import type {DecisionSignal,DecisionTask} from '../contracts/types.js';

/** A recovery is an execution obligation alongside all original business
 * causes. It never substitutes its generic text for the unfinished problem. */
export function recoverySignals(task:DecisionTask,key:string,reason:string,urgent:boolean):DecisionSignal[]{
 const saved=restoreDecisionTask(task);
 const recovery:DecisionSignal={key,kind:'recovery',category:saved.category,...(saved.scope?{scope:saved.scope}:{}),reason,entities:[...saved.entities],urgent,role:'inherited-trigger',sources:[{kind:'runtime',id:key}],
  ...(saved.memoryReview?{reviewRequirements:{...saved.memoryReview}}:{}),...(saved.fullContext!==undefined?{requiresFullContext:saved.fullContext}:{}),...(saved.notebookReview!==undefined?{notebookReview:saved.notebookReview}:{})};
 const inherited=saved.triggers!.map((trigger,index)=>({...trigger,key:`${key}:cause:${index}:${trigger.key}`,role:'inherited-trigger' as const,urgent:urgent||trigger.urgent}));
 const missing=saved.reasons.filter(reason=>!inherited.some(trigger=>trigger.reason===reason)).map((reason,index):DecisionSignal=>({key:`${key}:reason:${index}`,kind:'unknown',category:saved.category,...(saved.scope?{scope:saved.scope}:{}),reason,entities:[...saved.entities],urgent,role:'inherited-trigger'}));
 return [recovery,...inherited,...missing];
}
