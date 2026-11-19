import type {PlayerObservation} from '@subterfuge/bot-sdk/contracts';
import type {HybridState,SituationBrief} from './contracts.js';

/** count is the source counter at publication, not an assertion that every
 * historical event was individually available or delivered. */
export interface ReceiptDelivery {roomId:string;player:number;count:number;lastId:number;unavailable:number}
export const receiptScope=(task:Pick<SituationBrief,'kind'|'scope'>)=>task.kind+':'+task.scope;

/** Select available new facts, never a last-N or wall-clock cut. The source is
 * an authorized bounded observation; its missing history must remain explicit. */
export function receiptContext(o:PlayerObservation,saved:HybridState,task:Pick<SituationBrief,'kind'|'scope'>){
 const d=o.diplomacy,key=receiptScope(task),prior=saved.receiptDelivery?.[key];
 const valid=prior&&prior.roomId===o.roomId&&prior.player===o.view.player&&prior.count<=(d?.receiptCount??0)?prior:undefined;
 const available=d?.receipts??[],records=available.filter(r=>r.id>(valid?.lastId??-1));
 const count=d?.receiptCount??0,newCount=Math.max(0,count-(valid?.count??0));
 const unavailable=(valid?.unavailable??0)+Math.max(0,newCount-records.length);
 const delivery:ReceiptDelivery={roomId:o.roomId,player:o.view.player,count,lastId:Math.max(valid?.lastId??-1,...records.map(r=>r.id)),unavailable};
 return {records,delivery,key,coverage:{source:'authorized-observation-window',available:available.length,new:records.length,previousPublicationSourceCount:valid?.count??null,unavailableBeforeWindow:unavailable,meaning:'仅列未在本职责/会话成功发布时交付的可用回执；窗口外单事件未展开，不保证完整历史。当前信任、义务与历史结果另由当前授权状态提供，不能把空清单当作全历史无事件'}};
}

/** Called only after validated publication. Retry, cancellation and
 * stale responses never consume events. A concurrent newer fence cannot regress. */
export function acknowledgeReceipts(saved:HybridState,key:string,value:ReceiptDelivery){
 const old=saved.receiptDelivery?.[key];
 if(old&&old.roomId===value.roomId&&old.player===value.player&&old.count>value.count)return;
 (saved.receiptDelivery??={})[key]=structuredClone(value);
}
