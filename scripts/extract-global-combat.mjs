import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const statements=node('oX').body.statements;
const start=statements.findIndex(s=>s.getText(ref.tree).startsWith('let p = s.drillers'));
if(start<0)throw Error('Global damage phase missing');
const phase=statements.slice(start,start+4).map(s=>s.getText(ref.tree)).join('\n');
if(!phase.includes('if (g && Wa(n, r) >= 0)'))throw Error('Global damage phase boundary changed');
const declarations=ref.tree.statements.flatMap(s=>s.declarationList?.declarations??[]);
const accessors=['br','Rr','_s','Zo','Wa'].map(name=>`const ${declarations.find(d=>d.name.getText(ref.tree)===name).getText(ref.tree)};`).join('\n');
const code=`// @ts-nocheck
// Original oX General/King phase. Do not format. APK SHA256 ${ref.sha}
// Regenerate: node scripts/extract-global-combat.mjs
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams,q={General:'General',King:'King'},B={Sub:2,Outpost:1};
class we{constructor(type,index){this.type=type;this.index=index;}}
const te={getScreenName:(_info,i)=>String(i)};
const V={getSpecialistsAtLocation:(w,l)=>(l.type===B.Sub?w.subs.get(l.index):w.outposts.get(l.index)).specialistCache,
isSpecialistCaptive:(w,i)=>{const p=w.specialists.get(i);return p.ownerIndex!==(p.location.type===B.Sub?w.subs.get(p.location.index):w.outposts.get(p.location.index)).ownerIndex;}};
${accessors}
${node('uX').getText(ref.tree)}
export function originalGlobalCombat(n,e,t){
 const r={subIndex:e,otherLocation:t,outcome:0,combatText:'',combatTextMarker:0},s=n.world.subs.get(e);let l=false;
 ${phase}
 return r.combatText;
}
`;
const path='packages/engine/src/original-global-combat.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Global combat extraction differs');console.log('Global combat phase matches locked APK.');}else fs.writeFileSync(path,code);
