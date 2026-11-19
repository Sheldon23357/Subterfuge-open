import {createServer,type IncomingMessage} from 'node:http';
import {createHash} from 'node:crypto';
import {PlayerAccess,SerialExecutor} from './player-access.js';
import type {LobbyStore} from './lobby-store.js';
import {projectWaitingLobby,submitLobbyMembership} from './waiting-lobby.js';
import {projectLobbyEvents} from './lobby-events.js';

async function readCommand(req:IncomingMessage){
 const chunks:Buffer[]=[];let length=0;
 for await(const chunk of req){length+=chunk.length;if(length>2048)throw Error('Request too large');chunks.push(Buffer.from(chunk));}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!['id','kind','revision'].every(k=>Object.hasOwn(value,k)))throw Error('Invalid command');
 if(typeof value.id!=='string'||!value.id.length||value.id.length>128||!['join','leave','cancel','start'].includes(value.kind)||!Number.isSafeInteger(value.revision)||value.revision<1)throw Error('Invalid command');
 return value as {id:string;kind:'join'|'leave'|'cancel'|'start';revision:number};
}
/** Seat credentials are issued locally by the host. No anonymous seat claiming,
 * identity overrides, admin world data or credential distribution on this API.
 * Load inside the queue and commit before responding, including after restart.
 */
export function createLobbyApi(store:LobbyStore,options:{serial?:SerialExecutor;sync?:()=>Promise<void>;start?:(id:string,player:number,revision:number)=>Promise<void>}={}){
 const serial=options.serial??new SerialExecutor();
 return createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url??'/','http://localhost');
   const eventsPath=url.pathname==='/lobby/v2/events';
   if(url.pathname!=='/lobby/v2'&&url.pathname!=='/lobby/v2/commands'&&!eventsPath){send(404,{error:'Not found'});return;}
   // Authenticate before consuming request bodies. Repeat against the stored
   // identity inside the serialized operation, rather than trusting this read.
   const initial=store.current();if(!initial){send(503,{error:'Lobby unavailable'});return;}
   if(new PlayerAccess(initial.lobby.access).identity(req.headers.authorization)===null){send(401,{error:'Unauthorized'});return;}
   if(url.search&&!eventsPath){send(400,{error:'Query parameters are not supported'});return;}
   const reading=req.method==='GET'&&(url.pathname==='/lobby/v2'||eventsPath);
   const writing=req.method==='POST'&&url.pathname==='/lobby/v2/commands';
   if(!reading&&!writing){send(405,{error:'Method not allowed'});return;}
   let command:Awaited<ReturnType<typeof readCommand>>|undefined;
   if(writing){try{command=await readCommand(req);}catch{send(400,{error:'Invalid command'});return;}}
   await serial.run(async()=>{
    await options.sync?.();
    let current=store.current();if(!current){send(503,{error:'Lobby unavailable'});return;}
    const player=new PlayerAccess(current.lobby.access).identity(req.headers.authorization);
    if(player===null){send(401,{error:'Unauthorized'});return;}
    if(eventsPath){
     const a=url.searchParams.get('after')??'0',l=url.searchParams.get('limit')??'100';
     if([...url.searchParams.keys()].some(k=>!['after','limit'].includes(k))||url.searchParams.getAll('after').length>1||url.searchParams.getAll('limit').length>1||!/^\d+$/.test(a)||!/^\d+$/.test(l)){send(400,{error:'Invalid event cursor'});return;}
     const after=Number(a),limit=Number(l),all=projectLobbyEvents(current,player);
     if(!Number.isSafeInteger(after)||after<0||after>all.length||!Number.isInteger(limit)||limit<1||limit>200){send(400,{error:'Invalid event cursor'});return;}
     const events=all.slice(after,after+limit);send(200,{roomId:current.lobby.access.roomId,events,nextCursor:after+events.length,hasMore:after+events.length<all.length});return;
    }
    const view=()=>({...projectWaitingLobby(current!.lobby),...((current!.runtime?.room??current!.waitingRoom)?.timing?{timing:(current!.runtime?.room??current!.waitingRoom)!.timing}:{}),player,revision:current!.revision,...(current!.start?{status:current!.runtime!.status,secondsRemaining:current!.runtime!.secondsRemaining,gameSeat:current!.start.prepared.seatMapping.find(s=>s.lobbySeat===player)?.gameSeat??null}: {})});
    if(!command){send(200,view());return;}
    // User-local IDs cannot collide with another seat's accepted command IDs.
    const id=`p${player}-`+createHash('sha256').update(command.id).digest('hex');
    const prior=current.lobby.commands.find(c=>c.id===id);
    if(prior){
     if(prior.kind!==command.kind){send(409,{error:'Command id conflict'});return;}
     send(200,{...view(),accepted:true,duplicate:true});return;
    }
    if(command.kind==='start'){
     if(!options.start){send(400,{error:'Start endpoint unavailable'});return;}
     if(player!==0||current.lobby.seats[0]!==1){send(403,{error:'Only the joined host can start'});return;}
     if(current.start){if(current.start.id!==id){send(409,{error:'Lobby has already started'});return;}send(200,{...view(),accepted:true,duplicate:true});return;}
     if(command.revision!==current.revision||current.lobby.status!=='waiting'||current.lobby.seats.filter(s=>s===1).length<2){send(409,{error:'Lobby cannot start at this revision'});return;}
     await options.start(id,player,command.revision);current=store.current()!;send(200,{...view(),accepted:true,duplicate:false});return;
    }
    if(current.start){send(409,{error:'Lobby has already started'});return;}
    if(command.revision!==current.revision){send(409,{error:'Stale lobby revision',lobby:view()});return;}
    let next;
    try{next=submitLobbyMembership(current.lobby,{id,player,kind:command.kind});}
    catch{send(409,{error:'Lobby command rejected'});return;}
    // Only the compare-and-swap race is a conflict. Storage faults must not
    // masquerade as accepted operations or leak paths/SQL/credentials.
    let revision:number;
    try{revision=store.commit(next,current.revision);}catch(e){if(e instanceof Error&&e.message==='Stale lobby revision'){send(409,{error:'Stale lobby revision'});return;}throw e;}
    send(200,{...projectWaitingLobby(next),...(current.waitingRoom?.timing?{timing:current.waitingRoom.timing}:{}),player,revision,accepted:true,duplicate:false});
   });
  }catch{if(!res.headersSent)send(503,{error:'Lobby unavailable'});else res.end();}
 });
}
