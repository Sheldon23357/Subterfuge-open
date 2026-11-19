import type {SituationBrief} from './contracts.js';
import {fleetReferenceRenderer} from '@subterfuge/bot-sdk/presentation/fleet-labels';
import {selectRoundMaterials,type MaterialReason,type RoundMaterialSelection} from './round-material.js';
import {modelTacticalFeedback} from './tactical-material.js';
import {attackConclusions} from './attack-context.js';

type Row=Record<string,any>;
const rows=(value:any):Row[]=>Array.isArray(value)?value:value?.columns&&value?.rows?value.rows.map((row:any[])=>Object.fromEntries(value.columns.map((key:string,i:number)=>[key,row[i]]))):[];
const table=(columns:string[],records:Row[]):any=>records.length?{columns,rows:records.map(row=>columns.map(key=>row[key]??null))}:[];
const taskRows=(value:any):Row[]=>value?.byKind?Object.values(value.byKind).flatMap(rows):rows(value);
const closed=(a:Row)=>a.status!=='active'&&a.status!=='proposed';
const without=(r:Row,keys:string[])=>Object.fromEntries(Object.entries(r).filter(([key])=>!keys.includes(key)));

/** A model-only view. Publication guards retain the full, named brief. */
export function projectContextForModel(input:SituationBrief,focus:ReadonlySet<string>=new Set(),selection?:RoundMaterialSelection){
 const brief=structuredClone(input),g=brief.global as Row,h=brief.guidance as Row;
 const omittedFleetIds:string[]=[],omittedOutpostNames:string[]=[];
 const detailed=new Map<string,Set<MaterialReason>>();
 const note=(entity:string,reason:MaterialReason)=>{const reasons=detailed.get(entity)??new Set();for(const value of selection?.reasons.get(entity)??[])reasons.add(value);reasons.add(reason);detailed.set(entity,reasons);};
 delete g.commanderVersion;
 if(Array.isArray(g.identities))g.identities=table(['name','owner','type','drillers','shield'],g.identities.map(([name,owner,_visibility,type,drillers,shield]:any[])=>({name,owner,type,drillers,shield})));
 // Visibility is enforced before this projection; omit its redundant wire column.
 for(const [owner,key]of [[g,'identities'],[brief.facts as Row,'outposts'],[brief.facts as Row,'taskTargets']] as const){
  const value=owner[key];
  if(Array.isArray(value))owner[key]=value.map(p=>without(p,['visibility']));
  else if(value?.columns?.includes('visibility')){const i=value.columns.indexOf('visibility');value.columns.splice(i,1);for(const row of value.rows)row.splice(i,1);}
 }
 compactKnowledge(h);
 if(brief.kind!=='commander')compactExecution(h);
 compactContracts(brief);
 compactTaskTables(h);
 compactFeedback(g,input);
 if(brief.kind!=='commander'){
  if(h.editPolicy?.militaryEditsAllowed===false){delete h.editPolicy.friendlyTargets;delete h.editPolicy.returnFleetIds;}
  // Every authorized fleet remains individually identifiable in the default context.
  const economy=g.economy;
  if(economy?.columns&&economy.ownPosts){
   const all=rows({...economy,rows:economy.ownPosts}),detailed=all.filter(p=>p.type==='mine'||focus.has(p.name??p.id)),other=all.filter(p=>!detailed.includes(p));
   for(const p of detailed)note(p.name??p.id,p.type==='mine'?'critical-asset':'round-scope');
   if(other.length){
    const groups=new Map<string,Row>();
    for(const p of other){const r=groups.get(p.type)??{type:p.type,count:0,knownDrillers:0,unknownDrillers:0};r.count++;if(typeof p.drillers==='number')r.knownDrillers+=p.drillers;else r.unknownDrillers++;groups.set(p.type,r);omittedOutpostNames.push(p.name??p.id);}
    economy.ownPosts=detailed.map(p=>economy.columns.map((key:string)=>p[key]??null));
    economy.otherListedOutposts=table(['type','count','knownDrillers','unknownDrillers'],[...groups.values()]);
    economy.coverage={...economy.coverage,listed:detailed.length,summarized:other.length};
   }
  }
  const facts=brief.facts as Row,source=facts.outposts;
  if(source){
   const taskTargets=new Set(taskRows((input.guidance as Row).intentTasks).filter(t=>t.kind==='capture'&&!['completed','cancelled','expired'].includes(t.status)).map(t=>t.target));
   const all=rows(source),detailed=all.filter(p=>focus.has(p.name??p.id)),taskFacts=all.filter(p=>!detailed.includes(p)&&taskTargets.has(p.name??p.id)),other=all.filter(p=>!detailed.includes(p)&&!taskFacts.includes(p));
   for(const p of detailed)note(p.name??p.id,'round-scope');
   if(taskFacts.length){facts.taskTargets=table(['name','owner','type','drillers','shield'],taskFacts);for(const p of taskFacts)note(p.name??p.id,'current-task');}
   if(other.length){
    // A generic program shortlist does not expand raw facts in model input.
    for(const p of other)omittedOutpostNames.push(p.name??p.id);
    facts.outpostCoverage={total:all.length,detailed:detailed.length,taskTargets:taskFacts.length,summarized:other.length,meaning:'taskTargets只提供现有任务的目标状态，不含位置与生产明细；未展开据点仍在全局目录中，不代表已提供完整资料'};
   }
   facts.outposts=source.columns?table(source.columns,detailed):detailed;
   for(const p of taskFacts)omittedOutpostNames.push(p.name??p.id);
  }
 }
 // A parallel foreground may already have acted. Only carry a conclusion for
 // an explicit round problem; source allocations and rankings stay in audit.
 const attackSelection=selection??selectRoundMaterials(input,[...focus].map(entity=>({entity,reason:'round-scope'})));
 const attackTargets=new Set([...attackSelection.reasons].filter(([,reasons])=>reasons.some(r=>['round-scope','trigger','message','commander'].includes(r))).map(([entity])=>entity));
 for(const task of taskRows((input.guidance as Row).intentTasks))if(attackTargets.has(task.id)&&task.target)attackTargets.add(task.target);
 const assessment=attackConclusions(g.planning,attackTargets);
 delete g.planning;
 if(assessment)g.attackAssessment=assessment;
 for(const [owner,key]of [[h,'contractResults'],[h,'recentResults'],[g,'ownFleets'],[brief.facts as Row,'fleets']] as const)if(owner[key]?.rows?.length===0)owner[key]=[];
 const sectionCharacters=Object.fromEntries(Object.entries(brief).map(([key,value])=>[key,JSON.stringify({[key]:value}).length]));
 return {brief,omittedFleetIds:[...new Set(omittedFleetIds)],omittedOutpostNames:[...new Set(omittedOutpostNames)],selection:{expanded:[...detailed].map(([entity,reasons])=>({entity,reasons:[...reasons]})),sectionCharacters}};
}

