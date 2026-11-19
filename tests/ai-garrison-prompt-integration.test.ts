import {commanderModelFactory} from './helpers/model-fixture.js';

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFleetScenario,type FleetSetup} from '../packages/engine/src/index.js';
import {observation} from '../packages/server/src/player-api.js';
import {CommanderStore} from '../packages/server/src/commander-store.js';
import {CommanderWorker} from '../packages/ai/src/controller/runtime/commander-worker.js';
import {AiStore} from '../packages/ai/src/controller/storage/store.js';
import {initialState,type AiSnapshot} from '../packages/ai/src/controller/contracts/types.js';
import {fleetLabel} from '../packages/ai/src/controller/presentation/fleet-labels.js';

const fleetId='p0-'+'a1b2c3d4'.repeat(8),foreignFleetId='p3-'+'9abcdef0'.repeat(8),scheduleId='p0-'+'1234abcd'.repeat(8);
const roomId='garrison-integration',home='outpost-home-precise-01';
type Row=Record<string,any>;
const json=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function jsonLine(prompt:string,marker:string):any {
  const line=prompt.split('\n').find(line=>line.startsWith(marker));
  assert.ok(line,`Missing prompt section ${marker}`);
  return JSON.parse(line.slice(marker.length));
}

function fixture(){
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  cfg.match={mode:'mining',neptuniumGoal:200};
  const obs=observation({state:createFleetScenario(cfg),scheduled:[]},0,roomId),v=obs.view;
  v.size={width:80,height:80};v.playerCount=4;v.tick=117;obs.secondsSinceLastTick=299.125;obs.revision='rev-precise-117';
  const metric={active:true,paused:false,output:6,cycleMinutes:48.125,nextMinutes:null,progress:.875,capacity:300,used:100,contribution:50,neptunium:7,mines:1};
  v.outposts=[
    {id:home,position:{x:0,y:0},visibility:2,owner:0,type:'factory',drillers:0,shield:0,shieldMax:16,shieldsEnabled:false,destroyed:false,minePending:false,metrics:metric},
    {id:'outpost-own-reserve',position:{x:5,y:0},visibility:2,owner:0,type:'generator',drillers:17,shield:4,shieldMax:8,shieldsEnabled:true,metrics:{...metric,nextMinutes:0,contribution:75}},
    {id:'outpost-near-target',position:{x:2,y:0},visibility:2,owner:1,type:'mine',drillers:37,shield:6,shieldMax:10,shieldsEnabled:true},
    {id:'remote-fog',position:{x:10,y:10},visibility:0,owner:2},
    {id:'remote-type-only',position:{x:12,y:12},visibility:1,owner:null,type:'mine'},
    {id:'remote-visible',position:{x:32,y:32},visibility:2,owner:3,type:'factory',drillers:93,shield:0,shieldMax:0,shieldsEnabled:false},
  ];
  obs.outpostNames=Object.fromEntries(v.outposts.map(p=>[p.id,`DISPLAY-${p.id}`]));
  obs.scheduled=[{id:scheduleId,player:0,issueTick:119,status:'pending',action:{kind:'launch',source:home,destination:'outpost-near-target',drillers:10,}}];
  v.fleets=[
    {id:fleetId,owner:0,position:{x:0,y:0},drillers:10,state:'waiting',gift:false,source:home,destination:{kind:'outpost',id:'outpost-near-target'},secondsUntilLaunch:300.875,launchRemainingSeconds:300.875,giftPendingSeconds:59.5,departureCommitted:false,canCancelLaunch:true,},
    {id:foreignFleetId,owner:3,position:{x:32,y:32},drillers:13,state:'moving',gift:false,source:'remote-visible',destination:{kind:'outpost',id:'remote-type-only'}},
  ];
  // Enough distinct visible fleets to exercise the net-benefit fleet encoding
  // in every real prompt path, including both Commander calls.
  v.fleets.push(...Array.from({length:4},(_,i)=>({...v.fleets[0]!,id:'p0-'+String(i+2).repeat(64)})));


  const snapshot:AiSnapshot={observation:obs,chat:[],notifications:[],chatCursor:1,notificationCursor:2,chatPlayer:0,chatCount:4,
    task:{category:'strategy',scope:'global',weight:'heavy',entities:[home],reasons:['复核“守备”与运输 🚢'],deferred:[]},
    notebook:[{id:'note-exact-time',kind:'agreement',text:'条款含引号"和换行\n保留运输兵力。🚢',updatedAt:600.125,expiresAt:null}],
    reminders:[{id:'recheck',atSeconds:72000,note:'复核抵达，不代表已占领',entities:[home]}]};
  const historical=json(obs);historical.revision='rev-historical-116';historical.view.tick=116;historical.secondsSinceLastTick=12.875;historical.view.outposts[0]!.drillers=87654321;

  const history=[{id:'prior-observation',tool:'observe',result:{observation:historical}}];
  const {tick,...map}=json(v);
  const forecast={...map,format:'player-forecast/2',observedAt:{tick,seconds:299.125},targetTick:120,certainty:'conditional',assumptions:['未知指令未纳入'],unknownArrivals:[{fleetId:foreignFleetId,outpostId:'remote-fog',tick:119,fraction:.123456789,outcome:'unknown'}],uncertainPlayers:[3]};
  const feedback=[{id:'latest-forecast',tool:'forecast',arguments:{targetTick:120,detail:true},result:{status:'conditional',result:forecast,orders:[]}}];
  return {snapshot,state:initialState(roomId,0,{model:'fake-no-network',personality:'sentinel'}),history,feedback,historical,forecast};
}
function roundTable(prompt:string,title:string):Record<string,string>[] {
  const lines=prompt.split('\n'),start=lines.indexOf(`[${title}]`);
  assert.ok(start>=0,`missing ${title}`);const fields=lines[start+1]!.split('\t'),rows:Record<string,string>[]=[];
  const unescape=(value:string)=>value.replace(/\\([\\ntr])/g,(_,c:string)=>c==='n'?'\n':c==='t'?'\t':c==='r'?'\r':'\\');
  for(let i=start+2;i<lines.length&&!lines[i]!.startsWith('[');i++){
    if(!lines[i])continue;const cells=lines[i]!.split('\t');assert.equal(cells.length,fields.length);
    rows.push(Object.fromEntries(fields.map((field,j)=>[field,unescape(cells[j]!)])));
  }
  return rows;
}
function assertRoundAuthorizedMap(prompt:string,o:AiSnapshot['observation']){
  const posts=roundTable(prompt,'据点'),fleets=roundTable(prompt,'舰队');
  assert.equal(posts.length,o.view.outposts.length);assert.equal(fleets.length,o.view.fleets.length);
  const expected=(v:unknown)=>v===undefined?'?':v===null?'null':String(v);
  for(const p of o.view.outposts){
    const shown=posts.find(row=>row.名称===o.outpostNames![p.id])!;assert.ok(shown);
    for(const [field,value]of Object.entries({归属:p.owner,类型:p.type,可见性:p.visibility,兵力:p.drillers,护盾:p.shield,护盾开启:p.shieldsEnabled,已毁:p.destroyed,转矿待执行:p.minePending}))assert.equal(shown[field],expected(value),`${p.id} ${field}`);
    if(p.metrics){const production=JSON.parse(shown.生产!);assert.equal(production.output,p.metrics.output);assert.equal(production.paused,p.metrics.paused);assert.equal(production.nextWorldDays,p.metrics.nextMinutes===null?null:p.metrics.nextMinutes/10);}
  }
  for(const f of o.view.fleets){
    const shown=fleets.find(row=>row.舰队===fleetLabel(f.id))!;assert.ok(shown);
    assert.equal(shown.兵力,expected(f.drillers));assert.equal(shown.来源据点,expected(f.source?o.outpostNames![f.source]:f.source));
    assert.equal(shown.目的地类型,expected(f.destination?.kind));assert.equal(shown.目的地,expected(f.destination?.kind==='outpost'?o.outpostNames![f.destination.id]:f.destination?.id?fleetLabel(f.destination.id):undefined));
    assert.equal(shown.出航等待天,expected(f.launchRemainingSeconds===undefined?undefined:f.launchRemainingSeconds/600));
    assert.equal(shown.赠送等待天,undefined);assert.equal(shown.赠送,undefined);
  }
  assert.ok(!prompt.includes('[专家]'));

}

