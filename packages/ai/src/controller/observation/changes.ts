import type {PlayerObservation} from '../../../../contracts/src/index.js';

/** Compare authorized observations only. Disappearance is never proof of death. */
export function observationChanges(before:PlayerObservation|null,after:PlayerObservation) {
  if(!before||before.roomId!==after.roomId||before.view.player!==after.view.player)return {baselineAvailable:false,observedAt:{tick:after.view.tick,seconds:after.secondsSinceLastTick},changes:[]};
  const changes:unknown[]=[];
  for(const kind of ['outposts','fleets'] as const){
    const old=new Map(before.view[kind].map(r=>[r.id,r]));
    for(const next of after.view[kind]){
      const prev=old.get(next.id);old.delete(next.id);
      if(!prev){
        const current=Object.fromEntries(Object.entries(next).filter(([key])=>key!=='position'));
        changes.push({kind,id:next.id,event:'newly-observed',current});continue;
      }
      const fields:Record<string,unknown>={};
      for(const key of new Set([...Object.keys(prev),...Object.keys(next)])){
        if(['position','launchRemainingSeconds','giftPendingSeconds','mineRemainingSeconds','shieldDisableRemainingSeconds'].includes(key)){
          if(key!=='position'){
            const p=(prev as unknown as Record<string,unknown>)[key],n=(next as unknown as Record<string,unknown>)[key];
            if(typeof p==='number'&&typeof n==='number'&&(p>0)!==(n>0))fields[key]={before:p,after:n};
          }
          continue;
        }
        const p=(prev as unknown as Record<string,unknown>)[key],n=(next as unknown as Record<string,unknown>)[key];
        const meaningful=(v:unknown)=>key==='metrics'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['nextMinutes','progress'].includes(k))):v;
        if(JSON.stringify(meaningful(p))!==JSON.stringify(meaningful(n)))fields[key]={before:p===undefined?{known:false}:meaningful(p),after:n===undefined?{known:false}:meaningful(n)};
      }
      if(Object.keys(fields).length)changes.push({kind,id:next.id,event:'changed',fields});
    }
    for(const id of old.keys()){
      const settlement=kind==='fleets'?after.activity?.find(e=>e.subject===id&&(e.arrival||e.termination||e.transfer||e.kind==='fleet-recalled'||e.kind==='launch-cancelled')):undefined;
      changes.push({kind,id,event:'no-longer-observed',...(settlement?{settlement}:{meaning:'当前列表不再包含该实体，原因尚无授权事实确认，不推定抵达或被摧毁'})});
    }
  }
  for(const key of ['self','match'] as const){
    if(JSON.stringify(before.view[key])!==JSON.stringify(after.view[key]))changes.push({kind:key,before:before.view[key],after:after.view[key]});
  }
  if(JSON.stringify(before.scheduled)!==JSON.stringify(after.scheduled))changes.push({kind:'scheduled',before:before.scheduled,after:after.scheduled});
  const previousEvents=new Set((before.activity??[]).map(e=>e.id));
  const settlements=(after.activity??[]).filter(e=>(before.activityCursor!==undefined?e.id>=before.activityCursor:!previousEvents.has(e.id))&&(e.arrival||e.termination||e.transfer||e.kind==='fleet-recalled'||e.kind==='launch-cancelled'));
  return {baselineAvailable:true,since:{tick:before.view.tick,seconds:before.secondsSinceLastTick},observedAt:{tick:after.view.tick,seconds:after.secondsSinceLastTick},changes,settlements};
}
