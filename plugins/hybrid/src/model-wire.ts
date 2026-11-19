import type {SituationBrief} from './contracts.js';
import type {IntentNormalization} from './intent-compatibility.js';
import {fixedIntentSchema} from './intent-schema.js';
import {diplomacyTaskTargets,type DiplomacyEditScope} from './diplomacy-edit-scope.js';

/** Share identical task allowlists only when references reduce the wire size.
 * Never merge different permission scopes or change enum order. */
function shareTaskAllowlists(schema:Record<string,any>){
 const candidates=new Map<string,{field:string;value:Record<string,any>;count:number}>();
 const walk=(value:any,field:string,visit:(value:Record<string,any>,field:string)=>any):any=>{
  if(Array.isArray(value))return value.map(v=>walk(v,field,visit));
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value.enum))return visit(value,field);
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='properties'
   ?Object.fromEntries(Object.entries(v as Record<string,any>).map(([name,s])=>[name,walk(s,name,visit)]))
   :walk(v,field,visit)]));
 };
 const item=schema.properties.tasks.items;
 walk(item,'task',(value,field)=>{
  const key=JSON.stringify(value),found=candidates.get(key);
  if(found)found.count++;else candidates.set(key,{field,value,count:1});
  return value;
 });
 const definitions:Record<string,any>={},references=new Map<string,string>();
 for(const [key,{field,value,count}]of candidates){
  if(count<2)continue;
  const base='task'+field[0]!.toUpperCase()+field.slice(1);let name=base,index=2;
  while(Object.hasOwn(definitions,name))name=base+index++;
  const ref='#/$defs/'+name;
  const saved=(count-1)*key.length-count*JSON.stringify({$ref:ref}).length-JSON.stringify(name).length-1;
  if(saved<32)continue;
  definitions[name]=value;references.set(key,ref);
 }
 if(references.size){
  schema.properties.tasks.items=walk(item,'task',value=>{
   const ref=references.get(JSON.stringify(value));return ref?{$ref:ref}:value;
  });
  schema.$defs=definitions;
 }
 return schema;
}

