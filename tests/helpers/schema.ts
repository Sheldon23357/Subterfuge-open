import assert from 'node:assert/strict';

/** Expand local definitions for assertions about the effective contract. */
export function expandSchemaReferences(schema:Record<string,any>):Record<string,any>{
 const visit=(value:any):any=>{
  if(Array.isArray(value))return value.map(visit);
  if(!value||typeof value!=='object')return value;
  if(value.$ref){
   assert.match(value.$ref,/^#\/\$defs\/[^/]+$/);
   const definition=schema.$defs?.[value.$ref.slice(8)];
   assert.ok(definition,'reference must resolve: '+value.$ref);
   assert.deepEqual(Object.keys(value),['$ref']);
   return visit(definition);
  }
  return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$defs').map(([key,v])=>[key,visit(v)]));
 };
 return visit(schema);
}