async function drain(worker:CommanderWorker){
  for(let i=0;worker.busy&&i<500;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(worker.busy,false,'mock commander call should settle');
}
test('commander discussion and confirmed reconciliation send the shared named map without game writes',async()=>{
  const f=fixture(),obs=f.snapshot.observation,before=structuredClone(obs),store=new AiStore(':memory:'),threads=new CommanderStore();
  f.state.enabled=false;f.state.status='paused';
  const prompts:string[]=[],paths:string[]=[];
  const worker=new CommanderWorker({state:f.state,expectedPlayer:0,roster:()=>[],store,available:()=>true,onDirectives:()=>{},provider:commanderModelFactory(()=>({step:async request=>{
    prompts.push(request.prompt);
    return {tokens:0,reply:{tool:'finish',arguments:{memory:{strategy:prompts.length===1?'保留守备，复核兵力运输后再出发。':'遵照指挥官指令保留守备，复核兵力运输。'}},summary:'建议保留守备，并核对兵力运输风险。'}};
  }})),transport:{request:async(path,data)=>{
    paths.push(path);
    if(path==='/tool/observation')return obs;
    assert.equal(path,'/tool/commander/worker','discussion must not gain a game command path');
    return data?threads.worker(roomId,0,data,obs.view.tick):threads.read(roomId,0);
  }}});
  try{
    await threads.send(roomId,0,{id:'discussion',text:'这艘零兵潜艇运输兵力安全吗？',references:[{kind:'fleet',id:fleetId},{kind:'outpost',id:home}]},obs);
    worker.tick();await drain(worker);assert.equal(prompts.length,1);assert.equal(f.state.memory.strategy,'');
    const proposal=threads.read(roomId,0).messages.find(m=>m.proposal)!.proposal!;
    await threads.confirm(roomId,0,{proposalId:proposal.id,version:0},obs.view.tick);
    worker.tick(Date.now()+2000);await drain(worker);assert.equal(prompts.length,2);
    for(const [index,prompt]of prompts.entries()){
      assertRoundAuthorizedMap(prompt,obs);
      assert.ok(prompt.includes(`世界日=${117+299.125/600}`));assert.ok(prompt.includes(`观察版本=${obs.revision}`));
      assert.equal(prompt.includes('"position":{'),false);
      if(index===0){
        const playerMessage=jsonLine(prompt,'本次玩家消息：');
        assert.equal(playerMessage.references.find((r:Row)=>r.kind==='fleet').id,fleetId,'fleet references retain their separate identity namespace');
        assert.equal(playerMessage.references.find((r:Row)=>r.kind==='outpost').name,obs.outpostNames![home]);
        assert.equal(playerMessage.references.find((r:Row)=>r.kind==='outpost').id,undefined);
        const history=jsonLine(prompt,'最近私聊（只提供语境，未确认策略不是命令）：');
        assert.equal(history[0].references.find((r:Row)=>r.kind==='fleet').id,fleetId);
      }
    }
    assert.equal(threads.read(roomId,0).directives.appliedVersion,1);
    assert.equal(threads.read(roomId,0).messages.find(m=>m.role==='player')!.references.find(r=>r.kind==='outpost')!.id,home,'name presentation does not rewrite the original player message');
    assert.equal(f.state.enabled,false);assert.equal(f.state.status,'paused');assert.equal(f.state.calls,0);
    assert.ok(paths.every(path=>['/tool/observation','/tool/commander/worker'].includes(path)));assert.deepEqual(obs,before);
  }finally{await worker.close();store.close();}
});
