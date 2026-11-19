import type {PlayerObservation} from '../../../../contracts/src/index.js';

// Derived from the immutable ID, so labels survive movement, fog and restarts.
const fullFleet=/\bp(\d+)-([a-f0-9]{64})\b/gi;
export function fleetLabel(id:string):string {
  return id.replace(fullFleet,(_,owner:string,hash:string)=>`F${Number(owner)+1}-${hash.slice(0,8).toUpperCase()}`);
}
export function scheduleLabel(id:string):string {
  return id.replace(fullFleet,(_,owner:string,hash:string)=>`S${Number(owner)+1}-${hash.slice(0,8).toUpperCase()}`);
}
/** Scheduled command identities must not be presented as fleet identities. */
export function labelScheduleReferences(value:unknown,...references:unknown[]):unknown {
  const render=fleetReferenceRenderer(value,...references);
  const label=(id:string)=>render(id)===id?id:scheduleLabel(id);
  return project(value);
  function project(value:unknown,scope=''):unknown {
  if(Array.isArray(value))return value.map(v=>typeof v==='string'&&['scheduleIds','pendingScheduleIds','pendingSchedules','cancelledScheduleIds'].includes(scope)?label(v):project(v,scope));
  if(!value||typeof value!=='object')return value;
  const row=value as Record<string,unknown>;
  const result=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,['arguments','submittedArguments'].includes(k)?structuredClone(v):k==='scheduleId'&&typeof v==='string'?label(v):project(v,k)]));
  if(Array.isArray(result.scheduled))result.scheduled=result.scheduled.map(s=>s&&typeof s==='object'&&typeof s.id==='string'?{...s,id:label(s.id)}:s);
  if(['pendingAfterHorizon','pendingSchedules'].includes(scope)&&typeof result.id==='string')result.id=label(result.id);
  return result;
  }
}

export function shortFleetReferences<T>(value:T):T {
  if(typeof value==='string')return fleetLabel(value) as T;
  if(Array.isArray(value))return value.map(shortFleetReferences) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[fleetLabel(key),shortFleetReferences(v)])) as T;
  return value;
}
/** Resolve only actionable entity fields using this player's visible fleets.
 * Unknown or colliding labels never select an arbitrary unit. Narrative text,
 * memory, chat IDs and idempotency keys are deliberately left untouched. */
export function resolveFleetReferences(value:unknown,observation:PlayerObservation):unknown {
  if(Array.isArray(value))return value.map(v=>resolveFleetReferences(v,observation));
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,v])=>{
    if(['fleetId','destination'].includes(key)&&typeof v==='string'&&/^F\d+-[A-F0-9]{8}$/i.test(v)){
      const matches=observation.view.fleets.filter(f=>fleetLabel(f.id).toUpperCase()===v.toUpperCase());
      if(matches.length!==1)throw Error(matches.length?'舰队短代号有歧义，请重新观察并使用完整编号':'舰队短代号不在当前可见情报中，请重新观察');
      return [key,matches[0]!.id];
    }
    return [key,resolveFleetReferences(v,observation)];
  }));
}

/** Prompt-local collision guard. It never creates a new alias vocabulary: an
 * ambiguous short label falls back to the existing exact, resolvable raw ID. */
export function fleetReferenceRenderer(...values:unknown[]):(text:string)=>string {
  const identities=new Map<string,Set<string>>();
  // A candidate, note, command or proof can legally resemble a fleet identity.
  // Keep that exact spelling everywhere in this request when namespaces clash,
  // rather than changing an executable plan ID or guessing a new alias.
  const protectedIds=new Set<string>();
  const protect=(value:unknown,scope='')=>{
    if(Array.isArray(value)){for(const child of value)protect(child,scope);return;}
    if(!value||typeof value!=='object')return;
    const row=value as Record<string,unknown>,fleet=scope==='fleets'||row.kind==='fleet'||typeof row.state==='string'&&'drillers'in row&&'destination'in row||['incoming','arrivals','waitingDepartures'].includes(scope)||scope==='threats'&&row.estimated===false;
    const scheduled=['scheduled','pendingSchedules','pendingAfterHorizon'].includes(scope);
    for(const [key,child] of Object.entries(row)){
      if(typeof child==='string'&&/^p\d+-[a-f0-9]{64}$/i.test(child)&&
        (['planId','candidateId','resultRef','fingerprint','commandId','orderId'].includes(key)||key==='id'&&!fleet&&!scheduled))protectedIds.add(child.toLowerCase());
      protect(child,key);
    }
  };
  for(const value of values){
    protect(value);
    const source=typeof value==='string'?value:JSON.stringify(value)??'';
    for(const match of source.matchAll(/\bp(\d+)-([a-f0-9]{64})\b/gi)){
      const id=match[0],label=fleetLabel(id).toUpperCase(),ids=identities.get(label)??new Set<string>();
      ids.add(id);identities.set(label,ids);
    }
  }
  return text=>text.replace(/\bp(\d+)-([a-f0-9]{64})\b/gi,id=>
    protectedIds.has(id.toLowerCase())||(identities.get(fleetLabel(id).toUpperCase())?.size??0)>1?id:fleetLabel(id));
}
