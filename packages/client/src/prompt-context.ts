import {readPromptSections,readPromptSectionData} from '../../contracts/src/index.js';
export interface PromptContextModule {key:string;label:string;value:unknown;characters:number;bodyCharacters:number;start:number;end:number;source:string}
const labels:Record<string,string>={instructions:'规则与提示词',format:'材料格式',basis:'调用依据',kind:'任务类型',scope:'本轮范围',global:'全局局势',facts:'授权事实',permissions:'本轮权限',changes:'状态变化',guidance:'战略与约束',evidence:'消息与证据',unknowns:'未知事项',time:'时间与计量',match:'对局规则',self:'己方状态',players:'玩家概况',mining:'采矿与资源',criticalAssets:'关键资产',economy:'经济与生产',ownFleets:'己方舰队',planning:'候选与条件估算',roster:'玩家名单',identities:'据点身份与归属',relations:'外交关系',feedback:'执行反馈',outposts:'据点情报',fleets:'舰队情报',scheduled:'已接受的预约',requestedInformation:'补查结果',requestableInformation:'可补查对象',coverage:'资料覆盖',activity:'实际事件',intentTasks:'当前意图任务',readOnlyIntentTasks:'其他来源任务（只读）',recentResults:'最近执行结果',strategic:'当前战略',executionRules:'执行约束',serverAgreements:'服务器合同',agreements:'外交约定',commander:'指挥官指令',communicationFacts:'会话确定事实',contractResults:'合同实际回执',editPolicy:'本轮编辑权限',relationAdvice:'关系与承诺建议',contractFeasibility:'合同可行性估算',fulfillmentFeasibility:'履约可行性估算',messages:'消息原文',notificationIds:'通知标识',currentMessage:'本次玩家消息',confirmedDirectives:'已确认指挥官指令',publishedStrategy:'已发布战略',history:'最近讨论',historyCoverage:'讨论覆盖',relevantFacts:'相关据点事实',manual:'人工命令',execution:'执行状态',mode:'调用模式',room:'房间',player:'当前玩家',tick:'观察 Tick',conversation:'当前会话记录',fixedConversation:'固定会话范围',diplomacyPurpose:'外交评估目的',fulfillment:'履约目标',reusableTaskIds:'可复用任务',intentCoverage:'意图覆盖',commanderVersion:'指挥官版本',remainingInformationPasses:'剩余补查轮数',validationError:'回复校验错误'};
const tableLabels:Record<string,string>={attackAssessment:'相关进攻判断',conclusion:'程序结论',assessedAtWorldDay:'评估世界日',targets:'相关目标',reasons:'关键原因',estimates:'条件估算',forceSources:'兵力来源',source:'来源',stationed:'当前驻兵',reserveEstimate:'预估留守',availableEstimate:'预估可调兵力',unknownSchedules:'未知预约',type:'类型',listed:'已列出',total:'总数'};
export function promptFieldLabel(key:string){return Object.hasOwn(labels,key)?labels[key]!:Object.hasOwn(tableLabels,key)?tableLabels[key]!:key;}
export function isPromptRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
export function isPromptTable(value:unknown):value is Record<string,unknown>&{columns:string[];rows:unknown[][]}{
 return isPromptRecord(value)&&Array.isArray(value.columns)&&value.columns.every(c=>typeof c==='string')&&Array.isArray(value.rows)&&value.rows.every(Array.isArray);
}
/** Ordinary object wrappers become a single labelled path in the reading view. */
export function promptContextFields(value:Record<string,unknown>,parents:string[]=[]):{keys:string[];value:unknown}[]{
 return Object.entries(value).flatMap(([key,v])=>{
  if(!promptValueHasContent(v))return [];
  const keys=[...parents,key];
  return isPromptRecord(v)&&!isPromptTable(v)?promptContextFields(v,keys):[{keys,value:v}];
 });
}
/** Hide empty collections in the reading view; scalar zero, false and null remain facts. */
export function promptValueHasContent(value:unknown):boolean {
 if(Array.isArray(value))return value.length>0;
 if(isPromptRecord(value)){
  if(isPromptTable(value))return value.rows.length>0||Object.entries(value).some(([key,v])=>key!=='columns'&&key!=='rows'&&promptValueHasContent(v));
  return Object.values(value).some(promptValueHasContent);
 }
 return true;
}
/** Boundaries and labels come only from the prompt producer's paired section tags. */
export function promptContextModules(text:string):PromptContextModule[]{
 const sections=readPromptSections(text);
 if(!sections)return [{key:'raw',label:'完整原文（未标记或分段不完整）',value:text,characters:text.length,bodyCharacters:text.length,start:0,end:text.length,source:text}];
 return sections.map(section=>{
  let value:unknown=section.text;
  if(section.format==='json'||section.format==='compact')try{
   value=readPromptSectionData(section.text);
   const key=section.id.slice('brief.'.length);
   if(section.id.startsWith('brief.')&&isPromptRecord(value)&&Object.keys(value).length===1&&Object.hasOwn(value,key))value=value[key];
  }catch{/* Preserve an explicitly tagged but non-JSON body as literal text. */}
  return {key:section.id,label:section.label,value,characters:section.end-section.start,bodyCharacters:section.text.length,start:section.start,end:section.end,source:text.slice(section.start,section.end)};
 });
}
export function promptValueText(value:unknown):string{return typeof value==='string'?value:JSON.stringify(value,null,2)??String(value);}
export function promptValueMatches(value:unknown,query:string,key=''):boolean {
 const needle=query.trim().toLocaleLowerCase();
 return !needle||`${key}\n${promptFieldLabel(key)}\n${promptValueText(value)}`.toLocaleLowerCase().includes(needle);
}
