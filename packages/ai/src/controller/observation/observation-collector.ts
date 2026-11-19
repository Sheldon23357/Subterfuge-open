import {manualVersion,manualEntities,isTacticalManual} from '../execution/manual-coordination.js';
import { coalesceOwnArrivals } from './arrival-coalescing.js';
import { classifyChanges,classifyNotice } from '../runtime/decision.js';
import { confirmDepartures } from './departure-confirmation.js';
import type { ObservationHost } from '../runtime/runner-host.js';
import type { RunnerState } from '../runtime/runner-state.js';
import { gameSeconds,type AiSnapshot } from '../contracts/types.js';
import { deferWake } from '../runtime/wake-reducer.js';
import {phaseLabel,applicableMiningHistory,type MiningPhaseHistory} from '../analysis/mining-phase.js';

export function collectObservation(host:ObservationHost,runtime:RunnerState,snapshot:AiSnapshot,ownEffects=false){
    const now=gameSeconds(snapshot),previous=runtime.observed;
    if(previous&&previous.view.tick*600+previous.secondsSinceLastTick>now)return;
    const previousPhase=runtime.latestSnapshot?.miningPhase?.stage??(previous
      ?applicableMiningHistory(previous,host.store.latest<MiningPhaseHistory>(host.state.roomId,host.state.lobbySeat,'mining-phase-observed'))?.stage:null)??null;
    snapshot.miningPhase=host.store.observeMiningPhase(host.state.roomId,host.state.lobbySeat,snapshot.observation);
    const departures=confirmDepartures(previous,snapshot.observation,runtime.departureReviews);
    const departureReviewsChanged=JSON.stringify(runtime.departureReviews)!==JSON.stringify(departures.reviews);
    runtime.departureReviews=departures.reviews;
    const changes=classifyChanges(previous,snapshot.observation,{ignoreOwnEffects:ownEffects,confirmedDepartures:departures.confirmed});
    if(snapshot.miningPhase?.stage&&snapshot.miningPhase.stage!==previousPhase)changes.important.push({key:'mining-phase',kind:'mining-phase-change',category:'strategy',scope:'global',urgent:false,
      sources:[{kind:'observation',id:snapshot.observation.revision,observedSeconds:now}],entities:[],
      reason:`程序依据授权公开经济确认采矿局阶段为${phaseLabel(snapshot.miningPhase.stage)}；结合当前矿量、收入和本席处境复核战略，历史阶段不代替当前进度`});
    changes.minor.push(...departures.minor);changes.important.push(...departures.important.map(signal=>({...signal,kind:'attack-premise-change' as const,sources:[{kind:'observation' as const,id:snapshot.observation.revision,observedSeconds:now}]})));
    if(manualVersion(snapshot.observation)> (previous?manualVersion(previous):0)){
      const receipts=snapshot.observation.manualCommands!.receipts.filter(r=>r.version>(previous?manualVersion(previous):0)&&isTacticalManual(r));
      if(receipts.length)changes.important.push({key:'manual-commands',kind:'manual-command-change',sources:receipts.map(r=>({kind:'observation',id:r.id,observedSeconds:now})),category:'plan',scope:'local',urgent:false,
        entities:[...new Set(receipts.flatMap(r=>manualEntities(r,snapshot.observation.manualCommands)))],reason:'玩家手动操作事实已更新；在本次正常决策自动核对事实、谨慎理解意图并修订受影响的计划/预算/提醒，继续兼容的合法配合，不覆盖有效保护、不从旧提醒自动恢复已取消动作，也不等待玩家操作额外控制开关'});
    }
    runtime.observationGeneration++;
    runtime.observed=snapshot.observation;runtime.latestSnapshot=snapshot;runtime.checkedTick=snapshot.observation.view.tick;
    for(const event of changes.minor)deferWake(runtime,event.key,event.summary,now);
    for(const notice of snapshot.notifications){
      if(notice.id<host.state.notificationCursor)continue;
      const signal=classifyNotice(notice,snapshot.observation.view,{signals:[...changes.important,...runtime.signals.values()],observation:snapshot.observation});
      if(signal){changes.important.push(signal);runtime.pendingNotices.set(notice.id,notice);}else deferWake(runtime,`notice:${notice.kind}`,notice.text,now);
    }
    const reminders=host.store.reminders(host.state.roomId,host.state.lobbySeat);
    const arrivals=!runtime.busy&&!snapshot.hasMore&&!runtime.signals.size&&changes.important.length>0&&changes.important.every(s=>s.key.startsWith('arrival:'))?coalesceOwnArrivals(previous,snapshot.observation,changes.important,
      host.store.arrivalEstimates(host.state.roomId,host.state.lobbySeat),reminders,[]):{immediate:changes.important,delayed:[]};
    for(const arrival of arrivals.delayed)runtime.coalescedArrivals.set(arrival.signal.key,arrival);
    for(const signal of arrivals.immediate)runtime.signals.set(signal.key,signal);
    let dueChanged=false;
    for(const [key,arrival] of runtime.coalescedArrivals){
      const anchorChanged=!reminders.some(r=>r.id===arrival.reminderId&&r.atSeconds===arrival.atSeconds);
      if(runtime.signals.size||now>=arrival.atSeconds||anchorChanged){
        runtime.signals.set(key,{...arrival.signal,urgent:true,...(anchorChanged?{reason:arrival.signal.reason+'；原相关复核已变更，立即补查'}:{})});runtime.coalescedArrivals.delete(key);dueChanged=true;
      }
    }
    for(const r of reminders.filter(r=>r.atSeconds<=now)){
      if(runtime.busy&&runtime.presentedReminders.get(r.id)===JSON.stringify(r))continue;
      runtime.signals.set(`reminder:${r.id}`,{key:`reminder:${r.id}`,kind:r.source?.kind==='campaign'?'campaign-review':'reminder-due',sources:[{kind:'reminder',id:r.id,observedSeconds:now}],...(r.source?.kind==='campaign'?{relatedCampaignIds:[r.source.campaignId]}:{}),category:r.category??'plan',reason:`提醒到期：${r.note}`,entities:r.entities??[],urgent:true});dueChanged=true;
    }
    host.state.notificationCursor=Math.max(host.state.notificationCursor,snapshot.notificationCursor);
    if(dueChanged||departureReviewsChanged||changes.important.length||changes.minor.length||snapshot.notifications.length){host.saveWake();host.save('notifications-observed');}
  }
