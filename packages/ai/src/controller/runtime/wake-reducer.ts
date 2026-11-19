import { makeTask,mergeDecisionSignals } from './decision.js';
import type { ObservationHost } from './runner-host.js';
import type { RunnerState } from './runner-state.js';
import { gameSeconds,type AiSnapshot,type DecisionSignal,type DecisionTask,type DeferredEvent } from '../contracts/types.js';

export function deferWake(runtime:RunnerState,key:string,summary:string,now:number){
    const old=runtime.deferred.get(key);
    runtime.deferred.set(key,{key,summary,count:(old?.count??0)+1,firstSeconds:old?.firstSeconds??now,lastSeconds:now});
    if(runtime.deferred.size>64)runtime.deferred.delete(runtime.deferred.keys().next().value!);
  }

export function takePendingNotices(runtime:RunnerState,snapshot:AiSnapshot){
    const notices=new Map([...snapshot.notifications,...runtime.pendingNotices.values()].map(n=>[n.id,n]));
    runtime.pendingNotices.clear();return {...snapshot,notifications:[...notices.values()]};
  }
export function reducePendingWake(host:ObservationHost,runtime:RunnerState,snapshot:AiSnapshot,task:DecisionTask,includeChat=true){
    for(const [key,arrival] of runtime.coalescedArrivals)if(task.scope==='global'&&task.category!=='diplomacy'||task.entities.includes(arrival.target)){
      runtime.signals.set(key,arrival.signal);runtime.coalescedArrivals.delete(key);
    }
    const chatSignals:DecisionSignal[]=(includeChat?snapshot.chat:[]).filter(message=>message.from!==snapshot.chatPlayer&&!task.triggers?.some(trigger=>trigger.kind==='diplomacy-message'&&trigger.sources?.some(source=>source.kind==='chat'&&source.id===`${message.from}:${message.id}`))).map(message=>({key:`chat:${message.from}:${message.id}`,kind:'diplomacy-message',category:'diplomacy',reason:'收到新消息',entities:[],urgent:false,sources:[{kind:'chat',id:`${message.from}:${message.id}`,observedSeconds:gameSeconds(snapshot)}]}));
    const signals=mergeDecisionSignals([...runtime.signals.values(),...chatSignals]);
    if(signals.length){
      const reduction=reduceWakeTask(task,signals,[...runtime.deferred.values()]);
      task=reduction.task;const added=reduction.added;
      host.save('task-updated',{category:task.category,weight:task.weight,reasons:added.reasons});
      runtime.signals.clear();runtime.deferred.clear();runtime.inFlight=task;host.saveWake();
    }
    const now=gameSeconds(snapshot);
    for(const r of host.store.reminders(host.state.roomId,host.state.lobbySeat).filter(r=>r.atSeconds<=now))runtime.presentedReminders.set(r.id,JSON.stringify(r));
    task={...task,timing:{observedSeconds:now,waitingDepartures:snapshot.observation.view.fleets.filter(f=>f.owner===snapshot.observation.view.player&&f.state==='waiting'&&f.launchRemainingSeconds!==undefined).map(f=>({id:f.id,secondsRemaining:f.launchRemainingSeconds!})),dueReminders:host.store.reminders(host.state.roomId,host.state.lobbySeat).filter(r=>r.atSeconds<=now).map(r=>r.id)}};
    return {...takePendingNotices(runtime,snapshot),task};
  }

/** Pure deterministic task classification; applying state and journal effects stays in the adapter. */
export function reduceWakeTask(task:DecisionTask,signals:DecisionSignal[],deferred:DeferredEvent[]){
 const added=makeTask(signals,[],deferred,false);
      const military=task.category==='military'||added.category==='military';
      const global=task.fullContext||added.fullContext||task.category==='strategy'||added.category==='strategy'||task.scope==='global'&&task.category==='military'||added.scope==='global'&&added.category==='military';
 const inherited=task.triggers??task.reasons.map((reason,index):DecisionSignal=>({key:`untyped-task:${index}`,kind:'unknown',category:task.category,reason,entities:[...task.entities],urgent:false}));
 const review=[task.memoryReview,added.memoryReview].filter((r):r is NonNullable<typeof r>=>r!==undefined);
 const next={...task,...(added.fullContext?{fullContext:true}:{}),...(added.notebookReview?{notebookReview:true}:{}),...(review.length?{memoryReview:{factsNeeded:review.some(r=>r.factsNeeded),strategicReview:review.some(r=>r.strategicReview),cleanupNeeded:review.some(r=>r.cleanupNeeded)}}:{}),triggers:mergeDecisionSignals([...inherited,...added.triggers??[]]),category:military?'military':task.category==='strategy'||added.category==='strategy'?'strategy':task.category==='plan'||added.category==='plan'?'plan':'diplomacy',scope:global?'global':added.scope??'global',weight:global||task.weight==='heavy'||added.weight==='heavy'?'heavy':military||task.weight==='medium'||added.weight==='medium'?'medium':'light',
        reasons:[...new Set([...task.reasons,...added.reasons])],entities:[...new Set([...task.entities,...added.entities])],deferred:[...task.deferred,...added.deferred]};
 return {task:next as DecisionTask,added};
}
