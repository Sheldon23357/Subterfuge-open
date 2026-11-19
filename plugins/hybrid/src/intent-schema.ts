import {assessmentSchema} from './assessment.js';
import type {SituationBrief} from './contracts.js';
import type {PlayerDiplomacy} from '@subterfuge/bot-sdk/rules';
import {DIPLOMACY_RULES} from '@subterfuge/bot-sdk/rules';
export const DEFAULT_INTENT_PRIORITY=50;
export const intentDefaults={
 result:{summary:'',tasks:{upsert:[],cancel:[]},reviewOn:[]},
 edits:{upsert:[],cancel:[]},edit:{id:null},task:{reason:''},
 configuration:{minDrillers:null,maxDrillers:null,maintain:false},
 agreement:{status:'none',fulfillment:'none',summary:'',forbidAttack:false,forbiddenTargets:[],internalIntent:'',expiresWorldDay:null,jointAttack:null},
 constraints:{forbiddenPlayers:[],protectedSources:[],reserves:[]},
};
const text={type:'string',maxLength:1500},id={type:'string',minLength:1,maxLength:120};
const object=(properties:Record<string,unknown>,defaults:Record<string,unknown>={})=>({type:'object',additionalProperties:false,required:Object.keys(properties).filter(k=>!Object.hasOwn(defaults,k)),properties});
const nullable=(value:unknown)=>({anyOf:[value,{type:'null'}]});
const integer={type:'integer',minimum:0,maximum:1000000};
export interface ServerDiplomacySchema {self:number;peers:number[];enemies:number[];ceasefirePosts:string[];agreements:PlayerDiplomacy['agreements']}
function buildIntentSchema(kind:SituationBrief['kind'],posts:readonly string[],taskIds:readonly string[]=[],fleets:readonly string[]=[],server?:ServerDiplomacySchema,fixed=false):Record<string,any>{
 const target=posts.length?{...id,enum:[...posts]}:id;
 const common={target,until:{type:'number',minimum:0,maximum:10000000},reason:text};
 const priority={type:'number',minimum:0,maximum:100};
 const captureLimit={maxDrillersPerPlan:nullable(integer)};
 const spec={anyOf:[object({kind:{type:'string',enum:['avoid']},...common},intentDefaults.task),object({kind:{type:'string',enum:['capture']},...common,priority,...captureLimit},{...intentDefaults.task,priority:DEFAULT_INTENT_PRIORITY,maxDrillersPerPlan:null}),object({kind:{type:'string',enum:['configure']},...common,priority,minDrillers:nullable(integer),maxDrillers:nullable(integer),maintain:{type:'boolean'}},{...intentDefaults.task,...intentDefaults.configuration,priority:DEFAULT_INTENT_PRIORITY})]};
 spec.anyOf.push(object({kind:{type:'string',enum:['transfer']},...common,source:target,drillers:nullable(integer),priority},{...intentDefaults.task,priority:DEFAULT_INTENT_PRIORITY}) as any);
 if(kind==='commander')spec.anyOf.push(object({kind:{type:'string',enum:['focus']},...common,rally:target},intentDefaults.task) as any);
 if(fixed||fleets.length)for(const action of ['return-fleet'])spec.anyOf.push(object({kind:{type:'string',enum:[action]},fleetId:fixed?id:{...id,enum:[...fleets]},until:common.until,reason:text},intentDefaults.task) as any);
 const existing=fixed?id:taskIds.length?{...id,enum:[...taskIds]}:{type:'null'};
 const properties:Record<string,unknown>={summary:text,tasks:object({upsert:{type:'array',maxItems:12,items:object({id:fixed||taskIds.length?nullable(existing):existing,task:spec},intentDefaults.edit)},cancel:{type:'array',maxItems:fixed||taskIds.length?12:0,items:existing}},intentDefaults.edits),reviewOn:{type:'array',maxItems:16,items:id}};
 if(kind==='diplomacy'){properties.message=nullable(text);properties.agreement=object({...assessmentSchema.properties.agreement.properties,forbiddenTargets:{type:'array',maxItems:80,items:target},expiresWorldDay:nullable({type:'number',minimum:0})},Object.fromEntries(Object.entries(intentDefaults.agreement).filter(([k])=>!['status','fulfillment'].includes(k))));}
 if(kind==='commander')properties.constraints=object({forbiddenPlayers:assessmentSchema.properties.forbiddenPlayers,protectedSources:{type:'array',maxItems:80,items:target},reserves:{type:'array',maxItems:80,items:object({source:target,drillers:integer})}},intentDefaults.constraints);
 if(kind==='diplomacy')properties.fulfillAgreementId=nullable(id);
 if(kind!=='commander')properties.betrayAgreements={type:'array',maxItems:20,items:id};
 if(kind==='diplomacy')properties.diplomacyAction=nullable({anyOf:[
  object({kind:{const:'propose-agreement'},peer:{type:'integer',minimum:0,maximum:9},
   terms:{anyOf:[object({kind:{const:'ceasefire'},outposts:{type:'array',minItems:1,maxItems:80,uniqueItems:true,items:target}}),object({kind:{const:'joint-attack'},enemy:{type:'integer',minimum:0,maximum:9}})]},
   subsidy:nullable(object({payer:{type:'integer',minimum:0,maximum:9},amount:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}})),counterTo:nullable(id)}),
  object({kind:{const:'respond-agreement'},agreementId:id,response:{enum:['accept','reject','withdraw']}}),
 ]});
 if(kind==='diplomacy'&&server){
  // Only private interpretation is model-authored. Formal obligations have one server source.
  properties.agreement=object({summary:text,internalIntent:text});
  const peer=server.peers.length===1?server.peers[0]:undefined;
  const pending=server.agreements.filter(a=>a.status==='proposed'&&a.players.includes(server.self)&&a.players.includes(peer??-1));
  const received=pending.filter(a=>a.players[1]===server.self);
  const variants:Record<string,unknown>[]=[];
  if(peer!==undefined){
   const terms:Record<string,unknown>[]=[];
   if(server.ceasefirePosts.length)terms.push(object({kind:{const:'ceasefire'},outposts:{type:'array',minItems:1,maxItems:Math.min(80,server.ceasefirePosts.length),uniqueItems:true,items:{...id,enum:server.ceasefirePosts}}}));
   if(server.enemies.length)terms.push(object({kind:{const:'joint-attack'},enemy:{type:'integer',enum:server.enemies}}));
   if(terms.length)variants.push(object({kind:{const:'propose-agreement'},peer:{const:peer},terms:{anyOf:terms},subsidy:nullable(object({payer:{type:'integer',enum:[server.self,peer]},amount:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}})),counterTo:received.length?nullable({...id,enum:received.map(a=>a.id)}):{type:'null'}}));
   for(const a of pending)variants.push(object({kind:{const:'respond-agreement'},agreementId:{const:a.id},response:{enum:a.players[1]===server.self?['accept','reject']:['withdraw']}}));
  }
  properties.diplomacyAction=variants.length?nullable({anyOf:variants}):{type:'null'};
 }
 return object(properties,{...intentDefaults.result,...(kind!=='commander'?{betrayAgreements:[]}:{}),...(kind==='diplomacy'?{message:null,agreement:intentDefaults.agreement,diplomacyAction:null,fulfillAgreementId:null}:{})});
}

