import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const methods=(owner,names)=>node(owner).members.filter(m=>names.includes(m.name?.getText(ref.tree))).map(m=>m.getText(ref.tree)).join('\n');
// Read constants from the original initializer; never maintain a separate winner table.
const kDecl=ref.tree.statements.flatMap(n=>n.declarationList?.declarations??[]).find(n=>n.name.getText(ref.tree)==='K');
const kText=kDecl.initializer.getText(ref.tree);
const winners=kText.match(/NumWinnersForNumPlayers:\s*(\[[^\]]+\])/)[1];
const code=`// @ts-nocheck
// Verbatim APK 12075 functions. Do not format. SHA256 ${ref.sha}
// Regenerate: node scripts/extract-endgame.mjs
import {RULES} from '../../rules/src/index.js';
const he=RULES.GameParams,il={v4300:RULES},K={MaxPlayerCount:10,MaxWinnerCount:5,NumWinnersForNumPlayers:${winners}};
const pe={Mine:0,Factory:1,Generator:2},ke={Ended:1},De={Occupied:1}; let of=null;
class te{${methods('te',['hasTeams','teamCount','teamOf','teamFirstSeat','teamEndSeat','getOutpostGoal'])}}
class ut{${methods('ut',['isGameOver','getTeamOutpostCount','getTeamNeptunium','isTeamAlive','getWinningPlayers','playerTableOrderCompareFunc','calculateTeamOrder','calculatePlayerTableOrder','getTeamRankBySeat'])}}
${['fy','_2e','$2e'].map(n=>node(n).getText(ref.tree)).join('\n')}
export function originalStandings(n){const order=[],teams=[],ranks=[],winners=[];ut.calculatePlayerTableOrder(n,order);ut.calculateTeamOrder(n,teams);ut.getTeamRankBySeat(n,ranks);ut.getWinningPlayers(n,winners);return {order:order.filter(i=>i>=0),teams:teams.filter(i=>i>=0),teamRanks:ranks.slice(0,n.info.maxPlayerCount),winners:winners.filter(i=>i>=0)};}
export function originalGameOver(n){const result={playerIndex:-1};const ended=ut.isGameOver(n,result);return {ended,player:result.playerIndex,team:result.playerIndex<0||!te.hasTeams(n.info)?-1:te.teamOf(n.info,result.playerIndex)};}
`;
const path='packages/engine/src/original-endgame.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Endgame extraction differs from APK');console.log('Endgame excerpts match locked APK.');}else fs.writeFileSync(path,code);

