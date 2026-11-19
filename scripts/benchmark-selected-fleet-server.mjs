import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
import {createEightPlayerScenario} from '../dist/packages/server/src/eight-player.js';
import {submitFleetOrder,advanceFleetScenario} from '../dist/packages/engine/src/index.js';
import {saveRoom} from '../dist/packages/server/src/planning.js';
const ui=process.argv.includes('--ui');
const root=resolve(tmpdir()),dir=await mkdtemp(join(root,'subterfuge-selected-arrival-'));
if(!resolve(dir).startsWith(root+sep)||!basename(dir).startsWith('subterfuge-selected-arrival-'))throw Error('Invalid temporary directory');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
let snapshot=await readFile(process.argv.find(a=>a.endsWith('.json'))??'runtime/service-restart-backup-20261018.json','utf8');
if(ui){
 let state=createEightPlayerScenario();const posts=state.economy.outposts.filter(p=>p.owner===0);
 state=submitFleetOrder(state,{id:'ui-selected-fleet',player:0,action:{kind:'launch',source:posts[0].id,destination:posts[1].id,drillers:10}}).state;
 state=advanceFleetScenario(state,state.economy.tick+2);
 snapshot=saveRoom({state,scheduled:[]});
}
await writeFile(join(dir,'browser-eight.json'),snapshot);
const env={...process.env,LAB_PORT:String(port),LAB_DATA_DIR:dir,GAME_CLOCK:'manual'};delete env.PLAYER_PORT;
const child=spawn(process.execPath,[resolve('dist/packages/server/src/main.js')],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let errors='';child.stderr.on('data',chunk=>errors+=chunk);
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timed out: '+errors)),90000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited '+code+': '+errors));});});
 const base=`http://127.0.0.1:${port}`,samples=[];
 async function request(path,data){const response=await fetch(base+'/api/'+path,{headers:{'Content-Type':'application/json',Connection:'close'},...(data?{method:'POST',body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(path+': '+response.status);return response.json();}
 for(let trial=0;trial<3;trial++){
  const started=performance.now(),state=await request('state'),stateMs=performance.now()-started;
  const observed=performance.now();await request('perspective',{player:0});const perspectiveMs=performance.now()-observed;
  const step=performance.now();await request('step',{ticks:1});const stepMs=performance.now()-step;
  samples.push({tick:state.tick,stateMs:Math.round(stateMs),perspectiveMs:Math.round(perspectiveMs),stepAndSaveMs:Math.round(stepMs)});
 }
 const report={url:base,pid:child.pid,mode:ui?'isolated-ui-fixture':'isolated-original-snapshot',samples};
 await writeFile(ui?'runtime/selected-fleet-ui-server-20261018.json':'runtime/selected-fleet-server-performance-20261018.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(ui){console.log('UI fixture ready; terminate this script after verification.');await once(child,'exit');}
}finally{
 if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit').catch(()=>{});}
 await writeFile('runtime/selected-fleet-isolated-server-20261018.log',errors);
 await rm(dir,{recursive:true,force:true});
}
