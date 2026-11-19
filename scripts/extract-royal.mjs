import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const methods=(owner,names)=>node(owner).members.filter(m=>names.includes(m.name?.getText(ref.tree))||(owner==='G'&&ts.isConstructorDeclaration(m))).map(m=>m.getText(ref.tree)).join('\n');
const code=`// @ts-nocheck
// Verbatim numerical/lifecycle excerpts, APK 12075. Do not format this generated file.
// Source SHA256 ${ref.sha}. Regenerate: node scripts/extract-royal.mjs
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,$e=RULES.SpecialistParams;
const q={Queen:'Queen',Princess:'Princess',SecurityChief:'SecurityChief',Inspector:'Inspector',King:'King'};
const B={Specialist:3},De={Available:0,Occupied:1,Resigned:2,Eliminated:3},ta=340282347e30,Zn=999999974e-13;
const Z=c=>{if(!c)throw Error('Original royal assertion');};
const So=n=>Number.isInteger(n)?n>>31|1:n>=0?1:-1;
class Hc{};class G extends Hc{${methods('G',['add','subtract','lengthSqr'])}}
class we{constructor(type,index){this.type=type;this.index=index;}}
class V{
${methods('V',['getUnwrappedPosWithDimensions','getMinDistSquared','changeSpecialistOwnership'])}
static isSpecialistCaptive(w,i){return w.specialists.get(i).captive;}
static getItemPosition(w,location){return w.specialists.get(location.index).position;}
}
class ut{
${methods('ut',['eliminatePlayer'])}
static setSeatState(n,i,value){n.playerStates.get(i).seatState=value;}
static getGameTimeInSeconds(n){return n.seconds;}
}
const dt={getPuzzleIndex:()=>-1};
const fo=(n,i)=>n.playerStates.get(i).timeOfDeathInSecs<0;
const te={getScreenName:(_n,i)=>String(i)};
class kr{${methods('kr',['resign'])}}
${['j2e','q2e','X2e','Q2e','kH'].map(n=>node(n).getText(ref.tree)).join('\n')}
export const originalResign=(n,i)=>kr.resign(n,i);
export const originalInherit=j2e;
export const originalQueenPositions=Q2e;
export const originalChangeOwnership=V.changeSpecialistOwnership;
export const originalQueenLoss=X2e;
export const originalShieldMaximum=kH;
`;
const path='packages/engine/src/original-royal.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Royal extraction differs from APK');console.log('Royal excerpts match locked APK.');}else fs.writeFileSync(path,code);


