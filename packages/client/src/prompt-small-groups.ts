export interface PromptSmallGroup {key:string;value:number;members:string[]}
/** The denominator is the displayed module, not the entire prompt. Exactly 2%
 * stays visible. Preserve constituent IDs so tooltips and details stay usable. */
export function mergeSmallPromptGroups(groups:PromptSmallGroup[],total:number):PromptSmallGroup[]{
 const positive=groups.filter(g=>Number.isFinite(g.value)&&g.value>0);
 const small=positive.filter(g=>g.key==='other'||total>0&&g.value/total<0.02);
 const merged=new Set(small);
 return [...positive.filter(g=>!merged.has(g)),...(small.length?[{key:'other',value:small.reduce((n,g)=>n+g.value,0),members:small.flatMap(g=>g.members)}]:[])];
}