/** Program-owned dynamic authorization contract; never sent for generation. */
export function intentSchemaFor(kind:SituationBrief['kind'],posts:readonly string[],taskIds:readonly string[]=[],fleets:readonly string[]=[],server?:ServerDiplomacySchema){
 return buildIntentSchema(kind,posts,taskIds,fleets,server);
}

/** One structural contract per role and protocol capability, independent of
 * current objects, permissions, tick, proposals and task lifecycle. */
export function fixedIntentSchema(kind:SituationBrief['kind'],serverContracts:boolean){
 const schema=buildIntentSchema(kind,[],[],[],undefined,true);
 if(kind==='diplomacy'){
  if(serverContracts)schema.properties.agreement=object({summary:text,internalIntent:text});
  else delete schema.properties.diplomacyAction;
 }
 return schema;
}
/** A valid empty skeleton shows root/nested boundaries without duplicating name
 * enums, inventing actions or making optional fields mandatory. */
export function intentOutputExample(schema:Record<string,any>):unknown{
 if(schema.anyOf)return intentOutputExample(schema.anyOf.find((s:any)=>s.type==='null')??schema.anyOf[0]);
 if(schema.type==='object')return Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,intentOutputExample(v as Record<string,any>)]));
 if(schema.type==='array')return [];
 if(schema.enum)return schema.enum[0];
 if(schema.type==='boolean')return false;
 if(schema.type==='integer'||schema.type==='number')return 0;
 return schema.type==='null'?null:'';
}
