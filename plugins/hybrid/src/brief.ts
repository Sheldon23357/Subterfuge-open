import type {AiSnapshot,AiState} from '@subterfuge/bot-sdk/contracts/types';
import {mineLossCost} from '@subterfuge/bot-sdk/analysis/mine-strategy';
import {scheduledCommitments} from '@subterfuge/bot-sdk/analysis/scheduled-commitments';
import {mineHoldingAssessment} from '@subterfuge/bot-sdk/analysis/mine-strategy';
import {openingExpansion} from '@subterfuge/bot-sdk/analysis/opening-expansion';
import type {HybridState,SituationBrief,OperationState} from './contracts.js';
import {intentFeasibility} from './intent-feasibility.js';
import {basisOf,HYBRID_PROMPT_CHARACTERS} from './contracts.js';
import {namedBrief,mentionedOutposts} from './model-names.js';
import {effectiveAgreement} from './agreement-active.js';
import {pressureBrief} from './pressure-brief.js';
import {hybridPlanning} from './planning.js';
import {constraints} from './operations.js';
import {projectModelBrief} from './brief-projection.js';
import {fixedModelResponseSchema} from './model-wire.js';
import {jointSigningAssessment} from './joint-signing.js';
import {ceasefireMaterial} from './ceasefire.js';
import {modelAuthorization} from './model-permissions.js';
import {hybridBriefPrompt} from './prompts.js';
import {diplomacyContext} from './diplomacy-context.js';
import {relationAdvice} from './relation-policy.js';
import {projectContextForModel} from './model-context.js';
import {receiptContext} from './receipt-context.js';
import {selectRoundMaterials,type MaterialSeed} from './round-material.js';
import {prepareModelMaterial,prepareModelReferences} from './model-material.js';
import {presentModelNumbers} from './model-numbers.js';
import {visibleModelBrief,filterOutsideModelFeedback} from './model-vision.js';
import {readPromptSections} from '@subterfuge/bot-sdk/contracts';
export interface BriefTask {triggers?:{kind:string;reason:string;entities:string[]}[];pressureOnly?:boolean;diplomacyPurpose?:{needs:import('./contracts.js').DiplomacyNeed[];role:string};id:string;kind:SituationBrief['kind'];scope:string;posts:string[];messageIds:string[];players:number[];validationError?:string;commanderPart?:{index:number;count:number;text:string}}
/** Chunk boundaries are explicit in the task. No tail is silently truncated. */
export function makeBrief(task:BriefTask,s:Readonly<AiState>,snapshot:Readonly<AiSnapshot>,saved:HybridState,feedback?:unknown,operations:OperationState[]=[],renderPrompt:typeof hybridBriefPrompt=hybridBriefPrompt) {
 task={...task,posts:[...new Set(task.posts)],messageIds:[...new Set(task.messageIds)],players:[...new Set(task.players)]};
 // Only identical records are redundant. Distinct message IDs or changed prose remain intact.
 const o=snapshot.observation,v=o.view,messages=[...new Map(saved.chat.filter(m=>task.messageIds.includes(m.id)).map(m=>[JSON.stringify(m),m])).values()];
 const authorization=modelAuthorization(task,snapshot,saved);
 const {vision,visibleIds,names,intents,peers,editScope,editableIds}=authorization;
 const roundTriggers=[...new Map([...(snapshot.task?.triggers??[]).map(t=>({kind:t.kind,reason:t.reason,entities:t.entities})),...(task.triggers??[])].map(t=>[JSON.stringify(t),t])).values()];
 const receiptMaterial=receiptContext(o,saved,task);
 const selected=new Set([...task.posts,...messages.flatMap(m=>mentionedOutposts(m.text,o))]);
 if(task.kind!=='diplomacy')for(const t of intents)if('target'in t.spec&&!['completed','cancelled','expired'].includes(t.status))selected.add(t.spec.target);
 if(task.kind==='diplomacy')for(const t of intents)if(t.origin?.conversation===task.scope&&t.spec.kind==='capture'&&!['completed','cancelled','expired'].includes(t.status))selected.add(t.spec.target);
 const commanderText=s.commanderDirectives?.text??'';
 for(const id of [...roundTriggers.flatMap(t=>t.entities),...(task.diplomacyPurpose?.needs??[]).flatMap(n=>n.targets),...mentionedOutposts(commanderText,o)])if(v.outposts.some(p=>p.id===id))selected.add(id);
 const opponents=(snapshot.roster??[]).filter(p=>typeof p.displayName==='string'&&commanderText.includes(p.displayName)).map(p=>p.gamePlayer);
 const dialoguePeers=peers;
 const contractEnemies=(o.diplomacy?.agreements??[]).filter(a=>a.status==='active'&&a.terms.kind==='joint-attack'&&a.players.some(p=>p!==v.player&&dialoguePeers.includes(p))&&!a.fulfilled[a.players.indexOf(v.player)]).flatMap(a=>a.terms.kind==='joint-attack'?[a.terms.enemy]:[]);
 const planning=hybridPlanning(o,[...selected,...(task.kind==='diplomacy'?[]:intents.filter(t=>['pending','running','blocked'].includes(t.status)&&'target' in t.spec).map(t=>(t.spec as {target:string}).target))],task.kind==='diplomacy'?contractEnemies:opponents);
 // Diplomacy keeps the common attack shortlist plus conversation targets; unrelated commander targets stay in strategic review.
 if(task.kind==='diplomacy'&&feedback&&typeof feedback==='object'){
  const f=feedback as Record<string,unknown>;feedback=task.diplomacyPurpose?.needs.length?null:{basis:f.basis,selected:f.selected,coverage:f.coverage,limitations:f.limitations};
 }
 const materialSeeds:MaterialSeed[]=[...task.posts.map(entity=>({entity,reason:'round-scope' as const}))];
 const operationRoots=new Set([...materialSeeds.map(seed=>seed.entity),...roundTriggers.flatMap(t=>t.entities),...(task.diplomacyPurpose?.needs??[]).flatMap(n=>n.targets),...messages.flatMap(m=>mentionedOutposts(m.text,o)),...mentionedOutposts(commanderText,o)]);
 const relevantTasks=intents.filter(t=>!['completed','cancelled','expired'].includes(t.status)&&(!editableIds||editableIds.has(t.id))&&(operationRoots.has(t.id)||t.spec.kind==='return-fleet'||['target','source','rally'].some(key=>operationRoots.has((t.spec as any)[key]))));
 const relevantTaskIds=new Set(relevantTasks.map(t=>t.id));
 for(const operation of operations)if(operation.intentBindings?.some(b=>relevantTaskIds.has(b.id)))for(const entity of operation.fleets)materialSeeds.push({entity,reason:'linked-operation'});
 for(const candidate of planning.candidates)selected.add(candidate.target);
 const own=v.outposts.filter(p=>p.owner===v.player&&!p.destroyed),posts=v.outposts.filter(p=>selected.has(p.id));
 const relevantSources=new Set([...selected,...planning.candidates.flatMap(c=>c.launchSources.map(s=>s.source))]);
 const economicOwn=own;
 if(task.kind==='diplomacy')planning.estimates.forceSources.rows=planning.estimates.forceSources.rows.filter(row=>relevantSources.has(String(row[0])));
 planning.estimates.forceSources.coverage.listed=planning.estimates.forceSources.rows.length;
 const mining=mineHoldingAssessment(o),commitments=new Map(scheduledCommitments(o).map(c=>[c.source,c]));
 const ownIds=new Set(own.map(p=>p.id));
 const inbound=v.fleets.filter(f=>f.owner!==v.player&&!f.gift&&f.destination?.kind==='outpost'&&ownIds.has(f.destination.id));
 const economic=economicOwn.map(p=>{const c=commitments.get(p.id),available=p.drillers===undefined||c?.unknownSchedules.length?null:Math.max(0,p.drillers-(c?.drillers??0));return [p.id,p.type,p.drillers??null,p.shield??null,available,p.type==='mine'||p.minePending?null:available===null?null:Math.max(0,v.self.mineCreationCost-available),[Math.floor(p.position.x/5),Math.floor(p.position.y/5)]];});
 const terminal=(t:NonNullable<HybridState['intents']>[number])=>['completed','cancelled','expired'].includes(t.status);
 const visibleIntents=[...intents.filter(t=>!terminal(t)),...intents.filter(terminal).slice(-6)];
 const editableAgreements=editScope?.contracts.map(c=>c.agreementId);
 let brief:SituationBrief={format:'hybrid-brief/1',basis:basisOf(o,s.commanderDirectives?.version??0),kind:task.kind,scope:task.scope,
  global:{time:{worldDay:v.tick+o.secondsSinceLastTick/600,ruleSecondsPerWorldDay:600,publicIncomePeriodWorldDays:144,meaning:'intel.npPerDay是144世界日的静态收入；下列ETA假设收入与领土持续不变，不保证实际胜利'},match:v.match,self:v.self,players:{columns:['player','active','neptunium','npPerDay','numOutposts','drillers','drillerRate','staticVictoryWorldDays','currentLossIfMineCaptured'],rows:o.intel.map(p=>[p.player,p.active,p.neptunium,p.npPerDay,p.numOutposts,p.drillers,p.drillerRate,v.match?.mode==='mining'&&p.npPerDay>0?144*Math.max(0,v.match.neptuniumGoal-p.neptunium)/p.npPerDay:null,mineLossCost(p.neptunium)])},ownOutposts:own.length,visiblePosts:v.outposts.filter(p=>p.visibility===2).length,mining:mining?{balance:mining.balance,mineCount:mining.mineCount,oneLossCost:mining.oneLossCost,totalLocalShortfall:mining.totalLocalShortfall,staticVictoryWorldDays:mining.staticVictoryWorldDays}:null,criticalAssets:{mines:own.filter(p=>p.type==='mine'||p.minePending).map(p=>({id:p.id,drillers:p.drillers??null,shield:p.shield??null,minePending:p.minePending})),hostileApproaches:inbound.map(f=>({id:f.id,owner:f.owner,destination:f.destination,drillers:f.drillers,state:f.state})),coverage:'全部当前授权的己方矿场、在建矿场及可见敌方来袭；不推断未知航程或敌人未来命令'},economy:{mineCreation:{resource:'drillers',amount:v.self.mineCreationCost,paymentLocation:'建矿据点',neptuniumIsPayment:false},columns:['id','type','drillers','shield','availableAfterAcceptedSchedules','minePaymentShortfall','region'],ownPosts:economic,coverage:{listed:economicOwn.length,total:own.length},interpretation:'available只扣已接受预约，不等于安全可调兵量；null为未知。支付兵力可集结但航程、防守与持续持有由战术程序验证'},ownFleets:v.fleets.filter(f=>f.owner===v.player).map(f=>({id:f.id,owner:f.owner,drillers:f.drillers,state:f.state,source:f.source,destination:f.destination,canReturn:f.canReturn??null,returned:f.returned??null})),planning,roster:snapshot.roster,identities:v.outposts.map(p=>[p.id,o.outpostNames?.[p.id],p.owner,p.visibility,p.type??null,p.drillers??null,p.shield??null]),feedback,commanderVersion:s.commanderDirectives?.version??0},
  facts:{validationError:task.validationError,coverage:{selected:posts.length,total:v.outposts.length,scope:task.scope},outposts:posts.filter(p=>!ownIds.has(p.id)).map(p=>({id:p.id,name:o.outpostNames?.[p.id],owner:p.owner,type:p.type,region:[Math.floor(p.position.x/5),Math.floor(p.position.y/5)],drillers:p.drillers,shield:p.shield,production:p.metrics?{output:p.metrics.output,cycleMinutes:p.metrics.cycleMinutes}:undefined})),fleets:{columns:['id','owner','drillers','state','source','destinationKind','destinationId'],rows:v.fleets.filter(f=>f.owner!==v.player).map(f=>[f.id,f.owner,f.drillers,f.state,f.source??null,f.destination?.kind??null,f.destination?.id??null])},scheduled:o.scheduled.filter(q=>task.posts.some(id=>JSON.stringify(q).includes(JSON.stringify(id))))},
  changes:{triggers:roundTriggers,activity:{columns:['id','kind','tick','subject','source','destination','arrival','termination'],rows:o.activity?.filter(e=>selected.has(e.subject)||selected.has(e.source??'')||selected.has(e.destination?.id??'')).map(e=>[e.id,e.kind,e.tick,e.subject,e.source,e.destination,e.arrival??null,e.termination??null])}},
  guidance:{intentTasks:visibleIntents.filter(t=>!terminal(t)).map(t=>({id:t.id,authority:t.authority,originConversation:t.origin?.conversation??null,originAgreementId:t.origin?.agreementId??null,spec:Object.fromEntries(Object.entries(t.spec).filter(([key])=>key!=='reason')),status:t.status,reason:t.reason})),recentResults:visibleIntents.filter(terminal).map(t=>({id:t.id,kind:t.spec.kind,status:t.status,reason:t.reason})),reusableTaskIds:intents.filter(t=>t.origin?.conversation===task.scope&&!terminal(t)).map(t=>t.id),intentCoverage:{active:intents.filter(t=>!terminal(t)).length,terminalListed:visibleIntents.filter(terminal).length,terminalTotal:intents.filter(terminal).length},fulfillment:saved.messages.filter(m=>m.conversation===task.scope&&['blocked','staged'].includes(m.fulfillment?.state??'')).map(m=>({status:m.fulfillment!.state,reason:m.fulfillment!.reason,proposedTasks:m.intentEdits})),fixedConversation:{scope:task.scope,chatPlayers:task.players,identities:authorization.conversationIdentities},diplomacyPurpose:task.diplomacyPurpose?{role:task.diplomacyPurpose.role,needs:pressureBrief(task.diplomacyPurpose.needs)}:null,conversation:saved.conversations?.[task.scope]??null,strategic:saved.directive?{summary:saved.directive.summary,...(task.kind==='diplomacy'?{}:{reviewOn:saved.directive.reviewOn.slice(0,4)})}:null,executionRules:constraints(saved.directive,o,saved),agreements:saved.directive?.agreements.filter(a=>effectiveAgreement(a,v.tick+o.secondsSinceLastTick/600)).map(a=>({conversation:a.conversation,players:a.players,status:a.status,jointAttack:a.jointAttack??null,forbidAttack:a.forbidAttack,forbiddenTargets:a.forbiddenTargets,expiresWorldDay:a.expiresWorldDay,...(task.kind==='diplomacy'&&a.conversation===task.scope?{summary:a.summary,internalIntent:a.internalIntent}:{} )})),commander:task.commanderPart??(s.commanderDirectives?.text?{text:s.commanderDirectives.text}:null)},
  evidence:{coverage:{raw:task.messageIds.length,covered:task.messageIds.length},messages,notificationIds:snapshot.notifications.filter(n=>selected.has(n.location?.id??'')).map(n=>n.id),pendingWrites:snapshot.executionLedger?.pending.map(p=>p.id)},unknowns:['未观察到的据点、驻军和敌人未来命令未知','静态收入不是未来获胜保证','本任务为显式局部范围，未列出区域没有经过本任务评估']};
 const g=brief.global as Record<string,any>,guidance=brief.guidance as Record<string,any>;
 guidance.executionFeasibility=intentFeasibility(o,saved,planning,operations,editableIds);
 if(o.diplomacy){
  guidance.agreements=[];
  g.relations={observedAt:o.diplomacy.time,values:o.diplomacy.relations,competition:o.diplomacy.competition};
  guidance.serverAgreements=o.diplomacy.agreements;
  if(editScope)guidance.editPolicy={...editScope,militaryEditsAllowed:editScope.contracts.length>0,eligibleAgreementIds:editableAgreements,meaning:editableAgreements?.length===1?'程序已绑定唯一合同，fulfillAgreementId可省略；只编辑该合同列出的任务及目标':'只编辑所列当前会话合同的任务及目标；多份合同时显式选择精确fulfillAgreementId，无合同时tasks与cancel必须为空'};
  guidance.relationAdvice=relationAdvice(o);
  if(task.kind==='diplomacy')guidance.jointSigningAssessment=jointSigningAssessment(o,planning,authorization.peers,guidance.executionRules);
  if(task.kind==='diplomacy')guidance.ceasefireSigningAssessment=ceasefireMaterial(o,authorization.peers,saved,operations);
  guidance.contractGoals=o.diplomacy.agreements.filter(a=>a.status==='active').map(a=>{
   const i=a.players.indexOf(v.player);
   return {agreementId:a.id,kind:a.terms.kind,peer:a.players[1-i],deadline:a.deadline,
    ...(a.terms.kind==='ceasefire'?{outposts:a.terms.outposts}:{enemy:a.terms.enemy,captureGoal:1,progress:a.progress[i],fulfilled:a.fulfilled[i]}),
    subsidySettled:a.startedAt!==null&&a.subsidy!==null};
  });
  guidance.contractResults=receiptMaterial.records;
  guidance.receiptCoverage=receiptMaterial.coverage;
 }
 // Advice is approximate; bounded precision avoids presenting numerical noise as certainty.
 const estimate=(n:number|null)=>n===null?null:Math.round(n*1000)/1000;
 g.planning={...planning,candidates:{columns:['target','owner','classification','score','attackWorldDays','suggestedUntil','additionalForceEstimate','launchSources','reasons','newForceForScreenedAttackEstimate','assessment'],rows:planning.candidates.map(c=>[c.target,c.owner,c.classification,estimate(c.score),estimate(c.attackWorldDays),c.attackWorldDays===null?null:estimate(v.tick+o.secondsSinceLastTick/600+c.attackWorldDays+24),estimate(c.additionalForceEstimate),{columns:['source','availableEstimate','travelWorldDays'],rows:c.launchSources.map(s=>[s.source,estimate(s.availableEstimate),estimate(s.travelWorldDays)])},c.reasons,c.newForceForScreenedAttackEstimate,c.assessment])}};
 if(task.kind!=='commander'){
  const sources=g.planning.estimates.forceSources;
  sources.columns.push('type');for(const row of sources.rows)row.push(v.outposts.find(p=>p.id===row[0])?.type??null);
 }
 g.ownFleets={columns:['id','owner','drillers','state','source','destination','canReturn','returned'],rows:g.ownFleets.map((f:any)=>[f.id,f.owner,f.drillers,f.state,f.source??null,f.destination??null,f.canReturn,f.returned])};
 guidance.intentTasks={columns:['id','authority','originConversation','originAgreementId','kind','target','fleetId','until','priority','maxDrillersPerPlan','configuration','status','reason','source','drillers','rally'],rows:guidance.intentTasks.map((t:any)=>[t.id,t.authority,t.originConversation,t.originAgreementId,t.spec.kind,t.spec.target??null,t.spec.fleetId??null,t.spec.until,t.spec.priority??null,t.spec.maxDrillersPerPlan??null,t.spec.kind==='configure'?{minDrillers:t.spec.minDrillers,maxDrillers:t.spec.maxDrillers,maintain:t.spec.maintain}:null,t.status,t.reason??null,t.spec.source??null,t.spec.drillers??null,t.spec.rally??null])};
 guidance.recentResults={columns:['id','kind','status','reason'],rows:guidance.recentResults.map((t:any)=>[t.id,t.kind,t.status,t.reason])};
 if(snapshot.roster)g.roster={columns:['gamePlayer','chatPlayer','name'],rows:snapshot.roster.map(r=>[r.gamePlayer,r.chatPlayer,r.displayName])};
 const conversationAgreement=saved.directive?.agreements.find(a=>a.conversation===task.scope);
 const currentAgreement=!o.diplomacy&&conversationAgreement&&effectiveAgreement(conversationAgreement,v.tick+o.secondsSinceLastTick/600)?conversationAgreement:undefined;
 if(conversationAgreement&&!currentAgreement)guidance.conversation=null;
 if(currentAgreement)guidance.conversation={archived:guidance.conversation?.archived??0,meaning:'当前会话认知由下列协议摘要与内部真实意图承接，未处理原文仍完整提供'};
 const opening=openingExpansion(o);
 if(opening.active){
  const targets=[...new Map([...opening.targets.filter(t=>selected.has(t.id)),...opening.targets.filter(t=>opening.uncoveredHome.includes(t.id)),...opening.targets].map(t=>[t.id,t])).values()].slice(0,12);
  brief.global={...(brief.global as Record<string,unknown>),opening:{basis:opening.basis,untilWorldDay:opening.untilWorldDay,uncoveredHome:opening.uncoveredHome,
   coverage:{total:opening.targets.length,listed:targets.length},columns:['id','zone','ownSource','rivalPlayer','rivalSource','ownDistance','rivalDistance','claimForce','competitionForce','friendlyIncoming','hostileIncoming','covered'],
   rows:targets.map(t=>[t.id,t.zone,t.ownSource,t.rivalPlayer,t.rivalSource,t.ownDistance,t.rivalDistance,t.claimForce,t.competitionForce,t.friendlyIncoming,t.hostileIncoming,t.covered]),unknowns:opening.unknowns,interpretation:opening.interpretation}};
 }
 const named=projectModelBrief(namedBrief(brief,o));
 brief=diplomacyContext(named,new Set(saved.handledMessages??[]));
 const visible=visibleModelBrief(named,o,selected),modelBase=diplomacyContext(visible.brief,new Set(saved.handledMessages??[]));
 const selection=selectRoundMaterials(modelBase,materialSeeds.map(seed=>({...seed,entity:names.byId.get(seed.entity)??seed.entity})));
 const model=projectContextForModel(modelBase,selection.focus,selection);
 filterOutsideModelFeedback(model.brief,o);
 (model.brief.facts as Record<string,unknown>).permissions=authorization.permissions;
 const canonicalSchema=fixedModelResponseSchema(task.kind,!!o.diplomacy);
 const commanderNumbers=task.kind==='commander'?presentModelNumbers(model.brief):undefined;
 const material=commanderNumbers?{...prepareModelReferences(commanderNumbers.value,canonicalSchema),deduplicated:[] as string[],excluded:[],numericPresentation:commanderNumbers.changes}:prepareModelMaterial(model.brief,canonicalSchema);
 const responseSchema=material.responseSchema;
 const prompt=renderPrompt(task.kind,!!o.diplomacy,opening.active,editableAgreements?.length===0,material.brief,responseSchema);
 const sectionCharacters=Object.fromEntries(readPromptSections(prompt)!.filter(s=>s.id.startsWith('brief.')).map(s=>[s.id.slice(6),s.text.length]));
 if(prompt.length>HYBRID_PROMPT_CHARACTERS)throw Object.assign(Error(task.kind==='diplomacy'?'完整外交材料超过上下文上限，已阻塞；未处理来信原文保留，不进行拆分或摘要合并':'BRIEF_REQUIRES_SPLIT'),{characters:prompt.length,sections:sectionCharacters});
 return {brief:{...brief,basis:basisOf(o,s.commanderDirectives?.version??0)},modelBrief:material.brief,prompt,responseSchema,modelReferences:material.references,permissions:authorization.permissions,contextPosts:[...selected],receiptDelivery:receiptMaterial.delivery,receiptScope:receiptMaterial.key,contextSelection:{version:'round-material/9',visibility:{rule:'current-visibility-2',visibleOutposts:visibleIds.size,omittedOutposts:v.outposts.filter(p=>!visibleIds.has(p.id)).map(p=>p.id)},focus:[...selection.focus],expanded:model.selection.expanded,summarizedFleets:model.omittedFleetIds,summarizedOutposts:model.omittedOutpostNames,deduplicated:material.deduplicated,excluded:material.excluded,numericPresentation:material.numericPresentation,sectionCharacters,promptCharacters:prompt.length}};
}
export function splitTask(task:BriefTask):BriefTask[] {
 if(task.kind==='diplomacy')throw Error('外交必须通过完整请求预算预检，不能拆分后合并');
 const split=(values:string[],key:'posts'|'messageIds')=>{const n=Math.ceil(values.length/2);return [values.slice(0,n),values.slice(n)].map((v,i)=>({...task,id:task.id+'-'+i,scope:task.kind==='diplomacy'?task.scope:task.scope+'/'+i,[key]:v}));};
 if(task.messageIds.length>1)return split(task.messageIds,'messageIds');
 if(task.posts.length>1)return split(task.posts,'posts');
 throw Error('必要单条材料超过上下文上限，保留任务并等待输入调整');
}
