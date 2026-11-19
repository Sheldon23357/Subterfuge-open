import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const node=name=>{const n=ref.tree.statements.find(n=>n.name?.text===name);if(!n)throw Error(name);return n;};
const names=['handleSubDeparture','handleSubChangedCourse','handleSubArrivalToDormantOutpost','handleSubArrivalWithCombat','handlePlayerEliminated','handleInTransitCombat','handleGameOver','notifyOfSentryFire','handleSentryFired','handleDoubleAgentActivated','handleSpecialistHired','handleFundingSet','handleFundingNoLongerValid','handleInactivityWarning','handlePlayerResigned','handleSpecialistReleased','handleSpecialistPromoted','handleCreateMine','handleNewHireAvailable'];
const methods=names.map(name=>{const m=node('Hne').members.find(m=>m.name?.getText(ref.tree)===name);if(!m)throw Error(name);return m.getText(ref.tree);}).join('\n');
const deliveryGate=node('Pc').members.find(m=>m.name?.getText(ref.tree)==='handleEvent').body.statements[0].getText(ref.tree);
const code=`// @ts-nocheck
// Verbatim Hne gameplay notification dispatch, APK 12075. Do not format. SHA256 ${ref.sha}.
import {RULES,SPECIALISTS} from '../../rules/src/reference.js';
import {originalFleetTravelMinutes,originalPointVisible,originalCountSpecialists} from './original-specialist-economy.generated.js';
const he=RULES.GameParams;
const B={Nothing:0,Outpost:1,Sub:2,Specialist:3},pe={Mine:0},He={Moving:'moving'},Ns={SubWon:1};
const De={Occupied:1,Resigned:2,AutoResigned:3,Eliminated:4},yn={Urgent:0,Normal:1},K={MaxWinnerCount:10},ke={Ended:4};
const q=Object.fromEntries(SPECIALISTS.map(s=>[s.id,s.client_type_id]));
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const Z=()=>{};
const Bi=(o,i)=>o.label??String(i);
const te={getScreenName:(_info,seat)=>'P'+seat,isAlly:(info,a,b)=>a===b||a>=0&&b>=0&&info.teamSize>0&&Math.floor(a/info.teamSize)===Math.floor(b/info.teamSize)};
const V={getSubTravelTimeInMinutes:originalFleetTravelMinutes,countSpecialistOfType:originalCountSpecialists,getItemOwnerIndex:(w,l)=>l.type===1?w.outposts.get(l.index).ownerIndex:l.type===2?w.subs.get(l.index).ownerIndex:-1};
const wn={isVisibleForPlayer:originalPointVisible};
const qn={getType:(o)=>o.private_type};
const ut={getWinningPlayers:(state,out)=>{state.winners.forEach((seat,i)=>out[i]=seat);return state.winners.length;}};
${node('YG').getText(ref.tree)}
${node('MI').getText(ref.tree)}
class Listener{${methods}}
export function originalGameplayNotifications(state,method,args){
 const result=[],listener=Object.create(Listener.prototype);
 listener.handleEvent=(e,t,locationType,locationIndex,text,details,sendNotification,priority,_record,attack)=>{${deliveryGate}
 result.push({player:t,locationType,locationIndex,text,details,sendNotification,generateAlert:_record??true,urgent:priority===yn.Urgent,...(attack?{attack}:{})});};
 if(!${JSON.stringify(names)}.includes(method))throw Error('Unsupported original notification');
 listener[method](state,...args);return result;
}
`;
const path='packages/engine/src/original-notifications.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Notifications differ from locked APK');}else fs.writeFileSync(path,code);
