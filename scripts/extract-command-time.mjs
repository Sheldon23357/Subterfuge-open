import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const methods=(owner,names)=>names.map(name=>{
  const c=ref.tree.statements.find(n=>n.name?.text===owner),m=c?.members.find(n=>n.name?.getText(ref.tree)===name);
  if(!m)throw Error(`${owner}.${name}`);return m.getText(ref.tree);
}).join('\n');
const course=ref.tree.statements.find(n=>n.name?.text==='kr')?.members.find(n=>n.name?.getText(ref.tree)==='changeSubCourse');
const delays=[];
function visit(node){if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(ref.tree)==='s.secsUntilLaunch'&&node.right.getText(ref.tree).includes('he.MinutesToCancelAction'))delays.push(node.right.getText(ref.tree));ts.forEachChild(node,visit);}
if(!course)throw Error('kr.changeSubCourse missing');visit(course);
if(delays.length!==1)throw Error('Navigator delay assignment changed');
const code=`// @ts-nocheck
// Verbatim APK12075 time-dependent getters. Do not format. SHA256 ${ref.sha}
import {RULES} from '../../rules/src/reference-profile.js';
const he=RULES.GameParams,pe={Mine:0},He={WaitingForLaunch:'waiting',WaitingForCourseChange:'changing-course'};
class qn{${methods('qn',['GetSecondsUntilShieldDisable','isMiningInProgress','getType'])}}
class Jt{${methods('Jt',['getSecondsUntilLaunch','isGift','isBeingGifted'])}}
export const originalCommandTime={courseDelaySeconds:()=>${delays[0]},shieldRemaining:qn.GetSecondsUntilShieldDisable,mining:qn.isMiningInProgress,outpostType:qn.getType,launchRemaining:Jt.getSecondsUntilLaunch,gift:Jt.isGift,gifting:Jt.isBeingGifted};
`;
const path='packages/engine/src/original-command-time.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Command-time extraction differs from APK');}else fs.writeFileSync(path,code);