/** Task parameters and program execution conclusions remain independently usable. */
function compactExecution(h:Row){
 const tasks=taskRows(h.intentTasks),feedback=Array.isArray(h.executionFeasibility)?h.executionFeasibility:[];
 const meanings:Row={...(h.executionFeasibilityMeaning??{})};
 for(const evaluation of feedback){
  const task=tasks.find(t=>t.id===evaluation.taskId);if(!task)continue;
  for(const key of ['kind','target','status','source','maxDrillersPerPlan'])if(Object.hasOwn(task,key)&&JSON.stringify(task[key])===JSON.stringify(evaluation[key]))delete evaluation[key];
  if(task.reason===evaluation.executionReason)delete evaluation.executionReason;
  if(task.until===evaluation.deadline)delete evaluation.deadline;
  if(task.drillers===evaluation.requestedDrillers)delete evaluation.requestedDrillers;
  delete evaluation.listedSources;
  for(const key of ['operationEvidence','interpretation'])if(typeof evaluation[key]==='string'){
   const scope=key==='operationEvidence'?'operationEvidence':task.kind;
   // Do not silently replace differing explanations from future producers.
   if(meanings[scope]===undefined||meanings[scope]===evaluation[key]){meanings[scope]=evaluation[key];delete evaluation[key];}
  }
 }
 if(Object.keys(meanings).length)h.executionFeasibilityMeaning=meanings;
 // A contract adds only its own applicability checks. Its task's execution
 // assessment is already present; retain differing values rather than guess.
 if(Array.isArray(h.fulfillmentFeasibility))h.fulfillmentFeasibility=h.fulfillmentFeasibility.map((entry:Row)=>{
  const execution=feedback.find((p:Row)=>p.taskId===entry.taskId),task=tasks.find(t=>t.id===entry.taskId);
  if(!execution||!task)return entry;
  const result={...entry};
  const facts={...task,...execution,deadline:task.until};
  for(const key of Object.keys(result))if(key!=='taskId'&&key!=='agreementId'&&Object.hasOwn(facts,key)&&JSON.stringify(result[key])===JSON.stringify(facts[key]))delete result[key];
  return result;
 });
}

