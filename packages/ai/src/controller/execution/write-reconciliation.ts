import {createHash} from 'node:crypto';
import type {ProtocolReceipt} from '../../../../contracts/src/index.js';
import type {OutboxEntry} from '../../../../player-sdk/src/index.js';

export interface PendingWriteRequest {id:string;tool:string;arguments?:unknown;basisRevision?:string}
export interface WriteResolution {
 id:string;tool:string;status:'committed'|'rejected'|'not-executed'|'unknown';
 reason:string;protocolReceipt?:ProtocolReceipt;protocolReceiptPlayer?:number;
 message?:{id?:string;to:unknown;text:string;acceptedAtUtc:string};
}
/** Match one original logical request to its already scoped transport outbox.
 * No route similarities, body similarity, newest-message guesses or retries. */
export function resolveWriteOutbox(request:PendingWriteRequest,entries:readonly OutboxEntry[],roomId:string,roomEpoch:string,playerId:string,player:number):WriteResolution {
 const kind=request.tool==='order'?'order':request.tool==='say'?'chat-send':null;
 const identity=request.id;
 const base={id:request.id,tool:request.tool};
 if(!kind||!identity)return {...base,status:'unknown',reason:'缺少可核对的协议身份'};
 const key=createHash('sha256').update(JSON.stringify([kind,identity])).digest('hex');
 const scoped=entries.filter(entry=>entry.scope.roomId===roomId&&entry.scope.roomEpoch===roomEpoch&&entry.scope.playerId===playerId);
 const batches=kind==='order'?scoped.flatMap(entry=>{
  if(entry.request.kind!=='order-batch')return [];
  const commands=entry.request.payload.commands as import('../../../../contracts/src/index.js').ProtocolCommandRequest[];
  const index=commands.findIndex(c=>c.idempotencyKey===key);if(index<0)return [];
  const child=entry.receipt?.effectCommitted?entry.receipt.effects?.batchReceipts?.[index]:undefined;
  return [{...entry,request:commands[index]!,receipt:child??(entry.receipt?.state==='rejected'?null:undefined),...(entry.receipt?.state==='rejected'?{state:'settled' as const,reason:'batch-rejected-before-effects'}:{})}];
 }):[];
 const matches=[...scoped.filter(entry=>entry.request.kind===kind&&entry.request.idempotencyKey===key),...batches];
 if(matches.length!==1)return {...base,status:'unknown',reason:'未找到唯一的同身份传输记录'};
 const entry=matches[0]!,receipt=entry.receipt;
 if(receipt){
  if(receipt.scope.roomId!==roomId||receipt.scope.roomEpoch!==roomEpoch||receipt.scope.playerId!==playerId||receipt.idempotencyKey!==key)return {...base,status:'unknown',reason:'回执身份不匹配'};
  const evidence={protocolReceipt:receipt,protocolReceiptPlayer:player};
  if(receipt.state==='rejected')return {...base,...evidence,status:receipt.code==='BATCH_NOT_EXECUTED'?'not-executed':'rejected',reason:receipt.code??'权威回执拒绝'};
  if(receipt.effectCommitted&&['applied','scheduled','cancelled'].includes(receipt.state))return {...base,...evidence,status:'committed',reason:'权威回执确认已提交效果',
   ...(kind==='chat-send'&&typeof entry.request.payload.text==='string'?{message:{...(typeof receipt.effects?.messageId==='string'?{id:receipt.effects.messageId}:{}),to:entry.request.payload.to,text:entry.request.payload.text,acceptedAtUtc:receipt.updatedAt}}:{})};
  return {...base,...evidence,status:'unknown',reason:'已接收，尚无确定提交效果'};
 }
 if(entry.state==='settled'&&['absent-after-authority-retired','never-dispatched','batch-rejected-before-effects'].includes(entry.reason??''))return {...base,status:'not-executed',reason:entry.reason!};
 return {...base,status:'unknown',reason:entry.reason??'缺少权威回执'};
}
