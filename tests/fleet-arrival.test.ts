import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Worker as NodeWorker} from 'node:worker_threads';
import {labFleetArrivalSteps,knownFleetArrivalSteps,estimateKnownArrivals,type FleetArrivalEstimate} from '../packages/prediction/src/index.js';
import {createFleetScenario,submitFleetOrder,type FleetSetup} from '../packages/engine/src/index.js';
import {advanceRoom,fleetCountdowns,type LabRoom} from '../packages/server/src/planning.js';
import {scheduleOrder} from '../packages/server/src/scheduled-orders.js';
import {observation} from '../packages/server/src/player-api.js';
import {LocalFleetArrival,fleetArrivalKey,type FleetArrivalInput,type FleetArrivalWorker,type FleetArrivalRequest} from '../packages/client/src/local-fleet-arrival.js';

function fixture():LabRoom{
  const cfg=JSON.parse(readFileSync('examples/fleet-lab.json','utf8')).initial as FleetSetup;
  let state=createFleetScenario(cfg);
  state=submitFleetOrder(state,{id:'selected',player:0,action:{kind:'launch',source:'蓝方工厂',destination:'红方矿场',drillers:27}},17).state;
  return {state,scheduled:[]};
}
function finish(steps:Generator<void,FleetArrivalEstimate>){let next=steps.next(),count=0;while(!next.done){count++;assert.ok(count<2000);next=steps.next();}return {result:next.value,steps:count};}

test('selected ETA preserves fractional combat/arrival times and stops without waiting for unrelated distant fleets',()=>{
  const room=fixture();room.state.initial.size={width:80,height:80};room.state.initial.positions['红方后方']={x:35,y:0};
  room.state=submitFleetOrder(room.state,{id:'distant',player:1,action:{kind:'launch',source:'红方矿场',destination:'红方后方',drillers:1}}).state;
  const before=JSON.stringify(room),all=fleetCountdowns(room,0),selected=finish(labFleetArrivalSteps(room,'selected'));
  assert.equal(all.get('distant')?.arrivalMinutes,null);
  assert.ok(selected.steps<30,'the selected fleet does not wait 288 ticks for a distant one');
  assert.equal(selected.result.status,'estimated');
  assert.ok(Math.abs(selected.result.arrivalSeconds!/60-room.state.economy.tick*10-all.get('selected')!.arrivalMinutes!)<1e-8);
  assert.equal(JSON.stringify(room),before);
});

test('known selected ETA matches the existing observation-only table and uses absolute times across second updates',()=>{
  const room=fixture(),now=observation(room,0,'known',77),before=JSON.stringify(now);
  const table=estimateKnownArrivals(now),row=table.arrivals.find(f=>f.id==='selected')!;
  const result=finish(knownFleetArrivalSteps(now,'selected')).result;
  assert.equal(result.arrivalTick,row.arrivalTick);
  assert.ok(Math.abs((result.arrivalSeconds!-now.view.tick*600-now.secondsSinceLastTick)/60-row.arrivalMinutes!)<1e-8);
  assert.equal(JSON.stringify(now),before);
  const later={...now,secondsSinceLastTick:90};
  assert.equal(fleetArrivalKey({kind:'known',observation:now,atTick:100},'selected'),fleetArrivalKey({kind:'known',observation:later,atTick:100},'selected'));
});

test('selected predictions include future scheduled launches and stop at disappeared fleets and terminal matches',()=>{
  let room=fixture();
  room=scheduleOrder(room,{order:{id:'later',player:1,action:{kind:'launch',source:'红方矿场',destination:'红方后方',drillers:1}},issueTick:101});
  const at=102,expected=advanceRoom(room,at,true),table=fleetCountdowns(expected);
  const global=finish(labFleetArrivalSteps(room,'later',at)).result;
  assert.ok(Math.abs(global.arrivalSeconds!/60-at*10-table.get('later')!.arrivalMinutes!)<1e-8);
  const own=observation(room,1,'scheduled'),local=finish(knownFleetArrivalSteps(own,'later',at)).result;
  assert.equal(local.status,'estimated');
  assert.equal(finish(labFleetArrivalSteps(room,'missing')).result.status,'unknown');
  assert.equal(finish(knownFleetArrivalSteps(own,'missing')).result.status,'unknown');
  const ended=structuredClone(own);ended.view.match={mode:'mining',neptuniumGoal:200,ended:true};
  assert.equal(finish(knownFleetArrivalSteps(ended,'later')).result.status,'unknown');
});

