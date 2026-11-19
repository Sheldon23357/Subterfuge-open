import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
let clause;
const visit=n=>{if(ts.isCaseClause(n)&&n.expression.getText(ref.tree)==='q.Martyr')clause=n;ts.forEachChild(n,visit);};visit(node('r2e'));
if(!clause)throw Error('Martyr branch missing');
const body=clause.statements[0].statements.filter(s=>!ts.isBreakStatement(s)).map(s=>s.getText(ref.tree)).join('\n');
const destroy=node('V').members.find(m=>m.name?.getText(ref.tree)==='destroyOutpost').getText(ref.tree);
const code=`// @ts-nocheck
// Original r2e Martyr branch and blast helpers. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-martyr.mjs
import {RULES} from '../../rules/src/reference-profile.js';
import {clientDistanceSquared} from './client-geometry.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,B={Outpost:1,Sub:2},pe={Destroyed:3};
const te={getScreenName:(_n,i)=>String(i)};
class V{
static getMinDistSquared(a,b,width,height){return clientDistanceSquared(a,b,{width,height});}
static getItemPosition(w,p){return(p.type===B.Outpost?w.outposts.get(p.index):w.subs.get(p.index)).pos;}
static isSpecialistCaptive(w,index){const p=w.specialists.get(index);return p.ownerIndex!==(p.location.type===B.Outpost?w.outposts.get(p.location.index):w.subs.get(p.location.index)).ownerIndex;}
${destroy}
}
${['hX','o2e','l2e'].map(name=>node(name).getText(ref.tree)).join('\n')}
export function originalMartyrBlast(e,n,r){const i=e.world.specialists.get(r);let l=false;${body};return l;}
`;
const path='packages/engine/src/original-martyr.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Martyr extraction differs');console.log('Martyr branch matches locked APK.');}else fs.writeFileSync(path,code);
