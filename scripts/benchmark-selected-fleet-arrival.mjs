import {readFileSync,writeFileSync} from 'node:fs';
import {fleetCountdowns} from '../dist/packages/server/src/planning.js';
import {labFleetArrivalSteps} from '../dist/packages/prediction/src/index.js';
const exported=JSON.parse(readFileSync(process.argv[2]??'runtime/service-restart-backup-20261018.json','utf8'));
const {expected:state}=JSON.parse(exported.snapshot),room={state,scheduled:exported.scheduled,scheduledOrders:exported.scheduledOrders,agendaOrder:exported.agendaOrder,map:exported.map};
const before=JSON.stringify(room),start=performance.now(),all=fleetCountdowns(room,0),oldMs=performance.now()-start;
const selected=[];
const ids=[...all].filter(([,value])=>value.arrivalMinutes!==null).sort((a,b)=>a[1].arrivalMinutes-b[1].arrivalMinutes).slice(0,3).map(([id])=>id);
for(const id of ids){
  const begin=performance.now(),steps=labFleetArrivalSteps(room,id);let result=steps.next(),count=0;
  while(!result.done){result=steps.next();count++;}
  const old=all.get(id).arrivalMinutes,newMinutes=result.value.arrivalSeconds/60-state.economy.tick*10;
  selected.push({fleetId:id,ms:Math.round(performance.now()-begin),steps:count,matchesOld:Math.abs(old-newMinutes)<1e-7});
}
const report={tick:state.economy.tick,fleetCount:all.size,oldAllMs:Math.round(oldMs),selected,unchanged:before===JSON.stringify(room)};
writeFileSync('runtime/selected-fleet-arrival-performance-20261018.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
if(!report.unchanged||selected.some(item=>!item.matchesOld))throw Error('Benchmark changed behavior');
