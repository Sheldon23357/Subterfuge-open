import {mkdtempSync,rmSync,readFileSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import type {ProtocolCommandRequest,ExecutorScope,ProtocolSnapshotPage} from '../packages/contracts/src/index.js';
import {RoomStore} from '../packages/server/src/room-store.js';
import {createPlayerApi,observation} from '../packages/server/src/player-api.js';
import {applyProtocolGameCommand} from '../packages/server/src/player-commands.js';
import {PlayerAccess,SerialExecutor} from '../packages/server/src/player-access.js';
import {PlayerProtocolCoordinator} from '../packages/server/src/player-protocol-coordinator.js';
import type {PlayerProtocolHost} from '../packages/server/src/player-protocol-api.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {ChatStore} from '../packages/server/src/chat.js';
export function protocolHarness(t:TestContext,options:{room?:import('../packages/server/src/planning.js').LabRoom;roomId?:string}={}){
 const dir=mkdtempSync(join(tmpdir(),'player-protocol-fixture-')),path=join(dir,'room.sqlite');let wall=1_800_000_000_000,elapsed=100,store=new RoomStore(path,{wallNow:()=>wall,monotonicNow:()=>elapsed});
 const setup=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup,roomId=options.roomId??'fixture-room',room=structuredClone(options.room??{state:createFleetScenario(setup),scheduled:[]});room.playerRoomId=roomId;store.commit(room,0);const authority=store.protocol!.startAuthority(roomId,room.state.economy.players.length);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const generatedOwner=PlayerAccess.generate(room.state.economy.players.length),ownerCredentials={...generatedOwner,roomId},ownerAccess=new PlayerAccess(ownerCredentials);
 let grantNumber=0;
 const grant=(player=0,scopes:ExecutorScope[]=['observe','events.read','commands.write','control.lease'])=>{const token=`synthetic_fixture_only_${player}_${++grantNumber}_`+'x'.repeat(32),grantId=`fixture-grant-${grantNumber}`;store.protocol!.registerGrant({grantId,roomId,roomEpoch:store.protocol!.currentEpoch(roomId),player,tokenHash:createHash('sha256').update(token).digest('hex'),scopes,expiresAtMs:wall+1_000_000_000});return{token,principal:store.protocol!.authenticate('Bearer '+token)};};
 const first=grant();
 const session=store.protocol!.createSession(first.principal,'fixture-executor',['core/2']);const lease=store.protocol!.controlOperation(first.principal,'acquire',{roomEpoch:authority.roomEpoch,sessionId:session,idempotencyKey:'fixture-acquire'});
 const command=(id='fixture-command',overrides:Partial<ProtocolCommandRequest>={}):ProtocolCommandRequest=>({roomEpoch:authority.roomEpoch,sessionId:session,fence:lease.generation,authorizationVersion:'1',idempotencyKey:id,clientCommandId:id,expectedRevision:observation(store.load()!.room,0,roomId).revision,instructionsVersion:'0',kind:'order',payload:{action:{kind:'set-shields',outpostId:'蓝方工厂',enabled:false}},...overrides});
 return{dir,path,authority,first,session,lease,grant,command,ownerCredentials,ownerAccess,roomId,get store(){return store;},get repository(){return store.protocol!;},get wall(){return wall;},set wall(n:number){wall=n;},get elapsed(){return elapsed;},set elapsed(n:number){elapsed=n;},restore(snapshotPath:string){store.close();copyFileSync(snapshotPath,path);store=new RoomStore(path,{wallNow:()=>wall,monotonicNow:()=>elapsed});return store.protocol!.startAuthority(roomId,room.state.economy.players.length,{fork:true});},restart(fork=false){store.close();store=new RoomStore(path,{wallNow:()=>wall,monotonicNow:()=>elapsed});return store.protocol!.startAuthority(roomId,room.state.economy.players.length,{fork});},apply(request:ProtocolCommandRequest,player=0){const current=store.load()!,next=applyProtocolGameCommand(current.room,player,request);store.commit(next.room,current.revision);return next.effect;}};
}
export async function createOwnerProtocolHost(h:{repository:NonNullable<RoomStore['protocol']>;roomId:string;store:RoomStore;ownerAccess:PlayerAccess},options:{chat?:()=>ChatStore;commander?:CommanderStore;seconds?:()=>number;sync?:()=>Promise<void>;onDiagnostic?:(entry:import('../packages/server/src/request-diagnostics.js').RequestDiagnostic)=>void;serial?:SerialExecutor;onExternalControl?:(roomId:string,player:number)=>void;webRoot?:string;publicOrigin?:string}={}){
 h.repository.ownerControl(h.roomId,0,{action:'takeover',mode:'manual'});
 const chat=options.chat?.()??new ChatStore(),commander=options.commander??new CommanderStore(),coordinator=new PlayerProtocolCoordinator(h.repository,{roomId:()=>h.roomId,load:()=>h.store.load()!.room,...(options.seconds?{seconds:options.seconds}:{})});
 await coordinator.bindDomains(chat,commander);coordinator.refreshWorld();h.store.onCommit((room,_revision,reset)=>coordinator.worldCommitted(room,{reset}));
 const serial=options.serial??new SerialExecutor(),protocol:PlayerProtocolHost={onDiagnostic:options.onDiagnostic??(()=>{}),repository:h.repository,roomId:h.roomId,serial,...(options.publicOrigin?{publicOrigin:options.publicOrigin}:{}),load:()=>h.store.load()!,commit:(room,revision)=>h.store.commit(room,revision),ownerIdentity:authorization=>{const player=h.ownerAccess.identity(authorization);return player===null?null:{roomId:h.roomId,player};},chat:options.chat??(()=>chat),commander,snapshot:player=>coordinator.snapshot(player),capabilities:()=>coordinator.capabilities(),instructionsVersion:player=>coordinator.instructionsVersion(player),...(options.seconds?{seconds:options.seconds}:{}),...(options.sync?{sync:options.sync}:{}),...(options.onExternalControl?{onExternalControl:options.onExternalControl}:{})};
 return protocol;
}
export function snapshotDocument(first:ProtocolSnapshotPage,next:(token:string)=>ProtocolSnapshotPage){let page=first,text=page.page.text;while(page.page.nextPageToken){page=next(page.page.nextPageToken);text+=page.page.text;}return JSON.parse(text);}

/** Provision through the real owner boundary, so integration runtimes never use owner credentials as executor grants. */
export async function registerTestExecutor(baseUrl:string,ownerToken:string,scopes:ExecutorScope[]=['observe','events.read','commands.write','control.lease','chat.send','commander.worker']){
 const token=randomBytes(32).toString('base64url'),response=await fetch(new URL('/player/v2/owner/grants',baseUrl),{method:'POST',headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({grantId:'test-'+randomUUID(),tokenHash:createHash('sha256').update(token).digest('hex'),scopes,expiresAtMs:Date.now()+3600000})});
 if(response.status!==200)throw Error('Could not provision a v2 test executor: HTTP '+response.status);await response.json();return token;
}

export async function createOwnerPlayerApi(h:Parameters<typeof createOwnerProtocolHost>[0],options:NonNullable<Parameters<typeof createOwnerProtocolHost>[1]>={}){return createPlayerApi({protocol:await createOwnerProtocolHost(h,options),...(options.webRoot?{webRoot:options.webRoot}:{}),...(options.publicOrigin?{publicOrigin:options.publicOrigin}:{})});}
