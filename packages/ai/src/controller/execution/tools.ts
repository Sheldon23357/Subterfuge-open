import {BatchTransportError} from './batch-outcome.js';
import {modelActionTimes} from './model-action-time.js';

import {resolveOutpostReferences} from '../presentation/outpost-references.js';

import type {ModelToolState} from '../storage/state-ownership.js';
import {aiOutpostMentions} from '../../../../contracts/src/index.js';
import type {LocalToolResultMap} from './tool-results.js';
import {prepareNotebook,prepareReminders,prepareFinish} from '../storage/private-state-preparation.js';
import {object,keys} from './tool-validation.js';
export {object} from './tool-validation.js';
import { toolMetadata } from '../contracts/tool-metadata.js';
import type {MemoryEvidence} from '../storage/memory-evidence.js';


import type {ReviewReceipt} from '../storage/memory-consistency.js';
import type {NotebookQuery} from '../storage/memory-records.js';
import {chatTarget,CHAT_LIMIT_PER_TARGET,diplomacyCooldown} from '../analysis/chat-budget.js';

import { diagnosticText } from '../../../../contracts/src/index.js';
import type { AiSnapshot, GameGateway } from "../contracts/types.js";
import { compactGameError, GameRequestError, GameTransportError } from '../transport/gateway.js';
import {resolveFleetReferences} from '../presentation/fleet-labels.js';
import type {BatchEffect} from '../contracts/batch-effect.js';





