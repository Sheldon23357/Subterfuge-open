import {createHash} from 'node:crypto';
import {projectPlayerNotifications} from '../../engine/src/index.js';
import type {ChatMessage,CommanderThread} from '../../contracts/src/index.js';
import type {DurableDomainDocument} from './durable-domain-store.js';
import type {ChatStore} from './chat.js';
import type {CommanderStore} from './commander-store.js';
import type {LabRoom} from './planning.js';
import type {PlayerProtocolRepository} from './player-protocol-store.js';
import {PlayerObservationReader} from './player-observation.js';
const visible=(m:ChatMessage,player:number)=>m.to===null||m.from===player||(Array.isArray(m.to)?m.to.includes(player):m.to===player);
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
const EMPTY_CHAT=JSON.stringify({format:'chat-store/2',messages:[],reads:[]}),EMPTY_COMMANDER=JSON.stringify({format:'commander-store/1',threads:[]});
/** Connects existing world/domain stores to one durable filtered protocol cut. No model dependency. */
export class PlayerProtocolCoordinator {
 private observations=new PlayerObservationReader();
 private worldRevision=0;
 private chatDocument:DurableDomainDocument|undefined;private commanderDocument:DurableDomainDocument|undefined;
 private chat:ChatStore|undefined;private commander:CommanderStore|undefined;
 constructor(readonly repository:PlayerProtocolRepository,private options:{roomId:()=>string;load:()=>LabRoom;seconds?:()=>number;chatIdentity?:(player:number)=>{player:number;count:number}}){}
 private epoch=()=>this.repository.currentEpoch(this.options.roomId());
 private identity(player:number){return this.options.chatIdentity?.(player)??{player,count:this.options.load().state.economy.players.length};}
 async bindDomains(chat:ChatStore,commander:CommanderStore){
  await chat.bindDurable(this.chatDocument??=this.repository.domainDocument(this.epoch,'chat','journal',(before,after)=>{
   const old=JSON.parse(before) as {messages:ChatMessage[]},next=JSON.parse(after) as {messages:ChatMessage[]};
   const room=this.options.load();for(let player=0;player<room.state.economy.players.length;player++){const seat=this.identity(player).player,a=old.messages.filter(m=>visible(m,seat)),b=next.messages.filter(m=>visible(m,seat));if(hash(a)!==hash(b))this.repository.domainEvent(this.options.roomId(),player,'chat.changed',{cursor:String(b.length)},true);}
  }));
  await commander.bindDurable(this.commanderDocument??=this.repository.domainDocument(this.epoch,'commander','journal',(before,after)=>{
   const old=JSON.parse(before) as {threads:CommanderThread[]},next=JSON.parse(after) as {threads:CommanderThread[]},roomId=this.options.roomId();
   const room=this.options.load();for(let player=0;player<room.state.economy.players.length;player++){const a=old.threads.find(t=>t.roomId===roomId&&t.player===player),b=next.threads.find(t=>t.roomId===roomId&&t.player===player);if(hash(a)!==hash(b)){const changed=(a?.directives.version??0)!==(b?.directives.version??0)||(a?.directives.text??'')!==(b?.directives.text??'');this.repository.domainEvent(roomId,player,changed?'instructions.changed':'commander.changed',{instructionsVersion:String(b?.directives.version??0)},changed);}}
  }));this.chat=chat;this.commander=commander;
 }
 /** Invoke from a store onCommit callback, before the shared outer SQLite commit. */
 worldCommitted(room:LabRoom,options:{reset?:boolean;seatMapping?:{lobbySeat:number;gameSeat:number}[]}={}){
  const roomId=room.playerRoomId??this.options.roomId(),epoch=this.repository.ensureEpoch(roomId,room.state.economy.players.length,{...(options.reset?{fork:true}:{}),...(options.seatMapping?{subjectMapping:options.seatMapping.map(m=>({oldPlayer:m.lobbySeat,newPlayer:m.gameSeat})),transformDomain:(domain:string,payload:string)=>{if(domain==='chat')return payload;if(domain==='commander'){const data=JSON.parse(payload) as {format:string;threads:CommanderThread[]};data.threads=data.threads.flatMap(thread=>{if(thread.roomId!==roomId)return[];const map=options.seatMapping!.find(m=>m.lobbySeat===thread.player);return map?[{...thread,player:map.gameSeat}]:[];});return JSON.stringify(data);}return null;}}:{})});
  if(epoch.created){this.repository.domainDocument(epoch.roomEpoch,'chat','journal').initialize(EMPTY_CHAT,null);this.repository.domainDocument(epoch.roomEpoch,'commander','journal').initialize(EMPTY_COMMANDER,null);}
  this.refreshWorld(room,roomId);
 }
 refreshWorld(room=this.options.load(),roomId=this.options.roomId()){return this.repository.atomic(()=>{
  this.worldRevision++;
  for(let player=0;player<room.state.economy.players.length;player++){
   this.repository.observe(roomId,player,this.observations.read(room,player,roomId,this.worldRevision,this.options.seconds?.()).revision,room.state.economy.tick);
   const notifications=projectPlayerNotifications(room.state,player),digest=hash(notifications),doc=this.repository.domainDocument(this.repository.currentEpoch(roomId),'projection',`notifications-${player}`),prior=doc.read();
   if(prior===null)doc.initialize(digest,null);else if(prior!==digest)doc.transact(()=>{this.repository.domainEvent(roomId,player,'notifications.changed',{cursor:String(notifications.length)},true);return{payload:digest,result:undefined};});
  }
  this.repository.updateScheduleReceipts(roomId,[...room.scheduled,...(room.scheduledOrders??[])]);
 });}
 capabilities(){return this.chat&&this.commander?['chat.read/1','chat.send/1','commander.read/1','commander.worker/1','notifications.read/1']:[];}
 instructionsVersion(player:number){return String(this.commander?.version(this.options.roomId(),player)??0);}
 snapshot(player:number){const room=this.options.load(),scope=this.repository.scope(this.options.roomId(),this.epoch(),player),chatSeat=this.identity(player),messages=this.chat?.listForSeat(chatSeat.player),notifications=projectPlayerNotifications(room.state,player).map((notice,id)=>({...notice,id}));
  return{observation:this.observations.read(room,player,scope.roomId,this.worldRevision,this.options.seconds?.()),turnDeadline:this.repository.deadlineInfo(scope.roomId,room.state.economy.tick),instructionsVersion:this.instructionsVersion(player),...(this.commander?{commander:this.commander.read(scope.roomId,player)}:{}),...(messages?{chat:{messages:messages.slice(-200),cursor:String(messages.length),fromExclusive:String(Math.max(0,messages.length-200)),conversations:this.chat!.conversationsForSeat(chatSeat.player)}}:{}),notifications:{notifications:notifications.slice(-200),cursor:String(notifications.length),fromExclusive:String(Math.max(0,notifications.length-200))},coverage:{observation:'complete',chat:messages?'bounded-tail-with-complete-cursor':'not-supported',notifications:'bounded-tail-with-complete-cursor',commander:this.commander?'complete':'not-supported'}};
 }
}
