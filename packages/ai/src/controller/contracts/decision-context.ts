import type {AiState,AiSnapshot} from './types.js';
import type {DecisionContextBreakdown} from '../presentation/prompt-decision-breakdown.js';
import {isActiveNote} from '../storage/memory-records.js';
import {gameSeconds} from './types.js';
import {RECEIPT_MEASUREMENT} from '../presentation/prompt-receipt-breakdown.js';
export interface PromptContextMetrics {
 unit:'characters';total:number;sections:Record<string,number>;decisionContext?:DecisionContextBreakdown;
}
export interface PromptToolContextMetrics {
 unit:'characters';measurement:typeof RECEIPT_MEASUREMENT;guide:Record<string,number>;
 results:{history:Record<string,number>;feedback:Record<string,number>;total:Record<string,number>};
 sourceCharacters:{guide:number;history:number;feedback:number};
}
export interface PreparedDecisionContext {
 prompt:string;promptContext:PromptContextMetrics;promptTools:PromptToolContextMetrics;
 contextSelection:RoundContextSelection;memoryContext:ReturnType<typeof memoryContextMetrics>;
 contextBudget?:{unit:'characters';target:number;hardLimit:number;before:number;after:number;level:number;initialSections:Record<string,number>;sections:Record<string,number>};
}
/** Current whole-round accounting, independent of retired task-focus selection. */
export interface RoundContextSelection {
 mode:'task';goal:null;reason:string;entities:string[];evidence:string[];
 basisRevision:string;outposts:{total:number;selected:number};receipts:{full:number;indexed:number};
}

export function memoryContextMetrics(state:AiState,snapshot:AiSnapshot,..._unused:unknown[]){
 const notes=(snapshot.notebook??[]).filter(n=>isActiveNote(n,gameSeconds(snapshot)));
 const size=notes.reduce((sum,n)=>sum+n.text.length,0);
 return {unit:'characters',memory:state.memory.strategy.length,notebookFull:size,notebookSelected:size,activeRecords:notes.length,fullBodies:notes.length,indexedRecords:0,campaigns:0};
}

/** Existing model presentation consumers use this name; ownership is controller-neutral. */
export type BuiltPrompt=PreparedDecisionContext;