test('a historical selected ETA excludes commands actually issued after the selected time',()=>{
  const room=fixture(),later=advanceRoom(room,103,true);
  const historical=finish(labFleetArrivalSteps(later,'selected',100)).result;
  assert.deepEqual(historical,finish(labFleetArrivalSteps(room,'selected')).result);
});

test('client starts no worker until requested, caches completed results and rejects stale/cancelled/other-seat replies',async()=>{
  let starts=0;const sent:FleetArrivalRequest[]=[];
  const worker:FleetArrivalWorker={onmessage:null,onerror:null,postMessage:m=>sent.push(m),terminate:()=>{}};
  const client=new LocalFleetArrival(()=>{starts++;return worker;});
  const now=observation(fixture(),0,'cache'),input:FleetArrivalInput={kind:'known',observation:now,atTick:100};
  assert.equal(starts,0);
  try{
    const controller=new AbortController(),pending=client.estimate(input,'selected',controller.signal),rejected=assert.rejects(pending,{name:'AbortError'});
    const stale=sent.at(-1)!;controller.abort();await rejected;
    const active=client.estimate(input,'selected'),message=sent.at(-1)!;
    assert.equal(starts,1);if(message.kind!=='estimate'||stale.kind!=='estimate')throw Error('Expected estimate');
    const result=finish(knownFleetArrivalSteps(now,'selected')).result;
    worker.onmessage?.({data:{id:stale.id,key:stale.key,result}} as MessageEvent);
    worker.onmessage?.({data:{id:message.id,key:message.key,result}} as MessageEvent);
    assert.deepEqual(await active,result);const count=sent.length;
    assert.deepEqual(await client.estimate(input,'selected'),result);assert.equal(sent.length,count,'completed selection uses cache');
    const other={...input,observation:observation(fixture(),1,'other')};
    const switching=client.estimate(other,'selected'),request=sent.at(-1)!;
    if(request.kind!=='estimate')throw Error('Expected estimate');
    const invalid=assert.rejects(switching,/版本已更新/);
    worker.onmessage?.({data:{id:request.id,key:message.key,result}} as MessageEvent);await invalid;
  }finally{client.dispose();}
});

test('actual browser arrival worker performs known predictions without network, cancels work and scopes global snapshot reads',async()=>{
  const room=fixture(),now=observation(room,0,'thread');
  const worker=new NodeWorker(`
    const {parentPort,workerData}=require('node:worker_threads');
    globalThis.postMessage=data=>parentPort.postMessage(data);
    globalThis.fetch=async url=>{
      if(url!=='/api/prediction-source?roomId=global&revision=1')throw Error('Unexpected or hidden request');
      return {ok:true,json:async()=>({roomId:'global',revision:'1',room:workerData.room})};
    };
    import(workerData.module).then(()=>{parentPort.on('message',data=>globalThis.onmessage({data}));parentPort.postMessage({ready:true});});
  `,{eval:true,workerData:{room,module:new URL('../packages/client/src/fleet-arrival-worker.js',import.meta.url).href}});
  try{
    const replies:any[]=[];
    const response=await new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Arrival worker timed out')),15000);
      worker.on('error',error=>{clearTimeout(timer);reject(error);});
      worker.on('message',data=>{
        if(data.ready){
          worker.postMessage({kind:'estimate',id:1,key:'old',fleetId:'selected',input:{kind:'known',observation:now,atTick:1400}});
          worker.postMessage({kind:'cancel',id:1});
          worker.postMessage({kind:'estimate',id:2,key:'known',fleetId:'selected',input:{kind:'known',observation:now,atTick:100}});
        }else{replies.push(data);clearTimeout(timer);resolve(data);}
      });
    });
    assert.equal(response.id,2);assert.deepEqual(response.result,finish(knownFleetArrivalSteps(now,'selected')).result);assert.equal(replies.length,1);
    const global=await new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Global arrival worker timed out')),15000);
      const handler=(data:any)=>{if(data.id!==3)return;worker.off('message',handler);clearTimeout(timer);resolve(data);};worker.on('message',handler);
      worker.postMessage({kind:'estimate',id:3,key:'global',fleetId:'selected',input:{kind:'global',roomId:'global',revision:'1',startTick:100,atTick:100}});
    });
    assert.deepEqual(global.result,finish(labFleetArrivalSteps(room,'selected')).result);
  }finally{await worker.terminate();}
});
