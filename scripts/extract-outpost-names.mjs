import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const declaration=name=>{
 for(const statement of ref.tree.statements){
  if(statement.name?.text===name)return statement.getText(ref.tree);
  if(ts.isVariableStatement(statement))for(const d of statement.declarationList.declarations)if(d.name.getText(ref.tree)===name)return `const ${d.getText(ref.tree)};`;
 }
 throw Error(`Missing original declaration: ${name}`);
};
const output=`// @ts-nocheck
// Verbatim APK 12075 naming excerpts; regenerate with scripts/extract-outpost-names.mjs.
// SHA256 ${ref.sha}
const Z=(value)=>{if(!value)throw Error('Original naming assertion');};
const K={MaxOutpostCount:100};
${['MPe','I3','p0','mX','HG','Q1','E2e','Ane','JG','yne'].map(declaration).join('\n\n')}

/** Current pool by default; historical creation timestamps retain original positional names. */
export function originalOutpostNames(seed:number,count:number,createdAt:number=HG[HG.length-1].from):string[]{
 if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new RangeError('Invalid name seed');
 if(!Number.isInteger(count)||count<0||count>K.MaxOutpostCount)throw new RangeError('Invalid outpost count');
 const epoch=Ane(createdAt);
 const indices=epoch&&JG(epoch).length>=Q1?yne(seed,epoch):Array.from({length:Q1},(_,i)=>i);
 return indices.slice(0,count).map(i=>mX[i]);
}
`;
const path='packages/engine/src/outpost-names.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==output.replace(/\r\n/g,'\n'))throw Error('Outpost naming extraction differs from APK');console.log('Outpost naming excerpts match locked APK.');}
else fs.writeFileSync(path,output);