const ACTIONS = new Set([
  'propose-agreement',
  'respond-agreement',
  "launch",
  "cancel-launch",
  "return-fleet",
  "toggle-mine",
  "set-shields",
  "check-in",
  "cancel-inactivity-warning",
]);
function action(raw: unknown) {
  const a = object(raw);
  if (typeof a.kind !== "string" || !ACTIONS.has(a.kind))
    throw Error("Action not available");
  if ("player" in a || "revision" in a)
    throw Error("Identity override forbidden");
  return a;
}
export interface ToolContext {
  batchPrevalidated?:boolean;
  beforeEffect?:(tool:string,args:Record<string,unknown>,snapshot:AiSnapshot,batchEffect?:BatchEffect)=>void;
  batchEffect?:BatchEffect;
  /** Internal nested calls already carry engine units, never model supplied. */
  actionTimesNormalized?:boolean;
  strategicContextAvailable?:boolean;
  readMemoryReviews?:()=>ReviewReceipt[];
  state: ModelToolState;
  snapshot: AiSnapshot;
  gateway: GameGateway;
  id: string;
  spoken: number;
  chatSentByTarget?:Record<string,number>;
  onObservation?:(observation:AiSnapshot['observation'])=>void;
  now: number;
  active?:()=>boolean;
  signal?:AbortSignal;
  audit?:(kind:string,details:unknown)=>void;
  readNotebookArchive?:()=>unknown;
  readNotebookEntry?:(id:string)=>import('../contracts/types.js').NotebookEntry|undefined;
  readNotebookQuery?:(query:NotebookQuery)=>unknown;
  readManualReceipt?:(id:string)=>import('../../../../contracts/src/index.js').ManualCommandReceipt|undefined;
  readMemoryEvidence?:(reference:string)=>MemoryEvidence|undefined;
  hasMemoryEvidence?:(reference:string)=>boolean;
  readObservedFleetIds?:(reference:string)=>string[];
  readToolResult?:(id:string,detail?:boolean)=>unknown;
  readComparisonEvidence?:(resultRef:string,planId:string)=>import('../../../../prediction/src/index.js').KnownDefenseEvidence|null;
  defenseEvidenceTargets?:string[];
  onCampaigns?:(plans:import('../storage/campaign-state.js').Campaign[])=>void;
}
async function executeToolInternal(
  name: string,
  raw: unknown,
  c: ToolContext,
): Promise<unknown> {
  const a = object(resolveFleetReferences(resolveOutpostReferences(raw,c.snapshot.observation),c.snapshot.observation)),
    revision = c.snapshot.observation.revision;
  switch (name) {
    case 'notebook': return prepareNotebook(a,c);
    case 'reminders': return prepareReminders(a,c);
    case 'batch': {
      keys(a,['actions']);
      if(!Array.isArray(a.actions)||a.actions.length<1||a.actions.length>8)throw Error('Batch requires 1–8 actions');
      // Validate every envelope before the first mutation.
      for(const raw of a.actions){const item=object(raw);keys(item,['tool','arguments']);
        const args=object(item.arguments);
        if(item.tool==='order'){keys(args,['action']);action(args.action);}
        else throw Error('Batch only permits order');
      }
      if(c.batchPrevalidated&&c.gateway.batchAvailable&&c.gateway.orderBatch){
        c.beforeEffect?.('batch',a,c.snapshot);
        if(c.active&&!c.active())throw Error('Batch was paused before submission');
        const actions=a.actions.map(raw=>action(object(object(raw).arguments).action));
        for(let index=0;index<actions.length;index++)c.audit?.('batch-item-intent',{id:`${c.id}-item-${index}`,index,tool:'order',arguments:{action:actions[index]},basisRevision:revision});
        try{
          const result=await c.gateway.orderBatch(c.id,actions,revision);
          for(const child of result.results)c.audit?.('batch-item-result',child);
          return result;
        }catch(error){
          if(error instanceof BatchTransportError){for(const child of error.outcome.results)c.audit?.(child.status==='unknown'?'batch-item-unknown':'batch-item-result',child);throw error;}
          for(let index=0;index<actions.length;index++)c.audit?.('batch-item-result',{id:`${c.id}-item-${index}`,index,tool:'order',status:'rejected',error:'批次在下达前被拒绝'});
          throw error;
        }
      }
      let snapshot=c.snapshot;
      const results:unknown[]=[];
      for(let index=0;index<a.actions.length;index++){
        if(c.active&&!c.active())break;
        const item=object(a.actions[index]),id=`${c.id}-item-${index}`,basisRevision=snapshot.observation.revision;
        c.audit?.('batch-item-intent',{id,index,...item,basisRevision:snapshot.observation.revision});
        try{
          const batchEffect:BatchEffect={id:c.id,index,actions:a.actions as BatchEffect['actions'],
            accepted:results.map(row=>({index:Number(object(row).index),requestId:String(object(row).id)}))};
          const result=await executeToolInternal(item.tool as string,item.arguments,{...c,id,snapshot,batchEffect});
          snapshot={...snapshot,observation:result as AiSnapshot['observation']};
          const body=object(result);
          const receipt={id,index,tool:item.tool,status:'accepted',revision:snapshot.observation.revision,...body.commandReceipt?{commandReceipt:body.commandReceipt}:{},...body.protocolReceipt?{protocolReceipt:body.protocolReceipt,protocolReceiptPlayer:body.protocolReceiptPlayer}:{}};
          results.push(receipt);c.audit?.('batch-item-result',receipt);
        }catch(error){
          if(error instanceof GameTransportError){
            const failure=compactGameError(error,{expectedRevision:basisRevision});
            c.audit?.('batch-item-unknown',{id,index,...failure});
            const unknown={id,index,tool:item.tool,status:'unknown',error:diagnosticText(error.displayReason),...failure};
            const prefix=[...results,unknown] as Record<string,unknown>[];
            for(let next=index+1;next<a.actions.length;next++)prefix.push({id:`${c.id}-item-${next}`,index:next,tool:object(a.actions[next]).tool,status:'not-executed',reason:'前项结果未知，批次已停止'});
            throw new BatchTransportError(error,{status:'unknown',complete:false,requested:a.actions.length,processed:index+1,results:prefix},snapshot.observation);
          }
          if(error instanceof GameRequestError&&error.status===409){
            snapshot=error.observation?{...snapshot,observation:error.observation}:await c.gateway.snapshot(c.state.chatCursor,c.state.notificationCursor);
          }
          const receipt={id,index,tool:item.tool,status:'rejected',error:diagnosticText(error instanceof Error?error.message:'Rejected'),...(error instanceof GameRequestError?{...compactGameError(error,{expectedRevision:basisRevision,...(error.status===409?{currentRevision:snapshot.observation.revision}:{})}),...(error.detail?{detail:diagnosticText(error.detail)}:{})}:{})};
          results.push(receipt);c.audit?.('batch-item-result',receipt);break;
        }
      }
      const processed=results.length,complete=processed===a.actions.length&&results.every(r=>(r as {status:string}).status==='accepted');
      for(let index=processed;index<a.actions.length;index++)results.push({id:`${c.id}-item-${index}`,index,tool:object(a.actions[index]).tool,status:'not-executed',reason:'批次已停止'});
      return {observation:snapshot.observation,results,requested:a.actions.length,processed,complete};
    }
    case "order": {
      keys(a,['action']);
      const requested=action(a.action);
      if(requested.kind==='launch'&&requested.delaySeconds!==undefined&&requested.delaySeconds!==0){
        const at=c.now+Number(requested.delaySeconds);
        if(at%600!==0)throw Error('出发须为整数世界天；填写delayWorldDays使准备结束时刻为整数世界日，不自动取整');
      }
      c.beforeEffect?.('order',a,c.snapshot,c.batchEffect);
      const o=await c.gateway.request('/tool/order',{revision,order:{id:c.id,action:requested}}) as AiSnapshot['observation'];
      return {...o,commandReceipt:{id:c.id,status:'accepted'}};
    }
    case "say": {
      keys(a, ["to", "text"]);
      const recipients =
        a.to === null ? [] : Array.isArray(a.to) ? a.to : [a.to];
      // Reply to new incoming messages even while the test world's clock is stopped.
      // This does not waive the cooldown for unrelated unsolicited messages.
      const incoming = c.snapshot.chat.filter(m=>m.from!==c.snapshot.chatPlayer);
      const replying = a.to===null
        ? incoming.some(m=>m.to===null)
        : recipients.length>0&&recipients.every(to=>incoming.some(m=>m.from===to));
      if((c.chatSentByTarget?.[chatTarget(a.to as number|number[]|null)]??0)>=CHAT_LIMIT_PER_TARGET)throw Error('Chat target quota exceeded: '+chatTarget(a.to as number|number[]|null));
      if (
        (c.spoken === 0 &&
          !replying &&
          c.state.lastSpoke !== null &&
          c.now - c.state.lastSpoke < 300)
      )
        throw Error(JSON.stringify({code:'DIPLOMACY_COOLDOWN',message:'Diplomacy cooldown',...diplomacyCooldown(c.now,c.state.lastSpoke,c.spoken,c.snapshot.chat,c.snapshot.chatPlayer),correction:'Wait until nextUnsolicitedAtSeconds or reply to an actual incoming message from every recipient. This message was not sent; do not repeat identical say to probe the cooldown.'}));
      if (
        (a.to !== null && !recipients.length) ||
        recipients.some(
          (v) =>
            !Number.isInteger(v) ||
            Number(v) < 0 ||
            Number(v) >= c.snapshot.chatCount ||
            v === c.snapshot.chatPlayer,
        ) ||
        new Set(recipients).size !== recipients.length
      )
        throw Error("Invalid recipients");
      if (typeof a.text !== "string" || !a.text.trim() || a.text.length > 2000)
        throw Error("Invalid message");
      const names=c.snapshot.observation.outpostNames??{};
      const message=aiOutpostMentions(a.text,Object.entries(names).map(([id,name])=>({id,name}))).map(p=>p.text).join('');
      if(message.length>2000)throw Error('据点名称展开后消息超过2000字符，请缩短外交消息后重试。');
      const publicClaim=/(?:公开|公屏)(?:要求|表示|宣布|承诺|说)/;
      if(publicClaim.test(a.text)){
        const publicSenders=new Set(incoming.filter(m=>m.to===null).map(m=>m.from));
        const privateIncoming=incoming.filter(m=>m.from!==c.snapshot.chatPlayer&&m.to!==null);
        if(privateIncoming.length&&!privateIncoming.some(m=>publicSenders.has(m.from)))throw Error('消息来源是私聊，不能称为公开要求或公屏声明；请改写为私下收到的要求。');
      }
      c.beforeEffect?.('say',a,c.snapshot,c.batchEffect);
      return c.gateway.request("/tool/chat", {
        id: c.id,
        to: a.to,
        text: message,
      });
    }
    case "finish": return prepareFinish(a,c);
    default:
      throw Error("Unknown tool");
  }
}


/** Hybrid proposals share one guarded execution path; analysis runs in the planner. */
export function executeTool<K extends keyof LocalToolResultMap>(name:K,raw:unknown,c:ToolContext):Promise<LocalToolResultMap[K]>;
export function executeTool(name:string,raw:unknown,c:ToolContext):Promise<unknown>;
export async function executeTool(name:string,raw:unknown,c:ToolContext):Promise<unknown>{
 if(!toolMetadata(name))throw Error('Tool not available: '+name);
 const input=c.actionTimesNormalized?raw:modelActionTimes(name,raw);
 return executeToolInternal(name,input,{...c,actionTimesNormalized:true});
}
