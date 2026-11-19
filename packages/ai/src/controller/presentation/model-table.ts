/** Lossless shared columns. Each group has identical present keys and each row
 * carries its original index; absent keys never turn into null, zero or false. */
export function compactTable(rows:Record<string,unknown>[]){
 const groups=new Map<string,{fields:string[];rows:unknown[][]}>();
 rows.forEach((row,index)=>{
  const fields=Object.keys(row).filter(key=>row[key]!==undefined),key=JSON.stringify(fields);
  let group=groups.get(key);if(!group){group={fields,rows:[]};groups.set(key,group);}
  group.rows.push([index,...fields.map(field=>row[field])]);
 });
 return {encoding:'column-groups/1',length:rows.length,groups:[...groups.values()]};
}

const row=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Lossless shared-column encoding, applied AFTER names and units are resolved.
 * Missing keys remain missing. Authored request arguments retain their schema.
 * Use a table only when it is actually smaller than the corresponding JSON. */
export function encodeModelResultRows(value:unknown):unknown{
 if(Array.isArray(value)){
  const values=value.map(encodeModelResultRows);
  if(values.length>1&&values.every(row)){
   const table=compactTable(values);
   if(JSON.stringify(table).length<JSON.stringify(values).length)return table;
  }
  return values;
 }
 if(!row(value))return value;
 if(value.encoding==='column-groups/1')return value;
 return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,['arguments','submittedArguments','drafts'].includes(key)?child:encodeModelResultRows(child)]));
}
