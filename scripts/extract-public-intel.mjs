import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference(),fn=ref.tree.statements.find(n=>n.name?.text==='lye');
if(!fn)throw Error('Original intel builder missing');
const nodes=[];function visit(n){nodes.push(n);ts.forEachChild(n,visit);}visit(fn);
const declaration=nodes.find(n=>ts.isVariableStatement(n)&&n.getText(ref.tree).startsWith('const w = n.world.cachedValues.get(v)'));
const active=nodes.find(n=>ts.isVariableDeclaration(n)&&n.name.getText(ref.tree)==='R');
const row=nodes.find(n=>ts.isCallExpression(n)&&n.expression.getText(ref.tree)==='h.push')?.arguments[0];
const keys=['neptunium','npPerDay','outposts','numOutposts','drillers','output','drillerRate'];
if(!declaration||!active||!ts.isObjectLiteralExpression(row))throw Error('Original intel shape changed');
const properties=keys.map(k=>{const p=row.properties.find(p=>p.name?.getText(ref.tree)===k);if(!p)throw Error(k);return p.getText(ref.tree);});
const code=`// @ts-nocheck
// Verbatim lye public-intel statistics and expressions, APK12075. Do not format. SHA256 ${ref.sha}
const De={Occupied:1},pe={Mine:0,Generator:2,Factory:1};
export function originalPublicIntelStatistics(n,v,productionRate){
 const V={calculateDrillerProductionRateByPlayer:productionRate};
 ${declaration.getText(ref.tree)}
 const ${active.getText(ref.tree)};
 return {active:R,${properties.join(',\n')}};
}
`;
const path='packages/engine/src/original-public-intel.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Public intel differs from APK');}else fs.writeFileSync(path,code);
