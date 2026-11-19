import fs from 'node:fs';
import ts from 'typescript';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
function method(owner,name){const cls=ref.tree.statements.find(n=>n.name?.text===owner),m=cls?.members.find(n=>n.name?.getText(ref.tree)===name);if(!m)throw Error(owner+'.'+name);return m;}
const update=method('ut','update');
const branch=update.body.statements.find(n=>ts.isIfStatement(n));
if(!branch||!branch.thenStatement.getText(ref.tree).includes('secondsUntilGameInProgress'))throw Error('Countdown branch changed');
const code=`// @ts-nocheck
// Verbatim APK12075 lobby methods/countdown branch. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-lobby.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,ke={WaitingToStart:1,Starting:2,InProgress:3,Cancelled:5},De={Available:0,Occupied:1};
const _a={createRandomWorld:(s,...args)=>s.hooks.recreate(...args),createBestWorldStartingAtSeed:()=>{throw Error('Unsupported historical world recreation');}};
const Ms={calculate:(_cache,s)=>s.hooks.recalculate()};
const bX=(s,i)=>s.hooks.cancelSub(i);
class ut{${method('ut','setSeatState').getText(ref.tree)}
static getGameTimeInSeconds(s){return s.hooks.gameSeconds();}}
class kr{${['joinGame','leaveGame','cancelGame','startGame'].map(name=>method('kr',name).getText(ref.tree)).join('\n')}}
export const originalLobby={join:kr.joinGame,leave:kr.leaveGame,cancel:kr.cancelGame,start:kr.startGame};
/** Only the Starting branch; running-game time is handled by the game clock. */
export function originalLobbyCountdown(t,e){
 if(t.status!==ke.Starting)throw Error('Expected starting lobby');
 t.secondsSinceCreation+=e;
 ${branch.thenStatement.getText(ref.tree)}
}
`;
const path='packages/engine/src/original-lobby.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Lobby extraction differs from APK');}else fs.writeFileSync(path,code);
