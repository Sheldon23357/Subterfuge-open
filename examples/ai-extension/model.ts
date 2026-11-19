import type {AgentProvider,ModelResult} from '../../packages/ai/src/extension.js';
/** Deterministic offline transport fixture. No network, model account or credentials. */
export const exampleModel:AgentProvider={step:async request=>{
 request.signal.throwIfAborted();
 const schema=request.responseSchema as Record<string,any>|undefined;
 const sample=(s:Record<string,any>):unknown=>{
  if(s.$ref){const name=String(s.$ref).split('/').at(-1)!;return sample(schema?.$defs?.[name]??{});}
  if(s.const!==undefined)return s.const;
  if(s.enum)return s.enum.includes('none')?'none':s.enum[0];
  if(s.anyOf)return sample(s.anyOf.find((v:any)=>v.type==='null')??s.anyOf[0]);
  if(s.type==='null')return null;
  if(s.type==='array')return [];
  if(s.type==='object'||s.properties)return Object.fromEntries((s.required??[]).map((name:string)=>[name,sample(s.properties?.[name]??{})]));
  if(s.type==='number'||s.type==='integer')return s.minimum??0;
  if(s.type==='boolean')return false;
  return '依据授权资料保持观察。';
 };
 if(!schema)throw Error('The example model requires an explicit response schema');
 return {reply:sample(schema),tokens:0,usageKnown:{provenance:'synthetic',input:false,output:false,cached:false}} satisfies ModelResult<unknown>;
}};
