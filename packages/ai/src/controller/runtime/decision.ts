import {attentionTargets} from '../observation/attention.js';
import {capacityPressure} from '../analysis/capacity-pressure.js';
import {routineDefenseGrowth} from '../analysis/expected-growth.js';
import {enemyWaitingSources} from '../analysis/waiting-defense.js';
import type {PlayerObservation,PlayerNotification,PlayerActivityEvent} from '../../../../contracts/src/index.js';
import type {DecisionSignal,DeferredEvent,DecisionTask,DecisionTriggerKind} from '../contracts/types.js';

function fleetTerminationReason(result:NonNullable<PlayerActivityEvent['termination']>,observation:PlayerObservation,kind?:string){
  return result.outcome==='recovered'?`本人舰队已实际回收到${observation.outpostNames?.[result.outpost!]??result.outpost}，回收${result.drillers}兵力`:`本人舰队已由程序移除，移除时${result.drillers}兵力，未确认抵达任何据点`;
}

function fleetTransferReason(result:NonNullable<PlayerActivityEvent['transfer']>,player:number){return `舰队归属已由玩家${result.from}变为玩家${result.to}（${result.reason==='gift'?'实际赠送':'实际俘获'}），${result.to===player?'现由本人拥有':'不再由本人拥有'}；归属变更不是抵达证明`;}

/** Only reads the authenticated projection. Ordinary public changes are notes,
 * never reasons to block the clock or launch a model by themselves. */
