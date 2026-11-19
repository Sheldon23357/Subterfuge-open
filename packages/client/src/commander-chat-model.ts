import type {CommanderReference,CommanderProposal,CommanderThread,CommanderMessage} from '../../contracts/src/index.js';

export type CommanderAction='list'|'messages'|'confirm';
export type CommanderTransport=(action:CommanderAction,data?:unknown,signal?:AbortSignal)=>Promise<CommanderThread>;
export function commanderReferenceKey(reference:CommanderReference){return `${reference.kind}:${reference.id}`;}
export function addCommanderReference(references:CommanderReference[],reference:CommanderReference){
  if(references.some(item=>commanderReferenceKey(item)===commanderReferenceKey(reference)))return references;
  return [...references,reference].slice(0,12);
}
export function canConfirmCommanderProposal(proposal:CommanderProposal,version:number){return proposal.status==='pending'&&proposal.baseVersion===version;}
export function validateCommanderThread(thread:CommanderThread,roomId:string,player:number){
  if(!thread||thread.roomId!==roomId||thread.player!==player||!Array.isArray(thread.messages))throw Error('Commander identity changed');
  return thread;
}
export function commanderRequestId(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  const values=new Uint32Array(4);globalThis.crypto?.getRandomValues?.(values);
  return `commander-${Date.now().toString(36)}-${Array.from(values).map(x=>x.toString(36)).join('-')}-${Math.random().toString(36).slice(2)}`;
}
/** Never expose server/model protocol text or credentials in this conversation. */
export function commanderFriendlyError(action:CommanderAction){return action==='confirm'?'暂未确认成功，请刷新对话后核对指示再试。':action==='messages'?'暂时没能发送，内容已保留，可以重试。':'暂时连接不上 AI 对话，稍后会自动重连。';}
/** Concurrent list/send/confirm responses may arrive out of order. History is
 * append-only; never let an older read undo a confirmed instruction or receipt. */
export function commanderSnapshotIsCurrent(current:CommanderThread|null,incoming:CommanderThread){
 if(!current)return true;
 if(current.roomId!==incoming.roomId||current.player!==incoming.player)return false;
 if(incoming.directives.version<current.directives.version||incoming.directives.appliedVersion<current.directives.appliedVersion)return false;
 // A successful internal ACK clears its old failure notice without adding
 // another chat reply. Only that exact, newly acknowledged notice may vanish.
 const clearedNotice=(message:CommanderMessage)=>{
  const match=/^notice-reconcile-error-(\d+)$/.exec(message.id),version=match?Number(match[1]):NaN;
  return message.role==='assistant'&&message.status==='failed'&&Number.isSafeInteger(version)&&version>current.directives.appliedVersion&&version<=incoming.directives.appliedVersion;
 };
 const retained=current.messages.filter(message=>!clearedNotice(message));
 if(incoming.messages.length<retained.length)return false;
 const byId=new Map(incoming.messages.map(message=>[message.id,message]));
 return current.messages.every(message=>{
  const next=byId.get(message.id);if(!next)return clearedNotice(message);
  if(message.status!=='queued'&&next.status==='queued')return false;
  if(message.proposal&&(!next.proposal||message.proposal.status!=='pending'&&next.proposal.status==='pending'))return false;
  return true;
 });
}
export function commanderDirectiveChanges(previous:string,next:string){
 const lines=(text:string)=>text.split(/\n+/).map(line=>line.trim()).filter(Boolean);
 const before=lines(previous),after=lines(next);
 return {removed:before.filter(line=>!after.includes(line)),added:after.filter(line=>!before.includes(line))};
}
export function commanderKeyboardViewport(layoutHeight:number,visibleHeight:number,offsetTop:number,focused:boolean){
 if(!focused||!Number.isFinite(visibleHeight)||visibleHeight<=0||visibleHeight>=layoutHeight-80)return null;
 return {height:Math.max(120,visibleHeight),top:Math.max(0,offsetTop)};
}

/** Pure geometry for the dock: transient context grows up without shifting the row. */
export function commanderDockAnchor(room:{left:number;bottom:number},bar:{left:number;right:number;top:number;bottom:number},inline:boolean){
 return {left:(inline?bar.right+10:bar.left)-room.left,bottom:Math.max(0,room.bottom-(inline?bar.bottom:bar.top))+ (inline?0:10)};
}

/** Conversation time, not game-preview time; stable ties preserve journal order. */
export function commanderChronologicalMessages(messages:readonly CommanderMessage[]){
 return [...messages].sort((left,right)=>left.sentAt-right.sentAt);
}