function compactKnowledge(h:Row){
 const capacity=h.relationAdvice?.agreementCapacity;
 if(Array.isArray(capacity)){
  h.relationAdvice.agreementCapacity={own:capacity.filter(p=>p.complete),peers:table(['player','ceasefiresLowerBound','jointAttacksLowerBound'],capacity.filter(p=>!p.complete).map(p=>({player:p.player,ceasefiresLowerBound:p.visibleCeasefiresLowerBound??p.ceasefires,jointAttacksLowerBound:p.visibleJointAttacksLowerBound??p.jointAttacks}))),unknown:['actualCeasefires','actualJointAttacks','remainingCeasefires','remainingJointAttacks'],meaning:'对手仅列授权可见下界；实际完整占用与剩余名额未知，零不代表无占用；签署由服务器复核'};
 }
 const c=h.communicationFacts;
 if(c&&Array.isArray(c.ownOutposts)&&Array.isArray(c.peerOutposts)){
  c.ceasefireOutpostsByOwner=table(['player','outposts'],[{player:c.self,outposts:c.ownOutposts},...c.peerOutposts]);
  delete c.ownOutposts;delete c.peerOutposts;delete c.eligibleCeasefireOutposts;delete c.scopeContracts;
 }
}

function compactContracts(brief:SituationBrief){
 const h=brief.guidance as Row,contracts=rows(h.serverAgreements);if(!h.serverAgreements||h.serverAgreements.current)return;
 const peers=new Set((h.fixedConversation?.identities??[]).map((p:Row)=>p.gamePlayer));
 const referenced=JSON.stringify([(brief.evidence as Row).messages,h.commander,h.strategic,h.fulfillment,h.intentTasks,h.readOnlyIntentTasks,h.executionFeasibility,h.contractResults]);
 const detailed:Row[]=[],historical:Row[]=[],groups=new Map<string,Row>();
 for(const a of contracts){
  if(closed(a)){
   if(referenced.includes(a.id)){
    historical.push(without(a,['ticksLeft','ownCapturesRemaining','peerCapturesRemaining','ownTrustReward','ownShortfallPenalty','allowedActions']));
   }else{
    const keys=['peer','kind','status','enemy','reason','ownFulfilled','peerFulfilled'],key=JSON.stringify(keys.map(k=>a[k]??null));
    const r=groups.get(key)??{...Object.fromEntries(keys.map(k=>[k,a[k]??null])),count:0};r.count++;groups.set(key,r);
   }
   continue;
  }
  const edits=h.editPolicy?.contracts?.find((p:Row)=>p.agreementId===a.id),feasibility=h.contractFeasibility?.find((p:Row)=>p.agreementId===a.id);
  const obligation=h.relationAdvice?.obligations?.find((p:Row)=>p.agreementId===a.id);
  const record={...a,inConversation:brief.kind==='diplomacy'&&peers.has(a.peer),
   ...(edits?{edits:without(edits,['agreementId','deadline','enemy','ownFulfilled'])}:{}),
   ...(feasibility?{feasibility:without(feasibility,['agreementId','enemy','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','deadline','ticksLeft'])}:{}),
   ...(obligation?{countsInRiskBudget:true}:{}),
   ...(h.fulfillmentFeasibility?.some((p:Row)=>p.agreementId===a.id)?{taskFeasibility:h.fulfillmentFeasibility.filter((p:Row)=>p.agreementId===a.id).map((p:Row)=>without(p,['agreementId','ownCapturesRemaining','deadline','goalMeaning']))}:{}),
  };
  if(a.status==='proposed'){
   for(const k of ['ownProgress','peerProgress','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','peerFulfilled','ownShortfallPenalty'])delete (record as Row)[k];
  }
  detailed.push(record);
 }
 const terms=['id','peer','status',...(detailed.some(a=>a.ownProposalRole)?['ownProposalRole']:[]),'allowedActions','deadline','ticksLeft','inConversation'];
 const blocks=(records:Row[],history=false)=>({
  ceasefire:table(history?['id','peer','status','endedAt','deadline','outposts','subsidyPayer','subsidyAmount','subsidyPaid','reason']:[...terms,'outposts','subsidyPayer','subsidyAmount','subsidyPaid'],records.filter(a=>a.kind==='ceasefire')),
  jointAttack:table(history?['id','peer','status','endedAt','deadline','enemy','ownCaptureGoal','peerCaptureGoal','ownProgress','peerProgress','ownFulfilled','peerFulfilled','subsidyPayer','subsidyAmount','subsidyPaid','reason']:[...terms,'enemy','ownCaptureGoal','peerCaptureGoal','ownProgress','peerProgress','ownCapturesRemaining','peerCapturesRemaining','ownFulfilled','peerFulfilled','ownTrustReward','ownShortfallPenalty','subsidyPayer','subsidyAmount','subsidyPaid','countsInRiskBudget','edits','feasibility','taskFeasibility'],records.filter(a=>a.kind==='joint-attack')),
 });
 h.serverAgreements={current:blocks(detailed),history:blocks(historical,true),otherHistory:table(['peer','kind','status','enemy','reason','ownFulfilled','peerFulfilled','count'],[...groups.values()]),meaning:'current中proposed是待签条款，active才是当前义务；history与otherHistory均已终止，不可复活或计入当前义务；历史结果仅覆盖当前授权合同列表'};
 // Ceasefire permissions are required too; carry them beside that contract.
 const ceasefire=h.serverAgreements.current.ceasefire;
 for(const key of ['edits','feasibility','taskFeasibility'])if(detailed.some(a=>a.kind==='ceasefire'&&a[key]!==undefined)){
  ceasefire.columns.push(key);for(let i=0;i<ceasefire.rows.length;i++){const id=ceasefire.rows[i][0];ceasefire.rows[i].push(detailed.find(a=>a.id===id)?.[key]??null);}
 }
 if(h.editPolicy)delete h.editPolicy.contracts;
 delete h.contractFeasibility;delete h.fulfillmentFeasibility;
 if(h.relationAdvice)delete h.relationAdvice.obligations;
}

