import type {BotCommunicationServices} from '@subterfuge/bot-sdk/contracts/bot-mode';
import type {CommunicationWrite} from '@subterfuge/bot-sdk/runtime/communication';
import {scopeMatches,type HybridState} from './contracts.js';
import {settleDiplomacyMessage,reconcileDiplomacy} from './diplomacy-execution.js';
import {foregroundInputKey} from './foreground-input.js';
import {awaitingCommander} from './execution-recovery.js';
import {commanderPlanIssue} from './commander-commitments.js';

/** Sending and receipt reconciliation do not consume a tactical round. */
export async function communicateHybrid(s:BotCommunicationServices):Promise<void>{
 let saved=s.latest<HybridState>('state');if(!saved)return;
 saved=structuredClone(saved);
 const o=s.snapshot.observation,before=foregroundInputKey(saved,o);
 if(saved.directive&&!scopeMatches(saved.directive.basis,o))throw Error('Hybrid communication scope mismatch');
 const changed=reconcileDiplomacy(saved,o);
 const pending=s.latest<CommunicationWrite>('communication-write');
 const recovering=pending?saved.messages.find(m=>m.id===pending.requestId&&(pending.status==='unknown'||['pending','unknown'].includes(m.status))):undefined;
 const message=recovering??saved.messages.find(m=>m.status==='pending'&&m.basis.commanderVersion===(s.state.commanderDirectives?.version??0));
 if(changed){
  s.record('state',saved as unknown as Record<string,unknown>);
  if(before!==foregroundInputKey(saved,o))s.wake();
 }
 if(!message||!recovering&&(awaitingCommander(s.state,saved.directive)||commanderPlanIssue(saved,o)))return;
 const id=message.id;
 if(!scopeMatches(message.basis,o))throw Error('Diplomacy message scope mismatch');
 if(!recovering){
  message.requestId=id;
  s.record('state',saved as unknown as Record<string,unknown>);
  s.record('message-attempt',{id,requestId:id,lane:'communication'});
 }
 const result=await s.send(id,{to:message.to===null?null:message.to.length===1?message.to[0]!:message.to,text:message.text});
 // Model publication may have happened while the transport was awaited.
 saved=structuredClone(s.latest<HybridState>('state')??saved);
 const beforeSettlement=JSON.stringify(saved);
 settleDiplomacyMessage(saved,id,result.status==='accepted'?'accepted':result.status==='rejected'?'failed':'unknown',o);
 if(beforeSettlement!==JSON.stringify(saved)){
  s.record('state',saved as unknown as Record<string,unknown>);
  s.record('communication-settled',{id,status:result.status});
 }
 if(before!==foregroundInputKey(saved,o))s.wake();
}
