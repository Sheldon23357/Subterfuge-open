import type {PlayerObservation} from '../../../../contracts/src/index.js';

type Row=Record<string,unknown>;
const record=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** The authorized name table is the sole model-facing outpost namespace.
 * Never fall back to array position, approximate spelling or an unseen name. */
export function outpostNameIndex(observation:Pick<PlayerObservation,'view'|'outpostNames'>){
 const byId=new Map<string,string>(),byName=new Map<string,string>();
 for(const outpost of observation.view.outposts){
  const name=observation.outpostNames?.[outpost.id];
  if(typeof name!=='string'||!name.trim())throw Error(`据点缺少授权名称：${outpost.id}`);
  if(byName.has(name)&&byName.get(name)!==outpost.id)throw Error(`据点名称重复：${name}`);
  byId.set(outpost.id,name);byName.set(name,outpost.id);
 }
 return {byId,byName,resolve:(reference:unknown)=>{
  if(typeof reference!=='string')throw Error('据点名称必须是字符串');
  const id=byName.get(reference);
  if(!id)throw Error(`未知据点名称：${reference}；请使用当前海图中的完整名称`);
  return id;
 }};
}

/** Resolve only typed entity references. Authored text, candidate IDs, note IDs,
 * player numbers and fleet identities must remain byte-for-byte. */
export function resolveOutpostReferences(value:unknown,observation:PlayerObservation,options:{modelInput?:boolean}={}):unknown{
 // Internal fixtures can have no names; raw engine identities remain usable by
 // internal helpers. Production prompt construction requires a complete index.
 const names=observation.outpostNames??{};
 const byName=new Map<string,string[]>();
 const known=new Set(observation.view.outposts.map(p=>p.id));
 if(options.modelInput)outpostNameIndex(observation);
 for(const [id,name]of Object.entries(names))if(known.has(id))byName.set(name,[...(byName.get(name)??[]),id]);
 const resolve=(value:unknown):unknown=>{
  if(typeof value!=='string')return value;
  const matches=byName.get(value);
  if(matches?.length===1)return matches[0];
  if(matches?.length)throw Error(`据点名称重复：${value}`);
  if(!options.modelInput&&known.has(value))return value;
  throw Error(`未知据点名称：${value}；请使用当前海图中的完整名称`);
 };
 const entity=(value:unknown):unknown=>typeof value==='string'&&(byName.has(value)||options.modelInput&&known.has(value))?resolve(value):value;
 const visit=(input:unknown):unknown=>{
  if(Array.isArray(input))return input.map(visit);
  if(!record(input))return input;
  return Object.fromEntries(Object.entries(input).map(([key,child])=>{
   if(['source','outpostId','outpost'].includes(key)&&typeof child==='string')return [key,resolve(child)];
   if(key==='target'&&typeof child==='string')return [key,resolve(child)];
   if(key==='destination'&&typeof child==='string')return [key,resolve(child)];
   if(key==='id'&&input.kind==='outpost')return [key,resolve(child)];
   if(key==='detail'&&record(child)&&Array.isArray(child.outposts))return [key,{...child,outposts:child.outposts.map(resolve)}];
   if(['targets','sources'].includes(key)&&Array.isArray(child))return [key,child.map(item=>typeof item==='string'?resolve(item):visit(item))];
   if(key==='entities'&&Array.isArray(child))return [key,child.map(entity)];
   return [key,visit(child)];
  }));
 };
 return visit(value);
}

/** Read-only display transform. It is deliberately separate from archives and
 * command normalization, including the original submitted request. */
export function presentOutpostNames(value:unknown,names:Record<string,string>):unknown{
 const name=(value:unknown)=>typeof value==='string'&&Object.hasOwn(names,value)?names[value]:value;
 const referenceArrays=new Set(['targets','sources','entities','outpostIds','relatedOutposts','requestedOutposts','factories']);
 const tupleArrays=new Set(['sources','possibleDefenderSupport','thirdParties','ranking','risks']);
 const visit=(input:unknown,scope=''):unknown=>{
  if(Array.isArray(input))return input.map(value=>{
   if(typeof value==='string'&&referenceArrays.has(scope))return name(value);
   if(Array.isArray(value)&&tupleArrays.has(scope))return value.map((cell,index)=>index===0?name(cell):visit(cell));
   if(typeof value==='string'&&scope==='scope')return value.replace(/^(source:|outpost:|destination:outpost:)(.+)$/,(_all,prefix:string,id:string)=>prefix+String(name(id)));
   return visit(value,scope);
  });
  if(!record(input))return input;
  const outpost=scope==='outposts'||input.kind==='outpost';
  return Object.fromEntries(Object.entries(input).flatMap(([key,child])=>{
   if(key==='arguments'||key==='submittedArguments')return [[key,structuredClone(child)]];
   if(key==='outpostNames')return [];
   if(key==='id'&&(outpost||['target','verifiedTarget','sourceDefense','sourceBudgets','sourceSafety','sourceReserves','targets','ranked','excluded','details'].includes(scope)||input.kind==='outposts')&&typeof child==='string'&&Object.hasOwn(names,child))return [['name',name(child)]];
   if(key==='name'&&outpost&&typeof input.id==='string'&&Object.hasOwn(names,input.id))return [];
   if(['source','outpost','outpostId','target','destination','nearestOutpost','hub','subject','sourceId','targetId'].includes(key)&&typeof child==='string')return [[key,name(child)]];
   const targetKey=['reserved','sourceReservesById'].includes(scope)?String(name(key)):key;
   return [[targetKey,visit(child,key)]];
  }));
 };
 return visit(value);
}
