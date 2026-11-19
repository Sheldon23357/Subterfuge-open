import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {compareBotEvaluations} from '../dist/packages/ai/src/controller/analysis/tactical-evaluation.js';
import {botWeightedActionAllowed} from '../dist/packages/ai/src/controller/analysis/tactical-planner.js';
const [store,destination]=process.argv.slice(2).filter(a=>a!=='--frozen');
if(!store||!destination||process.argv.includes('--help')){console.log('用法：node scripts/analyze-bot-search.mjs AI私库目录 输出目录 [--frozen]\n只读关联搜索、最终选择和执行回执；--frozen 复用输出目录中已有的每席日志截止号。');process.exit(process.argv.includes('--help')?0:1);}
const source=resolve(store),output=resolve(destination);
mkdirSync(output,{recursive:true});
const frozen=process.argv.includes('--frozen')?JSON.parse(readFileSync(output+'/analysis.json','utf8')):null;
const sum=xs=>xs.reduce((a,b)=>a+b,0),count=(xs,key)=>xs.reduce((o,x)=>{const k=typeof key==='function'?key(x):x[key];o[k??'unknown']=(o[k??'unknown']??0)+1;return o;},{});
const canonical=v=>JSON.stringify(order(v));
function order(v){return Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,order(v)])):v;}
const actionKey=drafts=>canonical(drafts.map(d=>({issueTick:d.issueTick,action:d.action})));
function subtype(c){
 if(c.objective==='hold')return 'hold';
 if(c.id?.startsWith('internal-')||c.objective==='internal-relocation')return 'internal-transfer';
 if(c.combatIntent==='attrition')return 'attrition';
 if(c.objective.startsWith('opening-cover:'))return 'opening-expansion';
 if(c.kind==='combined')return 'combined';
 return c.objective.split(':')[0];
}
const improves=(a,b,margin=2)=>compareBotEvaluations(a,b)>0&&(a.outcome!==b.outcome||a.crossingTick!==b.crossingTick||a.utility>b.utility+margin);
const candidates=[],searches=[],decisions=[],batches=[],operations=[],captures=[];
const kinds=['started','mode-hybrid-search','mode-hybrid-decision','mode-hybrid-validation','mode-hybrid-validation-failed','mode-hybrid-operations','tool-intent','tool-result','tool-rejected','tool-unknown','batch-recovered','write-reconciled'];
for(const file of readdirSync(source).filter(x=>x.endsWith('.sqlite'))){
 const db=new DatabaseSync(source+'/'+file,{readOnly:true});db.exec('BEGIN');
 try{
  const identity=db.prepare('SELECT room,seat FROM seats').get();if(!identity)continue;const bot='AI'+String(identity.seat+1).padStart(2,'0');
  const cutoff=frozen?.captures.find(c=>c.file===file)?.maxJournalId??db.prepare('SELECT max(id) id FROM journal').get().id;
  captures.push({bot,file,room:identity.room,maxJournalId:cutoff});
  const rows=db.prepare(`SELECT id,kind,payload FROM journal WHERE room=? AND seat=? AND id<=? AND kind IN (${kinds.map(()=>'?').join(',')}) AND (kind NOT LIKE 'tool-%' OR json_extract(payload,'$.tool') IN ('batch','order')) ORDER BY id`).all(identity.room,identity.seat,cutoff,...kinds).map(r=>({id:r.id,kind:r.kind,p:JSON.parse(r.payload)}));
  const latestOps=new Map(),intents=new Map();let round=null;
  for(const r of rows){const p=r.p;
   if(r.kind==='started')round=p.sequence;
   if(r.kind==='mode-hybrid-search'){
    const d=p.decision,base=d.assessments.find(a=>a.candidate.id==='hold'),independent=d.policyDiagnostics?.executionPhase==='independent';
    const sid=`${bot}:${r.id}`,entry={sid,bot,journalId:r.id,sequence:p.sequence,step:p.step,tick:d.observedTick,basisRevision:d.basisRevision,budget:d.parameters.maxSimulations,timeMs:d.parameters.maxElapsedMs,phase:d.situation?.phase,independent:!!independent,selected:d.selected,selectedType:subtype(d.selected),action:!!d.selected.drafts.length,coverage:d.coverage,baseline:base?{score:base.score,stress:base.stress}:null,parameters:d.parameters};searches.push(entry);
    for(const a of d.assessments){
     const c=a.candidate,margin=d.parameters.minActionGain;
     const needsStress=Object.hasOwn(base??{},'stressCases');
     const passOrdinary=!!(a.score&&base?.score&&improves(a.score,base.score,margin));
     const weightedAdmission=!!(a.score&&base?.score&&(!needsStress||a.stress&&base.stress)&&botWeightedActionAllowed(a.score,base.score,a.stress,base.stress,margin));
     const passWorst=!!(a.score&&base?.score&&(!needsStress||a.stress&&base.stress)&&improves(a.stress??a.score,base.stress??base.score,margin));
     const hardReason=(a.reasons??[]).find(x=>/新增失矿|未能保持占领/.test(x));
     candidates.push({sid,bot,sequence:p.sequence,step:p.step,tick:d.observedTick,budget:d.parameters.maxSimulations,independent:!!independent,id:c.id,kind:c.kind,type:subtype(c),objective:c.objective,targets:c.targets,drafts:c.drafts,forceEstimate:c.forceEstimate,forceSizing:c.forceSizing,
      status:a.status,selected:c.id===d.selected.id,action:!!c.drafts.length,reasons:a.reasons,ordinaryReasons:c.reasons,score:a.score,stress:a.stress,stressCases:a.stressCases,uncertaintyPenalty:a.uncertaintyPenalty??0,margin,needsStress,passOrdinary,weightedAdmission,passWorst,hardHoldingFailure:hardReason??null,
      gateFailures:[...(a.status!=='evaluated'?['status-'+a.status]:[]),...(!a.score?['no-score']:[]),...(a.score&&needsStress&&(!a.stress||!base?.stress)?['incomplete-pressure']:[]),...(hardReason?['holding-failure']:[]),...(a.score&&base?.score&&!weightedAdmission?['weighted-gain-or-terminal-gate']:[])]});
    }
   }
   if(r.kind==='mode-hybrid-decision')decisions.push({bot,journalId:r.id,sequence:p.sequence,step:p.step,tick:p.decision.observedTick,budget:p.decision.parameters.maxSimulations,selected:p.decision.selected,selectedType:subtype(p.decision.selected),independent:p.decision.policyDiagnostics?.executionPhase==='independent',repaired:p.repaired,coverage:p.decision.coverage});
   if(r.kind==='mode-hybrid-operations')for(const op of p.operations??[]){const prior=latestOps.get(op.id);latestOps.set(op.id,{bot,firstJournalId:prior?.firstJournalId??r.id,lastJournalId:r.id,...op});}
   if(r.kind==='tool-intent')intents.set(p.id,{bot,journalId:r.id,sequence:round,tool:p.tool,id:p.id,actions:p.tool==='batch'?p.arguments?.actions?.filter(x=>x.tool==='order').map(x=>x.arguments.action):p.tool==='order'?[p.arguments?.action]:[]});
   if(['tool-result','tool-rejected','tool-unknown','batch-recovered','write-reconciled'].includes(r.kind)&&p.tool&&['order','batch'].includes(p.tool)){
    const intent=intents.get(p.id);batches.push({bot,journalId:r.id,id:p.id,sequence:intent?.sequence??round,tool:p.tool,recordKind:r.kind,actions:intent?.actions??[],items:p.result?.results?.map(x=>({index:x.index,id:x.id,status:x.status,code:x.code,receiptState:x.protocolReceipt?.state,effects:x.protocolReceipt?.effects})),status:p.result?.status??p.status,code:p.result?.code??p.code});
   }
  }
  operations.push(...latestOps.values());
 }finally{db.exec('ROLLBACK');db.close();}
}
// Relate by seat + durable round/step, then require the exact command actions.
for(const s of searches){
 const ds=decisions.filter(d=>d.bot===s.bot&&d.sequence===s.sequence&&d.step===s.step&&d.journalId>s.journalId);const final=ds[0];
 s.final=final?{journalId:final.journalId,selectedType:final.selectedType,action:!!final.selected.drafts.length,repaired:!!final.repaired,changed:actionKey(s.selected.drafts)!==actionKey(final.selected.drafts)}:null;
 const cmds=(final??s).selected.drafts.map(d=>d.action);
 const related=operations.filter(op=>op.bot===s.bot&&(op.id===`operation-${s.sequence}`||op.id===`operation-${s.sequence}-internal`)&&canonical(op.drafts.map(d=>d.action))===canonical(cmds));
 const op=related.sort((a,b)=>a.firstJournalId-b.firstJournalId)[0];
 const receipts=op?batches.filter(b=>b.bot===s.bot&&op.receiptIds?.includes(b.id)):[];
 s.execution=op?{operation:op.id,phase:op.phase,status:op.status,receipts:op.receiptIds,commandStates:count(op.commands??[],'state'),commands:op.commands?.map(c=>({state:c.state,orderId:c.orderId,reason:c.reason,evidenceId:c.evidenceId})),accepted:receipts.some(b=>b.items?.some(i=>i.status==='accepted'||i.receiptState==='applied')||b.status==='accepted')||(op.commands??[]).some(c=>c.orderId||['accepted','completed','underway'].includes(c.state))}:null;
}
const grouped=(rows,key,callback)=>Object.entries(Object.groupBy(rows,key)).map(([name,rs])=>({name,...callback(rs)}));
function summary(ss,cc){
 const actions=ss.filter(s=>s.action),evals=cc.filter(c=>c.action),selected=cc.filter(c=>c.selected&&c.action);
 return {searches:ss.length,selectedActions:actions.length,hold:ss.length-actions.length,independentSelected:actions.filter(s=>s.independent).length,simulations:sum(ss.map(s=>s.coverage.simulations)),generated:sum(ss.map(s=>s.coverage.generated)),assessmentRows:cc.length,actionAssessmentRows:evals.length,
  statuses:count(evals,'status'),selectedTypes:count(actions,'selectedType'),stops:count(ss,s=>s.coverage.stopReason),
  matchingExecutions:actions.filter(s=>s.execution).length,acceptedExecutions:actions.filter(s=>s.execution?.accepted).length,finalActions:ss.filter(s=>s.final?.action).length,missingFinal:ss.filter(s=>!s.final).length,
  byType:grouped(evals,c=>c.type,rs=>({assessed:rs.length,evaluated:rs.filter(c=>c.status==='evaluated').length,invalid:rs.filter(c=>c.status==='invalid').length,unknown:rs.filter(c=>c.status==='unknown').length,protected:rs.filter(c=>c.status==='protected').length,selected:rs.filter(c=>c.selected).length,ordinaryPositive:rs.filter(c=>c.passOrdinary).length,stressTested:rs.filter(c=>c.stressCases?.length).length,stressComplete:rs.filter(c=>c.stress).length,gateFailures:count(rs.flatMap(c=>c.gateFailures),x=>x)})).sort((a,b)=>b.assessed-a.assessed),
  rejectedReasons:Object.entries(count(evals.filter(c=>c.status!=='evaluated').flatMap(c=>c.reasons??[]),x=>x)).sort((a,b)=>b[1]-a[1]).slice(0,25),
  stageSimulations:ss.reduce((a,s)=>{for(const [k,v]of Object.entries(s.coverage.stages??{}))a[k]=(a[k]??0)+v;return a;},{}),
  selectedFeatures:{draftCounts:count(selected,c=>c.drafts.length),types:count(selected,'type'),forceMargins:count(selected,c=>!c.forceEstimate?'no-estimate':c.forceEstimate.committed<c.forceEstimate.required?'below-cheap-estimate':'at-or-above-cheap-estimate'),resized:selected.filter(c=>c.forceSizing).length},
 };
}
const report={at:new Date().toISOString(),source,captures,summary:summary(searches,candidates),byBudget:grouped(searches,s=>String(s.budget),ss=>summary(ss,candidates.filter(c=>ss.some(s=>s.sid===c.sid)))),byBot:grouped(searches,s=>s.bot,ss=>summary(ss,candidates.filter(c=>ss.some(s=>s.sid===c.sid)))),
 operationsSummary:{count:operations.length,phases:count(operations,'phase'),statuses:count(operations,'status'),commandStates:count(operations.flatMap(o=>o.commands??[]),'state')},
 executions:batches,operations,searches,candidates,
 limitations:['Explicit source directory; per-seat SQLite read transactions are not a simultaneous global snapshot.','Generated count lacks a durable full list of untested candidates; assessment rows exclude unvisited branches and include hold/refinement/combination.','A search selection, final post-refresh selection, command acceptance and actual settlement are separate events.','Retrospective gain-gate diagnostics use current source against stored scores; historical algorithm changes may alter exact finalist ordering.','Per-candidate wall/CPU cost is not recorded; assessment counts are not time shares.','Not selected in these samples does not prove a policy can never execute.']};
writeFileSync(output+'/analysis.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({at:report.at,summary:report.summary,byBudget:report.byBudget.map(x=>({name:x.name,searches:x.searches,selectedActions:x.selectedActions,selectedTypes:x.selectedTypes,acceptedExecutions:x.acceptedExecutions})),operationsSummary:report.operationsSummary},null,2));
