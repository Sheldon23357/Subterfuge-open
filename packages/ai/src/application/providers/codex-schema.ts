type Schema=Record<string,any>;
const object=(v:unknown):v is Schema=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Distribute object conditions before strict decoding makes every property
 * required. In particular, per-action closed objects must stay separate. */
function alternatives(s:Schema):Schema{
 if(!s.properties||!s.anyOf?.every((b:unknown)=>object(b)&&b.properties))return s;
 const {anyOf,...base}=s;
 return {anyOf:anyOf.map((branch:Schema)=>({
  ...base,...branch,
  properties:branch.additionalProperties===false?branch.properties:{...base.properties,...branch.properties},
  required:[...new Set([...(base.required??[]),...(branch.required??[])])],
 }))};
}
const nullable=(s:Schema):boolean=>s.type==='null'||Array.isArray(s.type)&&s.type.includes('null')||s.enum?.includes(null)||s.anyOf?.some((b:Schema)=>nullable(b))===true;
const resolve=(s:Schema,root:Schema):Schema=>s.$ref?.startsWith('#/$defs/')?root.$defs?.[s.$ref.slice(8)]??s:s;
function presence(value:unknown):{present:boolean;value:unknown}|null {
 if(!object(value)||Object.keys(value).sort().join()!=='present,value'||typeof value.present!=='boolean'||!value.present&&value.value!==null)return null;
 return {present:value.present,value:value.value};
}

/** OpenAI strict output requires all declared keys. Optional non-null fields
 * receive a transport-only null alternative. Optional nullable fields use an
 * explicit presence envelope so omission cannot clear an inherited value. */
export function codexGenerationSchema(schema:Schema):Schema{
 const visit=(raw:unknown):any=>{
  if(!object(raw))return raw;
  const s=alternatives(raw),out={...s};
  // Strict generation rejects uniqueItems; uniqueness remains enforced by the
  // original contract after transport restoration, never by this projection.
  delete out.uniqueItems;
  if(s.anyOf)out.anyOf=s.anyOf.map(visit);
  if(s.properties){
   const required=new Set<string>(s.required??[]);
   out.properties=Object.fromEntries(Object.entries(s.properties).map(([key,field])=>{
    const value=visit(field);
    if(!required.has(key)&&nullable(resolve(field as Schema,schema)))return [key,{
     description:'可选字段使用存在性对象：省略填 {"present":false,"value":null}；显式设置填 {"present":true,"value":原值}，原值可为 null。',
     anyOf:[
      {type:'object',additionalProperties:false,required:['present','value'],properties:{present:{type:'boolean',enum:[false]},value:{type:'null'}}},
      {type:'object',additionalProperties:false,required:['present','value'],properties:{present:{type:'boolean',enum:[true]},value}},
     ],
    }];
    return [key,!required.has(key)&&!nullable(value)?{anyOf:[value,{type:'null'}],description:'未使用的可选字段填 null；传输层还原为省略。'}:value];
   }));
   out.required=Object.keys(s.properties);out.additionalProperties=false;
  }
  if(s.items)out.items=visit(s.items);
  if(s.$defs)out.$defs=Object.fromEntries(Object.entries(s.$defs).map(([key,value])=>[key,visit(value)]));
  return out;
 };
 return visit(schema);
}

/** Restore presence envelopes and remove transport-only null placeholders.
 * Preserve explicit business null, zero, false and malformed non-null values
 * so the original semantic and permission validators still see them. */
export function restoreCodexOptionals(value:unknown,schema:Schema):any{
 const source=(s:Schema)=>resolve(s,schema);
 const matches=(value:any,raw:Schema):boolean=>{
  const s=alternatives(source(raw));
  if(s.anyOf&&!s.anyOf.some((b:Schema)=>matches(value,b)))return false;
  if(s.const!==undefined&&value!==s.const||s.enum&&!s.enum.includes(value))return false;
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(s.type&&!(Array.isArray(s.type)?s.type:[s.type]).some((t:string)=>t===type||t==='integer'&&Number.isInteger(value)))return false;
  if(s.properties&&object(value)){
   const required=new Set<string>(s.required??[]);
   if([...required].some(key=>!Object.hasOwn(value,key)))return false;
   return Object.entries(s.properties).every(([key,field])=>{
    if(!Object.hasOwn(value,key))return true;
    if(!required.has(key)){
     if(nullable(source(field as Schema))){const p=presence(value[key]);if(p)return !p.present||matches(p.value,field as Schema);}
     else if(value[key]===null)return true;
    }
    return matches(value[key],field as Schema);
   });
  }
  return true;
 };
 const visit=(value:any,raw:Schema):any=>{
  const s=alternatives(source(raw));
  if(s.anyOf){const branch=s.anyOf.find((b:Schema)=>matches(value,b));if(branch)return visit(value,branch);}
  if(Array.isArray(value)&&s.items)return value.map(item=>visit(item,s.items));
  if(!object(value)||!s.properties)return value;
  const required=new Set<string>(s.required??[]);
  return Object.fromEntries(Object.entries(value).flatMap(([key,fieldValue])=>{
   const field=s.properties[key];
   if(field&&!required.has(key)){
    if(nullable(source(field))){const p=presence(fieldValue);if(p)return p.present?[[key,visit(p.value,field)]]:[];}
    else if(fieldValue===null)return [];
   }
   return [[key,field?visit(fieldValue,field):fieldValue]];
  }));
 };
 return visit(value,schema);
}
