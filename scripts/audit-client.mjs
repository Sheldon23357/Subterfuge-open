import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import {readReference,sourcePath,extractReferenceMethod,runReference,runReferenceRecruitment} from './reference-functions.mjs';

const reference=readReference();
const output='docs/research/data';
fs.mkdirSync(output,{recursive:true});
const load=name=>JSON.parse(fs.readFileSync(`docs/rules/data/${name}.json`,'utf8'));
const write=(name,data)=>fs.writeFileSync(`${output}/${name}.json`,JSON.stringify(data,null,2)+'\n');
const line=node=>reference.tree.getLineAndCharacterOfPosition(node.getStart(reference.tree)).line+1;
const functions=[],tutorials=[],commands=[];
function walk(node,owner='') {
  let scope=owner;
  if(ts.isClassDeclaration(node)) scope=node.name?.text??'<anonymous>';
  if(ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const name=node.name?.getText(reference.tree)??'<anonymous>';
    functions.push({symbol:ts.isMethodDeclaration(node)?`${owner}.${name}`:name,line:line(node),end_line:reference.tree.getLineAndCharacterOfPosition(node.end).line+1});
    if(owner==='kr'||owner==='tr') commands.push({symbol:`${owner}.${name}`,line:line(node),status:'requires_semantic_review'});
  }
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken
    &&ts.isElementAccessExpression(node.left)&&node.left.expression.getText(reference.tree)==='ur'
    &&ts.isNewExpression(node.right)&&node.right.expression.getText(reference.tree)==='Tr') {
    const args=node.right.arguments??[];
    const index=Number(node.left.argumentExpression.getText(reference.tree));
    tutorials.push({id:`T${String(index+1).padStart(2,'0')}`,client_index:index,
      title:args[0]&&ts.isStringLiteral(args[0])?args[0].text:null,
      subtitle:args[1]&&ts.isStringLiteral(args[1])?args[1].text:null,
      goal:args[2]&&ts.isStringLiteral(args[2])?args[2].text:null,
      debug:index>=24,line:line(node),status:'metadata_extracted_map_and_solution_not_ported'});
  }
  ts.forEachChild(node,child=>walk(child,scope));
}
walk(reference.tree);

const root='research/extracted/assets/public';
const assets=[];
function inventory(directory) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()) inventory(file);
    else {
      const buffer=fs.readFileSync(file),ext=path.extname(file).toLowerCase();
      const kind=['.png','.jpg','.jpeg','.webp','.svg'].includes(ext)?'image':['.mp3','.wav','.ogg'].includes(ext)?'audio':['.ttf','.woff','.woff2'].includes(ext)?'font':'code_or_data';
      const semantic=path.basename(file,ext).replace(/-[A-Za-z0-9_-]{8}$/,'');
      const dimensions=ext==='.png'&&buffer.length>=24&&buffer.subarray(1,4).toString()==='PNG'
        ?{width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)}:null;
      const relative=path.relative(root,file).replaceAll('\\','/');
      assets.push({id:kind==='code_or_data'?`${kind}/${relative}`:`${kind}/${semantic}${ext}`,path:relative,kind,bytes:buffer.length,
        sha256:crypto.createHash('sha256').update(buffer).digest('hex'),dimensions,
        builtin_reference:reference.source.includes(path.basename(file))});
    }
  }
}
inventory(root);
assets.sort((a,b)=>a.path.localeCompare(b.path));
const ids=new Set();
for(const asset of assets) { if(ids.has(asset.id)) throw new Error(`Ambiguous semantic asset id: ${asset.id}`); ids.add(asset.id); }
const rules=load('rules'),specialists=load('specialists'),cases=load('acceptance-cases');
const coverage=rules.map(rule=>({id:rule.id,summary:rule.summary_zh,evidence:rule.status,source_ids:rule.source_ids,spec_examples:cases.filter(c=>c.rule_ids.includes(rule.id)).map(c=>c.id)}));
for(const specialist of specialists)coverage.push({id:`SPEC-${specialist.id}`,summary:specialist.summary_zh,evidence:specialist.status,source_ids:specialist.source_ids,spec_examples:[]});
for(const tutorial of tutorials){delete tutorial.status;tutorial.metadata_only=true;}
write('coverage',coverage);write('assets',assets);write('tutorials',tutorials);write('commands',commands);
fs.mkdirSync('research/verification',{recursive:true});
fs.writeFileSync('research/verification/symbols.json',JSON.stringify(functions,null,2)+'\n');
const samples=[];
for(const [name,field,max,start] of [['calculateTicksBetweenDrillerProductions','tycoons',48,0],['calculateTicksBetweenNpProductions','outposts',100,1]]) {
  const method=extractReferenceMethod(reference,name);
  for(let value=start;value<=max;value++) samples.push({symbol:`V.${name}`,source_line:method.line,input:{[field]:value},output:runReference(method,{[field]:value}),evidence:'executed_original_method_with_cache_stubs'});
}
const hireFixtures=[];
for(const gameSeed of [0,1,2147483647])for(const playerIndex of [0,4,9])for(const hireNumber of [1,2,18,19,24,25,49,100])hireFixtures.push({gameSeed,playerIndex,hireNumber});
const hireResults=runReferenceRecruitment(reference,hireFixtures);
write('recruitment-reference-samples',{profile:'apk-12075-rules-4300',source_sha256:reference.sha,
  evidence:'executed_original_deck_functions_with_metadata_and_array_stubs',
  samples:hireFixtures.map((input,index)=>({input,client_type_ids:hireResults[index]}))});
write('reference-samples',{profile:'apk-12075-rules-4300',source_sha256:reference.sha,samples});
const counts=Object.fromEntries(['image','audio','font','code_or_data'].map(kind=>[kind,assets.filter(a=>a.kind===kind).length]));
write('audit-manifest',{profile:'apk-12075-rules-4300',source_path:sourcePath,source_sha256:reference.sha,
  symbols:functions.length,command_candidates:commands.length,tutorials:tutorials.length,assets:counts,
  coverage_entries:coverage.length,purpose:'reference-source-inventory',
  original_method_samples:samples.length,recruitment_samples:hireFixtures.length,
  limitations:['Source inventory is not current product coverage','Asset presence is not visual QA','Reference fixtures do not prove online server equivalence','Current product scope: docs/development/feature-availability.md']});
console.log(JSON.stringify({symbols:functions.length,commands:commands.length,tutorials:tutorials.length,assets:counts,coverage:coverage.length,reference_samples:samples.length},null,2));