/** The model writes shallow JSON; the executor keeps its strict internal types. */
export function modelResponseSchema(internal:Record<string,any>,options:{activeAgreementIds?:string[]|undefined;friendlyPosts?:string[];diplomacyScope?:DiplomacyEditScope;fixedGeneration?:boolean}={}){
 const properties={...internal.properties};
 const specs=properties.tasks.properties.upsert.items.properties.task.anyOf;
 const fields:Record<string,any>={id:internal.properties.tasks.properties.upsert.items.properties.id};
 for(const s of specs)Object.assign(fields,s.properties);
 fields.kind={type:'string',enum:specs.map((s:any)=>s.properties.kind.enum[0])};
 if(fields.drillers)fields.drillers={anyOf:[{type:'integer',minimum:1,maximum:1000000},{type:'null'}]};
 const taskItem={type:'object',additionalProperties:false,required:['kind','until'],properties:fields,
  anyOf:specs.map((s:any)=>({type:'object',additionalProperties:false,properties:{id:fields.id,...s.properties,until:fields.until,
   ...(s.properties.kind.enum[0]==='transfer'?{drillers:fields.drillers}:{}),
   ...(['configure','transfer'].includes(s.properties.kind.enum[0])&&options.friendlyPosts?{target:options.friendlyPosts.length?{type:'string',enum:options.friendlyPosts}:{type:'null'}}:{}),
   ...(s.properties.kind.enum[0]==='transfer'&&options.friendlyPosts?{source:options.friendlyPosts.length?{type:'string',enum:options.friendlyPosts}:{type:'null'}}:{})},
   // Inheritance is conditional on unchanged live identity, target and kind.
   // A flat generation contract must also cover retargeting and kind changes.
   required:[...new Set([...s.required,...(s.properties.priority?['priority']:[])])],
   ...(s.properties.kind.enum[0]==='configure'?{anyOf:['minDrillers','maxDrillers'].map(k=>({required:[k],properties:{[k]:{type:'integer',minimum:0,maximum:1000000}}}))}:{})}))};
 properties.tasks={type:'array',maxItems:12,items:taskItem};
 properties.cancel=internal.properties.tasks.properties.cancel;
 if(properties.agreement){delete properties.agreement;properties.agreementSummary={type:'string',maxLength:1500};properties.internalIntent={type:'string',maxLength:1500};}
 if(properties.constraints){Object.assign(properties,properties.constraints.properties);delete properties.constraints;}
 if(properties.diplomacyAction){
  delete properties.diplomacyAction;
  properties.action={type:'string',enum:['none','ceasefire','joint-attack','accept','reject','withdraw']};
  for(const k of ['peer','enemy'])properties[k]={type:'integer',minimum:0,maximum:1000000};
  for(const k of ['peer','enemy'])properties[k]={type:'integer',minimum:0,maximum:9};
  properties.subsidy={type:['object','null'],additionalProperties:false,required:['payer','amount'],properties:{payer:{type:'integer',minimum:0,maximum:9},amount:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}}};

  for(const k of ['agreementId','counterTo'])properties[k]={type:['string','null'],maxLength:120};
  properties.outposts={type:'array',maxItems:80,items:{type:'string',maxLength:120}};
  const variants=internal.properties.diplomacyAction.anyOf?.find((s:any)=>s.anyOf)?.anyOf;
  if(variants){
   const proposals=variants.filter((s:any)=>s.properties.kind.const==='propose-agreement');
   const replies=variants.filter((s:any)=>s.properties.kind.const==='respond-agreement');
   const terms=proposals.flatMap((s:any)=>s.properties.terms.anyOf);
   properties.action={type:'string',enum:['none',...new Set([...terms.map((s:any)=>s.properties.kind.const),...replies.flatMap((s:any)=>s.properties.response.enum)])]};
   if(proposals.length&&proposals.every((s:any)=>s.properties.peer.const!==undefined))properties.peer={type:'integer',enum:proposals.map((s:any)=>s.properties.peer.const)};
   const enemy=terms.find((s:any)=>s.properties.enemy)?.properties.enemy;
   if(enemy)properties.enemy=enemy;
   const posts=terms.find((s:any)=>s.properties.outposts)?.properties.outposts;
   if(posts)properties.outposts=posts;
   if(replies.length&&replies.every((s:any)=>s.properties.agreementId.const!==undefined))properties.agreementId={type:'string',enum:replies.map((s:any)=>s.properties.agreementId.const)};
  }
  if(internal.properties.diplomacyAction.type==='null')properties.action={type:'string',enum:['none']};
  properties.action={...properties.action,type:['string','null'],enum:[...properties.action.enum,null]};
  if(options.activeAgreementIds||options.fixedGeneration){
   const ids=options.activeAgreementIds;
   properties.fulfillAgreementId=ids?(ids.length?{anyOf:[{type:'string',enum:ids},{type:'null'}]}:{type:'null'}):internal.properties.fulfillAgreementId;
   // Placement is explicit at both shallow levels; decoder lifts one consistent ID.
   fields.fulfillAgreementId=properties.fulfillAgreementId;
   for(const variant of taskItem.anyOf)variant.properties.fulfillAgreementId=properties.fulfillAgreementId;
   if(ids&&!ids.length){properties.tasks={...properties.tasks,maxItems:0};properties.cancel={...properties.cancel,maxItems:0};}
  }
 }
 if(options.diplomacyScope){
  const scope=options.diplomacyScope;
  const variants=taskItem.anyOf.filter((variant:any)=>{
   const kind=variant.properties.kind.enum[0];
   if(!scope.contracts.length)return false;
   if(kind==='return-fleet'){
    if(!scope.returnFleetIds.length)return false;
    variant.properties.fleetId={type:'string',enum:scope.returnFleetIds};return true;
   }
   if(kind==='focus')return false;
   const targets=diplomacyTaskTargets(kind,scope);
   if(!targets.length||kind==='transfer'&&scope.friendlyTargets.length<2)return false;
   variant.properties.target={type:'string',enum:targets};
   if(kind==='transfer')variant.properties.source={type:'string',enum:scope.friendlyTargets};
   return true;
  });
  if(variants.length){
   taskItem.anyOf=variants;
   for(const key of Object.keys(fields))if(!variants.some((v:any)=>Object.hasOwn(v.properties,key)))delete fields[key];
   fields.kind={type:'string',enum:variants.map((v:any)=>v.properties.kind.enum[0])};
   const targets=[...new Set(variants.flatMap((v:any)=>v.properties.target?.enum??[]))];
   if(targets.length)fields.target={type:'string',enum:targets};
   if(variants.some((v:any)=>v.properties.fleetId))fields.fleetId={type:'string',enum:scope.returnFleetIds};
  }else properties.tasks={type:'array',maxItems:0,items:{type:'null'}};
 }
 // Each closed branch already declares all applicable fields and requirements.
 // The construction-time field union is unnecessary in the transmitted schema.
 if(properties.tasks.items===taskItem)properties.tasks={...properties.tasks,items:{anyOf:taskItem.anyOf}};
 return shareTaskAllowlists({type:'object',additionalProperties:false,required:['summary','tasks','cancel','reviewOn',...(internal.properties.constraints?['forbiddenPlayers','protectedSources','reserves']:[])],properties});
}

