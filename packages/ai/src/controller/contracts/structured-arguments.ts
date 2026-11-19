import {toolNamesWhere} from './tool-metadata.js';
// Constrain common planning and finalization arguments at generation time.
type Schema=Record<string,unknown>;
const str:Schema={type:'string'},num:Schema={type:'integer'};
const array=(items:Schema):Schema=>({type:'array',items});
const nullable=(value:Schema):Schema=>({anyOf:[value,{type:'null'}]});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const optionalObject=(properties:Record<string,Schema>)=>object(Object.fromEntries(Object.entries(properties).map(([k,v])=>[k,nullable(v)])));
const note=object({id:str,kind:{type:'string',enum:['fact','plan','agreement','note']},priority:{type:'string',enum:['high','medium','low']},text:{...str,maxLength:12000},expiresWorldDay:nullable({type:'number',description:'Absolute future world day, with at most 1/600 day precision; null means no expiry.'})});
const reminder=object({id:str,atWorldDay:{type:'integer',description:'Absolute future integer world day.'},note:str,category:nullable({type:'string',enum:['plan','military','strategy']}),entities:nullable(array(str))});
export const STRUCTURED_ARGUMENT_DEFINITIONS:Record<string,Schema>={};
/** Fail closed when metadata and generation shapes drift; ordering is irrelevant. */
function checkedSchemas(names:string[],schemas:Record<string,Schema>,kind:string):Record<string,Schema>{
  const missing=names.filter(name=>!Object.hasOwn(schemas,name));
  const extra=Object.keys(schemas).filter(name=>!names.includes(name));
  if(missing.length||extra.length)throw Error(`Invalid ${kind} tool schemas: missing=${missing.join(',')}; extra=${extra.join(',')}`);
  return schemas;
}
export const STRUCTURED_TOOLS=toolNamesWhere(tool=>tool.wireShape==='structured');
const finishWrites={manualReview:object({version:num,receiptIds:array(str),reason:str}),memory:optionalObject({strategy:{...str,maxLength:1000}}),notebook:optionalObject({set:array(note),remove:array(str)}),reminders:optionalObject({set:array(reminder),cancel:array(str),complete:array(str)})};
export const STRUCTURED_ARGUMENT_SCHEMA_BY_TOOL=checkedSchemas(STRUCTURED_TOOLS,{
  finish:optionalObject({...finishWrites,commanderCleanup:object({version:num,basisRevision:str,completed:array(object({quote:{...str,maxLength:1200},reason:{...str,maxLength:300},evidence:array({...str,maxLength:180})}))})}),
},'structured');
// Compatibility export only. Consumers resolve schemas by tool name, never array index.
export const STRUCTURED_ARGUMENT_SCHEMAS=STRUCTURED_TOOLS.map(tool=>STRUCTURED_ARGUMENT_SCHEMA_BY_TOOL[tool]!);
/** In these strict shapes null means omitted for optional fields. Actual
 * null expiresWorldDay still means a permanent notebook entry. */
export function normalizeStructuredArguments(raw:Record<string,unknown>,tool?:string):Record<string,unknown>{
  const inferred=tool??'finish';
  const root=STRUCTURED_ARGUMENT_SCHEMA_BY_TOOL[inferred];
  const definitions=STRUCTURED_ARGUMENT_DEFINITIONS as Record<string,Schema>;
  const resolve=(schema:Schema|undefined):Schema|undefined=>schema&&typeof schema.$ref==='string'?definitions[schema.$ref.split('/').pop()!]:schema;
  const semanticNulls=new Set(['expiresWorldDay','reviewAt','trust','hostility','threat','cooperation']);
  const visit=(value:unknown,input:Schema|undefined):unknown=>{
    let schema=resolve(input);
    if(Array.isArray(schema?.anyOf)){
      const branches=(schema.anyOf as Schema[]).map(resolve).filter((s):s is Schema=>!!s&&s.type!=='null');
      schema=branches.find(s=>{
        if(!value||typeof value!=='object'||Array.isArray(value))return true;
        const props=s.properties as Record<string,Schema>|undefined;
        return ['kind','tool'].every(k=>!(k in value)||!Array.isArray(props?.[k]?.enum)||(props![k]!.enum as unknown[]).includes((value as Record<string,unknown>)[k]));
      });
    }
    if(Array.isArray(value))return value.map(v=>visit(v,schema?.items as Schema|undefined));
    if(!value||typeof value!=='object')return value;
    const properties=schema?.properties as Record<string,Schema>|undefined;
    return Object.fromEntries(Object.entries(value).flatMap(([k,v])=>{
      const field=resolve(properties?.[k]);
      const optionalNull=Array.isArray(field?.anyOf)&&(field.anyOf as Schema[]).some(s=>s.type==='null');
      // Unknown properties and required nulls remain visible to the validator.
      // Never silently erase a misspelling simply because its value was null.
      if(v===null&&optionalNull&&!semanticNulls.has(k))return [];
      return [[k,visit(v,field)]];
    }));
  };
  return visit(raw,root) as Record<string,unknown>;
}
