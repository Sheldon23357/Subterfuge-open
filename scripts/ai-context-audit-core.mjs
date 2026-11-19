import assert from 'node:assert/strict';
export const blankKind=node=>node.kind==='null'?'null':node.kind==='string'&&node.value===''?'emptyString':node.kind==='array'&&!node.children.length?'emptyArray':node.kind==='object'&&!node.members.length?'emptyObject':null;
/** Strict JSON lexical tree. Every UTF-16 source position belongs to one token. */
export function parseJsonSource(source){
 let at=0;const tokens=[],nodes=[];
 const token=(kind,start,end,path)=>{tokens.push({kind,start,end,path});};
 const whitespace=path=>{const start=at;while(/[ \t\r\n]/.test(source[at]??'x'))at++;if(at>start)token('whitespace',start,at,path);};
 const punctuation=(char,path)=>{assert.equal(source[at],char);token('punctuation',at,at+1,path);at++;};
 function string(kind,path){const start=at++;assert.equal(source[start],'"');for(;;){if(at>=source.length)throw Error('Unclosed string');const c=source[at++];if(c==='\\'){at++;continue;}if(c==='"')break;}const value=JSON.parse(source.slice(start,at));token(kind,start,at,path);return {kind:'string',value,start,end:at,path};}
 function value(path){
  whitespace(path);const start=at,c=source[at];let node;
  if(c==='"')node=string('stringValue',path);
  else if(c==='{'){
   punctuation('{',path);const members=[],data=Object.create(null);whitespace(path);
   if(source[at]!=='}')for(;;){
    const key=string('propertyName',path),childPath=path+( /^[A-Za-z_$][\w$]*$/.test(key.value)?'.'+key.value:'['+JSON.stringify(key.value)+']');
    tokens.at(-1).path=childPath;whitespace(childPath);punctuation(':',childPath);const child=value(childPath);members.push({key,value:child});data[key.value]=child.value;whitespace(path);
    if(source[at]!==',')break;punctuation(',',path);whitespace(path);
   }
   punctuation('}',path);node={kind:'object',value:data,members,start,end:at,path};
  }else if(c==='['){
   punctuation('[',path);const children=[];whitespace(path);
   if(source[at]!==']')for(;;){children.push(value(path+'['+children.length+']'));whitespace(path);if(source[at]!==',')break;punctuation(',',path);}
   punctuation(']',path);node={kind:'array',value:children.map(c=>c.value),children,start,end:at,path};
  }else{
   const raw=/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at))?.[0];
   if(!raw)throw Error('Invalid JSON value at '+at);at+=raw.length;const decoded=JSON.parse(raw),kind=raw==='null'?'null':typeof decoded==='boolean'?'boolean':'number';token(kind,start,at,path);node={kind,value:decoded,start,end:at,path};
  }
  nodes.push(node);return node;
 }
 const root=value('$');whitespace('$');assert.equal(at,source.length);
 assert.deepEqual(JSON.parse(JSON.stringify(root.value)),JSON.parse(source));
 let end=0;for(const t of tokens){assert.equal(t.start,end,'token coverage');assert.ok(t.end>t.start);end=t.end;}assert.equal(end,source.length);
 return {root,tokens,nodes};
}
const idPattern=/\b(?:p\d+-)?[a-f0-9]{64}\b|\b(?:[A-Za-z][A-Za-z0-9._-]{0,35}-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
export function inspectJson(source){
 const tree=parseJsonSource(source),categories={},blanks={null:0,emptyString:0,emptyArray:0,emptyObject:0,lexemeCharacters:0,objectMembers:0,objectMemberCharacters:0,tableCells:0},ids=[],tables=[],fields=[],blankRows=[],floatRows=[];
 for(const t of tree.tokens){
  categories[t.kind]=(categories[t.kind]??0)+t.end-t.start;
  if(t.kind==='stringValue'||t.kind==='propertyName')for(const match of source.slice(t.start+1,t.end-1).matchAll(idPattern)){
   const id=match[0],kind=/^p\d+-[a-f0-9]{64}$/i.test(id)?'scopedHash':/^[a-f0-9]{64}$/i.test(id)?'hash64':/^[a-f0-9]{8}-/i.test(id)?'uuid':'prefixedUuid';
   ids.push({id,kind,path:t.path,start:t.start+1+match.index,end:t.start+1+match.index+id.length,characters:id.length});
  }
 }
 const memberByValue=new Map(tree.nodes.flatMap(n=>n.kind==='object'?n.members.map(m=>[m.value,m]):[]));
 for(const node of tree.nodes){
  const empty=blankKind(node);if(empty){blanks[empty]++;blanks.lexemeCharacters+=node.end-node.start;const member=memberByValue.get(node),pair=member?node.end-member.key.start:0;if(member){blanks.objectMembers++;blanks.objectMemberCharacters+=pair;}blankRows.push({path:node.path,kind:empty,characters:node.end-node.start,memberCharacters:pair});}
  if(node.kind==='number'&&!Number.isInteger(node.value)){const raw=source.slice(node.start,node.end),digits=raw.split('.')[1]?.split(/[eE]/)[0].length??0;if(digits>3)floatRows.push({path:node.path,raw,characters:raw.length,fractionDigits:digits});}
  if(node.kind==='object'){
   for(let i=0;i<node.members.length;i++){
    const member=node.members[i],child=member.value,exclusiveEnd=i+1<node.members.length?node.members[i+1].key.start:node.end-1;
    fields.push({path:child.path,kind:child.kind,valueCharacters:child.end-child.start,memberCharacters:exclusiveEnd-member.key.start,start:member.key.start,end:exclusiveEnd});
   }
   const cols=node.value.columns,rowKey=Array.isArray(node.value.rows)?'rows':Array.isArray(node.value.ownPosts)?'ownPosts':null;
   if(!Array.isArray(cols)||!cols.every(c=>typeof c==='string')||!rowKey)continue;
   const rows=node.value[rowKey];if(!rows.every(Array.isArray))continue;
   const strict=Object.keys(node.value).length===2&&rowKey==='rows',rawSize=node.end-node.start;
   const nullColumns=cols.map((name,index)=>({name,index})).filter(c=>rows.length&&rows.every(r=>r[c.index]===null));
   const nullCells=rows.reduce((sum,row)=>sum+row.filter(v=>v===null).length,0);blanks.tableCells+=nullCells;
   const allEmpty=rows.length===0,headerChars=JSON.stringify(cols).length;
   const records=rows.map(row=>Object.fromEntries(cols.map((column,index)=>[column,row[index]])));
   tables.push({path:node.path,rowKey,columns:cols,rows:rows.length,cells:rows.reduce((n,r)=>n+r.length,0),nullCells,allNullColumns:nullColumns.map(c=>c.name),strict,characters:rawSize,headerCharacters:headerChars,emptySchemaSaving:strict&&allEmpty?rawSize-2:0,recordsCharacters:JSON.stringify(records).length,tupleToRecordsDelta:JSON.stringify(records).length-(strict?rawSize:JSON.stringify({columns:cols,rows}).length)});
  }
 }
 assert.equal(Object.values(categories).reduce((a,b)=>a+b,0),source.length);
 return {...tree,categories,blanks,ids,tables,fields,blankRows,floatRows};
}
export function pruneEmptyMembers(value){
 if(Array.isArray(value))return value.map(pruneEmptyMembers);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([,v])=>!(v===null||v===''||Array.isArray(v)&&!v.length||v&&typeof v==='object'&&!Object.keys(v).length)).map(([k,v])=>[k,pruneEmptyMembers(v)]));
}
export function transformTables(value,mode){
 if(Array.isArray(value))return value.map(v=>transformTables(v,mode));
 if(!value||typeof value!=='object')return value;
 const {columns,rows}=value;
 if(Object.keys(value).length===2&&Array.isArray(columns)&&columns.every(c=>typeof c==='string')&&Array.isArray(rows)&&rows.every(r=>Array.isArray(r)&&r.length===columns.length)){
  if(!rows.length)return mode==='emptyTables'?[]:value;
  if(mode==='nullColumns'){
   const omitted=columns.map((name,i)=>({name,i})).filter(c=>rows.every(r=>r[c.i]===null)),keep=columns.map((_,i)=>i).filter(i=>!omitted.some(c=>c.i===i));
   if(omitted.length)return {columns:keep.map(i=>columns[i]),rows:rows.map(row=>keep.map(i=>transformTables(row[i],mode))),allNullColumns:omitted.map(c=>c.name)};
  }
 }
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,transformTables(v,mode)]));
}
export function selfTest(){
 for(const raw of ['{"x":null,"y":false,"z":0,"empty":[],"object":{},"s":""}',' { "escaped" : "引号\\\"与\\n换行🛰️", "n": -1.25e3 } ','[true,false,1,null,"null",{"rows":[[null,2]],"columns":["a","b"]}]']){const t=inspectJson(raw);assert.equal(Object.values(t.categories).reduce((a,b)=>a+b,0),raw.length);}
 const s=inspectJson('{"columns":["id","n"],"rows":[["p0-'+'a'.repeat(64)+'",null]]}');assert.equal(s.ids.length,1);assert.equal(s.ids[0].characters,67);assert.equal(s.tables[0].nullCells,1);
 return true;
}
