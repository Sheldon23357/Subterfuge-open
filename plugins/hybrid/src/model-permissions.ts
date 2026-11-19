import type {AiSnapshot} from '@subterfuge/bot-sdk/contracts/types';
import type {BriefTask} from './brief.js';
import type {HybridState,IntentSpec,StrategicAssessment} from './contracts.js';
import {contextIntents} from './intent-context.js';
import {intentSchemaFor} from './intent-schema.js';
import {modelResponseSchema} from './model-wire.js';
import {currentModelVision} from './model-vision.js';
import {diplomacyEditScope,namedDiplomacyEditScope} from './diplomacy-edit-scope.js';
import {outpostNameIndex} from '@subterfuge/bot-sdk/presentation/outpost-references';

type Schema=Record<string,any>;
export interface TaskPermission {
 kind:IntentSpec['kind'];targets?:string[];sources?:string[];rallies?:string[];fleetIds?:string[];
}
export interface ModelPermissions {
 version:'hybrid-permissions/1';worldDay:number;kind:BriefTask['kind'];
 maxTasks:number;maxCancel:number;editableTaskIds:string[];cancelTaskIds:string[];tasks:TaskPermission[];
 visibleOutposts:string[];protectedSources:string[];reserveSources:string[];
 betrayalAgreementIds:string[];fulfillmentAgreementIds:string[];
 diplomacy:{actions:string[];peer:number|null;enemies:number[];ceasefireOutposts:string[];subsidyPayers:number[];
  counterTo:string[];responses:{agreementId:string;actions:string[]}[];signedAcceptAgreementIds:string[]};
}
const closed=(status:string)=>['completed','cancelled','expired'].includes(status);
const resolve=(s:Schema|undefined,root:Schema):Schema=>s?.$ref?.startsWith('#/$defs/')?root.$defs[s.$ref.slice(8)]:s??{};
function enums(s:Schema|undefined,root:Schema):any[]{
 const value=resolve(s,root);return value.enum??value.anyOf?.flatMap((v:Schema)=>enums(v,root))??[];
}

/** One authority source for both the model's changing permission catalog and
 * the host's captured/publication checks. No planning or model calls occur. */
export function modelAuthorization(task:BriefTask,snapshot:Readonly<AiSnapshot>,saved:HybridState){
 const o=snapshot.observation,v=o.view,vision=currentModelVision(o),visibleIds=new Set(vision.view.outposts.map(p=>p.id));
 const names=outpostNameIndex(o),name=(id:string)=>names.byId.get(id)??id,now=v.tick+o.secondsSinceLastTick/600;
 const intents=contextIntents(saved,now),active=intents.filter(t=>!closed(t.status));
 const conversationIdentities=task.players.map(chatPlayer=>({chatPlayer,gamePlayer:snapshot.roster!==undefined
  ?snapshot.roster.find(r=>r.chatPlayer===chatPlayer)?.gamePlayer??null
  :snapshot.chatPlayer===v.player&&chatPlayer>=0&&chatPlayer<v.playerCount?chatPlayer:null}));
 const peers=conversationIdentities.map(p=>p.gamePlayer).filter((p):p is number=>p!==null&&p!==v.player);
 const editScope=task.kind==='diplomacy'&&o.diplomacy?diplomacyEditScope(o,intents,task.scope,peers):undefined;
 const modelEditScope=editScope?{...editScope,friendlyTargets:editScope.friendlyTargets.filter(id=>visibleIds.has(id)),contracts:editScope.contracts.map(c=>({...c,captureTargets:c.captureTargets.filter(id=>visibleIds.has(id)),avoidTargets:c.avoidTargets.filter(id=>visibleIds.has(id))}))}:undefined;
 const editableIds=editScope?new Set(editScope.contracts.flatMap(c=>c.editableTaskIds)):undefined;
 const visiblePosts=vision.view.outposts.filter(p=>!p.destroyed).map(p=>name(p.id)),friendly=vision.view.outposts.filter(p=>p.owner===v.player&&!p.destroyed).map(p=>name(p.id));
 const server=task.kind==='diplomacy'&&o.diplomacy?{
  self:v.player,peers,enemies:o.intel.filter(p=>p.active&&p.player!==v.player&&!peers.includes(p.player)).map(p=>p.player),
  agreements:o.diplomacy.agreements.filter(a=>a.status!=='proposed'||a.deadline>now),
  ceasefirePosts:vision.view.outposts.filter(p=>!p.destroyed&&(p.owner===v.player||p.owner!==undefined&&p.owner!==null&&peers.includes(p.owner))).map(p=>name(p.id)),
 }:undefined;
 const authorizationSchema=modelResponseSchema(intentSchemaFor(task.kind,visiblePosts,
  active.filter(t=>editableIds?editableIds.has(t.id):task.kind==='commander'||t.authority!=='commander').map(t=>t.id),
  v.fleets.filter(f=>f.owner===v.player&&f.canReturn===true).map(f=>f.id),server),{
  activeAgreementIds:editScope?.contracts.map(c=>c.agreementId),friendlyPosts:friendly,
  ...(modelEditScope?{diplomacyScope:namedDiplomacyEditScope(modelEditScope,name)}:{}),
 });
 const properties=authorizationSchema.properties,variants:Schema[]=properties.tasks.maxItems===0?[]:properties.tasks.items.anyOf??[];
 const taskPermissions:TaskPermission[]=variants.map(variant=>{
  const p=variant.properties,kind=p.kind.enum[0] as IntentSpec['kind'];
  return {kind,...(p.target?{targets:enums(p.target,authorizationSchema)}:{}),...(p.source?{sources:enums(p.source,authorizationSchema)}:{}),
   ...(p.rally?{rallies:friendly}:{}),...(p.fleetId?{fleetIds:enums(p.fleetId,authorizationSchema)}:{})};
 });
 const peer=peers.length===1?peers[0]!:null;
 const pending=peer===null?[]:(server?.agreements??[]).filter(a=>a.status==='proposed'&&a.players.includes(v.player)&&a.players.includes(peer));
 const permissions:ModelPermissions={version:'hybrid-permissions/1',worldDay:now,kind:task.kind,
  maxTasks:properties.tasks.maxItems,maxCancel:properties.cancel.maxItems,
  editableTaskIds:[...new Set(variants.flatMap(s=>enums(s.properties.id,authorizationSchema)).filter(id=>typeof id==='string'))],
  cancelTaskIds:enums(properties.cancel.items,authorizationSchema),tasks:taskPermissions,
  visibleOutposts:visiblePosts,protectedSources:task.kind==='commander'?visiblePosts:[],reserveSources:task.kind==='commander'?visiblePosts:[],
  betrayalAgreementIds:task.kind==='commander'?[]:(o.diplomacy?.agreements??[]).filter(a=>a.status==='active'&&a.deadline>now&&a.players.includes(v.player)).map(a=>a.id),
  fulfillmentAgreementIds:editScope?.contracts.map(c=>c.agreementId)??[],
  diplomacy:{actions:server?enums(properties.action,authorizationSchema).filter(v=>typeof v==='string'):['none'],peer,
   enemies:server?.enemies??[],ceasefireOutposts:server?.ceasefirePosts??[],subsidyPayers:server&&peer!==null?[v.player,peer]:[],
   counterTo:pending.filter(a=>a.players[1]===v.player).map(a=>a.id),
   responses:pending.map(a=>({agreementId:a.id,actions:a.players[1]===v.player?['accept','reject']:['withdraw']})),
   signedAcceptAgreementIds:server?.agreements.filter(a=>a.status==='active'&&a.deadline>now&&a.players[1]===v.player&&a.players[0]===peer).map(a=>a.id)??[]},
 };
 return {permissions,authorizationSchema,vision,visibleIds,names,intents,peers,conversationIdentities,editScope,modelEditScope,editableIds};
}

