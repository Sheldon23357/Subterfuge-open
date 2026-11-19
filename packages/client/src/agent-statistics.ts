import type {DiagnosticCall} from './AgentCallList.js';

export interface PromptCompositionSummary {
 unit:'characters';calls:number;total:number;sections:Record<string,number>;toolReturns:Record<string,number>;
 decisionContext:{total:number;sections:Record<string,number>;coveredCalls:number};
}
export interface DiagnosticStatistics {
 modelRateLimits?:{byRound?:Record<string,number>;unassigned?:number;total:number;byLane:{automatic:number;background:number;commander:number};lastAt:string|null};
 toolUsage?:{all:{total:number;counts:Record<string,number>};recent:{total:number;counts:Record<string,number>};recentRounds:number[];unassigned:number};
 generation:string;calls:number;duration:{totalMs:number;measuredCalls:number};
 composition:{all:PromptCompositionSummary;recent:PromptCompositionSummary};
 rounds:{round:number;calls:Pick<DiagnosticCall,'callRef'|'round'|'usage'>[]}[];
 executionRounds:{round:number;events:{id:number;kind:'error'|'rework'|'retry';source:string;reason:string;at:string|null;step:number|null;attempt:number|null}[]}[];
 unassignedCalls:number;
 commanderUsage:{calls:number;tokens:number;knownTokenCalls:number;unknownTokenCalls:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;inputCalls:number;outputCalls:number;byMode:Record<string,{calls:number;tokens:number}>};
}
/** Also used for call-page previews; aggregate responses use the same character denominators. */
export function aggregatePromptComposition(calls:DiagnosticCall[]):PromptCompositionSummary{
 const result:PromptCompositionSummary={unit:'characters',calls:0,total:0,sections:{},toolReturns:{},decisionContext:{total:0,sections:{},coveredCalls:0}};
 let coveredCharacters=0;
 const sumInto=(target:Record<string,number>,source:Record<string,number>)=>{for(const [key,value]of Object.entries(source))if(Number.isFinite(value)&&value>0)target[key]=(Object.hasOwn(target,key)?target[key]!:0)+value;};
 for(const call of calls){
  const breakdown=call.promptBreakdown;if(breakdown?.unit!=='characters')continue;
  result.calls++;result.total+=breakdown.total??Object.values(breakdown.sections).reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
  sumInto(result.sections,breakdown.sections);sumInto(result.toolReturns,breakdown.toolReturns??{});
  const parent=breakdown.sections.decisionContext??0,detail=breakdown.decisionContext;result.decisionContext.total+=parent;
  if(!detail||detail.total!==parent||!Object.values(detail.sections).every(n=>Number.isSafeInteger(n)&&n>=0)||Object.values(detail.sections).reduce((a,b)=>a+b,0)!==detail.total)continue;
  result.decisionContext.coveredCalls++;coveredCharacters+=detail.total;sumInto(result.decisionContext.sections,detail.sections);
 }
 if(result.decisionContext.total>coveredCharacters)result.decisionContext.sections.unavailable=result.decisionContext.total-coveredCharacters;
 return result;
}