export function classifyChanges(before:PlayerObservation|null,after:PlayerObservation,options:{ignoreOwnEffects?:boolean;confirmedDepartures?:ReadonlySet<string>}={}){
  const important:DecisionSignal[]=[],minor:{key:string;summary:string}[]=[];
  if(!before||before.roomId!==after.roomId||before.view.player!==after.view.player)return {important,minor};
  const a=before.view,b=after.view,p=b.player;
  const add=(kind:DecisionTriggerKind,key:string,category:DecisionSignal['category'],reason:string,entities:string[]=[],urgent=false)=>important.push({key,kind,category,reason,entities,urgent,sources:[{kind:'observation',id:after.revision,observedSeconds:after.view.tick*600+after.secondsSinceLastTick},{kind:'observation',id:before.revision,observedSeconds:before.view.tick*600+before.secondsSinceLastTick}]});
  if(a.self.activity?.inactivityWarningCount!==b.self.activity?.inactivityWarningCount&&Number(b.self.activity?.inactivityWarningCount)>0)add('activity-warning','activity','plan','收到活跃状态警告');
  // Queue bookkeeping is context, not a decision by itself. Keep it deferred
  // so the observer persists the new baseline even when no model is needed.
  if(JSON.stringify(before.scheduled)!==JSON.stringify(after.scheduled)){
    minor.push({key:'scheduled',summary:'预约指令记录已更新，合并至下次复核'});
    const previous=new Map(before.scheduled.map(order=>[order.id,order]));
    for(const order of after.scheduled){
      const old=previous.get(order.id);
      // Some invalidated orders are cancelled with failed=true. Do not mute
      // execution failures as accepted own effects or ordinary cancellation.
      if((order.status==='failed'||order.failed===true)&&
        (!old||old.status!==order.status||old.failed!==order.failed||old.reason!==order.reason))
        add('execution-failure',`scheduled-failed:${order.id}`,'plan',`预约指令执行失败：${order.reason??order.id}`,[order.id],true);
    }
  }
  for(const player of after.intel){const old=before.intel.find(p=>p.player===player.player);if(old?.active&&!player.active)add('player-eliminated',`eliminated:${player.player}`,'strategy','有玩家被淘汰');}
  const posts=new Map(a.outposts.map(o=>[o.id,o]));
  const pressure=capacityPressure(after),previousPressure=capacityPressure(before);
  if(!options.ignoreOwnEffects&&pressure.state!=='none'&&pressure.state!==previousPressure.state)
    add('investment-opportunity','capacity-pressure','strategy',pressure.state==='blocked'?'总兵力已满容量，工厂停产：提高有效进攻／夺供能点／合理开矿优先级，出兵本身不释放容量':'兵力临近容量且预计12世界天内满兵，提前安排有效进攻或投资');
  const attention=attentionTargets(after);
  // A change at our actual attack destination invalidates the plan's premises.
  // This is a decision wake, never an automatic cancellation or hidden scan.
  for(const o of b.outposts){
    if(o.owner===p)continue;
    const attackers=attention.get(o.id)??[];if(!attackers.length)continue;
    const old=posts.get(o.id);if(!old)continue;
    const defensesIncreased=o.drillers!==undefined&&(old.drillers===undefined||o.drillers>old.drillers)||
      o.shield!==undefined&&(old.shield===undefined||o.shield>old.shield);
    const defensesChanged=o.owner!==old.owner||o.type!==old.type||o.visibility!==old.visibility||o.destroyed!==old.destroyed||o.shieldsEnabled!==old.shieldsEnabled||
      o.shieldMax!==old.shieldMax||old.drillers!==undefined&&o.drillers===undefined;
    const expected=defensesIncreased&&routineDefenseGrowth(old,o,before,after);
    if(expected)minor.push({key:`expected-growth:${o.id}`,summary:`${after.outpostNames?.[o.id]??o.id}防守增长符合已知生产/恢复上界，合并记录`});
    if(defensesIncreased&&!expected||defensesChanged)
      add('attack-premise-change',`attack-target:${o.id}`,'military',`${after.outpostNames?.[o.id]??o.id}进攻目标防御或情报发生变化，复核原出兵方案`,[o.id,...attackers],true);
  }
  for(const o of b.outposts){const old=posts.get(o.id);if(!old)continue;const name=after.outpostNames?.[o.id]??o.id,own=o.owner===p,wasOwn=old.owner===p;
    if(wasOwn&&!own)add('outpost-control-change',`post:${o.id}`,'military',`${name}失去控制`,[o.id],true);
    else if(own&&!wasOwn)add('outpost-control-change',`post:${o.id}`,'military',`${name}已占领`,[o.id]);
    else if(own&&!options.ignoreOwnEffects){
      const dispatched=b.fleets.filter(f=>f.owner===p&&f.source===o.id).reduce((n,f)=>n+Math.max(0,f.drillers-(a.fleets.find(old=>old.id===f.id)?.drillers??0)),0);
      const startingMine=!old.minePending&&o.minePending;
      const troopLoss=o.drillers!==undefined&&old.drillers!==undefined&&old.drillers-o.drillers>dispatched&&!startingMine;
      const shieldLoss=o.shield!==undefined&&old.shield!==undefined&&o.shield<old.shield&&o.shieldsEnabled!==false;
      if(troopLoss||shieldLoss)minor.push({key:`damage:${o.id}`,summary:`${name}兵力或护盾减少，合并至下次复核`});
      if(o.type!==old.type||o.minePending!==old.minePending||o.shieldDisablePending!==old.shieldDisablePending||o.shieldsEnabled!==old.shieldsEnabled)add('construction-change',`economy:${o.id}`,'plan',`${name}建设或护盾状态变化`,[o.id]);
      if(o.type!=='mine'&&!o.minePending&&Number(old.drillers)<b.self.mineCreationCost&&Number(o.drillers)>=b.self.mineCreationCost)add('investment-opportunity',`funded:${o.id}`,'strategy',`${name}形成可投资兵力：比较进攻、机动预备与开矿的争胜收益`,[o.id]);
    }else if(o.owner!==old.owner)minor.push({key:'public-ownership',summary:`${name}归属变化`});
    else if(o.visibility!==old.visibility||o.type!==old.type||o.drillers!==old.drillers&&Number(o.drillers)<Number(old.drillers))minor.push({key:'public-intel',summary:`${name}公开或可见情报变化`});
  }
  const waitingSources=enemyWaitingSources(a);
  const fleets=new Map(a.fleets.map(f=>[f.id,f]));
  for(const f of b.fleets){const old=fleets.get(f.id);fleets.delete(f.id);
    if(!options.ignoreOwnEffects&&old&&f.owner===p&&!old.returned&&f.returned)add('fleet-state-change',`fleet-return:${f.id}`,'military','本人舰队已返航，舰数减半，尚未确认抵达',[f.id,...(f.destination?[f.destination.id]:[])]);
    if(old?.owner===p&&f.owner!==p)add('fleet-state-change',`fleet-lost:${f.id}`,'military','本人舰队归属变化',[f.id],true);
    if(old&&f.owner===p&&f.state==='moving'&&f.drillers<old.drillers)add('fleet-state-change',`fleet-damage:${f.id}`,'military','本人航行舰队兵力减少',[f.id],true);
    // A visibly confirmed departure creates an opening at an existing attack
    // target. Disappearance alone is not departure and never uses hidden IDs.
    if(old&&waitingSources.has(f.id)&&old.owner===f.owner&&!options.confirmedDepartures?.has(f.id)&&(f.state==='launching'||f.state==='moving')){
      const source=waitingSources.get(f.id)!;
      const post=b.outposts.find(o=>o.id===source&&o.owner===f.owner&&o.owner!==p);
      const ours=attention.get(source)??[];
      if(post&&ours.length&&old.drillers>0)
        add('attack-premise-change',`attack-departure:${source}`,'military',`${after.outpostNames?.[source]??source}敌舰实际出发，可撤回防守减少，复核进攻机会`,[source,f.id,...ours],true);
    }
    // New contacts or substantive changes at the same contested destination
    // matter even when that destination is neutral. Pure movement is ignored.
    const changed=!old||old.owner!==f.owner||old.gift!==f.gift||old.drillers!==f.drillers||!options.confirmedDepartures?.has(f.id)&&(old.state==='waiting')!==(f.state==='waiting')||JSON.stringify(old.destination)!==JSON.stringify(f.destination);
    if(changed){
      const contested=new Set([f,old].flatMap(ship=>ship&&ship.owner!==p&&!ship.gift&&ship.destination?.kind==='outpost'?[ship.destination.id]:[]));
      for(const id of contested){
        const post=b.outposts.find(o=>o.id===id&&o.owner!==p),ours=attention.get(id)??[];
        if(post&&ours.length)add('attack-premise-change',`contested-target:${id}`,'military',`${after.outpostNames?.[id]??id}同一争夺目标的对手舰队出现或方案变化，复核抵达与战果`,[id,f.id,...ours],true);
      }
    }
    const target=f.destination?.kind==='outpost'?b.outposts.find(o=>o.id===f.destination?.id):f.destination?.kind==='fleet'?b.fleets.find(o=>o.id===f.destination?.id):undefined;
    if(f.owner!==p&&!f.gift&&target?.owner===p&&changed)add('threat-change',`threat:${f.id}`,'military','发现指向本人单位的敌方舰队',[f.id,target.id],true);
    else if(!old)minor.push({key:'fleet-contacts',summary:'可见舰队出现或消失'});
  }
  for(const f of fleets.values()){
    if(f.owner===p){
      const settled=after.activity?.find(e=>e.subject===f.id&&(e.arrival||e.termination||e.transfer));
      const cancelled=after.activity?.some(e=>e.subject===f.id&&e.kind==='launch-cancelled');
      const reason=settled?.arrival?`本人舰队已抵达${after.outpostNames?.[settled.arrival.outpost]??settled.arrival.outpost}，${settled.arrival.outcome==='delivered'?`实际交付${settled.arrival.drillers??'未知'}兵力`:'进攻被击败'}`:settled?.transfer?fleetTransferReason(settled.transfer,p):settled?.termination?fleetTerminationReason(settled.termination,after,settled.kind):cancelled?'本人待发舰队已撤销，按实际回收状态更新计划':'本人舰队已不在当前列表，授权结算记录尚未覆盖原因；程序事实待核实，不推定抵达或被摧毁';
      add('fleet-state-change',`arrival:${f.id}`,'plan',reason,[f.id,...(f.source?[f.source]:[]),...(f.destination?[f.destination.id]:[])]);
    }
    else minor.push({key:'fleet-contacts',summary:'可见舰队出现或消失'});
  }
  // A resumed interval can contain an entire launch and arrival, so there may
  // be no vanished fleet in the previous map. Use the authorized event itself.
  const priorEvents=new Set((before.activity??[]).map(e=>e.id));
  for(const event of after.activity??[]){
    if(!event.arrival&&!event.termination&&!event.transfer||event.actor!==p&&event.transfer?.to!==p||(before.activityCursor!==undefined?event.id<before.activityCursor:priorEvents.has(event.id)))continue;
    if(important.some(s=>s.key===`arrival:${event.subject}`))continue;
    if(event.transfer){add('fleet-state-change',`arrival:${event.subject}`,'plan',`结算补传：${fleetTransferReason(event.transfer,p)}`,[event.subject]);continue;}
    if(event.termination){add('fleet-state-change',`arrival:${event.subject}`,'plan',`结算补传：${fleetTerminationReason(event.termination,after,event.kind)}`,[event.subject,...(event.termination.outpost?[event.termination.outpost]:[])]);continue;}
    if(!event.arrival)continue;
    const target=after.outpostNames?.[event.arrival.outpost]??event.arrival.outpost;
    add('fleet-state-change',`arrival:${event.subject}`,'plan',`结算补传：本人舰队已抵达${target}，${event.arrival.outcome==='delivered'?`实际交付${event.arrival.drillers??'未知'}兵力`:'进攻被击败'}`,[event.subject,event.arrival.outpost]);
  }
  return {important,minor};
}
/** Notices are already restricted to this player's authenticated inbox. Never
 * infer ownership from text or confuse a fleet ID with an outpost ID. */
