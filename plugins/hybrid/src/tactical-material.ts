import type {BotAssessment} from '@subterfuge/bot-sdk/analysis/tactical-planner';

export interface ProposalDecision {
 resourceGap:{committed:number;requiredEstimate:number;shortfallEstimate:number}|null;
 conditionalOutcome:{outcome:'own-eliminated'|'opponent-crossing'|'ongoing'|'own-crossing';crossingTick:number|null;certainty:string|null}|null;
 reactionOutcome?:ProposalDecision['conditionalOutcome'];
 risks:string[];
}
/** Consequences of existing calculations, never their score weights. */
export function proposalDecision(a:BotAssessment):ProposalDecision {
 const force=a.candidate.forceEstimate;
 const outcome=(score:BotAssessment['score']):ProposalDecision['conditionalOutcome']=>score?{outcome:({'-2':'own-eliminated','-1':'opponent-crossing','0':'ongoing','1':'own-crossing'} as const)[String(score.outcome) as '-2'|'-1'|'0'|'1'],crossingTick:score.crossingTick,certainty:score.terminalCertainty}:null;
 return {
  resourceGap:force?{committed:force.committed,requiredEstimate:force.required,shortfallEstimate:Math.max(0,force.required-force.committed)}:null,
  conditionalOutcome:outcome(a.score),...(a.stress?{reactionOutcome:outcome(a.stress)}:{}),
  risks:[...new Set([...(a.score?.unknowns??[]),...(a.stress?.unknowns??[]),...(a.stressCases?.some(s=>s.status==='unknown')?['敌方反应情景未完整验证']:[])])],
 };
}

type Row=Record<string,any>;
const actionKeys=['kind','source','destination','outpostId','fleetId','drillers','enabled'];
export const decisionActions=(drafts:readonly {action:Row;issueTick?:number}[])=>drafts.map(({action,issueTick})=>({...Object.fromEntries(actionKeys.filter(key=>Object.hasOwn(action,key)).map(key=>[key,action[key]])),...(typeof issueTick==='number'?{atWorldDay:issueTick}:{})}));

/** Historical goals are not reconstructed executable commands. */
function historicalGoals(value:unknown,render:(value:string)=>string):Row[]{
 if(typeof value!=='string')return [];
 return value.split('+').map(goal=>{
  if(goal==='hold')return {kind:'hold'};
  const colon=goal.indexOf(':'),kind=colon<0?goal:goal.slice(0,colon),entity=colon<0?null:render(goal.slice(colon+1));
  return {kind,...(entity?kind==='return'?{fleetId:entity}:{target:entity}:{})};
 });
}
const compactLimits=new Map([
 ['仅授权观察','仅授权观察'],
 ['基线沿现有行动继续；另列可见资产的敌方反应假设','基线继续已有行动；敌方反应仅为情景假设'],
 ['敌方反应是有限压力测试，不是已发生命令、意图预测或穷尽所有反击','敌方反应测试有限，不表示真实命令或穷尽反击'],
 ['矿场长期资本按可见局部守备折减，库存暴露是评分启发式而非失守概率；已结算失矿扣款只在引擎库存中计一次','矿场持有与暴露是启发式估算，非失守概率；失矿实际扣款以结算为准'],
 ['未来执行仍需权限、资源及局面复核','执行前复核权限、资源和局面'],
]);

