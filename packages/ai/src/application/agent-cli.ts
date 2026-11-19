import {BotPluginCatalog,defaultPluginDirectory} from './plugin-catalog.js';
import {BotModeRegistry} from '../controller/contracts/mode-registry.js';
import {join,resolve} from 'node:path';
import {controllerCheckpoints} from './controller-checkpoint.js';
import {controllerSynchronizer} from './controller-sync.js';
import {readFileSync,existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createInterface} from 'node:readline';
import {parseAgentConfig} from '../controller/contracts/agent-config.js';
import {startAgentConsole,type AgentConsoleOptions} from './agent-console.js';
import {AgentRuntime} from './agent-runtime.js';
import {localAgentConnections} from './local-agent-connections.js';
import {createProviderFromEnv} from './providers/provider-factory.js';
import {validateSettings,type AgentProvider} from '../controller/contracts/types.js';
import {installDevReloadIPC} from './agent-dev-reload.js';

function includeLoopbackInProxyBypass(){
  const entries=[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1','localhost','::1'].filter((v):v is string=>!!v).flatMap(v=>v.split(',').map(x=>x.trim()).filter(Boolean));
  const bypass=[...new Set(entries)].join(',');process.env.NO_PROXY=bypass;process.env.no_proxy=bypass;
}

/** Offline is autonomous local execution; reaching a model transport is a bug. */
export const offlineAgentProvider:AgentProvider={step:async()=>{throw Error('未配置模型；hybrid 应使用本地战术决策。');}};
async function main(){
  // The local player API and controller console must never be sent through an environment proxy.
  includeLoopbackInProxyBypass();
  const args=process.argv.slice(2),allowed=new Set(['--config','--provider','--run-one','--console','--console-mode','--console-web-root','--store-directory','--local-game-directory','--local-player-port','--plugin-directory','--check-plugin']);
  const options=new Map<string,string>();
  for(let i=0;i<args.length;i++){
    const key=args[i]!;if(!allowed.has(key)||options.has(key))throw Error('Usage: agent-cli [--config PATH] [--provider offline|env] [--run-one SEAT_ID] [--console [PORT]] [--console-mode local|configured] [--console-web-root PATH] [--store-directory PATH]');
    if(key==='--console'){const next=args[i+1];options.set(key,next&&!next.startsWith('--')?args[++i]!:'0');}
    else{const value=args[++i];if(!value||value.startsWith('--'))throw Error(`Missing ${key} value`);options.set(key,value);}
  }
  if(options.has('--check-plugin')){
    if([...options.keys()].some(k=>!['--check-plugin','--plugin-directory'].includes(k)))throw Error('--check-plugin cannot start a console or game');
    const temporary=await mkdtemp(join(tmpdir(),'subterfuge-plugin-check-'));
    try{const catalog=new BotPluginCatalog(temporary,new BotModeRegistry(),resolve(options.get('--plugin-directory')??defaultPluginDirectory));
      const installed=await catalog.install(resolve(options.get('--check-plugin')!));const validation=catalog.validate(installed.id,undefined);
      process.stdout.write(JSON.stringify({id:installed.id,...validation})+'\n');if(!validation.valid)process.exitCode=1;
    }finally{await rm(temporary,{recursive:true,force:true});}
    return;
  }
  if(!options.has('--config')&&!options.has('--console'))throw Error('--config is required unless using --console');
  if(options.has('--config')&&options.has('--store-directory'))throw Error('--store-directory cannot be combined with --config; set storeDirectory in the configuration file');
  const kind=options.get('--provider')??'offline';if(!['offline','env'].includes(kind))throw Error('--provider must be offline or env');
  const config=parseAgentConfig(options.has('--config')?JSON.parse(readFileSync(options.get('--config')!,'utf8')):{storeDirectory:options.get('--store-directory')??'.agent-runtime',seats:[]});
  if(kind==='offline')for(const seat of config.seats)seat.settings=validateSettings({...seat.settings,provider:'offline',model:''});
  if(!options.has('--console')&&!config.seats.length)throw Error('CLI runtime requires configured seats');
  if(options.has('--console')&&options.has('--run-one'))throw Error('--console and --run-one cannot be combined');
  if(options.has('--console-mode')&&!options.has('--console'))throw Error('--console-mode requires --console');
  const consoleMode=options.get('--console-mode')??(config.seats.length?'configured':'local');
  if(!['local','configured'].includes(consoleMode))throw Error('--console-mode must be local or configured');
  if(options.has('--console')){
    if(consoleMode==='configured'&&!options.has('--config'))throw Error('Configured console mode requires --config');
    if(consoleMode==='local'&&config.seats.length)throw Error('Local console mode requires an empty seat list; use configured mode for --config seats');
    if(consoleMode==='configured'&&(options.has('--local-game-directory')||options.has('--local-player-port')))throw Error('Configured console mode cannot use --local-game-directory or --local-player-port');
  }
  const modes=new BotModeRegistry();
  const sources=resolve(options.get('--plugin-directory')??defaultPluginDirectory);
  const plugins=new BotPluginCatalog(join(config.storeDirectory,'plugins'),modes,sources);
  await plugins.load();
  if(!modes.list().some(m=>m.id==='hybrid')){
    try{await plugins.install(join(sources,'hybrid'));}
    catch(error){plugins.noteUnavailable('hybrid',error instanceof Error?error.message:'Default plugin load failed');}
  }
  const profileFile=join(config.storeDirectory,'controller-slots.json');
  const storedModes=existsSync(profileFile)?JSON.parse(readFileSync(profileFile,'utf8')).slots?.map((slot:{settings?:{mode?:string}})=>slot.settings?.mode).filter((id:unknown):id is string=>typeof id==='string')??[]:[];
  plugins.markMissing([...storedModes,...config.seats.map(s=>s.settings.mode??'hybrid')]);
  const runtime=new AgentRuntime(config,kind==='env'?createProviderFromEnv():offlineAgentProvider,process.env,options.has('--console')&&consoleMode==='local'?{modes,fixedSlots:true,profilesPath:join(config.storeDirectory,'controller-slots.json')}:{modes});
  const emit=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
  let consoleServer:Awaited<ReturnType<typeof startAgentConsole>>|undefined;
  const localTimers:ReturnType<typeof setInterval>[]=[];
  let ended:()=>void=()=>{};const end=new Promise<void>(resolve=>{ended=resolve;});
  let closing:Promise<void>|null=null;
  const close=()=>closing??=(async()=>{for(const timer of localTimers)clearInterval(timer);await Promise.all([runtime.shutdown(),consoleServer?.close()]);ended();})();
  installDevReloadIPC(runtime,close);
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void close().then(()=>process.exit(0),()=>process.exit(1));});
  try{
    if(options.has('--console')){
      const consoleOptions:AgentConsoleOptions={plugins,port:Number(options.get('--console')),webRoot:options.get('--console-web-root')??'packages/client/agent-console-public',provider:kind as 'offline'|'env',connectionMode:consoleMode as 'local'|'configured',checkpointActive:()=>runtime.checkpointActive};
      // Only project-local mode may discover credentials or exchange files with a local game.
      // Configured v2 checkpoints remain the runtime's opt-in, protocol-based participant.
      if(consoleMode==='local'){
        const localPort=Number(options.get('--local-player-port')??4311);
        if(!Number.isSafeInteger(localPort)||localPort<1||localPort>65535)throw Error('Invalid local player port');
        const directory=options.get('--local-game-directory')??'runtime';
        const synchronize=controllerSynchronizer(runtime,directory,localPort);
        const checkpoint=controllerCheckpoints(runtime,directory);
        const checkpointTimer=setInterval(()=>void checkpoint().catch(()=>{}),250);checkpointTimer.unref();
        const bindingTimer=setInterval(()=>void synchronize().catch(()=>{}),2000);bindingTimer.unref();
        localTimers.push(checkpointTimer,bindingTimer);
        Object.assign(consoleOptions,{synchronize,disconnect:synchronize.disconnect,localConnections:()=>localAgentConnections(directory,localPort)});
        void synchronize().catch(()=>{});
      }
      consoleServer=await startAgentConsole(runtime,consoleOptions);
      runtime.serve();process.stdout.write(consoleServer.url+'\n');
      if(process.env.AI_CONSOLE_DEV_RELOAD==='1'&&process.send)process.send({kind:'dev-reload-ready'});
      await end;return;
    }
    const once=options.get('--run-one');
    if(once){await runtime.runOne(once);emit({type:'status',seats:runtime.status()});if(runtime.status().some(s=>s.error))process.exitCode=1;return;}
    runtime.serve();emit({type:'ready',provider:kind,mode:'live',seats:runtime.status(),commands:'JSON lines: {command:start|pause|status|run-one|shutdown,id:seat-id}'});
    const input=createInterface({input:process.stdin,crlfDelay:Infinity});
    // Dispatch independently so pause/shutdown can abort a long run-one.
    const commands=new Set<Promise<void>>();
    for await(const line of input){
      if(!line.trim())continue;
      const task=(async()=>{try{
        const c=JSON.parse(line) as {command:string;id:string};
        if(c.command==='status')emit({type:'status',seats:runtime.status()});
        else if(c.command==='shutdown'){input.close();await close();emit({type:'closed'});}
        else if(['start','pause','run-one'].includes(c.command)){
          if(typeof c.id!=='string')throw Error('Seat id is required');
          if(c.command==='start')await runtime.start(c.id);else if(c.command==='pause')await runtime.pause(c.id);else await runtime.runOne(c.id);
          emit({type:'status',seats:runtime.status()});
        }else throw Error('Unknown command');
      }catch{emit({type:'error',message:'Command failed. Check configuration, player access, control ownership, and local private logs.'});}})();
      commands.add(task);void task.finally(()=>commands.delete(task));
    }
    await close();await Promise.all(commands);
  }finally{await close();}
}
void main().catch(error=>{process.stderr.write((error instanceof Error?error.message:'Agent runtime failed')+'\n');process.exitCode=1;});