export function classifyNotice(n:PlayerNotification,view:PlayerObservation['view'],options:{signals?:readonly DecisionSignal[];observation?:PlayerObservation}={}):DecisionSignal|null {
  const loc=n.location?.id;
  const own=!!loc&&(n.location?.kind==='outpost'&&view.outposts.some(o=>o.id===loc&&o.owner===view.player)||n.location?.kind==='fleet'&&view.fleets.some(f=>f.id===loc&&f.owner===view.player));
  const signal=(kind:DecisionTriggerKind,key:string,category:DecisionSignal['category'],reason:string,entities:string[],urgent=false):DecisionSignal=>{
    const matches=options.signals?.filter(s=>s.key===key)??[],existing=matches[0];
    const sources=[...matches.flatMap(s=>s.sources??[]),{kind:'notification' as const,id:String(n.id),observedSeconds:view.tick*600}];
    return existing?{...existing,kind:existing.kind??kind,sources,urgent:urgent||matches.some(s=>s.urgent),entities:[...new Set([...matches.flatMap(s=>s.entities),...entities])]}:{key,kind,sources,category,reason,entities,urgent};
  };
  // Global notices have no location. Ignore already-resolved state, and reuse
  // the state-diff key/reason so one event is not counted as two causes.
  if(n.kind==='inactivity-warning')return Number(view.self.activity?.inactivityWarningCount)>0?
    signal('activity-warning','activity','plan','收到活跃状态警告',[],true):null;

  if(n.kind==='mine-created'){
    if(n.location?.kind!=='outpost'||!loc)return null;
    if(own)return signal('construction-change',`economy:${loc}`,'plan',`${loc}建设状态变化`,[loc]);
    // Public mine announcements are useful context, but only an already
    // relevant target needs a new decision. Do not infer hidden garrisons.
    const refs=options.observation?attentionTargets(options.observation).get(loc):
      view.fleets.filter(f=>f.owner===view.player&&!f.gift&&f.destination?.kind==='outpost'&&f.destination.id===loc).map(f=>f.id);
    return refs?.length?signal('attack-premise-change',`attack-target:${loc}`,'military',n.text,[loc,...refs],true):null;
  }
  if(n.kind==='battle'&&(own||n.battle?.attacker.player===view.player||n.battle?.defender.player===view.player))return signal('battle-notice',`notice:${n.id}`,'military',n.text,loc?[loc]:[],true);
  return null;
}
export function makeTask(signals:DecisionSignal[],reasons:string[],deferred:DeferredEvent[],diplomacy:boolean):DecisionTask {
  const category=signals.some(s=>s.category==='military')?'military':signals.some(s=>s.category==='strategy')?'strategy':signals.some(s=>s.category==='plan')?'plan':diplomacy||signals.some(s=>s.category==='diplomacy')?'diplomacy':'plan';
  const local=category==='military'&&signals.every(s=>s.category!=='strategy'&&s.scope!=='global'&&!s.key.startsWith('eliminated:'));
  const triggers=mergeDecisionSignals(signals);
  if(diplomacy&&!triggers.some(s=>s.kind==='diplomacy-message'))triggers.push({key:'incoming-chat',kind:'diplomacy-message',category:'diplomacy',reason:'收到新的外交消息',entities:[],urgent:false,sources:[{kind:'runtime',id:'incoming-chat'}]});
  for(const [index,reason] of reasons.entries())if(!diplomacy&&!signals.some(s=>s.reason===reason))triggers.push({key:`untyped-reason:${index}`,kind:'unknown',category,reason,entities:[],urgent:false});
  const review=signals.filter(s=>s.reviewRequirements).map(s=>s.reviewRequirements!);
  const requirements={...(signals.some(s=>s.requiresFullContext)?{fullContext:true}:{}),...(signals.some(s=>s.notebookReview)?{notebookReview:true}:{}),...(review.length?{memoryReview:{factsNeeded:review.some(r=>r.factsNeeded),strategicReview:review.some(r=>r.strategicReview),cleanupNeeded:review.some(r=>r.cleanupNeeded)}}:{})};
  return {...requirements,triggers,category,scope:local?'local':'global',weight:category==='diplomacy'?'light':category==='plan'||local?'medium':'heavy',reasons:[...new Set([...reasons,...signals.map(s=>s.reason)])],entities:[...new Set(signals.flatMap(s=>s.entities))],deferred};
}

