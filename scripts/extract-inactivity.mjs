import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const methods=(owner,names)=>node(owner).members.filter(m=>names.includes(m.name?.getText(ref.tree))).map(m=>m.getText(ref.tree)).join('\n');
const clear=node('kr').members.find(m=>m.name?.getText(ref.tree)==='perform').body.statements[0].getText(ref.tree);
const code=`// @ts-nocheck
// Verbatim APK 12075 inactivity functions. Do not format. Source SHA256 ${ref.sha}.
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,Re={CheckIn:'check-in'};
const K={MinutesPerTick:10,SecondsPerTick:600};
const De={Available:0,Occupied:1,Resigned:2,AutoResigned:3,Eliminated:4};
const fe={instance:()=>({isSimulatedFuture:n=>n.simulatedFuture})};
const V={destroySpecialist:()=>{throw Error('Legacy cleanup is not applicable to rules 4300');}};
class ut{
${methods('ut',['getMinutesSinceLastSeen'])}
static getGameTimeInSeconds(n){return n.seconds;}
}
class kr{
${methods('kr',['checkIn','cancelInactivityWarning'])}
static resign(n,i){return n.resign(i);}
}
${['H2e','J2e','K2e'].map(n=>node(n).getText(ref.tree)).join('\n')}
export function originalClearActivityWarnings(e,t){${clear}}
export const originalInactivity={tick:K2e,warningCount:H2e,checkIn:kr.checkIn,cancelWarning:kr.cancelInactivityWarning};
`;
const path='packages/engine/src/original-inactivity.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Inactivity extraction differs from APK');}else fs.writeFileSync(path,code);
