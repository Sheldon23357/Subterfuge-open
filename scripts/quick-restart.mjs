import http from 'node:http';
import net from 'node:net';
import {execFile,spawn} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {readFile,writeFile,mkdir,readdir,unlink,open} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareBuild,verifyBuild} from './dev-build-cache.mjs';

const exec=promisify(execFile),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const direct=new http.Agent({proxyEnv:{}});
export function request(port,path,body,headers={}) {
  return new Promise((done,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,agent:direct,method:body===undefined?'GET':'POST',
      headers:{Origin:`http://127.0.0.1:${port}`,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers}},res=>{
      const parts=[];let size=0;
      res.on('data',part=>{size+=part.length;if(size>32*1024*1024)res.destroy(Error('Response too large'));else parts.push(part);});
      res.on('error',reject);res.on('end',()=>{
        // Do not print arbitrary server bodies: errors may contain private data.
        if(res.statusCode!==200&&res.statusCode!==202)return reject(Error(`HTTP ${res.statusCode} on ${path.split('?')[0]}`));
        const text=Buffer.concat(parts).toString('utf8');let data;
        try{data=JSON.parse(text);}catch{data=text;}
        done({data,headers:res.headers});
      });
    });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('Local API timeout')));
    req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
async function consoleSession(port) {
  const home=await request(port,'/');
  const cookie=home.headers['set-cookie']?.map(value=>value.split(';')[0]).join('; ');
  if(!cookie)throw Error('Console session cookie missing');
  const {data:boot}=await request(port,'/api/agent/bootstrap',undefined,{Cookie:cookie,'X-Agent-Console':'1'});
  return async(path,body)=>(await request(port,path,body,{Cookie:cookie,'X-Agent-CSRF':boot.csrf})).data;
}
export async function waitFor(label,check,{timeoutMs=180000,intervalMs=750,retryConnection=false,retryReadTimeout=false,log=console.log}={}) {
  const start=Date.now();let progress=start;
  for(;;) {
    try{const value=await check();if(value)return value;}
    catch(error){if(!(retryConnection&&['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code)||retryReadTimeout&&error.message==='Local API timeout'))throw error;}
    if(Date.now()-start>=timeoutMs)throw Error(`${label}: timed out after ${Math.round(timeoutMs/1000)}s`);
    if(Date.now()-progress>=10000){log(`Waiting: ${label} (${Math.round((Date.now()-start)/1000)}s)`);progress=Date.now();}
    await sleep(intervalMs);
  }
}
/** A returned, valid response can be obsolete before publication. Count both
 * facts separately; a healthy model must not fail restart checks for staleness. */
export function modelTurnEvidence(entries,since) {
  const cutoff=Date.parse(since),terminal=new Set(['completed','superseded','stale-dependency','partition-reviewed','incomplete-conversation','superseded-pressure']);
  const returned=entries.filter(c=>{
    const finished=typeof c.finishedAt==='string'?Date.parse(c.finishedAt):c.startedAt;
    return c.lane!=='commander'&&c.outcome==='completed'&&!c.error&&!c.validationError&&c.usage?.totalTokens>0&&
      (c.processingStatus===undefined||terminal.has(c.processingStatus))&&Number.isFinite(finished)&&finished>=cutoff;
  });
  const published=returned.filter(c=>c.callPhase!=='transport'&&(c.processingStatus===undefined||c.processingStatus==='completed')).length;
  return {count:returned.length,published,unpublished:returned.length-published};
}
function argValue(args,name) {
  const i=args.indexOf(name);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Error(`Required running argument missing: ${name}`);
  return args[i+1];
}
const world=g=>hash([g.tick,g.outposts,g.fleets]);
const configuration=c=>hash(c.seats.map(({id,settings,providerConfig,bound,roomId,lobbySeat})=>({id,settings,providerConfig,bound,roomId,lobbySeat})));
const bound=s=>s.seats.filter(seat=>seat.bound);
function assertBindings(status,bindings) {
  const seats=bound(status);
  if(seats.length!==bindings.bindings.length||bindings.bindings.some(b=>!seats.some(s=>s.roomId===bindings.roomId&&s.lobbySeat===b.seat&&s.controllerSlot===b.slot)))throw Error('Bound seats do not match the active room manifest');
}
export async function windowsPlatform(action,config) {
  if(process.platform!=='win32')throw Error('Quick restart currently supports Windows only');
  const encoded=Buffer.from(JSON.stringify(config),'utf8').toString('base64');
  // Start-Process descendants can inherit an extra pipe handle. Waiting for the
  // child's `close` event (execFile) would then wait for the entire new service.
  // Wait for PowerShell exit + its complete JSON result instead.
  return new Promise((done,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(config.root,'scripts/quick-restart-windows.ps1'),'-Action',action,'-Config',encoded],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    let stdout='',stderr='',exited=false,code,timer;
    const finish=(error,value)=>{clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();error?reject(error):done(value);};
    const check=()=>{
      if(!exited)return;
      if(code!==0){finish(Error(`Windows ${action} failed: ${stderr.slice(0,1500)||'exit '+code}`));return;}
      let value;try{value=JSON.parse(stdout.replace(/^\uFEFF/,''));}catch{return;}
      finish(null,value);
    };
    child.stdout.on('data',part=>{stdout+=part.toString('utf8');if(stdout.length>1024*1024)child.kill();check();});
    child.stderr.on('data',part=>{if(stderr.length<16000)stderr+=part.toString('utf8');});
    child.once('error',error=>finish(error));
    child.once('exit',value=>{exited=true;code=value;timer=setTimeout(()=>finish(Error(`Windows ${action} returned no JSON result`)),2000);check();});
  });
}
async function portsFree(ports) {
  const results=await Promise.all(ports.map(port=>new Promise((done,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});
    socket.once('connect',()=>{socket.destroy();done(false);});
    socket.once('error',e=>e.code==='ECONNREFUSED'?done(true):reject(e));
    socket.setTimeout(1000,()=>{socket.destroy();reject(Error('Port probe timed out'));});
  })));
  return results.every(Boolean);
}
export async function cleanupLocks(store) {
  for(const name of await readdir(store)) {
    if(!/^[a-f0-9]{64}\.lock$/.test(name))continue;
    const file=resolve(store,name);
    if(dirname(file)!==resolve(store))throw Error('Lock escaped the store directory');
    const record=JSON.parse(await readFile(file,'utf8'));
    if(!Number.isSafeInteger(record.pid)||record.pid<=0)throw Error('Invalid lock owner; refusing cleanup');
    try {process.kill(record.pid,0);throw Error('Store lock still has a live owner');}
    catch(error){if(error.code!=='ESRCH')throw error;}
    await unlink(file);
  }
}
export function parseOptions(args) {
  const options={root,ports:[4310,4311,4400],bots:6,seed:4300,provider:'minimax',newGame:false,update:false,dryRun:false};
  const flags={'--new-game':'newGame','--update':'update','--dry-run':'dryRun'};
  const values={'--bots':'bots','--seed':'seed','--provider':'provider','--game-port':0,'--player-port':1,'--console-port':2};
  const seen=new Set();
  for(let i=0;i<args.length;i++) {
    const flag=args[i];if(seen.has(flag))throw Error(`Duplicate option ${flag}`);seen.add(flag);
    if(flag in flags){options[flags[flag]]=true;continue;}
    if(!(flag in values)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Use --dry-run | [--update] [--new-game --bots 6 --provider minimax|existing --seed 4300] [--game-port N --player-port N --console-port N]');
    const key=values[flag],value=args[++i];
    if(typeof key==='number')options.ports[key]=Number(value);else options[key]=key==='provider'?value:Number(value);
  }
  if(options.ports.some(p=>!Number.isInteger(p)||p<1||p>65535)||new Set(options.ports).size!==3)throw Error('Invalid or duplicate ports');
  if(!Number.isInteger(options.bots)||options.bots<2||options.bots>10||!Number.isSafeInteger(options.seed)||options.seed<0||!['minimax','existing'].includes(options.provider))throw Error('New tests support 2–10 bots, a nonnegative integer seed and --provider minimax|existing');
  if(!options.newGame&&['--bots','--seed','--provider'].some(flag=>seen.has(flag)))throw Error('Test settings require --new-game; ordinary restart preserves the current room');
  return options;
}
export async function restart(options,dependencies={}) {
  const platform=dependencies.platform??windowsPlatform,build=dependencies.build??prepareBuild,verify=dependencies.verify??verifyBuild;
  const log=dependencies.log??console.log,report={at:new Date().toISOString(),phases:[],passed:false};
  let output,lock;
  async function stage(name,fn) {
    log(`Starting: ${name}`);const start=Date.now();report.phase=name;
    const value=await fn();report.phases.push({name,ms:Date.now()-start});
    if(output)await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
    log(`Done: ${name} (${((Date.now()-start)/1000).toFixed(1)}s)`);return value;
  }
  const wait=(label,fn,extra={})=>waitFor(label,fn,{log,...extra,...dependencies.waitOptions});
  const game=async(path,body)=>(await request(options.ports[0],path,body)).data;
  let api;
  try {
    const processes=await stage('discover running services',()=>platform('discover',{root:options.root,ports:options.ports}));
    const data=resolve(options.root,argValue(processes.agent.args,'--local-game-directory'));
    const store=resolve(options.root,argValue(processes.agent.args,'--store-directory'));
    if(Number(argValue(processes.agent.args,'--console'))!==options.ports[2]||Number(argValue(processes.agent.args,'--local-player-port'))!==options.ports[1])throw Error('Running console/player ports differ from requested ports');
    const [initial,bindings]=await Promise.all([game('/api/state'),readFile(join(data,'controller-bindings.json'),'utf8').then(JSON.parse)]);
    api=await consoleSession(options.ports[2]);
    const [initialStatus,initialConfig]=await Promise.all([api('/api/agent/status'),api('/api/agent/config')]);
    if(initial.realtime)throw Error('Quick restart supports manual/test-auto rooms; use the linked restart workflow for realtime rooms');
    if(initial.commanderRoomId!==bindings.roomId)throw Error('Data directory does not belong to the listening room');
    assertBindings(initialStatus,bindings);
    if(initialStatus.jobs.some(j=>j.status==='running'))throw Error('A seat action is already running; wait before restarting');
    if(initialStatus.seats.some(s=>s.checkpoint?.blocked)|| (await game('/api/checkpoints')).busy)throw Error('A checkpoint is already in progress');
    const resume=bound(initialStatus).filter(s=>s.enabled).map(s=>s.id);
    if(initialConfig.seats.some(s=>s.providerConfig?.keySource==='session'&&s.providerConfig.hasKey))throw Error('A provider key exists only in console memory; configure an environment key before cold restart');
    if(options.newGame&&options.provider==='minimax'&&!dependencies.skipEnvironmentCheck&&!process.env.MINIMAX_API_KEY?.trim())throw Error('MINIMAX_API_KEY is required in the launch environment');
    const summary={room:initial.commanderRoomId,tick:initial.tick,data,store,bound:bound(initialStatus).length,resume,
      newGame:options.newGame,update:options.update,ports:options.ports,checkpoint:true,build:'one shared build, reuse only verified source/output hashes'};
    log(JSON.stringify(summary));
    if(options.dryRun)return {...report,dryRun:true,plan:summary,passed:true};
    const lockPath=join(options.root,'runtime','.quick-restart.lock');
    await mkdir(dirname(lockPath),{recursive:true});
    try {lock=await open(lockPath,'wx');}catch(error){if(error.code==='EEXIST')throw Error('Another restart lock exists; inspect its PID before removing it');throw error;}
    await lock.writeFile(JSON.stringify({pid:process.pid,at:report.at}));
    output=resolve(options.root,'outputs','quick-restart',new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
    await mkdir(output,{recursive:true});report.output=output;report.plan=summary;
    await writeFile(join(output,'processes.json'),JSON.stringify(processes,null,2));
    if(options.update)await stage('fetch and fast-forward',async()=>{
      await exec('git',['fetch'],{cwd:options.root,windowsHide:true});
      await exec('git',['merge','--ff-only','@{upstream}'],{cwd:options.root,windowsHide:true});
    });
    const receipt=join(options.root,'runtime','.dev-build-receipt.json');
    report.build=await stage('shared verified build',()=>build(options.root,receipt));
    // Recheck identity and room after the build. An operator may have changed them.
    if(!isDeepStrictEqual(await platform('discover',{root:options.root,ports:options.ports}),processes))throw Error('Processes changed during build; restart was not attempted');
    const beforePause=await game('/api/state');
    if(beforePause.commanderRoomId!==initial.commanderRoomId||beforePause.autoAdvance.enabled!==initial.autoAdvance.enabled)throw Error('Room or advance intent changed during build');
    const intent=await api('/api/agent/status');
    if(hash(bound(intent).filter(s=>s.enabled).map(s=>s.id))!==hash(resume)||configuration(await api('/api/agent/config'))!==configuration(initialConfig))throw Error('Seat intent/configuration changed during build; restart was not attempted');
    report.checkpoint=await stage('linked checkpoint',async()=>{
      await game('/api/auto-advance',{enabled:false});
      const started=await game('/api/checkpoints',{name:'快速重启前 '+new Date().toISOString()});
      const expected=started.job?.id??started.id;
      if(!expected)throw Error('Checkpoint response lacks job identity');
      return wait('linked checkpoint',async()=>{
        const state=await game('/api/checkpoints');
        if(state.job?.id!==expected)throw Error('Checkpoint job changed');
        if(state.job.status==='failed')throw Error('Linked checkpoint failed; services remain running');
        return !state.busy&&state.job.status==='completed'?state.job:false;
      },{timeoutMs:660000,intervalMs:1000,retryReadTimeout:true});
    });
    async function actions(ids,action) {
      const jobs=await Promise.all(ids.map(async id=>(await api('/api/agent/action',{id,action})).job));
      return wait(`${action} seats`,async()=>{
        const status=await api('/api/agent/status');
        const current=jobs.map(job=>status.jobs.find(j=>j.id===job.id));
        if(current.some(j=>j?.status==='failed'))throw Error(`Seat ${action} failed; inspect console logs`);
        return current.every(j=>j?.status==='completed')?status:false;
      });
    }
    const frozen=await stage('pause and drain',async()=>{
      // Pause every bound seat: this also drains an already-paused seat's background work.
      await actions(bound(await api('/api/agent/status')).map(s=>s.id),'pause');
      await wait('leases and model queue idle',async()=>{
        const s=await api('/api/agent/status');
        if(bound(s).some(s=>s.error))throw Error('Pause reported a seat error; refusing process stop');
        return bound(s).every(s=>!s.enabled&&!s.busy&&!s.owned&&!s.starting&&!s.stopping)&&!s.modelQueue?.active&&!s.modelQueue?.waiting;
      });
      const g=await game('/api/state');
      if(g.commanderRoomId!==initial.commanderRoomId||g.autoAdvance.enabled)throw Error('Expected the original paused room');
      return {room:g.commanderRoomId,world:world(g),config:configuration(await api('/api/agent/config'))};
    });
    await verify(options.root,receipt);
    const base={root:options.root,ports:options.ports,processes};
    await stage('stop verified processes',async()=>{
      await platform('stop',base);await wait('ports released',()=>portsFree(options.ports),{timeoutMs:15000,intervalMs:250});
      await cleanupLocks(store);
    });
    const environment={LAB_DATA_DIR:data,LAB_PORT:String(options.ports[0]),PLAYER_PORT:String(options.ports[1]),GAME_CLOCK:'manual',
      SUBTERFUGE_PREBUILT_RECEIPT:receipt,NO_PROXY:[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1','localhost','::1'].filter(Boolean).join(',')};
    // Windows environment names and PowerShell JSON object keys are case-insensitive.
    async function launch(stage) {
      return platform('start',{...base,stage,environment,stdout:join(output,stage+'.out.log'),stderr:join(output,stage+'.err.log')});
    }
    async function credentials() {
      const access=JSON.parse(await readFile(join(data,'player-access.json'),'utf8'));
      if(access.format!=='player-access/1'||access.roomId!==(await game('/api/state')).commanderRoomId||!access.credentials?.length)throw Error('Invalid room credentials');
      await Promise.all(access.credentials.map(async c=>{
        const {data:s}=await request(options.ports[1],'/player/v2/owner/control',undefined,{Authorization:'Bearer '+c.token});
        if(s.roomId!==access.roomId||s.player!==c.player||s.mode!=='manual')throw Error('Player credential identity/control mismatch');
      }));
    }
    await stage('game ready',async()=>{
      report.gameProcess=await launch('game');
      const g=await wait('game API',()=>game('/api/state'),{retryConnection:true});
      if(g.commanderRoomId!==frozen.room||world(g)!==frozen.world||g.autoAdvance.enabled)throw Error('Room or paused world changed across restart');
      await credentials();
    });
    await stage('console ready and bindings restored',async()=>{
      report.agentProcess=await launch('agent');
      api=await wait('console session',()=>consoleSession(options.ports[2]),{retryConnection:true});
      await api('/api/agent/connections/local',{});
      await wait('room bindings',async()=>{
        const s=await api('/api/agent/status');if(bound(s).length!==bindings.bindings.length)return false;
        assertBindings(s,bindings);return s;
      });
      if(configuration(await api('/api/agent/config'))!==frozen.config)throw Error('Configuration changed across restart');
    });
    let targets=resume;
    if(options.newGame)await stage(options.provider==='existing'?'new test with existing models':'new MiniMax bot test',async()=>{
      const config=await api('/api/agent/config');
      const slots=Array.from({length:options.bots},(_,i)=>config.seats.find(s=>s.controllerSlot===i));
      if(slots.some(s=>!s))throw Error('Requested controller slots unavailable');
      if(options.provider==='existing'&&slots.some(s=>s.providerConfig?.kind==='offline'||!s.settings?.model))throw Error('Existing test models must be configured before creating a room');
      for(const seat of options.provider==='minimax'?slots:[]) {
        if(seat.providerConfig?.preset==='minimax'&&seat.providerConfig.hasKey)continue;
        await api('/api/agent/configuration',{id:seat.id,provider:{kind:'openai-compatible',preset:'minimax'},settings:seat.settings});
      }
      const g=await game('/api/new',{players:options.bots,seed:options.seed,mapMode:'quantity-priority',startMode:'fresh',
        controllerBindings:slots.map((s,seat)=>({seat,slot:s.controllerSlot})),aiSeats:[]});
      if(g.commanderRoomId===initial.commanderRoomId)throw Error('New room was not created');
      await api('/api/agent/connections/local',{});
      await wait('new test bindings',async()=>{
        const s=await api('/api/agent/status');
        return bound(s).length===options.bots&&bound(s).every(s=>s.roomId===g.commanderRoomId)?s:false;
      });
      await credentials();targets=slots.map(s=>s.id);
      const configured=await api('/api/agent/config');
      if(options.provider==='minimax'&&configured.seats.filter(s=>targets.includes(s.id)).some(s=>s.providerConfig.preset!=='minimax'||!s.providerConfig.hasKey))throw Error('MiniMax provider not ready');
      if(options.provider==='existing'&&slots.some(s=>{const next=configured.seats.find(n=>n.id===s.id);return !next||!isDeepStrictEqual([next.settings,next.providerConfig],[s.settings,s.providerConfig]);}))throw Error('Existing model configuration changed while creating the room');
    });
    const since=new Date().toISOString();
    let advanceFrom;
    if(targets.length)await stage('bot activation and model verification',async()=>{
      await actions(targets,'start');
      const config=await api('/api/agent/config');
      const observeModels=options.newGame||initial.autoAdvance.enabled;
      const models=observeModels?targets.filter(id=>config.seats.find(s=>s.id===id)?.providerConfig.kind!=='offline'):[];
      if(!options.newGame&&initial.autoAdvance.enabled) {
        // A restored strategy can already be current at the frozen tick. Resume
        // its original clock intent before waiting for the next natural review.
        advanceFrom=(await game('/api/state')).tick;
        await game('/api/auto-advance',{enabled:true});
      }
      report.completedCalls=await wait('completed model turns',async()=>{
        const status=await api('/api/agent/status');
        const seats=targets.map(id=>status.seats.find(s=>s.id===id));
        if(seats.some(s=>!s||s.error))throw Error('Bot health failed after start');
        if(!seats.every(s=>s.enabled&&s.owned))return false;
        const complete=await Promise.all(models.map(async id=>{
          const calls=await api('/api/agent/debug/calls?seat='+encodeURIComponent(id)+'&limit=12');
          return {id,...modelTurnEvidence(calls.entries,since)};
        }));
        return complete.every(c=>c.count>0)?{seats:seats.map(s=>({id:s.id,enabled:s.enabled,owned:s.owned,calls:s.calls,tokens:s.tokens})),models:complete,
          modelWait:observeModels?'observed-natural-turns':'not-required-while-game-paused'}:false;
      });
    });
    if(options.newGame||initial.autoAdvance.enabled)await stage('resume and observe automatic advance',async()=>{
      const before=await game('/api/state');
      if(before.match?.ended)throw Error('Room has ended; automatic advance was not resumed');
      if(!before.autoAdvance.enabled)await game('/api/auto-advance',{enabled:true});
      await wait('natural game advance',async()=>{
        const g=await game('/api/state');if(g.autoAdvance.error)throw Error('Automatic advance failed');
        return g.tick>(advanceFrom??before.tick)?g:false;
      });
    });
    const final=await game('/api/state');
    report.game={room:final.commanderRoomId,tick:final.tick,autoAdvance:final.autoAdvance};
    report.passed=true;report.phase='completed';report.finishedAt=new Date().toISOString();
    await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));log(`Restart verified. Report: ${join(output,'report.json')}`);
    return report;
  }catch(error) {
    report.error=error.message;
    if(output)await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
    log(`Stopped at ${report.phase}: ${error.message}. Existing databases/checkpoints are preserved; no automatic reset or retry.`);
    throw error;
  }finally {
    if(lock){await lock.close();await unlink(join(options.root,'runtime','.quick-restart.lock'));}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{await restart(parseOptions(process.argv.slice(2)));}catch(error){console.error(error.message);process.exitCode=1;}
}