function compactTaskTables(h:Row){
 for(const key of ['intentTasks','readOnlyIntentTasks']){
  const value=h[key];if(!value?.columns)continue;
  const all=rows(value),groups:Record<string,unknown>={};
  for(const kind of new Set(all.map(t=>t.kind))){
   const fields=['id','authority','originConversation','originAgreementId','status','reason','until',
    ...(kind==='transfer'?['source','target','drillers','priority']:kind==='focus'?['target','rally']:kind==='return-fleet'?['fleetId']:kind==='capture'?['target','priority','maxDrillersPerPlan']:kind==='configure'?['target','priority','configuration']:['target'])].filter(k=>value.columns.includes(k));
   groups[kind]=table(fields,all.filter(t=>t.kind===kind));
  }
  h[key]={byKind:groups,...(value.meaning?{meaning:value.meaning}:{})};
 }
 if(Array.isArray(h.reusableTaskIds)&&h.reusableTaskIds.every((id:string)=>Object.values(h.intentTasks?.byKind??{}).some(t=>rows(t).some(r=>r.id===id))))delete h.reusableTaskIds;
}

function compactFeedback(g:Row,input:SituationBrief){
 const feedback=g.feedback;if(!feedback)return;
 const render=fleetReferenceRenderer(input);
 if(input.kind!=='commander'){g.feedback=modelTacticalFeedback(feedback,render);return;}
 const objective=(value:any)=>typeof value==='string'?render(value):value;
 if(typeof feedback.selected==='string')feedback.selected=objective(feedback.selected);
 if(Array.isArray(feedback.conditionalAlternatives)){
  feedback.conditionalAlternatives=feedback.conditionalAlternatives.map((p:Row)=>({
   ...without(p,['utility']),objective:objective(p.objective),
   ...(Array.isArray(p.targets)?{targets:p.targets.map(objective)}:{}),
  }));
  if(feedback.conditionalAlternatives.length)feedback.alternativeMeaning='按程序建议顺序列出条件方案，尚未执行，不表示胜率或全局最优';
 }
 if(Array.isArray(feedback.unverified))feedback.unverified=feedback.unverified.map((p:Row)=>({...p,objective:objective(p.objective)}));
 if(Array.isArray(feedback.limitations))feedback.limitations=[...new Set(feedback.limitations)];
}

