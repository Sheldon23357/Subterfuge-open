import {modelDataLabels} from './model-data-labels.js';

export const MODEL_DATA_PREFIX='!model-data/1\n';
const reverse=new Map(Object.entries(modelDataLabels).map(([key,label])=>[label,key]));
if(reverse.size!==Object.keys(modelDataLabels).length)throw Error('Duplicate model-data label');
const columnKeys=new Set(['columns','actionColumns','launchSourceColumns']);
const bare=(s:string)=>s.length>0&&s.trim()===s&&!/[,{}\[\]:"\\\u0000-\u001f\u007f]/u.test(s)&&!['?','是','否','null','true','false'].includes(s)&&!Number.isFinite(Number(s));
const string=(s:string)=>bare(s)?s:JSON.stringify(s);

/** Readable flow records: explicit keys and columns, never positional schema guessing.
 * Unknown keys are quoted so future fields cannot collide with translated labels.
 * JSON normalization preserves the producer's existing undefined/array semantics. */
export function encodeModelData(value:unknown):string{
 const normalized:unknown=JSON.parse(JSON.stringify(value));
 const write=(v:unknown,key=''):string=>{
  if(v===null)return '?';if(v===true)return '是';if(v===false)return '否';
  if(typeof v==='number')return String(v);
  if(typeof v==='string')return columnKeys.has(key)?Object.hasOwn(modelDataLabels,v)?modelDataLabels[v]!:JSON.stringify(v):string(v);
  if(Array.isArray(v))return '['+v.map(x=>write(x,key)).join(',')+']';
  if(v&&typeof v==='object'){
   const record=v as Record<string,unknown>,columns=record.columns,rows=record.rows;
   // A small, wide table is easier to read as named records: in particular,
   // own/peer contract obligations must not depend on counting 25 columns.
   if(Object.keys(record).length===2&&Array.isArray(columns)&&columns.length>=8&&new Set(columns).size===columns.length&&columns.every(k=>typeof k==='string'&&/^[A-Za-z_$][\w$]*$/.test(k))&&Array.isArray(rows)&&rows.length>0&&rows.length<=3&&rows.every(r=>Array.isArray(r)&&r.length===columns.length))
    return '表['+rows.map(r=>write(Object.fromEntries(columns.map((k,i)=>[k,r[i]])))).join(',')+']';
   return '{'+Object.entries(record).map(([k,x])=>(Object.hasOwn(modelDataLabels,k)?modelDataLabels[k]:JSON.stringify(k))+':'+write(x,k)).join(',')+'}';
  }
  throw Error('Unsupported model-data value');
 };
 return MODEL_DATA_PREFIX+write(normalized);
}

/** Strict bounded parser. Bad or truncated content never produces partial facts. */
export function decodeModelData(source:string):unknown{
 if(!source.startsWith(MODEL_DATA_PREFIX))throw Error('Unknown model-data format');
 let at=MODEL_DATA_PREFIX.length,nodes=0;
 const fail=():never=>{throw Error('Invalid model-data at '+at);};
 function quoted():string{
  const start=at++;for(;at<source.length;at++){if(source[at]==='\\'){at++;continue;}if(source[at]==='"'){at++;return JSON.parse(source.slice(start,at)) as string;}}
  return fail();
 }
 function token():string{const start=at;while(at<source.length&&!/[,{}\[\]:]/u.test(source[at]!))at++;if(at===start)return fail();return source.slice(start,at);}
 function value(key='',depth=0):unknown{
  if(depth>96||++nodes>250000)return fail();const c=source[at];
  if(c==='"')return quoted();
  if(source.startsWith('表[',at)){
   at++;const records=value('',depth+1);
   if(!Array.isArray(records)||!records.length||records.some(r=>!r||typeof r!=='object'||Array.isArray(r)))return fail();
   const columns=Object.keys(records[0]);
   if(records.some(r=>JSON.stringify(Object.keys(r))!==JSON.stringify(columns)))return fail();
   return {columns,rows:records.map(r=>columns.map(k=>r[k]))};
  }
  if(c==='{'){
   at++;const result:Record<string,unknown>={};if(source[at]==='}'){at++;return result;}
   for(;;){const raw=source[at]==='"',name=raw?quoted():token(),k=raw?name:reverse.get(name)??name;
    if(source[at++]!==':'||Object.hasOwn(result,k))return fail();
    Object.defineProperty(result,k,{value:value(k,depth+1),enumerable:true,writable:true,configurable:true});
    const separator=source[at++];if(separator==='}')return result;if(separator!==',')return fail();
   }
  }
  if(c==='['){at++;const result:unknown[]=[];if(source[at]===']'){at++;return result;}for(;;){result.push(value(key,depth+1));const separator=source[at++];if(separator===']')return result;if(separator!==',')return fail();}}
  const t=token();if(t==='?')return null;if(t==='是')return true;if(t==='否')return false;
  if(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(t)){const number=Number(t);if(!Number.isFinite(number))return fail();return number;}
  if(!bare(t))return fail();return columnKeys.has(key)?reverse.get(t)??t:t;
 }
 const result=value();if(at!==source.length)fail();return result;
}

export function readPromptSectionData(text:string):unknown{return text.startsWith(MODEL_DATA_PREFIX)?decodeModelData(text):JSON.parse(text) as unknown;}
