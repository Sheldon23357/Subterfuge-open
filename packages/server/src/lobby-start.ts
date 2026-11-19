import {createFleetScenario,originalLobby,originalMapCandidate,applyGameplayMapComposition} from '../../engine/src/index.js';
import {roomFromMap,matchCreation} from './generated-room.js';
import {PlayerAccess,type PlayerAccessFile} from './player-access.js';
import {restoreWaitingLobby,saveWaitingLobby,type WaitingLobby} from './waiting-lobby.js';
import {saveRoom,restoreRoom,type LabRoom} from './planning.js';
import {LOBBY_START_DELAY_SECONDS} from '../../contracts/src/index.js';

export interface PreparedLobbyStart {
 format:'prepared-lobby-start/1';
 sourceLobby:string;
 access:PlayerAccessFile;
 seatMapping:{lobbySeat:number;gameSeat:number}[];
 room:LabRoom;
 secondsUntilGameInProgress:number;
 recreated:boolean;
}
/** Prepare everything privately before a caller atomically commits the lobby
 * transition and room. This does not mutate/publish the supplied lobby or world.
 * The caller must compare sourceLobby against the current membership at commit.
 */
export function prepareLobbyStart(lobby:WaitingLobby,player:number,seed:number,waitingRoom:LabRoom):PreparedLobbyStart{
 const sourceLobby=saveWaitingLobby(lobby),snapshot=restoreWaitingLobby(sourceLobby);
 if(player!==0||snapshot.status!=='waiting'||snapshot.seats[0]!==1)throw Error('Only the joined host can start a waiting lobby');
 const occupied=snapshot.seats.flatMap((s,i)=>s===1?[i]:[]),capacity=snapshot.seats.length;
 if(occupied.length<2)throw Error('At least two joined players are required');
 if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('Invalid start seed');
 // Copy and validate; the prepared result must own its map and command queue.
 const original=restoreRoom(saveRoom(waitingRoom,{trustedLocalStorage:true}),{trustedLocalStorage:true});
 if(original.state.economy.players.length!==capacity||original.clock||original.state.economy.tick!==0||(original.state.secondsSinceLastTick??0)!==0||original.state.activity?.some(p=>p.lastCheckinTime!==0))throw Error('Expected an unstarted waiting world');
 if(original.playerRoomId!==undefined&&original.playerRoomId!==snapshot.access.roomId)throw Error('Waiting world identity mismatch');
 const teamSize=original.state.economy.initial.teamSize;
 // Original team identity is floor(seat/teamSize). Only whole teams can be
 // compacted without silently assigning a player new formal allies.
 if(teamSize>0){
  for(let first=0;first<capacity;first+=teamSize){
   const count=snapshot.seats.slice(first,first+teamSize).filter(s=>s===1).length;
   if(count!==0&&count!==teamSize)throw Error('Incomplete teams cannot start');
  }
 }
 const rules=matchCreation(occupied.length,{mode:original.state.initial.match?.mode??'mining',teamSize,neptuniumGoal:original.state.initial.match?.neptuniumGoal??200});
 const recreated=occupied.length<capacity;
 // kr.startGame calls createRandomWorld at exactly the supplied seed, NOT the
 // 500-candidate selector. Server seed selection remains a separate concern.
 let room=original;
 if(recreated){
  const {valid,...candidate}=applyGameplayMapComposition(originalMapCandidate(occupied.length,seed),seed);
  if(!valid)throw Error('Start seed does not produce an eligible map');
  room=roomFromMap({...candidate,algorithm:'apk12075-rules4300',players:occupied.length,requestedSeed:seed,seed},rules);
 }
 if(original.timing){room.timing=structuredClone(original.timing);if(recreated&&original.timing.mode==='realtime'){const setup=structuredClone(room.state.initial);setup.match!.realtimeTickMilliseconds=original.timing.tickSeconds*1000;room.state=createFleetScenario(setup);}}
 room.playerRoomId=snapshot.access.roomId;
 const seats=occupied.map(()=>({lastCheckinTime:0}));let didRecreate=false;
 const state={status:1,info:{initialMaxPlayerCount:capacity,maxPlayerCount:capacity,playerCount:occupied.length,seed,percentGeneratorsMin:30,percentGeneratorsMax:60},
  world:{cachedValues:{}},playerStates:{get:(i:number)=>seats[i]!},secondsUntilGameInProgress:0,
  hooks:{gameSeconds:()=>0,recreate:(count:number,requestedSeed:number)=>{if(count!==occupied.length||requestedSeed!==seed||!recreated)throw Error('Unexpected recreation');didRecreate=true;},recalculate:()=>{}},
  listener:{handleGameStarting:()=>{}}};
 const queue={count:original.scheduled.length+(original.scheduledOrders?.length??0)};
 if(!originalLobby.start(state,player,seed,queue)||didRecreate!==recreated)throw Error('Original start transition failed');
 // The regenerated room starts with an empty agenda. A full room preserves its
 // actual map, reservations and queue; do not recreate it merely to unify paths.
 if(recreated&&(queue.count!==0||room.scheduled.length||(room.scheduledOrders?.length??0)))throw Error('Recreated queue must be empty');
 const access:PlayerAccessFile={format:'player-access/1',roomId:snapshot.access.roomId,credentials:occupied.map((seat,gameSeat)=>({player:gameSeat,token:snapshot.access.credentials[seat]!.token}))};
 new PlayerAccess(access);
 return{format:'prepared-lobby-start/1',sourceLobby,access,seatMapping:occupied.map((lobbySeat,gameSeat)=>({lobbySeat,gameSeat})),room,secondsUntilGameInProgress:LOBBY_START_DELAY_SECONDS,recreated};
}

export interface StoredLobbyStart {
 format:'stored-lobby-start/1';id:string;seed:number;startedAtMs:number;
 sourceRoom:string;prepared:PreparedLobbyStart;
}
/** Strict restart validation also recomputes the source-derived start result.
 * A checksum alone cannot prove that credentials correspond to the saved map.
 */
export function restoreLobbyStart(text:string):StoredLobbyStart{
 const raw=JSON.parse(text);
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==6||!['format','id','seed','startedAtMs','sourceRoom','prepared'].every(k=>Object.hasOwn(raw,k))||raw.format!=='stored-lobby-start/1'||typeof raw.id!=='string'||!raw.id.length||raw.id.length>128||!Number.isSafeInteger(raw.startedAtMs)||raw.startedAtMs<0||typeof raw.sourceRoom!=='string'||typeof raw.prepared?.sourceLobby!=='string')throw Error('Invalid stored lobby start');
 const sourceLobby=restoreWaitingLobby(raw.prepared.sourceLobby),sourceRoom=restoreRoom(raw.sourceRoom,{trustedLocalStorage:true});
 const prepared=prepareLobbyStart(sourceLobby,0,raw.seed,sourceRoom);
 if(JSON.stringify(prepared)!==JSON.stringify(raw.prepared))throw Error('Stored start disagrees with original transition');
 return{format:'stored-lobby-start/1',id:raw.id,seed:raw.seed,startedAtMs:raw.startedAtMs,sourceRoom:raw.sourceRoom,prepared};
}