export function fixedModelResponseSchema(kind:SituationBrief['kind'],serverContracts:boolean){
 return modelResponseSchema(fixedIntentSchema(kind,serverContracts),{fixedGeneration:true});
}

export function decodeModelResponse(raw:unknown,kind:SituationBrief['kind'],audit:IntentNormalization[]=[],context:{peer?:number|null}={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
 const a=structuredClone(raw) as Record<string,any>;
 // Internal callers and recorded test providers may already return executor types.
 if(a.tasks&& !Array.isArray(a.tasks))return a;
 if(kind==='diplomacy'&&Array.isArray(a.tasks)){
  const links=[a.fulfillAgreementId,...a.tasks.map((t:any)=>t?.fulfillAgreementId)].filter(v=>v!==null&&v!==undefined);
  if(new Set(links).size>1)throw Error('One diplomatic edit batch must refer to one exact signed agreement');
  if(links.length&&a.fulfillAgreementId==null)a.fulfillAgreementId=links[0];
  a.tasks.forEach((t:any,i:number)=>{if(t&&Object.hasOwn(t,'fulfillAgreementId')){audit.push({path:`$.tasks[${i}].fulfillAgreementId`,rule:'move-fulfilment',value:t.fulfillAgreementId});delete t.fulfillAgreementId;}});
 }
 if(Array.isArray(a.tasks))a.tasks={upsert:a.tasks.map((item:any)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Each task must be a flat object');
  const {id=null,...task}=item;return {id,task};
 }),cancel:a.cancel??[]};
 else if(a.cancel!==undefined)a.tasks={upsert:[],cancel:a.cancel};
 delete a.cancel;
 if(kind==='commander'){
  const keys=['forbiddenPlayers','protectedSources','reserves'];
  if(keys.some(k=>Object.hasOwn(a,k))){if(!keys.every(k=>Object.hasOwn(a,k)))throw Error('Commander must provide all three constraint arrays');a.constraints=Object.fromEntries(keys.map(k=>[k,a[k]]));for(const k of keys)delete a[k];}
 }
 if(kind==='diplomacy'){
  if(Object.hasOwn(a,'agreementSummary')||Object.hasOwn(a,'internalIntent')){a.agreement={summary:a.agreementSummary??'',internalIntent:a.internalIntent??''};delete a.agreementSummary;delete a.internalIntent;}
  const metadata=['peer','counterTo','subsidy','outposts','enemy','ownCommitment','peerCommitment','agreementId'];
  const action=a.action===null?'none':a.action??(metadata.some(k=>Object.hasOwn(a,k))?'none':undefined);
  if(action!==undefined){
   const proposal=action==='ceasefire'||action==='joint-attack';
   if(!['none','ceasefire','joint-attack','accept','reject','withdraw'].includes(action))throw Error('Unknown diplomacy action');
   if(proposal&&a.peer===undefined&&context.peer!==undefined&&context.peer!==null){
    a.peer=context.peer;audit.push({path:'$.peer',rule:'bind-conversation-peer',value:context.peer});
   }
   a.diplomacyAction=action==='none'?null:proposal?{kind:'propose-agreement',peer:a.peer,
    terms:action==='ceasefire'?{kind:action,outposts:a.outposts}:{kind:action,enemy:a.enemy},
    subsidy:a.subsidy===undefined?null:a.subsidy,counterTo:a.counterTo??null}
    :{kind:'respond-agreement',agreementId:a.agreementId,response:action};
   const allowed=new Set(proposal?['peer','counterTo','subsidy',...(action==='ceasefire'?['outposts']:['enemy'])]:action==='none'?[]:['agreementId']);
   for(const k of metadata){
    if(Object.hasOwn(a,k)&&!allowed.has(k))audit.push({path:'$.'+k,rule:'drop-extra-field',value:a[k]});
    delete a[k];
   }
   delete a.action;
  }
 }
 return a;
}
