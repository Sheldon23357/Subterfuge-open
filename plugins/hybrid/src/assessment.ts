/** Internal normalized assessment validator; model-facing protocol is intent-protocol.ts. */
import type {StrategicAssessment} from './contracts.js';
const string={type:'string',maxLength:1500}, id={type:'string',maxLength:120}, strings={type:'array',maxItems:80,items:id};
const object=<P extends Record<string,unknown>>(properties:P)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const agreementSchema=object({fulfillment:{type:'string',enum:['none','rules','tasks','message','deception']},status:{type:'string',enum:['none','proposed','negotiating','confirmed','fulfilled','expired','terminated','violated']},summary:string,forbidAttack:{type:'boolean'},forbiddenTargets:strings,internalIntent:string,expiresWorldDay:{type:['number','null'],minimum:0},jointAttack:{anyOf:[object({enemy:{type:'integer',minimum:0,maximum:9},until:{type:'number',minimum:0,maximum:10000000}}),{type:'null'}]}});
// Internal ordinary agreements need no offensive component. The model-facing
// protocol requires the explicit nullable field for each new diplomacy result.
agreementSchema.required=agreementSchema.required.filter(k=>!['jointAttack','fulfillment'].includes(k));
export const assessmentSchema=object({summary:string,objectives:{type:'array',maxItems:12,items:object({id,kind:{type:'string',enum:['capture','defend','mine','expand','hold']},targets:strings,priority:{type:'number',minimum:0,maximum:100},reason:string})},forbiddenPlayers:{type:'array',maxItems:10,items:{type:'integer',minimum:0,maximum:9}},protectedSources:strings,reserves:{type:'array',maxItems:80,items:object({source:id,drillers:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}})},reviewOn:strings,message:{type:['string','null'],maxLength:1500},agreement:agreementSchema});
export function parseAssessment(raw:unknown,players:number,postIds:ReadonlySet<string>):StrategicAssessment {
 if(typeof raw==='string')raw=JSON.parse(raw);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Invalid assessment');
 const a=raw as StrategicAssessment;
 if(Object.keys(a).sort().join()!==Object.keys(assessmentSchema.properties).sort().join())throw Error('Unexpected assessment fields');
 const text=(v:unknown,n=1500)=>typeof v==='string'&&v.length<=n;
 const ids=(v:unknown)=>Array.isArray(v)&&v.length<=80&&v.every(x=>text(x,120));
 if(!text(a.summary)||!Array.isArray(a.objectives)||a.objectives.length>12||!a.objectives.every(o=>o&&Object.keys(o).sort().join()==='id,kind,priority,reason,targets'&&text(o.id,120)&&['capture','defend','mine','expand','hold'].includes(o.kind)&&ids(o.targets)&&o.targets.every(id=>postIds.has(id))&&Number.isFinite(o.priority)&&o.priority>=0&&o.priority<=100&&text(o.reason)))throw Error('Invalid objectives');
 if(!Array.isArray(a.forbiddenPlayers)||a.forbiddenPlayers.length>players||!a.forbiddenPlayers.every(p=>Number.isInteger(p)&&p>=0&&p<players)||!ids(a.protectedSources)||!a.protectedSources.every(id=>postIds.has(id))||!Array.isArray(a.reserves)||a.reserves.length>80||!a.reserves.every(r=>r&&Object.keys(r).sort().join()==='drillers,source'&&postIds.has(r.source)&&Number.isSafeInteger(r.drillers)&&r.drillers>=0))throw Error('Invalid constraints');
 if(!ids(a.reviewOn))throw Error('Invalid review conditions: maximum 80 strings of 120 characters');
 if(!(a.message===null||text(a.message,1500))||!a.agreement||Object.keys(a.agreement).filter(k=>!['jointAttack','fulfillment'].includes(k)).sort().join()!=='expiresWorldDay,forbidAttack,forbiddenTargets,internalIntent,status,summary'||!['none','proposed','negotiating','confirmed','fulfilled','expired','terminated','violated'].includes(a.agreement.status)||typeof a.agreement.forbidAttack!=='boolean'||!ids(a.agreement.forbiddenTargets)||!a.agreement.forbiddenTargets.every(id=>postIds.has(id))||!text(a.agreement.summary)||!text(a.agreement.internalIntent)||!(a.agreement.expiresWorldDay===null||Number.isFinite(a.agreement.expiresWorldDay)&&a.agreement.expiresWorldDay>=0))throw Error('Invalid diplomacy result');
 if(a.agreement.fulfillment!==undefined&&!['none','rules','tasks','message','deception'].includes(a.agreement.fulfillment))throw Error('Invalid fulfillment mode');
 if(a.agreement.jointAttack!==undefined&&a.agreement.jointAttack!==null){const j=a.agreement.jointAttack;if(Object.keys(j).sort().join()!=='enemy,until'||!Number.isInteger(j.enemy)||j.enemy<0||j.enemy>=players||!Number.isFinite(j.until)||j.until<0||j.until>10000000)throw Error('Invalid joint attack');}
 return structuredClone(a);
}
