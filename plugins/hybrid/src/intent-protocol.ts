export {intentSchemaFor,intentOutputExample} from './intent-schema.js';

import {parseAssessment} from './assessment.js';
import {validateCommanderTransferSources} from './commander-commitments.js';
import {parseDiplomacyAction} from '@subterfuge/bot-sdk/rules';
import type {IntentSpec,IntentEdits,StrategicAssessment,SituationBrief} from './contracts.js';
function fieldsAt(value:any,fields:string[],path:string,prefix='Invalid intent task'){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${prefix}: ${path}: expected object`);
 const missing=fields.filter(k=>!Object.hasOwn(value,k)),extra=Object.keys(value).filter(k=>!fields.includes(k));
 if(missing.length||extra.length)throw Error(`${prefix}: ${path}: ${[...missing.map(k=>`missing ${path}.${k}`),...extra.map(k=>`unexpected ${path}.${k}`)].join('; ')}; allowed fields: ${fields.join(',')}`);
}
export function parseIntentResult(raw:unknown,kind:SituationBrief['kind'],players:number,posts:ReadonlySet<string>,fleets:ReadonlySet<string>=new Set()):StrategicAssessment{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid intent result');
 const a=raw as Record<string,any>,keys=['summary','tasks','reviewOn',...(kind==='diplomacy'?['message','agreement']:kind==='commander'?['constraints']:[]),...(Object.hasOwn(raw,'diplomacyAction')&&kind==='diplomacy'?['diplomacyAction']:[]),...(Object.hasOwn(raw,'fulfillAgreementId')&&kind==='diplomacy'?['fulfillAgreementId']:[]),...(Object.hasOwn(raw,'betrayAgreements')&&kind!=='commander'?['betrayAgreements']:[])].sort();
 fieldsAt(a,keys,'$','Unexpected intent fields');
 const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
 const validId=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=120;
 const count=(v:any)=>Number.isSafeInteger(v)&&v>=0&&v<=1000000;
 fieldsAt(a.tasks,['upsert','cancel'],'tasks','Invalid task edits');
 for(const key of ['upsert','cancel'])if(!Array.isArray(a.tasks[key])||a.tasks[key].length>12)throw Error(`Invalid task edits: tasks.${key}: expected array of at most 12 entries`);
 for(const [i,id] of a.tasks.cancel.entries())if(!validId(id))throw Error(`Invalid task edits: tasks.cancel[${i}]: expected task ID`);
 if(new Set(a.tasks.cancel).size!==a.tasks.cancel.length)throw Error('Invalid task edits: tasks.cancel: duplicate ID');
 const seen=new Set<string>();
 if(!Array.isArray(a.reviewOn)||a.reviewOn.length>16)throw Error('Invalid review conditions: reviewOn: expected array of at most 16 conditions');
 for(const [index,edit] of a.tasks.upsert.entries()){
  const path=`tasks.upsert[${index}]`;
  fieldsAt(edit,['id','task'],path,'Invalid task identity');
  if(edit.id!==null&&!validId(edit.id))throw Error(`Invalid task identity: ${path}.id: expected null for new task or nonempty task ID (max 120 characters)`);
  if(edit.id!==null&&(seen.has(edit.id)||a.tasks.cancel.includes(edit.id)))throw Error(`Invalid task identity: ${path}.id: duplicate upsert ID or also listed in tasks.cancel`);
  if(edit.id!==null)seen.add(edit.id);
  const t=edit.task;
  const fleetTask=t?.kind==='return-fleet';
  const fields=['kind',fleetTask?'fleetId':'target','until','reason',...(t?.kind==='transfer'?['source','drillers','priority']:t?.kind==='focus'?['rally']:t?.kind==='capture'?['priority']:t?.kind==='configure'?['priority','minDrillers','maxDrillers','maintain']:[])];
  if(t?.kind==='capture'&&Object.hasOwn(t,'maxDrillersPerPlan'))fields.push('maxDrillersPerPlan');
  fieldsAt(t,fields,path+'.task');
  const invalid=(field:string,expected:string):never=>{throw Error(`Invalid intent task: ${path}.task.${field}: ${expected}`);};
  if(!['avoid','capture','configure','return-fleet','transfer','focus'].includes(t.kind))invalid('kind','expected an allowed task kind');
  if(t.kind==='transfer'){
   if(!posts.has(t.source)||t.source===t.target)invalid('source','expected exact authorized source different from target');
   if(t.drillers!==null&&(!count(t.drillers)||t.drillers===0))invalid('drillers','expected null (current safe available force) or positive integer');
  }
  if(t.kind==='focus'&&(kind!=='commander'||!posts.has(t.rally)))invalid('rally','focus requires commander authority and exact authorized rally post');
  if(!(fleetTask?fleets.has(t.fleetId):posts.has(t.target)))invalid(fleetTask?'fleetId':'target','expected exact authorized reference');
  if(!Number.isFinite(t.until)||t.until<0||t.until>10000000)invalid('until','expected finite absolute world day in [0,10000000]');
  if(typeof t.reason!=='string'||t.reason.length>1500)invalid('reason','expected string of at most 1500 characters');
  if(t.kind==='capture'&&t.maxDrillersPerPlan!==undefined&&t.maxDrillersPerPlan!==null&&!count(t.maxDrillersPerPlan))invalid('maxDrillersPerPlan','expected null or integer in [0,1000000]');
  if(['capture','configure','transfer'].includes(t.kind)&&(!Number.isFinite(t.priority)||t.priority<0||t.priority>100))throw Error(`Invalid task priority: ${path}.task.priority: expected finite number in [0,100]`);
  if(t.kind==='configure'){
   for(const key of ['minDrillers','maxDrillers'])if(t[key]!==null&&!count(t[key]))invalid(key,'expected null or integer in [0,1000000]');
   if(t.minDrillers!==null&&t.maxDrillers!==null&&t.minDrillers>t.maxDrillers)invalid('maxDrillers','must be >= minDrillers');
   if(typeof t.maintain!=='boolean')invalid('maintain','expected boolean');
   if(t.minDrillers===null&&t.maxDrillers===null)invalid('minDrillers','configuration must specify at least one driller bound');
  }
 }
 if(kind==='diplomacy'&&(!a.agreement||!Object.hasOwn(a.agreement,'jointAttack')))throw Error('Missing jointAttack: use null for no genuine joint offensive');
 if(kind==='diplomacy'&&(!a.agreement||!['none','rules','tasks','message','deception'].includes(a.agreement.fulfillment)))throw Error('Missing fulfillment: choose rules, tasks, message, deception or none');
 if(kind==='diplomacy'&&a.agreement.status==='confirmed'&&a.agreement.fulfillment==='none')throw Error('Confirmed agreement requires an explicit fulfillment mode: agreement.fulfillment cannot be none when agreement.status=confirmed');
 if(kind==='diplomacy'&&a.agreement.fulfillment==='rules'&&!a.agreement.forbidAttack&&!a.agreement.forbiddenTargets?.length&&!a.agreement.jointAttack)throw Error('Rules fulfillment requires actual attack restrictions or jointAttack');
 if(kind==='diplomacy'&&a.agreement.fulfillment==='deception'&&a.agreement.jointAttack)throw Error('Deceptive acceptance cannot publish a genuine jointAttack');
 const constraints=kind==='commander'?a.constraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]};
 if(!exact(constraints,['forbiddenPlayers','protectedSources','reserves']))throw Error('Invalid commander constraints');
 const tasks=a.tasks as IntentEdits;
 const normalized=parseAssessment({summary:a.summary,objectives:tasks.upsert.filter(e=>e.task.kind==='capture').map((e,i)=>({id:'intent-'+i,kind:'capture',targets:[(e.task as Extract<IntentSpec,{kind:'capture'}>).target],priority:(e.task as Extract<IntentSpec,{kind:'capture'}>).priority,reason:e.task.reason})),...constraints,reviewOn:a.reviewOn,message:kind==='diplomacy'?a.message:null,agreement:kind==='diplomacy'?a.agreement:{status:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null}},players,posts);
 if(kind==='commander')validateCommanderTransferSources(tasks,normalized.protectedSources);
 const diplomacyAction=a.diplomacyAction==null?null:parseDiplomacyAction(a.diplomacyAction);
 if(diplomacyAction?.kind==='propose-agreement'&&diplomacyAction.terms.kind==='ceasefire'&&!diplomacyAction.terms.outposts.every(id=>posts.has(id)))throw Error('Protocol proposal requires exact authorized outposts');
 if(a.betrayAgreements!==undefined&&(!Array.isArray(a.betrayAgreements)||a.betrayAgreements.length>20||!a.betrayAgreements.every(validId)))throw Error('Invalid explicit betrayal agreement IDs');
 if(a.fulfillAgreementId!==undefined&&a.fulfillAgreementId!==null&&!validId(a.fulfillAgreementId))throw Error('Invalid fulfilment agreement ID');
 return {...normalized,intentEdits:structuredClone(tasks),diplomacyAction,fulfillAgreementId:a.fulfillAgreementId??null,...(a.betrayAgreements!==undefined?{betrayAgreements:a.betrayAgreements}:{})};
}
