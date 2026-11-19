import {mergeSmallPromptGroups} from './prompt-small-groups.js';
export interface PromptCompositionGroup {key:string;value:number;members:string[]}
const order=['policy','taskGuidance','rulesAndTools','strategyAndMemory','stateProjection','decisionContext','toolReceipts','closingGuidance'];
/** Merge main categories below 2%; nested charts use their own denominators. */
export function promptCompositionGroups(sections:Record<string,number>):PromptCompositionGroup[]{
 const values={...sections},receipts=['decisionHistory','feedback'];
 values.toolReceipts=receipts.reduce((n,k)=>n+(Number.isFinite(sections[k])&&sections[k]!>0?sections[k]!:0),0);
 for(const key of receipts)delete values[key];
 const keys=[...order,...Object.keys(values).filter(k=>!order.includes(k)&&!['other','unclassified'].includes(k)).sort()]
  .filter(k=>Number.isFinite(values[k])&&values[k]!>0);
 const groups=keys.map(key=>({key,value:values[key]!,members:key==='toolReceipts'?receipts.filter(k=>sections[k]!>0):[key]}));
 for(const key of ['other','unclassified'])if(Number.isFinite(values[key])&&values[key]!>0)groups.push({key:key==='unclassified'?'unclassified':'other',value:values[key]!,members:[key]});
 return mergeSmallPromptGroups(groups,groups.reduce((n,g)=>n+g.value,0));
}
