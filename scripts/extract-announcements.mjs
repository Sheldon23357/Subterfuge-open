import fs from 'node:fs';
import {readReference} from './reference-functions.mjs';
const ref=readReference();
const owner=ref.tree.statements.find(n=>n.name?.text==='Hne');
const method=owner.members.find(n=>n.name?.getText(ref.tree)==='handleSpecialistPromoted');
const mine=owner.members.find(n=>n.name?.getText(ref.tree)==='handleCreateMine');
const lifecycle=['handlePlayerJoined','handlePlayerLeft','handleGameStarting','handleGameStarted'].map(name=>{const node=owner.members.find(n=>n.name?.getText(ref.tree)===name);if(!node)throw Error('Missing '+name);return node.getText(ref.tree);});
if(!method||!mine)throw Error('Announcement handler missing');
const code=`// @ts-nocheck
// Exact APK 12075 notification handler. Do not format. SHA256 ${ref.sha}.
import {SPECIALISTS} from '../../rules/src/reference.js';
const kt=Object.fromEntries(SPECIALISTS.map(s=>[s.client_type_id,{name:s.name_en}]));
const te={getScreenName:(_info,seat)=>String(seat)},De={Occupied:1},B={Nothing:0,Outpost:1},yn={Normal:0,Urgent:1};
class Listener{${method.getText(ref.tree)}
${mine.getText(ref.tree)}
${lifecycle.join('\n')}}
export function originalPromotionRecipients(players,owner,type){
 const recipients=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player)=>recipients.push(player);
 listener.handleSpecialistPromoted({info:{maxPlayerCount:players.length},playerStates:{get:i=>({seatState:players[i].active?1:4})},world:{specialists:{get:()=>({ownerIndex:owner,type})}}},0);
 return recipients;
}
export function originalMineRecipients(players,owner){
 const recipients=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player)=>recipients.push(player);
 listener.handleCreateMine({info:{maxPlayerCount:players.length},playerStates:{get:i=>({seatState:players[i].active?1:4})},world:{outposts:{get:()=>({ownerIndex:owner})}}},0);
 return recipients;
}
export function originalLifecycleNotices(kind,capacity,occupied,actor,secondsUntilGameInProgress=0){
 const methods={join:'handlePlayerJoined',leave:'handlePlayerLeft',starting:'handleGameStarting',started:'handleGameStarted'};
 const method=methods[kind];if(!method)throw Error('Invalid lifecycle notice');
 const notices=[];const listener=Object.create(Listener.prototype);
 listener.handleEvent=(_state,player,_type,_index,text,_details,notify,priority)=>notices.push({player,text,notify,priority});
 listener[method]({info:{maxPlayerCount:capacity,playerCount:occupied},secondsUntilGameInProgress},actor);
 return notices;
}
`;
const path='packages/engine/src/original-announcements.generated.ts';
if(process.argv.includes('--check')){if(fs.readFileSync(path,'utf8').replace(/\r\n/g,'\n')!==code.replace(/\r\n/g,'\n'))throw Error('Announcements differ from APK');}else fs.writeFileSync(path,code);