/** Merge duplicate event identity without discarding provenance or a parallel cause. */
export function mergeDecisionSignals(signals:readonly DecisionSignal[]):DecisionSignal[]{
  const merged=new Map<string,DecisionSignal>();
  for(const signal of signals){
    const id=JSON.stringify([signal.key,signal.kind??null,signal.role??'new-trigger']);
    const previous=merged.get(id);
    if(!previous){merged.set(id,structuredClone(signal));continue;}
    const sources=[...new Map([...(previous.sources??[]),...(signal.sources??[])].map(source=>[JSON.stringify(source),source])).values()];
    merged.set(id,{...previous,urgent:previous.urgent||signal.urgent,entities:[...new Set([...previous.entities,...signal.entities])],
      ...(previous.scope==='global'||signal.scope==='global'?{scope:'global' as const}:{}),
      ...(previous.requiresFullContext||signal.requiresFullContext?{requiresFullContext:true}:{}),...(previous.notebookReview||signal.notebookReview?{notebookReview:true}:{}),
      ...(previous.reviewRequirements||signal.reviewRequirements?{reviewRequirements:{factsNeeded:!!(previous.reviewRequirements?.factsNeeded||signal.reviewRequirements?.factsNeeded),strategicReview:!!(previous.reviewRequirements?.strategicReview||signal.reviewRequirements?.strategicReview),cleanupNeeded:!!(previous.reviewRequirements?.cleanupNeeded||signal.reviewRequirements?.cleanupNeeded)}}:{}),
      ...(sources.length?{sources}:{}),...(previous.relatedCampaignIds||signal.relatedCampaignIds?{relatedCampaignIds:[...new Set([...(previous.relatedCampaignIds??[]),...(signal.relatedCampaignIds??[])])]}:{})});
  }
  return [...merged.values()];
}