/** Normalized executor values are checked against the exact captured catalog,
 * then independently checked against current authority immediately before any
 * publication. A valid JSON shape never grants a game or task capability. */
export class ModelPermissionDenied extends Error {
 constructor(readonly path:string){super('Model permission denied: '+path+' is outside the current authorized scope');}
}
export function assertModelPermissions(a:StrategicAssessment,p:ModelPermissions,names:Readonly<Record<string,string>>={},allowSignedAccept=false){
 const fail=(path:string):never=>{throw new ModelPermissionDenied(path);};
 const name=(id:string)=>names[id]??id,contains=(values:readonly string[]|undefined,id:string,path:string)=>{if(!values?.includes(id))fail(path);};
 const edits=a.intentEdits??{upsert:[],cancel:[]};
 if(edits.upsert.length>p.maxTasks)fail('tasks');if(edits.cancel.length>p.maxCancel)fail('cancel');
 for(const id of edits.cancel)contains(p.cancelTaskIds,id,'cancel:'+id);
 for(const [i,edit]of edits.upsert.entries()){
  const path='tasks['+i+']',task=edit.task,option=p.tasks.find(t=>t.kind===task.kind);
  if(!option)fail(path+'.kind');
  if(edit.id!==null)contains(p.editableTaskIds,edit.id,path+'.id');
  if(task.until<=p.worldDay)fail(path+'.until');
  if('target'in task)contains(option!.targets,name(task.target),path+'.target');
  if('source'in task)contains(option!.sources,name(task.source),path+'.source');
  if('rally'in task)contains(option!.rallies,name(task.rally),path+'.rally');
  if('fleetId'in task)contains(option!.fleetIds,task.fleetId,path+'.fleetId');
 }
 for(const id of a.protectedSources)contains(p.protectedSources,name(id),'protectedSources');
 for(const r of a.reserves)contains(p.reserveSources,name(r.source),'reserves.source');
 for(const id of a.agreement.forbiddenTargets)contains(p.visibleOutposts,name(id),'agreement.forbiddenTargets');
 for(const id of a.betrayAgreements??[])contains(p.betrayalAgreementIds,id,'betrayAgreements');
 if(a.fulfillAgreementId!=null)contains(p.fulfillmentAgreementIds,a.fulfillAgreementId,'fulfillAgreementId');
 const action=a.diplomacyAction;if(!action)return;
 if(p.kind!=='diplomacy')fail('diplomacyAction');
 if(action.kind==='propose-agreement'){
  if(!p.diplomacy.actions.includes(action.terms.kind)||action.peer!==p.diplomacy.peer)fail('diplomacyAction.peer/terms');
  if(action.terms.kind==='ceasefire'){
   if(action.terms.outposts.length>80)fail('diplomacyAction.outposts.length');
   for(const id of action.terms.outposts)contains(p.diplomacy.ceasefireOutposts,name(id),'diplomacyAction.outposts');
  }
  else if(!p.diplomacy.enemies.includes(action.terms.enemy))fail('diplomacyAction.enemy');
  if(action.counterTo!=null)contains(p.diplomacy.counterTo,action.counterTo,'diplomacyAction.counterTo');
  if(action.subsidy&&!p.diplomacy.subsidyPayers.includes(action.subsidy.payer))fail('diplomacyAction.subsidy.payer');
 }else{
  if(allowSignedAccept&&action.response==='accept'&&p.diplomacy.signedAcceptAgreementIds.includes(action.agreementId))return;
  const proposal=p.diplomacy.responses.find(r=>r.agreementId===action.agreementId);
  if(!proposal?.actions.includes(action.response))fail('diplomacyAction.agreementId/response');
 }
}
