import {originalLobby} from '../../engine/src/index.js';
import {PlayerAccess,type PlayerAccessFile} from './player-access.js';

export interface LobbyMembershipCommand {id:string;player:number;kind:'join'|'leave'|'cancel'}
export interface WaitingLobby {
 format:'waiting-lobby/1';access:PlayerAccessFile;status:'waiting'|'cancelled';
 seats:(0|1)[];commands:LobbyMembershipCommand[];
}
function exact(value:unknown,fields:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid lobby record');
 const record=value as Record<string,unknown>;
 if(Object.keys(record).length!==fields.length||fields.some(f=>!Object.hasOwn(record,f)))throw Error('Invalid lobby fields');return record;
}
export function createWaitingLobby(access:PlayerAccessFile):WaitingLobby{
 exact(access,['format','roomId','credentials']);if(!Array.isArray(access.credentials))throw Error('Invalid lobby credentials');
 for(const credential of access.credentials)exact(credential,['player','token']);
 new PlayerAccess(access);
 return{format:'waiting-lobby/1',access:structuredClone(access),status:'waiting',seats:access.credentials.map(()=>0),commands:[]};
}
/** Membership-only waiting stage. No game world has been attached yet, so no
 * fleet commands can enter this model. World creation/start is a later atomic
 * transition; do not mistake this for the full original pre-game world.
 */
export function submitLobbyMembership(lobby:WaitingLobby,raw:LobbyMembershipCommand):WaitingLobby{
 exact(raw,['id','player','kind']);
 if(typeof raw.id!=='string'||!raw.id.length||raw.id.length>128||!Number.isInteger(raw.player)||raw.player<0||raw.player>=lobby.seats.length||!['join','leave','cancel'].includes(raw.kind))throw Error('Invalid lobby command');
 const prior=lobby.commands.find(c=>c.id===raw.id);
 if(prior){if(prior.player!==raw.player||prior.kind!==raw.kind)throw Error('Lobby command id conflict');return lobby;}
 const next=structuredClone(lobby),seats=next.seats.map(seatState=>({seatState}));
 const bridge={status:next.status==='waiting'?1:5,info:{maxPlayerCount:seats.length,playerCount:seats.filter(p=>p.seatState===1).length},
  playerStates:{get:(i:number)=>seats[i]!},world:{subs:{count:0,get:()=>{throw Error('No world in membership stage');}}},
  hooks:{cancelSub:()=>{throw Error('No world in membership stage');}},listener:{handlePlayerJoined:()=>{},handlePlayerLeft:()=>{}}};
 if(!originalLobby[raw.kind](bridge,raw.player))throw Error('Lobby command rejected');
 next.status=bridge.status===5?'cancelled':'waiting';next.seats=seats.map(p=>p.seatState);
 next.commands.push({id:raw.id,player:raw.player,kind:raw.kind});return next;
}
/** Public projection never includes join tokens or other players' command IDs. */
export function projectWaitingLobby(lobby:WaitingLobby){return{roomId:lobby.access.roomId,status:lobby.status,capacity:lobby.seats.length,occupied:lobby.seats.map(s=>s===1)};}
export function saveWaitingLobby(lobby:WaitingLobby){return JSON.stringify({format:'waiting-lobby-snapshot/1',access:lobby.access,commands:lobby.commands,expected:lobby});}
export function restoreWaitingLobby(text:string):WaitingLobby{
 const data=exact(JSON.parse(text),['format','access','commands','expected']);
 if(data.format!=='waiting-lobby-snapshot/1'||!Array.isArray(data.commands))throw Error('Invalid lobby snapshot');
 let lobby=createWaitingLobby(data.access as PlayerAccessFile);
 for(const command of data.commands){const next=submitLobbyMembership(lobby,command);if(next===lobby)throw Error('Duplicate lobby history');lobby=next;}
 if(JSON.stringify(lobby)!==JSON.stringify(data.expected))throw Error('Lobby snapshot and replay disagree');return lobby;
}
