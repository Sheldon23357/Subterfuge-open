import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference(),fn=ref.tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='bX');
if(!fn)throw Error('Missing original recall');
const code=`// @ts-nocheck
// Verbatim APK12075 bX recall. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-recall.mjs
const B={Outpost:1};
class we{constructor(type,index){this.type=type;this.index=index;}}
const V={setSpecialistLocation:(world,index,location)=>world.hooks.relocate(index,location),destroySub:(state,index)=>state.hooks.destroy(index)};
${fn.getText(ref.tree)}
export const originalRecallSub=bX;
`;
const path='packages/engine/src/original-recall.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Recall extraction differs from APK');}else fs.writeFileSync(path,code);
