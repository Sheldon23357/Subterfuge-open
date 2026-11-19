import type {PromptSection} from '@subterfuge/bot-sdk/contracts';
import {encodeModelData} from '@subterfuge/bot-sdk/contracts';
const materialLabels:Record<string,string>={global:'全局局势',facts:'授权事实',changes:'实际状态变化',guidance:'战略、约束与外交材料',evidence:'消息与证据',unknowns:'未知事项',currentMessage:'本次玩家消息',confirmedDirectives:'已确认指挥官指令',publishedStrategy:'已发布战略',self:'己方状态',intel:'授权情报',roster:'玩家名单',identities:'据点身份与归属',relevantFacts:'相关据点事实',manual:'人工命令',execution:'执行状态',executionRules:'执行约束',planning:'候选与条件估算',intentTasks:'当前意图任务',history:'最近讨论',historyCoverage:'讨论覆盖'};
/** Section identities are assigned where model materials are assembled. */
export function promptMaterialSections(value:unknown,compact=false):PromptSection[]{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid prompt material');
 const metadata=new Set(['format','basis','kind','scope','mode','room','player','tick']);
 const entries=Object.entries(value),basis=entries.filter(([key,v])=>metadata.has(key)&&v!==undefined);
 return [
  ...(basis.length?[{id:'brief.metadata',label:'任务与调用依据',format:'json' as const,text:JSON.stringify(Object.fromEntries(basis))}]:[]),
  ...entries.filter(([key,v])=>!metadata.has(key)&&v!==undefined).map(([key,v])=>({id:'brief.'+key,label:Object.hasOwn(materialLabels,key)?materialLabels[key]!:key,format:compact&&['global','guidance','facts'].includes(key)?'compact' as const:'json' as const,text:compact&&['global','guidance','facts'].includes(key)?encodeModelData({[key]:v}):JSON.stringify({[key]:v})})),
 ];
}