/** Model view only. Raw objective IDs, utility and search counters stay in audit. */
export function modelTacticalFeedback(feedback:Row,render:(value:string)=>string){
 const project=(plan:Row):Row=>{
  const actions=Array.isArray(plan.actions)?plan.actions.map((a:Row)=>Object.fromEntries(Object.entries(a).map(([key,value])=>[key,typeof value==='string'?render(value):value]))):undefined;
  const decision=plan.decision as ProposalDecision|undefined;
  return {
   ...(actions?{actions}:{goals:historicalGoals(plan.objective,render)}),
   ...(Array.isArray(plan.targets)?{targets:plan.targets.map((value:string)=>render(value))}:{}),
   ...(plan.plannedOrders!==undefined?{plannedOrders:plan.plannedOrders}:{}),
   ...(plan.status?{status:plan.status}:{}),
   ...(decision?{resourceGap:decision.resourceGap,conditionalOutcome:decision.conditionalOutcome,...(decision.reactionOutcome?{reactionOutcome:decision.reactionOutcome}:{}),risks:decision.risks.map(render)}:{}),
  };
 };
 const selected=feedback.selectedPlan?project(feedback.selectedPlan):{goals:historicalGoals(feedback.selected,render)};
 const selectedActions='actions'in selected?selected.actions:undefined;
 const alternatives=(feedback.conditionalAlternatives??[]).map((plan:Row)=>{
  const result=project(plan);
  if(selectedActions&&result.actions){
   const before=new Set(selectedActions.map((a:Row)=>JSON.stringify(a))),after=new Set(result.actions.map((a:Row)=>JSON.stringify(a)));
   const {actions,...consequences}=result;
   return {...consequences,differenceFromSelected:{add:actions.filter((a:Row)=>!before.has(JSON.stringify(a))),remove:selectedActions.filter((a:Row)=>!after.has(JSON.stringify(a)))}};
  }
  return result;
 });
 const unverified=(feedback.unverified??[]).map(project),plans=[selected,...alternatives,...unverified] as Row[];
 const withRisks=plans.filter(plan=>Array.isArray(plan.risks)&&plan.conditionalOutcome!=null);
 const sharedRisks: string[]=withRisks.length>1?[...new Set<string>(withRisks[0]!.risks)].filter(risk=>withRisks.every(plan=>plan.risks.includes(risk))):[];
 if(sharedRisks.length)for(const plan of withRisks)plan.risks=plan.risks.filter((risk:string)=>!sharedRisks.includes(risk));
 const evaluated=plans.filter(plan=>plan.status==='evaluated'),sharedAssessment:Row={};
 for(const key of ['conditionalOutcome','reactionOutcome'])if(evaluated.length>1&&evaluated[0]![key]!=null&&evaluated.every(plan=>JSON.stringify(plan[key])===JSON.stringify(evaluated[0]![key]))){
  sharedAssessment[key]=evaluated[0]![key];for(const plan of evaluated)delete plan[key];
 }
 for(const plan of plans){
  if(plan.resourceGap===null)delete plan.resourceGap;
  if(plan.risks?.length===0)delete plan.risks;
  if(Array.isArray(plan.targets)&&plan.targets.length===0)delete plan.targets;
 }
 const actionLists=plans.flatMap(plan=>[plan.actions,plan.differenceFromSelected?.add,plan.differenceFromSelected?.remove].filter(Array.isArray)) as Row[][];
 const allActions=actionLists.flat(),sameDay=allActions.length&&allActions.every(action=>typeof action.atWorldDay==='number'&&action.atWorldDay===allActions[0]!.atWorldDay);
 const columns=[...actionKeys,'atWorldDay'].filter(key=>(key!=='atWorldDay'||!sameDay)&&allActions.some(action=>Object.hasOwn(action,key)));
 // One set of semantic column names, not an internal action-ID catalog.
 for(const list of actionLists)for(let i=0;i<list.length;i++)list[i]=columns.map(key=>list[i]![key]??null) as any;
 return {
  ...(typeof feedback.assessedAtWorldDay==='number'?{assessedAtWorldDay:feedback.assessedAtWorldDay}:{}),
  ...(columns.length?{actionColumns:columns,...(sameDay?{actionWorldDay:allActions[0]!.atWorldDay}:{})}:{}),
  selected,conditionalAlternatives:alternatives,
  unverified,...(sharedRisks.length?{sharedRisks}:{}),
  ...(Object.keys(sharedAssessment).length?{evaluatedDefaults:sharedAssessment}:{}),
  coverage:{complete:feedback.coverage?.complete??null,stopReason:feedback.coverage?.stopReason??null},
  limitations:[...new Set<string>((feedback.limitations??[]).map((value:string)=>compactLimits.get(value)??value))],
  reviewWhen:['关联目标归属、兵力或来袭变化','来源可调量或合同/任务约束变化','真实执行失败或结算与条件预测不一致'],
  meaning:'条件方案按建议排序，未表示已执行。动作按actionColumns读列，null为不适用，执行日默认actionWorldDay；差异相对selected。evaluatedDefaults/sharedRisks只用于已评估方案。缺口未给出即未计算，goals仅历史方向；条件结果非保证。',
 };
}
