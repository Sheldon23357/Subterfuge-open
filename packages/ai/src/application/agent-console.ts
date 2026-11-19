import type {BotPluginCatalog} from './plugin-catalog.js';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {validateSettings} from '../controller/contracts/types.js';
import {MAX_AGENT_INSTANCES,type AgentSeatConfig} from '../controller/contracts/agent-config.js';
import type {ConsoleService} from './console-service.js';
import {sessionProviderPresets} from './agent-provider.js';
import {ConsoleBotLinks} from './console-bot-links.js';
import {PublishedConsoleStatus} from './console-status.js';
import {readBoundedResponse} from './bounded-response.js';

export interface ConsoleJob {id:string;seat:string;action:'start'|'pause';status:'running'|'completed'|'failed';error?:string}
export interface LocalAgentConnection {serverUrl:string;roomId:string;player:number;token:string}
export interface AgentConsoleOptions {plugins?:Pick<BotPluginCatalog,'list'|'install'|'scan'|'validate'>;port?:number;webRoot:string;provider:'offline'|'env';connectionMode?:'local'|'configured';checkpointActive?:()=>boolean;localConnections?:()=>Promise<LocalAgentConnection[]>;synchronize?:()=>Promise<void>;disconnect?:(id:string)=>Promise<void>}
type Runtime=ConsoleService;
function equal(a:unknown,b:string){if(typeof a!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function record(value:unknown):Record<string,unknown>{if(!object(value))throw Error('Invalid protocol response');return value;}
export interface AgentConnectionIdentity {serverUrl:string;roomId:string;lobbySeat:number;gamePlayer:number;chatPlayer:number;chatCount:number;roster:{chatPlayer:number;gamePlayer:number}[];lobbyConnection?:boolean;ownerCredential?:boolean}
export async function joinAgentRoom(serverUrl:unknown,roomCode:unknown,key:unknown,signal?:AbortSignal){
  if(typeof serverUrl!=='string'||serverUrl.length>2000||typeof roomCode!=='string'||!/^[A-Za-z0-9]{6}$/.test(roomCode)||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw Error('请填写服务器地址及 6 位房间码。');
  const url=new URL(serverUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Invalid server origin');
  const response=await fetch(new URL(`/api/rooms/${roomCode.toUpperCase()}/join`,url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  const text=await readBoundedResponse(response,8192,kind=>Error(kind==='missing'?'Missing room response':'Invalid room response'));
  const value=JSON.parse(text);if(!response.ok)throw Error(typeof value.error==='string'?value.error:'无法加入房间。');
  if(typeof value.playerToken!=='string'||!/^[a-f0-9]{64}$/.test(value.playerToken))throw Error('Invalid room credential');
  return value.playerToken as string;
}
/** Authenticate the entered player credential against the public v2 protocol only. */
export async function probeAgentConnection(serverUrl:unknown,playerToken:unknown,signal?:AbortSignal):Promise<AgentConnectionIdentity>{
  if(typeof serverUrl!=='string'||serverUrl.length>2000||typeof playerToken!=='string'||!/^[a-f0-9]{64}$/.test(playerToken))throw Error('Invalid connection input');
  if(serverUrl.includes(playerToken))throw Error('Credential cannot be part of server origin');
  const url=new URL(serverUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Invalid server origin');
  const timeoutSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers={Authorization:`Bearer ${playerToken}`,Accept:'application/json','Content-Type':'application/json'};
  const read=async(response:Response)=>{if(!response.ok||!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')){await response.body?.cancel();throw Error('Connection rejected');}return JSON.parse(await readBoundedResponse(response,65536)) as unknown;};
  const lobbyResponse=await fetch(new URL('/lobby/v2',url),{headers,redirect:'error',signal:timeoutSignal});
  let lobby:Record<string,unknown>|null=null;
  if(![401,404].includes(lobbyResponse.status))lobby=record(await read(lobbyResponse));else await lobbyResponse.body?.cancel();
  if(lobby){
    if(typeof lobby.roomId!=='string'||!Number.isSafeInteger(lobby.player)||!Number.isSafeInteger(lobby.capacity)||!Array.isArray(lobby.occupied)||lobby.occupied.length!==lobby.capacity)throw Error('Invalid lobby identity');
    const lobbySeat=lobby.player as number,chatCount=lobby.capacity as number,integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<10;
    if(!integer(lobbySeat)||!integer(chatCount)||lobbySeat>=chatCount||chatCount<1||lobby.roomId.includes(playerToken))throw Error('Invalid lobby mapping');
    if(lobby.status==='waiting')return {serverUrl:url.origin,roomId:lobby.roomId,lobbySeat,gamePlayer:lobbySeat,chatPlayer:lobbySeat,chatCount,roster:Array.from({length:chatCount},(_,chatPlayer)=>({chatPlayer,gamePlayer:chatPlayer})),lobbyConnection:true,ownerCredential:true};
  }
  const protocol=record(await read(await fetch(new URL('/player/v2/protocol',url),{headers,redirect:'error',signal:timeoutSignal})));
  if(!Array.isArray(protocol.versions)||!protocol.versions.some(v=>object(v)&&v.major===2&&v.minor===0)||!Array.isArray(protocol.capabilities)||!protocol.capabilities.includes('core/2'))throw Error('Server does not support player protocol v2');
  const ownerResponse=await fetch(new URL('/player/v2/owner/identity',url),{headers,redirect:'error',signal:timeoutSignal});
  let identity:Record<string,unknown>,control:Record<string,unknown>,ownerCredential=false;
  if(ownerResponse.ok){identity=record(await read(ownerResponse));control=record(await read(await fetch(new URL('/player/v2/owner/control',url),{headers,redirect:'error',signal:timeoutSignal})));ownerCredential=true;}
  else{
    if(![401,404].includes(ownerResponse.status)){await read(ownerResponse);throw Error('Connection rejected');}await ownerResponse.body?.cancel();
  const hello=record(await read(await fetch(new URL('/player/v2/sessions/hello',url),{method:'POST',headers,body:JSON.stringify({supportedVersions:[{major:2,minor:0}],requiredCapabilities:['core/2'],optionalCapabilities:[],executorInstanceId:randomBytes(16).toString('hex')}),redirect:'error',signal:timeoutSignal})));
  identity=record(hello.identity);if(!object(hello.scope)||!object(hello.version)||hello.version.major!==2||hello.version.minor!==0||typeof hello.sessionId!=='string')throw Error('Invalid v2 session response');
  control=record(await read(await fetch(new URL(`/player/v2/control?sessionId=${encodeURIComponent(hello.sessionId)}`,url),{headers,redirect:'error',signal:timeoutSignal})));
  }
  if(typeof identity.roomId!=='string'||!identity.roomId.trim()||identity.roomId.length>200||/[\x00-\x1f\x7f-\x9f]/.test(identity.roomId)||identity.roomId.includes(playerToken)||!['manual','agent'].includes(String(control.mode)))throw Error('Invalid player identity');
  const integer=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<10;
  if(!integer(identity.lobbySeat)||!integer(identity.gamePlayer)||!integer(identity.chatPlayer)||typeof identity.chatCount!=='number'||!Number.isSafeInteger(identity.chatCount)||identity.chatCount<1||identity.chatCount>10||Number(identity.chatPlayer)>=identity.chatCount||Number(identity.lobbySeat)>=identity.chatCount||!Array.isArray(identity.roster)||identity.roster.length<1||identity.roster.length>identity.chatCount)throw Error('Invalid player mapping');
  const roster=identity.roster.map(r=>{if(!object(r)||!integer(r.chatPlayer)||!integer(r.gamePlayer)||Number(r.chatPlayer)>=Number(identity.chatCount))throw Error('Invalid roster');return {chatPlayer:r.chatPlayer as number,gamePlayer:r.gamePlayer as number};});
  if(new Set(roster.map(r=>r.chatPlayer)).size!==roster.length||new Set(roster.map(r=>r.gamePlayer)).size!==roster.length||!roster.some(r=>r.chatPlayer===identity.chatPlayer&&r.gamePlayer===identity.gamePlayer))throw Error('Invalid roster mapping');
  return {serverUrl:url.origin,roomId:identity.roomId,lobbySeat:identity.lobbySeat as number,gamePlayer:identity.gamePlayer as number,chatPlayer:identity.chatPlayer as number,chatCount:identity.chatCount,roster,...(lobby?{lobbyConnection:true}:{}),...(ownerCredential?{ownerCredential:true}:{})};
}
/** Local operator console. Browser session is ephemeral; never a game/provider credential. */
export async function startAgentConsole(runtime:Runtime,options:AgentConsoleOptions){
  const connectionMode=options.connectionMode??(runtime.fixedController?'local':'manual');
  if(connectionMode==='configured'&&(runtime.fixedController||options.synchronize||options.disconnect||options.localConnections))throw Error('Configured console cannot use project-local controller integration');
  if(!Number.isSafeInteger(options.port??0)||(options.port??0)<0||(options.port??0)>65535)throw Error('Invalid console port');
  const root=realpathSync(options.webRoot),assets=new Map<string,{file:string;type:string}>(),devReload=process.env.AI_CONSOLE_DEV_RELOAD==='1',reloadClients=new Set<ServerResponse>();
  for(const [name,type] of [['index.html','text/html; charset=utf-8'],['agent-console.js','text/javascript; charset=utf-8'],['agent-console.css','text/css; charset=utf-8'],... (statSync(join(root,'assets'),{throwIfNoEntry:false})? [['assets/abyss-command.png','image/png']]:[])]){
    const path=realpathSync(join(root,name!)),rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel)||!statSync(path).isFile())throw Error('Invalid console asset');
    assets.set(name==='index.html'?'/':`/${name}`,{file:path,type:type!});
  }
  const session=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  let cookieName='';
  const jobs:ConsoleJob[]=[],pending=new Set<Promise<void>>();let origin='',host='',closed=false;
  const statusView=new PublishedConsoleStatus(()=>({fixedSlots:runtime.fixedController,connectionMode,provider:options.provider,mode:'live',modelQueue:runtime.modelQueue?.status??null,seats:runtime.status().map(({serverUrl:_,...seat})=>seat),jobs}));
  const probeControllers=new Set<AbortController>();
  const drafts=new Map<string,{identity:AgentConnectionIdentity;token:string;expiresAt:number}>();let probes=0;
  const hallLinks=new Map<string,{origin:string;slotId?:string;expiresAt:number;credential?:{code:string;playerToken:string}}>();
  const botLinks=new ConsoleBotLinks(runtime);
  const expire=()=>{for(const [id,link] of hallLinks)if(link.expiresAt<=Date.now())hallLinks.delete(id);for(const [id,draft] of drafts)if(draft.expiresAt<=Date.now())drafts.delete(id);};
  const draftTimer=setInterval(expire,30000);draftTimer.unref();
  let adding=Promise.resolve();
  const serialAdd=<T>(fn:()=>Promise<T>):Promise<T>=>{const task=adding.then(fn);adding=task.then(()=>{},()=>{});return task;};
  const send=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const fail=(res:ServerResponse,status:number,message:string)=>send(res,status,{error:message});
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if(closed)return fail(res,503,'Console closing');
    if(req.headers.host!==host)return fail(res,403,'Host rejected');
    // The sole cross-origin mutation: a nonce-bound, single-use top-level form return.
    // Credentials travel in the POST body, never in navigation URLs or public status.
    if(req.url==='/hall-link/return'){
      if(req.method!=='POST'||!String(req.headers['content-type']??'').startsWith('application/x-www-form-urlencoded'))return fail(res,405,'Invalid hall return');
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)return fail(res,413,'Hall return too large');chunks.push(Buffer.from(chunk));}
      const fields=new URLSearchParams(Buffer.concat(chunks).toString()),nonce=fields.get('nonce')??'';
      expire();const link=hallLinks.get(nonce);
      if(!link||link.credential||req.headers.origin!==link.origin)return fail(res,403,'Hall return rejected');
      const code=fields.get('code')??'',playerToken=fields.get('playerToken')??'';
      if(!/^[A-Z0-9]{6}$/.test(code)||!/^[a-f0-9]{64}$/.test(playerToken))return fail(res,400,'Invalid hall credential');
      link.credential={code,playerToken};res.writeHead(303,{Location:origin+'/#handoff='+nonce});res.end();return;
    }
    if(req.headers.origin!==undefined&&req.headers.origin!==origin)return fail(res,403,'Origin rejected');
    // A link from the game or another page may open the console document. This
    // does not authorize cross-origin API, asset, iframe or mutation requests.
    const fetchSite=String(req.headers['sec-fetch-site']??'');
    const homeNavigation=req.method==='GET'&&req.url==='/'&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'&&['same-site','cross-site'].includes(fetchSite);
    if(fetchSite&&!['same-origin','none'].includes(fetchSite)&&!homeNavigation)return fail(res,403,'Cross-site request rejected');
    // Reject raw ambiguous paths before URL canonicalization can erase traversal.
    const raw=req.url??'';if(!raw.startsWith('/')||raw.startsWith('//')||/[\\%]/.test(raw.split('?')[0]!)||raw.split('?')[0]!.split('/').some(x=>x==='.'||x==='..'))return fail(res,400,'Invalid path');
    const url=new URL(raw,origin),path=url.pathname;
    if(devReload&&path==='/__dev/client.js'&&req.method==='GET'&&!url.search){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end("const events=new EventSource('/__dev/events');events.addEventListener('message',()=>location.reload());");return;}
    if(devReload&&path==='/__dev/events'&&req.method==='GET'&&!url.search){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write(': connected\n\n');reloadClients.add(res);res.on('close',()=>reloadClients.delete(res));return;}
    if(devReload&&path==='/__dev/reload'&&req.method==='POST'&&!url.search){for(const client of reloadClients)client.write('data: reload\n\n');return send(res,202,{reloaded:reloadClients.size});}
    if(!path.startsWith('/api/')){
      if(req.method!=='GET')return fail(res,405,'Method not allowed');
      const asset=assets.get(path);if(!asset||url.search)return fail(res,404,'Not found');
      if(path==='/'){
        // Cookies share a hostname across ports. Overwrite this console's slot
        // on restart and expire only this application's old random-name cookies.
        const legacy=[...new Set((req.headers.cookie??'').split(';').map(c=>c.trim().split('=')[0]!).filter(name=>/^agent_console_[a-f0-9]{16}$/.test(name)))];
        res.setHeader('Set-Cookie',[`${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`,...legacy.map(name=>`${name}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`)]);
      }
      res.writeHead(200,{'Content-Type':asset.type});let data:Buffer;try{data=readFileSync(asset.file);}catch{return fail(res,503,'Console asset unavailable');}if(path==='/'&&devReload)data=Buffer.from(data.toString('utf8').replace('</body>','<script src="/__dev/client.js"></script></body>'));res.end(data);return;
    }
    const cookies=(req.headers.cookie??'').split(';').map(x=>x.trim());
    if(!cookies.some(x=>equal(x,`${cookieName}=${session}`)))return fail(res,401,'Open the console page first');
    if(path==='/api/agent/bootstrap'){
      if(req.method!=='GET')return fail(res,405,'Method not allowed');
      if(req.headers['x-agent-console']!=='1'||url.search)return fail(res,403,'Bootstrap rejected');
      return send(res,200,{csrf,connectionMode,capabilities:['seat-binding.unbound-configuration/1',...(options.plugins?['bot-plugins.local/1']:[])]});
    }
    if(!equal(req.headers['x-agent-csrf'],csrf))return fail(res,403,'CSRF rejected');
    if(req.method==='GET'){
      if(path==='/api/agent/provider-presets'&&!url.search)return send(res,200,{presets:sessionProviderPresets()});
      if(path==='/api/agent/tick-times'){
        if([...url.searchParams.keys()].some(k=>!['seat','after'].includes(k))||url.searchParams.getAll('seat').length!==1||url.searchParams.getAll('after').length>1)return fail(res,400,'Invalid tick time query');
        const after=Number(url.searchParams.get('after')??0);
        if(!Number.isSafeInteger(after)||after<0)return fail(res,400,'Invalid tick time cursor');
        const seat=runtime.consoleConfig().seats.find(s=>s.id===url.searchParams.get('seat'));
        if(!seat?.roomId)return fail(res,400,'Unknown seat');
        const times=await runtime.tickTimes?.(seat.id,after);
        if(!times)return send(res,200,{available:false,records:[],hasMore:false,nextCursor:after});
        return send(res,200,{available:true,...times});
      }
      if(path.startsWith('/api/agent/debug/')){
        if(url.searchParams.getAll('seat').length!==1||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1))return fail(res,400,'Invalid diagnostic query');
        const seat=url.searchParams.get('seat')!,section=path.slice('/api/agent/debug/'.length);
        const query=Object.fromEntries([...url.searchParams.entries()].filter(([key])=>key!=='seat'));
        if(section==='status'){if(Object.keys(query).length)return fail(res,400,'Invalid debug status query');return send(res,200,runtime.debugStatus(seat));}
        return send(res,200,runtime.debugRead(seat,section,query));
      }
      if(path==='/api/agent/status'&&!url.search){const body=statusView.read();if(body===null)return fail(res,503,'Status unavailable');res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});return res.end(body);}
      if(path==='/api/agent/plugins'&&!url.search)return send(res,200,{available:!!options.plugins,plugins:options.plugins?.list()??[]});
      if(path==='/api/agent/config'&&!url.search)return send(res,200,runtime.consoleConfig());
      if(path==='/api/agent/logs'){
        if([...url.searchParams.keys()].some(k=>!['seat','before'].includes(k))||url.searchParams.getAll('seat').length!==1||url.searchParams.getAll('before').length>1)return fail(res,400,'Invalid log query');
        const before=url.searchParams.get('before');if(before!==null&&(!/^[1-9][0-9]*$/.test(before)||!Number.isSafeInteger(Number(before))))return fail(res,400,'Invalid cursor');
        return send(res,200,runtime.consoleLogs(url.searchParams.get('seat')!,before===null?undefined:Number(before)));
      }
      return fail(res,404,'Not found');
    }
    if(req.method!=='POST')return fail(res,405,'Method not allowed');
    if(options.checkpointActive?.())return fail(res,409,'联动存档进行中，请稍后操作');
    if(!['/api/agent/plugins/scan','/api/agent/plugins/validate','/api/agent/plugins/install','/api/agent/hall-link/start','/api/agent/hall-link/consume','/api/agent/browser-entry','/api/agent/disconnect','/api/agent/configuration','/api/agent/action','/api/agent/settings','/api/agent/connections/local','/api/agent/connections/probe','/api/agent/instances','/api/agent/provider','/api/agent/remove','/api/agent/models','/api/agent/debug/settings','/api/agent/debug/resume','/api/agent/debug/discard','/api/agent/debug/clear'].includes(path)||url.search)return fail(res,404,'Not found');
    if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json')return fail(res,415,'JSON required');
    let bytes=0;const chunks:Buffer[]=[];
    for await(const chunk of req){bytes+=chunk.length;if(bytes>16384){fail(res,413,'Body too large');return;}chunks.push(Buffer.from(chunk));}
    const body:unknown=JSON.parse(Buffer.concat(chunks).toString());
    if(options.checkpointActive?.())return fail(res,409,'联动存档进行中，请稍后操作');
    if(!object(body))return fail(res,400,'Invalid request');
    if(path==='/api/agent/plugins/scan'){
      if(!options.plugins)return fail(res,409,'Local plugins unavailable');
      if(Object.keys(body).some(k=>k!=='directory')||typeof body.directory!=='string')return fail(res,400,'Choose a plugin directory');
      try{return send(res,200,{plugins:await options.plugins.scan(body.directory)});}catch(e){return fail(res,400,e instanceof Error?e.message:'Scan failed');}
    }
    if(path==='/api/agent/plugins/validate'){
      if(!options.plugins)return fail(res,409,'Local plugins unavailable');
      if(Object.keys(body).some(k=>!['id','config','seat'].includes(k))||typeof body.id!=='string'||(body.seat!==undefined&&typeof body.seat!=='string'))return fail(res,400,'Choose a plugin and valid seat');
      const validation=options.plugins.validate(body.id,body.config);
      if(typeof body.seat==='string'&&runtime.validatePluginConnection)validation.checks.push(...await runtime.validatePluginConnection(body.seat));
      validation.valid=validation.checks.every(c=>c.passed);
      return send(res,200,validation);
    }
    if(path==='/api/agent/plugins/install'){
      if(!options.plugins)return fail(res,409,'Local plugin installation is unavailable');
      if(Object.keys(body).some(k=>!['directory','trusted','replace'].includes(k))||body.trusted!==true||typeof body.directory!=='string'||(body.replace!==undefined&&typeof body.replace!=='boolean'))return fail(res,400,'Choose a trusted local plugin directory');
      try{const plugin=await options.plugins.install(body.directory,body.replace===true?id=>{if(runtime.consoleConfig().seats.some(s=>(s.settings.mode??'hybrid')===id))throw Error('请先将使用此插件的所有席位切换到其他插件，再更新。');}:undefined);return send(res,200,{plugin});}
      catch(error){return fail(res,400,error instanceof Error?error.message:'Plugin installation failed');}
    }
    if(connectionMode==='configured'&&['/api/agent/connections/local','/api/agent/connections/probe','/api/agent/instances','/api/agent/disconnect','/api/agent/remove'].includes(path))return fail(res,409,'Configured console connections are managed by --config; local discovery and connection changes are disabled');
    if(path==='/api/agent/connections/local'){
      if(Object.keys(body).length)return fail(res,400,'Invalid local connection request');
      return serialAdd(async()=>{
        if(closed)return fail(res,503,'Console closing');
        if(runtime.fixedController){await options.synchronize?.();return send(res,200,{fixedSlots:true,available:runtime.status().filter(s=>s.bound).length,added:[]});}
        const candidates=await options.localConnections?.()??[];
        if(candidates.length>10)throw Error('Too many local seats');
        // Only this process's configured local player endpoint may receive host credentials.
        for(const candidate of candidates){const url=new URL(candidate.serverUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Invalid local endpoint');}
        const controller=new AbortController();probeControllers.add(controller);
        try{
          const results=await Promise.allSettled(candidates.map(async candidate=>{
            const identity=await probeAgentConnection(candidate.serverUrl,candidate.token,AbortSignal.any([controller.signal,AbortSignal.timeout(2000)]));
            if(identity.roomId!==candidate.roomId||identity.lobbySeat!==candidate.player)throw Error('Local identity changed');
            return {identity,token:candidate.token};
          }));
          const added:string[]=[];let available=0;
          for(const result of results){
            if(result.status!=='fulfilled')continue;
            available++;if(closed)break;
            const {identity,token}=result.value;
            if(runtime.consoleConfig().seats.some(s=>s.serverUrl===identity.serverUrl&&s.roomId===identity.roomId&&s.lobbySeat===identity.lobbySeat))continue;
            if(runtime.status().length>=MAX_AGENT_INSTANCES)break;
            const id='local-'+createHash('sha256').update(JSON.stringify([identity.serverUrl,identity.roomId,identity.lobbySeat])).digest('hex').slice(0,12);
            runtime.addSeat({...identity,id,tokenEnv:'CONSOLE_SESSION_TOKEN',settings:validateSettings({model:'',personality:'schemer'})},token);
            added.push(id);
          }
          return send(res,200,{available,added});
        }finally{probeControllers.delete(controller);}
      });
    }
    if(path==='/api/agent/connections/probe'){
      if(Object.keys(body).some(k=>!['serverUrl','playerToken','roomCode','key'].includes(k))||body.playerToken!==undefined&&body.roomCode!==undefined)return fail(res,400,'Invalid connection request');
      expire();if(drafts.size+probes>=10)return fail(res,429,'Too many pending connections');
      probes++;const controller=new AbortController();probeControllers.add(controller);
      try{
        const token=body.roomCode!==undefined?await joinAgentRoom(body.serverUrl,body.roomCode,body.key,controller.signal):body.playerToken;
        const identity=await probeAgentConnection(body.serverUrl,token,controller.signal);
        if(closed)return fail(res,503,'Console closing');
        const probeId=randomBytes(24).toString('hex'),expiresAt=Date.now()+300000;
        drafts.set(probeId,{identity:{...identity,...(body.roomCode!==undefined?{lobbyConnection:true}:{})},token:token as string,expiresAt});
        return send(res,200,{probeId,expiresAt,identity});
      }catch(error){
        const allowed=['房间已满。','房间不存在，请核对房间码。','房间已开始或已关闭，无法加入。'];
        const message=error instanceof Error&&allowed.includes(error.message)?error.message:'连接检查未通过，请核对游戏大厅地址、房间码或玩家凭据。';
        return fail(res,400,message);
      }finally{probes--;probeControllers.delete(controller);}
    }
    if(path==='/api/agent/hall-link/start'){
      if(connectionMode==='configured')return fail(res,409,'Connections managed by configuration');
      if(typeof body.hallOrigin!=='string'||body.slotId!==undefined&&(typeof body.slotId!=='string'||!runtime.status().some(s=>s.id===body.slotId&&!s.bound)))return fail(res,400,'Invalid hall request');
      let hall:URL;try{hall=new URL(body.hallOrigin);}catch{return fail(res,400,'Invalid hall');}
      if(!['http:','https:'].includes(hall.protocol)||hall.origin!==body.hallOrigin||hall.username||hall.password)return fail(res,400,'Invalid hall');
      expire();for(const [id,link] of hallLinks)if(link.slotId===body.slotId&&link.origin===hall.origin)hallLinks.delete(id);if(hallLinks.size>=8)return fail(res,429,'Too many hall connections');
      const nonce=randomBytes(24).toString('hex');hallLinks.set(nonce,{origin:hall.origin,...(typeof body.slotId==='string'?{slotId:body.slotId}:{}),expiresAt:Date.now()+300000});
      return send(res,200,{nonce});
    }
    if(path==='/api/agent/hall-link/consume'){
      expire();const nonce=typeof body.nonce==='string'?body.nonce:'',link=hallLinks.get(nonce);
      if(!link?.credential)return fail(res,400,'席位授权已过期，请重新连接。');
      hallLinks.delete(nonce);return send(res,200,{hallOrigin:link.origin,slotId:link.slotId,...link.credential});
    }
    if(path==='/api/agent/instances'){
      if(Object.keys(body).some(k=>!['probeId','id','settings','roomCode','botName'].includes(k))||typeof body.probeId!=='string'||body.id!==undefined&&(typeof body.id!=='string'||!/^[a-zA-Z0-9_-]{1,60}$/.test(body.id))||body.roomCode!==undefined&&(typeof body.roomCode!=='string'||!/^[A-Z0-9]{6}$/.test(body.roomCode)||typeof body.botName!=='string'||!body.botName.trim()||body.botName.length>60))return fail(res,400,'Invalid instance request');
      const settings=validateSettings(body.settings),probeId=body.probeId;
      return serialAdd(async()=>{
        if(closed)return fail(res,503,'Console closing');
        expire();const draft=drafts.get(probeId);if(!draft)return fail(res,400,'Connection confirmation expired; probe again');
        const id=typeof body.id==='string'?body.id:`agent-${randomBytes(5).toString('hex')}`;
        const config:AgentSeatConfig={...draft.identity,id,tokenEnv:'CONSOLE_SESSION_TOKEN',settings};
        if(runtime.fixedController){
          const slot=runtime.status().find(s=>!s.bound&&(body.id===undefined||s.id===body.id))?.controllerSlot;
          if(slot===undefined||!runtime.bindControllerSlot)return fail(res,409,'没有可用的 AI 席位。');
          const linked=body.roomCode?await botLinks.reserve({slot:`ai-${String(slot+1).padStart(2,'0')}`,roomId:config.roomId,origin:config.serverUrl,code:body.roomCode as string,token:draft.token,name:body.botName as string}):null;
          try{await runtime.bindControllerSlot(slot,config,draft.token);}catch(error){if(linked)await botLinks.release(linked);throw error;}
          if(linked)botLinks.commit(linked);
          drafts.delete(probeId);return send(res,201,{id:`ai-${String(slot+1).padStart(2,'0')}`,persistence:'process'});
        }
        const linked=body.roomCode?await botLinks.reserve({slot:id,roomId:config.roomId,origin:config.serverUrl,code:body.roomCode as string,token:draft.token,name:body.botName as string}):null;
        try{runtime.addSeat(config,draft.token);}catch(error){if(linked)await botLinks.release(linked);throw error;}
        if(linked)botLinks.commit(linked);
        drafts.delete(probeId);return send(res,201,{id,persistence:'process'});
      });
    }
    if(!object(body)||typeof body.id!=='string'||!runtime.status().some(s=>s.id===body.id))return fail(res,400,'Unknown seat');
    const id=body.id;
    if(path==='/api/agent/browser-entry'){
      if(Object.keys(body).some(k=>k!=='id'))return fail(res,400,'Invalid browser entry');
      if(!runtime.browserIdentity)return fail(res,409,'No linked hall owner identity');
      let identity;
      try{identity=runtime.browserIdentity(id);}catch{return fail(res,409,'No linked hall owner identity');}
      const code=botLinks.roomCode(id)??identity.code;
      if(!code)return fail(res,409,'No linked hall owner identity');
      return send(res,200,{...identity,code});
    }
    if(path==='/api/agent/disconnect'){
      if(Object.keys(body).some(k=>k!=='id'))return fail(res,400,'Invalid disconnect request');
      if(jobs.some(j=>j.seat===id&&j.status==='running'))return fail(res,409,'Seat action in progress');
      if(runtime.fixedController){
        if(!options.disconnect)return fail(res,409,'Controller disconnect unavailable');
        await options.disconnect(id);
      }else{await runtime.pause(id);await runtime.removeSeat(id);}
      await botLinks.disconnect(id);
      return send(res,200,{id,config:runtime.consoleConfig()});
    }
    if(path==='/api/agent/configuration'){
      if(Object.keys(body).some(k=>!['id','provider','settings','requireUnbound'].includes(k))||body.requireUnbound!==undefined&&typeof body.requireUnbound!=='boolean')return fail(res,400,'Invalid configuration');
      if(body.requireUnbound===true&&runtime.status().some(s=>s.id===id&&s.bound!==false))return fail(res,409,'该 bot 槽位已被绑定。');
      if(jobs.some(j=>j.seat===id&&j.status==='running'))return fail(res,409,'Seat action in progress');
      return send(res,200,runtime.configureSeat(id,body.provider,body.settings));
    }
    if(path.startsWith('/api/agent/debug/')){
      if(path==='/api/agent/debug/clear'){
        if(Object.keys(body).some(k=>k!=='id'))return fail(res,400,'Invalid clear request');
        return send(res,200,runtime.clearDiagnostics(id));
      }
      if(path==='/api/agent/debug/settings'){
        if(Object.keys(body).some(k=>!['id','settings'].includes(k))||!object(body.settings))return fail(res,400,'Invalid debug settings');
        return send(res,200,runtime.setDebug(id,body.settings));
      }
      if(path==='/api/agent/debug/resume'||path==='/api/agent/debug/discard'){
        if(Object.keys(body).some(k=>!['id','breakpointId'].includes(k))||typeof body.breakpointId!=='string')return fail(res,400,'Invalid breakpoint action');
        return send(res,200,await (path.endsWith('/resume')?runtime.resumeDebug(id,body.breakpointId):runtime.discardDebug(id,body.breakpointId)));
      }
      return fail(res,404,'Not found');
    }
    if(['/api/agent/provider','/api/agent/remove','/api/agent/models'].includes(path)){
      if(jobs.some(j=>j.seat===id&&j.status==='running'))return fail(res,409,'Seat action in progress');
      if(path==='/api/agent/provider'){
        if(Object.keys(body).some(k=>!['id','config','seat'].includes(k)))return fail(res,400,'Invalid provider request');
        runtime.configureProvider(id,body.config);
      }else if(path==='/api/agent/models'){
        if(Object.keys(body).some(k=>!['id','config','seat'].includes(k)))return fail(res,400,'Invalid models request');
        return send(res,200,await runtime.listProviderModels(id,body.config));
      }else{
        if(Object.keys(body).some(k=>k!=='id'))return fail(res,400,'Invalid removal request');
        await runtime.removeSeat(id);
      }
      return send(res,200,{id,persistence:'process',config:runtime.consoleConfig()});
    }
    if(path==='/api/agent/settings'){
      if(Object.keys(body).some(k=>!['id','settings'].includes(k)))return fail(res,400,'Invalid settings request');
      if(jobs.some(j=>j.seat===id&&j.status==='running'))return fail(res,409,'Seat action in progress');
      return send(res,200,{settings:runtime.updateSettings(id,body.settings),persistence:'process'});
    }
    if(Object.keys(body).some(k=>!['id','action'].includes(k))||typeof body.action!=='string'||!['start','pause'].includes(body.action))return fail(res,400,'Invalid action');
    const action=body.action as ConsoleJob['action'];
    if(runtime.status().find(s=>s.id===id)?.bound===false)return fail(res,409,'Bind this AI slot from game setup first');
    if(jobs.some(j=>j.seat===id&&j.status==='running'&&(action!=='pause'||j.action==='pause')))return fail(res,409,'Seat action in progress');
    while(jobs.length>=100){const done=jobs.findIndex(j=>j.status!=='running');if(done<0)return fail(res,429,'Too many pending actions');jobs.splice(done,1);}
    const job:ConsoleJob={id:randomBytes(12).toString('hex'),seat:id,action,status:'running'};jobs.push(job);
    const task=Promise.resolve().then(()=>action==='start'?runtime.start(id):runtime.pause(id)).then(()=>{if(action!=='pause'&&runtime.status().find(s=>s.id===id)?.error){job.status='failed';job.error='Action failed. Check seat status and private local logs.';}else job.status='completed';},()=>{job.status='failed';job.error='Action failed. Check seat status and private local logs.';});
    pending.add(task);void task.finally(()=>{pending.delete(task);if(!closed)statusView.publish();});send(res,202,{job});
  };
  // Bounded recovery room for cookies accumulated before stable names existed.
  const server=createServer({maxHeaderSize:64*1024},(req,res)=>{void handler(req,res).then(()=>{if(!closed&&req.method==='POST'&&res.statusCode<400)statusView.publish();}).catch(()=>{if(!res.headersSent)fail(res,400,'Request failed. Check seat state and input.');else res.end();});});
  server.requestTimeout=10000;server.headersTimeout=10000;
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});}
  catch(error){statusView.close();clearInterval(draftTimer);throw error;}
  const address=server.address();if(!address||typeof address==='string')throw Error('Console listener failed');
  cookieName=`agent_console_${address.port}`;
  host=`127.0.0.1:${address.port}`;origin=`http://${host}`;
  return {url:origin+'/',close:async()=>{closed=true;statusView.close();await botLinks.close();for(const client of reloadClients)client.end();reloadClients.clear();for(const controller of probeControllers)controller.abort();clearInterval(draftTimer);drafts.clear();hallLinks.clear();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await Promise.all(pending);await adding;}};
}
